/**
 * Store: session state, the decision log, rotation, pruning, and the two
 * scopes of `/jev:off`.
 */

import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LOG_ROTATE_BYTES,
  SESSION_TTL_MS,
  Store,
  safeSessionId,
  type DecisionRecord,
} from "../../src/hooks/store.js";
import { cleanup, tempDir } from "./helpers.js";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = tempDir();
  store = new Store(dir);
});
afterEach(() => {
  cleanup(dir);
});

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    ts: new Date().toISOString(),
    session_id: "s1",
    event: "PreToolUse",
    decision: "ask",
    ...overrides,
  };
}

describe("safeSessionId", () => {
  it("keeps an ordinary id", () => {
    expect(safeSessionId("abc-123_DEF")).toBe("abc-123_DEF");
  });

  it("cannot be used to escape the data directory", () => {
    expect(safeSessionId("../../etc/passwd")).not.toContain("/");
    expect(safeSessionId("../../etc/passwd")).not.toContain("..");
  });

  it("never produces an empty name", () => {
    expect(safeSessionId("")).toBe("unknown");
    expect(safeSessionId("///")).not.toBe("");
  });
});

describe("session state", () => {
  it("reads an empty state for an unknown session", () => {
    expect(store.readSession("nope")).toEqual({ prompts: [], stop_blocks: 0 });
  });

  it("round-trips what it wrote", () => {
    store.writeSession("s1", { prompts: ["a"], stop_blocks: 2, disabled: true });
    const session = store.readSession("s1");
    expect(session.prompts).toEqual(["a"]);
    expect(session.stop_blocks).toBe(2);
    expect(session.disabled).toBe(true);
    expect(session.updated).toBeTypeOf("number");
  });

  it("survives a corrupt session file", () => {
    store.writeSession("s1", { prompts: ["a"], stop_blocks: 0 });
    writeFileSync(join(dir, "sessions", "s1.json"), "{not json");
    expect(store.readSession("s1")).toEqual({ prompts: [], stop_blocks: 0 });
  });

  it("ignores fields of the wrong type", () => {
    store.writeSession("s1", { prompts: [], stop_blocks: 0 });
    writeFileSync(join(dir, "sessions", "s1.json"), JSON.stringify({ prompts: "nope", stop_blocks: "nope" }));
    expect(store.readSession("s1")).toEqual({ prompts: [], stop_blocks: 0 });
  });
});

describe("disable flags", () => {
  it("disables one session without touching another", () => {
    store.setDisabled("s1", true);
    expect(store.isDisabled("s1")).toBe(true);
    expect(store.isDisabled("s2")).toBe(false);
  });

  it("re-enables a session", () => {
    store.setDisabled("s1", true);
    store.setDisabled("s1", false);
    expect(store.isDisabled("s1")).toBe(false);
  });

  it("falls back to a global flag when the session is unknown", () => {
    const result = store.setDisabled(null, true);
    expect(result.scope).toBe("global");
    expect(store.isDisabled("any-session")).toBe(true);
  });

  it("clears the global flag when a session is re-enabled", () => {
    store.setDisabled(null, true);
    store.setDisabled("s1", false);
    expect(existsSync(store.globalDisablePath)).toBe(false);
    expect(store.isDisabled("s1")).toBe(false);
  });
});

describe("pending asks", () => {
  it("remembers and consumes one", () => {
    store.rememberAsk("s1", { tool_use_id: "t1", ts: 1, tool_name: "Bash" });
    expect(store.takeAsk("s1", "t1")?.tool_name).toBe("Bash");
    expect(store.takeAsk("s1", "t1")).toBeUndefined();
  });

  it("leaves other entries alone", () => {
    store.rememberAsk("s1", { tool_use_id: "t1", ts: 1, tool_name: "Bash" });
    store.rememberAsk("s1", { tool_use_id: "t2", ts: 2, tool_name: "Write" });
    store.takeAsk("s1", "t1");
    expect(store.readSession("s1").pending_asks?.map((p) => p.tool_use_id)).toEqual(["t2"]);
  });

  it("is bounded", () => {
    for (let index = 0; index < 50; index += 1) {
      store.rememberAsk("s1", { tool_use_id: `t${index}`, ts: index, tool_name: "Bash" });
    }
    expect(store.readSession("s1").pending_asks!.length).toBeLessThanOrEqual(20);
  });
});

describe("decision log", () => {
  it("appends one line per record and reads them back in order", () => {
    store.append(record({ decision: "a" }));
    store.append(record({ decision: "b" }));
    const lines = readFileSync(store.logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(store.readLog().map((r) => r.decision)).toEqual(["a", "b"]);
  });

  it("skips a malformed line rather than failing the read", () => {
    store.append(record({ decision: "a" }));
    writeFileSync(store.logPath, `${readFileSync(store.logPath, "utf8")}{broken\n`);
    expect(store.readLog()).toHaveLength(1);
  });

  it("rotates at the size limit and keeps one generation", () => {
    writeFileSync(store.logPath, "x".repeat(LOG_ROTATE_BYTES + 1));
    store.append(record({ decision: "after-rotation" }));
    expect(existsSync(join(dir, "decisions.1.jsonl"))).toBe(true);
    expect(statSync(store.logPath).size).toBeLessThan(LOG_ROTATE_BYTES);
    // The rotated generation is still readable, oldest first.
    expect(store.readLog().at(-1)?.decision).toBe("after-rotation");
  });

  it("reads an empty log as an empty array", () => {
    expect(store.readLog()).toEqual([]);
  });
});

describe("pruning", () => {
  it("removes session files past the ttl and keeps fresh ones", () => {
    store.writeSession("old", { prompts: [], stop_blocks: 0 });
    store.writeSession("new", { prompts: [], stop_blocks: 0 });
    const oldPath = join(dir, "sessions", "old.json");
    const stale = (Date.now() - SESSION_TTL_MS - 60_000) / 1000;
    utimesSync(oldPath, stale, stale);

    expect(store.pruneSessions(Date.now())).toBe(1);
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(join(dir, "sessions", "new.json"))).toBe(true);
  });

  it("runs at most once a day", () => {
    store.pruneSessions(Date.now());
    store.writeSession("old", { prompts: [], stop_blocks: 0 });
    const oldPath = join(dir, "sessions", "old.json");
    const stale = (Date.now() - SESSION_TTL_MS - 60_000) / 1000;
    utimesSync(oldPath, stale, stale);
    expect(store.pruneSessions(Date.now())).toBe(0);
    expect(existsSync(oldPath)).toBe(true);
  });
});

describe("resilience", () => {
  it("does not throw when the data directory cannot be created", () => {
    const blocked = new Store("/dev/null/cannot-exist");
    expect(() => blocked.append(record())).not.toThrow();
    expect(() => blocked.writeSession("s1", { prompts: [], stop_blocks: 0 })).not.toThrow();
    expect(blocked.readSession("s1")).toEqual({ prompts: [], stop_blocks: 0 });
    expect(blocked.readLog()).toEqual([]);
    expect(blocked.isDisabled("s1")).toBe(false);
  });
});
