/**
 * Stop: the truth table, and the loop protections around it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endsWithQuestion, handleStop, MIN_MESSAGE_CHARS, stopPolicy } from "../../src/hooks/handlers/stop.js";
import type { HookInput } from "../../src/hooks/types.js";
import { FakeModel, noul } from "../helpers/fake-model.js";
import { cleanup, makeDeps, tempDir } from "./helpers.js";

const AUTO = 0.85;
const YES = 0.97;
const NO = 0.02;
const MAYBE = 0.5;

const MESSAGE =
  "I refactored the parser and the tests pass. I did not migrate the old call sites yet; that is still outstanding.";

function input(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: "s1",
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: MESSAGE,
    background_tasks: [],
    session_crons: [],
    ...overrides,
  };
}

function answers(
  complete: number,
  unfinished: number,
  asks: number,
  addresses: number,
  verified = 0.02,
): Record<string, ReturnType<typeof noul>> {
  return {
    claims_complete: noul(complete),
    admits_unfinished: noul(unfinished),
    asks_user: noul(asks),
    addresses_request: noul(addresses),
    claims_verified: noul(verified),
  };
}

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => {
  cleanup(dir);
});

describe("stopPolicy truth table", () => {
  // complete, unfinished, asks_user, addresses -> block?
  const cases: [number, number, number, number, boolean, string][] = [
    [YES, NO, NO, YES, false, "a clean done is never second-guessed"],
    [NO, YES, NO, YES, true, "says work remains and is not waiting on the user"],
    [NO, YES, YES, YES, false, "says work remains but is waiting on the user"],
    [NO, YES, MAYBE, YES, false, "unsure whether it is waiting on the user"],
    [NO, MAYBE, NO, YES, false, "unsure whether work remains"],
    [NO, NO, NO, NO, false, "nothing fired"],
    [YES, YES, NO, YES, true, "claims done and also admits something is left"],
    [YES, YES, YES, YES, false, "claims done, admits a gap, and asks the user"],
    [NO, 0.84, NO, YES, false, "just below the threshold"],
    [NO, 0.86, NO, YES, true, "just above the threshold"],
    [NO, YES, 0.16, YES, false, "asks_user just above 1 - auto"],
    [NO, YES, 0.15, YES, true, "asks_user exactly at 1 - auto"],
  ];

  for (const [complete, unfinished, asks, addresses, expected, label] of cases) {
    it(`${expected ? "block" : "allow"}: ${label}`, () => {
      const result = stopPolicy(
        {
          claims_complete: complete,
          admits_unfinished: unfinished,
          asks_user: asks,
          addresses_request: addresses,
          claims_verified: NO,
        },
        AUTO,
      );
      expect(result.block).toBe(expected);
    });
  }

  it("explains itself when it blocks", () => {
    const result = stopPolicy(
      { claims_complete: NO, admits_unfinished: YES, asks_user: NO, addresses_request: YES, claims_verified: NO },
      AUTO,
    );
    expect(result.reasons.join(" ")).toContain("still outstanding");
  });
});

describe("endsWithQuestion", () => {
  it("recognizes a trailing question", () => {
    expect(endsWithQuestion("Which one do you want?")).toBe(true);
    expect(endsWithQuestion("Done. Anything else?  ")).toBe(true);
  });

  it("ignores a question mark earlier in the message", () => {
    expect(endsWithQuestion(`Why? Because of the cache. ${"x".repeat(300)}`)).toBe(false);
  });
});

describe("handleStop", () => {
  const withPrompt = (deps: ReturnType<typeof makeDeps>): void => {
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["refactor the parser and migrate the call sites"] }));
  };

  it("blocks when Claude said work remains", async () => {
    const model = new FakeModel(() => answers(NO, YES, NO, YES));
    const deps = makeDeps(dir, { model });
    withPrompt(deps);
    const output = await handleStop(input(), deps);
    expect(output?.decision).toBe("block");
    expect(output?.reason).toContain("[jev]");
    expect(output?.reason).toContain("unfinished");
  });

  it("counts the block so it happens at most once per prompt", async () => {
    const model = new FakeModel(() => answers(NO, YES, NO, YES));
    const deps = makeDeps(dir, { model });
    withPrompt(deps);
    expect((await handleStop(input(), deps))?.decision).toBe("block");
    expect(deps.store.readSession("s1").stop_blocks).toBe(1);
    expect(await handleStop(input(), deps)).toBeUndefined();
    expect(model.calls).toHaveLength(1);
  });

  it("says nothing when the work reads as finished", async () => {
    const model = new FakeModel(() => answers(YES, NO, NO, YES));
    const deps = makeDeps(dir, { model });
    withPrompt(deps);
    expect(await handleStop(input(), deps)).toBeUndefined();
    expect(deps.store.readLog().at(-1)?.decision).toBe("allow");
  });

  const skips: [string, Partial<HookInput>][] = [
    ["stop_hook_active is set", { stop_hook_active: true }],
    ["a background task is in flight", { background_tasks: [{ id: "t1", type: "shell", status: "running" }] }],
    ["a cron will wake the session", { session_crons: [{ id: "c1", schedule: "* * * * *" }] }],
    ["the message is too short", { last_assistant_message: "x".repeat(MIN_MESSAGE_CHARS - 1) }],
    ["there is no message", { last_assistant_message: "" }],
    ["the message ends by asking the user", { last_assistant_message: `${MESSAGE} Shall I continue?` }],
  ];

  for (const [label, overrides] of skips) {
    it(`says nothing when ${label}`, async () => {
      const model = new FakeModel(() => answers(NO, YES, NO, YES));
      const deps = makeDeps(dir, { model });
      withPrompt(deps);
      expect(await handleStop(input(overrides), deps)).toBeUndefined();
      expect(model.calls).toHaveLength(0);
    });
  }

  it("says nothing when no prompt was ever recorded", async () => {
    const model = new FakeModel(() => answers(NO, YES, NO, YES));
    const deps = makeDeps(dir, { model });
    expect(await handleStop(input(), deps)).toBeUndefined();
    expect(model.calls).toHaveLength(0);
  });

  it("obeys stop_check", async () => {
    const model = new FakeModel(() => answers(NO, YES, NO, YES));
    const deps = makeDeps(dir, { model, config: { stopCheck: false } });
    withPrompt(deps);
    expect(await handleStop(input(), deps)).toBeUndefined();
  });

  it("does nothing when the session is disabled", async () => {
    const model = new FakeModel(() => answers(NO, YES, NO, YES));
    const deps = makeDeps(dir, { model });
    withPrompt(deps);
    deps.store.setDisabled("s1", true);
    expect(await handleStop(input(), deps)).toBeUndefined();
  });

  it("fails open with no api key", async () => {
    const deps = makeDeps(dir, { model: null, config: { apiKey: null } });
    withPrompt(deps);
    expect(await handleStop(input(), deps)).toBeUndefined();
  });

  it("fails open when the model throws", async () => {
    const model = new FakeModel(() => {
      throw new Error("overloaded");
    });
    const deps = makeDeps(dir, { model });
    withPrompt(deps);
    expect(await handleStop(input(), deps)).toBeUndefined();
    expect(deps.store.readLog().at(-1)?.decision).toBe("error");
  });

  it("sends only the request and the final message", async () => {
    const model = new FakeModel(() => answers(YES, NO, NO, YES));
    const deps = makeDeps(dir, { model });
    withPrompt(deps);
    await handleStop(input(), deps);
    expect(Object.keys(model.calls[0]!.state as Record<string, unknown>).sort()).toEqual([
      "final_message",
      "user_request",
    ]);
  });
});

/**
 * The verification ledger, end to end through the Stop handler.
 *
 * The bookkeeping half lives in `tests/hooks/verification.test.ts`; this is the
 * wiring: does a claim that the checks pass actually meet the record of what
 * the checks did, and does the ledger survive the things that should not clear
 * it.
 */
describe("handleStop and the verification ledger", () => {
  const CLAIM = "Fixed the parser and all tests pass now. Everything is green and ready to ship.";
  const withPrompt = (deps: ReturnType<typeof makeDeps>): void => {
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["fix the failing parser test"] }));
  };
  const claimsVerified = () => answers(YES, NO, NO, YES, YES);

  it("blocks a claim that checks pass when the last check failed", async () => {
    const deps = makeDeps(dir, { model: new FakeModel(claimsVerified) });
    withPrompt(deps);
    deps.store.updateSession("s1", (s) => ({
      ...s,
      verification: {
        last: { kind: "test", ok: false, ts: deps.now() - 4 * 60_000, command: "npm test" },
        edits_since: 0,
      },
    }));

    const output = await handleStop(input({ last_assistant_message: CLAIM }), deps);
    expect(output?.decision).toBe("block");
    expect(output?.reason).toContain("[jev]");
    expect(output?.reason).toContain("says checks pass");
    expect(output?.reason).toContain("npm test");
    expect(output?.reason).toContain("4 min ago");
    expect(output?.reason).toContain("Re-run it, or correct the claim.");
    expect(deps.store.readLog().at(-1)?.decision).toBe("block");
    expect(deps.store.readSession("s1").stop_blocks).toBe(1);
  });

  it("says nothing when the last check passed and nothing has changed since", async () => {
    const deps = makeDeps(dir, { model: new FakeModel(claimsVerified) });
    withPrompt(deps);
    deps.store.updateSession("s1", (s) => ({
      ...s,
      verification: { last: { kind: "test", ok: true, ts: deps.now() - 60_000, command: "npm test" }, edits_since: 0 },
    }));
    expect(await handleStop(input({ last_assistant_message: CLAIM }), deps)).toBeUndefined();
    expect(deps.store.readLog().at(-1)?.decision).toBe("allow");
  });

  it("logs, but does not block, a claim with no verification on record", async () => {
    const deps = makeDeps(dir, { model: new FakeModel(claimsVerified) });
    withPrompt(deps);
    expect(await handleStop(input({ last_assistant_message: CLAIM }), deps)).toBeUndefined();
    const record = deps.store.readLog().at(-1);
    expect(record?.decision).toBe("unverified-claim");
    expect(record?.reasons?.join(" ")).toContain("no verification command on record");
    expect(deps.store.readSession("s1").stop_blocks).toBe(0);
  });

  it("logs, but does not block, a claim made after edits landed on a passing run", async () => {
    const deps = makeDeps(dir, { model: new FakeModel(claimsVerified) });
    withPrompt(deps);
    deps.store.updateSession("s1", (s) => ({
      ...s,
      verification: { last: { kind: "test", ok: true, ts: deps.now() - 60_000, command: "npm test" }, edits_since: 2 },
    }));
    expect(await handleStop(input({ last_assistant_message: CLAIM }), deps)).toBeUndefined();
    expect(deps.store.readLog().at(-1)?.decision).toBe("unverified-claim");
  });

  it("does not block a message that never claimed the checks pass", async () => {
    const deps = makeDeps(dir, { model: new FakeModel(() => answers(YES, NO, NO, YES, NO)) });
    withPrompt(deps);
    deps.store.updateSession("s1", (s) => ({
      ...s,
      verification: { last: { kind: "test", ok: false, ts: deps.now(), command: "npm test" }, edits_since: 0 },
    }));
    expect(await handleStop(input({ last_assistant_message: CLAIM }), deps)).toBeUndefined();
    expect(deps.store.readLog().at(-1)?.decision).toBe("allow");
  });

  it("lets the stop-short rule speak first when both rules fire", async () => {
    const deps = makeDeps(dir, { model: new FakeModel(() => answers(NO, YES, NO, YES, YES)) });
    withPrompt(deps);
    deps.store.updateSession("s1", (s) => ({
      ...s,
      verification: { last: { kind: "test", ok: false, ts: deps.now(), command: "npm test" }, edits_since: 0 },
    }));
    const output = await handleStop(input({ last_assistant_message: CLAIM }), deps);
    expect(output?.decision).toBe("block");
    expect(output?.reason).toContain("unfinished");
    // Still one block, not two.
    expect(deps.store.readSession("s1").stop_blocks).toBe(1);
  });

  it("asks claims_verified as part of the one request it already makes", async () => {
    const model = new FakeModel(claimsVerified);
    const deps = makeDeps(dir, { model });
    withPrompt(deps);
    await handleStop(input({ last_assistant_message: CLAIM }), deps);
    expect(model.calls).toHaveLength(1);
    expect(Object.keys(model.calls[0]!.questions).sort()).toEqual([
      "addresses_request",
      "admits_unfinished",
      "asks_user",
      "claims_complete",
      "claims_verified",
    ]);
    // The ledger is compared in code; it is never sent to the model.
    expect(JSON.stringify(model.calls[0]!.state)).not.toContain("npm test");
  });

  it("records the claims_verified signal for calibration even when nothing fires", async () => {
    const deps = makeDeps(dir, { model: new FakeModel(claimsVerified) });
    withPrompt(deps);
    deps.store.updateSession("s1", (s) => ({
      ...s,
      verification: { last: { kind: "lint", ok: true, ts: deps.now(), command: "npm run lint" }, edits_since: 0 },
    }));
    await handleStop(input({ last_assistant_message: CLAIM }), deps);
    expect(deps.store.readLog().at(-1)?.signals?.claims_verified).toBe(YES);
  });
});
