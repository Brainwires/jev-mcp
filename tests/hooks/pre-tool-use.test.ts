/**
 * PreToolUse: the decision table, row by row.
 *
 * Section 1 of `docs/DESIGN_0.3.md` is a nineteen-row table evaluated top-down,
 * first match wins. Every row has a test here, named by its number, plus the
 * flow around it: fail-open, the disable flags, redaction, and what reaches the
 * decision log.
 *
 * The three outcomes are silence, a note (`additionalContext`, delivered with
 * the tool result — after the call ran), and a trip (`deny`, the only
 * pre-execution output). Nothing prompts the user unless `ask_on_trip` is set.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Answer } from "../../src/decision/types.js";
import { MAX_NOTES_PER_PROMPT } from "../../src/hooks/advisory.js";
import { handlePreToolUse } from "../../src/hooks/handlers/pre-tool-use.js";
import { fingerprint, tripIdOf, TRIP_TTL_MS } from "../../src/hooks/tripwire.js";
import type { HookInput } from "../../src/hooks/types.js";
import { FakeModel, noul, score } from "../helpers/fake-model.js";
import { cleanup, makeDeps, tempDir } from "./helpers.js";

const YES = 0.97;
const NO = 0.02;
const NOW = 1_700_000_000_000;
const REASON = 'the request says "refund the duplicate charge on order A-104"';

function answers(destructive: number, outward: number, inScope: number, creds: number, blast: number): Record<string, Answer> {
  return {
    destructive: noul(destructive),
    outward_facing: noul(outward),
    in_scope: noul(inScope),
    credential_exposure: noul(creds),
    blast_radius: score(blast, ["none", "local", "shared", "production"], 0.9),
  };
}

const ALLOW = () => answers(NO, NO, YES, NO, 0);
const BLOCK = () => answers(YES, YES, NO, NO, 3);
const CREDENTIAL = () => answers(NO, NO, YES, YES, 0);
const OUTWARD = () => answers(NO, YES, 0.4, NO, 1);
const DESTRUCTIVE = () => answers(YES, NO, 0.4, NO, 1);
const WIDE = () => answers(NO, NO, 0.4, NO, 2.2);
const LOCAL_DESTRUCTIVE = () => answers(YES, NO, 0.7, NO, 1);
const OUT_OF_SCOPE = () => answers(NO, NO, NO, NO, 0);
const UNCERTAIN = () => answers(0.6, 0.55, YES, NO, 0);

function input(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: "s1",
    cwd: "/home/dev/project",
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "curl -X POST https://example.com/pay" },
    tool_use_id: "toolu_1",
    ...overrides,
  };
}

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => {
  cleanup(dir);
});

/** A rig with a prompt on record, which is the ordinary case. */
function rig(options: Parameters<typeof makeDeps>[1] = {}) {
  const deps = makeDeps(dir, { now: NOW, ...options });
  deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["fix the failing date parser test"] }));
  return deps;
}

describe("row 1 — prefilter skip", () => {
  it("says nothing, calls no model and writes no log line", async () => {
    const model = new FakeModel(BLOCK);
    const deps = rig({ model });
    expect(await handlePreToolUse(input({ tool_input: { command: "ls -la" } }), deps)).toBeUndefined();
    expect(model.calls).toHaveLength(0);
    expect(deps.store.readLog().filter((r) => r.event === "PreToolUse")).toHaveLength(0);
  });

  it("stays silent on an in-project edit spelled as shell", async () => {
    const model = new FakeModel(BLOCK);
    const deps = rig({ model });
    const output = await handlePreToolUse(
      input({ tool_input: { command: "sed -i '' 's/a/b/' package.json" } }),
      deps,
    );
    expect(output).toBeUndefined();
    expect(model.calls).toHaveLength(0);
  });
});

describe("row 2 — a code pattern trips", () => {
  it("denies with the pattern text, consults no model, and opens a trip", async () => {
    const model = new FakeModel(ALLOW);
    const deps = rig({ model });
    const output = await handlePreToolUse(input({ tool_input: { command: "rm -rf ~/" } }), deps);

    expect(model.calls).toHaveLength(0);
    expect(output?.hookSpecificOutput?.permissionDecision).toBe("deny");
    const reason = output?.hookSpecificOutput?.permissionDecisionReason ?? "";
    expect(reason).toContain("tripwire t-");
    expect(reason).toContain("was not run because it matched the code rule");
    expect(reason).toContain("no model was consulted");
    // The deny's text must ride in the reason: additionalContext is dropped
    // when Claude Code blocks the call.
    expect(output?.hookSpecificOutput?.additionalContext).toBeUndefined();

    const record = deps.store.readLog().at(-1);
    expect(record?.decision).toBe("trip");
    expect(record?.source).toBe("pattern");
    expect(record?.channel).toBe("deny");
    expect(record?.emitted).toContain("tripwire");
    const trip = deps.store.liveTrips("s1", NOW)[0];
    expect(trip?.source).toBe("pattern");
    expect(trip?.pattern).toBe("rm-rf-wide");
    expect(trip?.denies).toBe(1);
  });

  it("still trips with no API key at all", async () => {
    const deps = makeDeps(dir, { model: null, config: { apiKey: null }, now: NOW });
    const output = await handlePreToolUse(input({ tool_input: { command: "rm -rf /" } }), deps);
    expect(output?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

describe("row 3 — an affirmed re-issue passes", () => {
  const command = "rm -rf ~/";

  it("passes with an inline marker, with no judging and no model call", async () => {
    const model = new FakeModel(BLOCK);
    const deps = rig({ model });
    await handlePreToolUse(input({ tool_input: { command } }), deps);

    const reissue = await handlePreToolUse(
      input({ tool_input: { command: `${command} # jev:intended ${REASON}` } }),
      deps,
    );
    expect(reissue).toBeUndefined();
    expect(model.calls).toHaveLength(0);

    const record = deps.store.readLog().at(-1);
    expect(record?.decision).toBe("reissue");
    expect(record?.affirmation).toContain("refund the duplicate charge");
    expect(record?.trip_id).toBe(tripIdOf(fingerprint("Bash", { command })));
    // Closed: the trip has been answered.
    expect(deps.store.liveTrips("s1", NOW)).toEqual([]);
    expect(deps.store.readSession("s1").pending_reissues?.[0]?.tool_use_id).toBe("toolu_1");
  });

  it("passes on the strength of an earlier sidecar affirmation, for a Write", async () => {
    const model = new FakeModel(BLOCK);
    const deps = rig({ model });
    const write = input({ tool_name: "Write", tool_input: { file_path: "/etc/hosts", content: "x" } });

    const trip = await handlePreToolUse(write, deps);
    const id = tripIdOf(fingerprint("Write", { file_path: "/etc/hosts", content: "x" }));
    expect(trip?.hookSpecificOutput?.permissionDecisionReason).toContain(`true # jev:intended ${id}:`);

    const sidecar = await handlePreToolUse(
      input({ tool_input: { command: `true # jev:intended ${id}: ${REASON}` } }),
      deps,
    );
    expect(sidecar).toBeUndefined();
    expect(deps.store.readLog().at(-1)?.decision).toBe("affirm");

    expect(await handlePreToolUse(write, deps)).toBeUndefined();
    expect(deps.store.readLog().at(-1)?.decision).toBe("reissue");
    expect(model.calls).toHaveLength(1); // the original judgment, and nothing since
  });

  it("does not honour a marker once the trip has expired", async () => {
    const opened = rig();
    await handlePreToolUse(input({ tool_input: { command: "rm -rf ~/" } }), opened);

    const later = makeDeps(dir, { model: new FakeModel(ALLOW), now: NOW + TRIP_TTL_MS + 1 });
    const output = await handlePreToolUse(
      input({ tool_input: { command: `rm -rf ~/ # jev:intended ${REASON}` } }),
      later,
    );
    // A new trip, not a pass: the marker answered nothing.
    expect(output?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(later.store.readLog().at(-1)?.decision).toBe("trip");
  });
});

describe("row 4 — the same call again, unaffirmed", () => {
  it("denies again with the repeat text and counts the attempt", async () => {
    const deps = rig();
    await handlePreToolUse(input({ tool_input: { command: "rm -rf ~/" } }), deps);
    const again = await handlePreToolUse(input({ tool_input: { command: "rm -rf ~/" } }), deps);

    const reason = again?.hookSpecificOutput?.permissionDecisionReason ?? "";
    expect(again?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(reason).toContain("(attempt 2)");
    expect(reason).toContain("still without a marker");
    const record = deps.store.readLog().at(-1);
    expect(record?.decision).toBe("trip-repeat");
    expect(deps.store.liveTrips("s1", NOW)[0]?.denies).toBe(2);
  });

  it("treats a marker shorter than the minimum as absent, and counts it", async () => {
    const deps = rig();
    await handlePreToolUse(input({ tool_input: { command: "rm -rf ~/" } }), deps);
    const again = await handlePreToolUse(input({ tool_input: { command: "rm -rf ~/ # jev:intended yes" } }), deps);

    expect(again?.hookSpecificOutput?.permissionDecision).toBe("deny");
    const decisions = deps.store.readLog().map((r) => r.decision);
    expect(decisions).toContain("marker-short");
    expect(decisions.at(-1)).toBe("trip-repeat");
  });
});

describe("row 5 — a marker on a call that was never tripped", () => {
  it("is stripped before judging, counted, and changes nothing", async () => {
    const model = new FakeModel(ALLOW);
    const deps = rig({ model });
    const output = await handlePreToolUse(
      input({ tool_input: { command: `curl -X POST https://example.com/pay # jev:intended ${REASON}` } }),
      deps,
    );

    expect(output).toBeUndefined();
    const action = (model.calls[0]?.state as { action: string }).action;
    expect(action).not.toContain("jev:intended");
    expect(action).not.toContain("refund the duplicate charge");
    const decisions = deps.store.readLog().map((r) => r.decision);
    expect(decisions).toContain("marker-unmatched");
  });

  it("records the marker text, so the user can see a reflex forming", async () => {
    const deps = rig({ model: new FakeModel(ALLOW) });
    await handlePreToolUse(
      input({ tool_input: { command: `curl -X POST https://example.com/pay # jev:intended ${REASON}` } }),
      deps,
    );
    const record = deps.store.readLog().find((r) => r.decision === "marker-unmatched");
    expect(record?.affirmation).toContain("refund the duplicate charge");
  });

  it("does not let a marker move the judgment it was stripped from", async () => {
    // The same command, with and without a marker, is judged identically
    // because the marker never reaches the model.
    const bare = new FakeModel(ALLOW);
    await handlePreToolUse(input(), rig({ model: bare }));
    const marked = new FakeModel(ALLOW);
    await handlePreToolUse(
      input({ tool_input: { command: `curl -X POST https://example.com/pay # jev:intended ${REASON}` } }),
      rig({ model: marked }),
    );
    expect((marked.calls[0]?.state as { action: string }).action).toBe(
      (bare.calls[0]?.state as { action: string }).action,
    );
  });
});

describe("row 6 — no model", () => {
  it("fails open on a judge-class call with no key", async () => {
    const deps = makeDeps(dir, { model: null, config: { apiKey: null }, now: NOW });
    expect(await handlePreToolUse(input(), deps)).toBeUndefined();
  });

  it("fails open when the model throws, and logs the error", async () => {
    const model = new FakeModel(() => {
      throw new Error("connection reset");
    });
    const deps = rig({ model });
    expect(await handlePreToolUse(input(), deps)).toBeUndefined();
    const record = deps.store.readLog().at(-1);
    expect(record?.decision).toBe("error");
    expect(record?.error).toContain("connection reset");
  });
});

describe("row 7 — a model block trips", () => {
  it("denies with the model text and opens a model trip", async () => {
    const deps = rig({ model: new FakeModel(BLOCK) });
    const output = await handlePreToolUse(input(), deps);

    const reason = output?.hookSpecificOutput?.permissionDecisionReason ?? "";
    expect(output?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(reason).toContain("this Bash call was not run");
    expect(reason).toContain("The jev classifier scored it");
    expect(reason).toContain("# jev:intended <the sentence of the user's request");
    expect(reason).not.toContain("true # jev:intended"); // Bash needs no sidecar.

    const record = deps.store.readLog().at(-1);
    expect(record?.decision).toBe("trip");
    expect(record?.source).toBe("model");
    expect(record?.signals?.destructive).toBe(YES);
    expect(deps.store.liveTrips("s1", NOW)[0]?.source).toBe("model");
  });

  it("offers the sidecar form for a tool with no comment syntax", async () => {
    const deps = rig({ model: new FakeModel(BLOCK) });
    const output = await handlePreToolUse(
      input({ tool_name: "mcp__stripe__create_refund", tool_input: { charge: "ch_123" } }),
      deps,
    );
    expect(output?.hookSpecificOutput?.permissionDecisionReason).toContain("true # jev:intended t-");
  });
});

describe("row 8 — a policy allow is silence", () => {
  it("says nothing and logs allow", async () => {
    const deps = rig({ model: new FakeModel(ALLOW) });
    expect(await handlePreToolUse(input(), deps)).toBeUndefined();
    const record = deps.store.readLog().at(-1);
    expect(record?.decision).toBe("allow");
    expect(record?.suppressed).toBe("allow");
  });

  it("stays silent on a push the user asked for, wide radius and all", async () => {
    const deps = makeDeps(dir, { model: new FakeModel(() => answers(0.1, YES, 0.81, NO, 2.77)), now: NOW });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["bump the version and push the release"] }));
    expect(await handlePreToolUse(input({ tool_input: { command: "git push" } }), deps)).toBeUndefined();
    expect(deps.store.readLog().at(-1)?.decision).toBe("allow");
  });
});

describe("rows 9 to 12 — notes", () => {
  const rows: [string, () => Record<string, Answer>, string, string][] = [
    ["row 9, credential exposure", CREDENTIAL, "credential", "touching secret values"],
    ["row 10, outward facing", OUTWARD, "outward", "reaching outside this machine"],
    ["row 11, destructive", DESTRUCTIVE, "destructive", "was scored destructive"],
    ["row 12, wide blast radius", WIDE, "wide", "affecting shared or external state"],
  ];

  for (const [name, shape, firm, text] of rows) {
    it(`${name} is a note with no permission decision`, async () => {
      const deps = rig({ model: new FakeModel(shape) });
      const output = await handlePreToolUse(input(), deps);

      expect(output?.hookSpecificOutput?.permissionDecision).toBeUndefined();
      expect(output?.hookSpecificOutput?.additionalContext).toContain("[jev] The Bash call above");
      expect(output?.hookSpecificOutput?.additionalContext).toContain(text);
      const record = deps.store.readLog().at(-1);
      expect(record?.decision).toBe("note");
      expect(record?.channel).toBe("note");
      expect(record?.firm).toContain(firm);
      expect(record?.emitted).toContain("[jev]");
    });
  }

  it("names the call rather than the whole tool input", async () => {
    const deps = rig({ model: new FakeModel(CREDENTIAL) });
    const output = await handlePreToolUse(input({ tool_input: { command: "cat .env" } }), deps);
    expect(output?.hookSpecificOutput?.additionalContext).toContain("(cat .env)");
  });

  it("counts a note against the per-prompt budget", async () => {
    const deps = rig({ model: new FakeModel(CREDENTIAL) });
    await handlePreToolUse(input(), deps);
    expect(deps.store.readSession("s1").notes_this_prompt).toBe(1);
  });
});

describe("rows 13 to 15 — silence with a reason", () => {
  const rows: [string, () => Record<string, Answer>, string][] = [
    ["row 13, a local overwrite the user asked about", LOCAL_DESTRUCTIVE, "local-destructive"],
    ["row 14, a firm out-of-scope reading alone", OUT_OF_SCOPE, "scope"],
    ["row 15, uncertain signals only", UNCERTAIN, "uncertain"],
  ];

  for (const [name, shape, suppressed] of rows) {
    it(`${name} is silent, logged as silent-${suppressed}`, async () => {
      const deps = rig({ model: new FakeModel(shape) });
      expect(await handlePreToolUse(input(), deps)).toBeUndefined();
      const record = deps.store.readLog().at(-1);
      expect(record?.decision).toBe(`silent-${suppressed}`);
      expect(record?.suppressed).toBe(suppressed);
    });
  }
});

describe("rows 16 and 17 — the duplicate check and the cap", () => {
  it("row 16: says the same thing about the same call once", async () => {
    const deps = rig({ model: new FakeModel(CREDENTIAL) });
    expect((await handlePreToolUse(input(), deps))?.hookSpecificOutput?.additionalContext).toBeDefined();
    expect(await handlePreToolUse(input(), deps)).toBeUndefined();
    expect(deps.store.readLog().at(-1)?.suppressed).toBe("dup");
  });

  it("row 16: a different call is still noted", async () => {
    const deps = rig({ model: new FakeModel(CREDENTIAL) });
    await handlePreToolUse(input(), deps);
    const other = await handlePreToolUse(input({ tool_input: { command: "cat .env" } }), deps);
    expect(other?.hookSpecificOutput?.additionalContext).toBeDefined();
  });

  it("row 17: stops at the per-prompt cap", async () => {
    const deps = rig({ model: new FakeModel(CREDENTIAL) });
    deps.store.updateSession("s1", (s) => ({ ...s, notes_this_prompt: MAX_NOTES_PER_PROMPT }));
    expect(await handlePreToolUse(input(), deps)).toBeUndefined();
    expect(deps.store.readLog().at(-1)?.suppressed).toBe("cap");
  });
});

describe("row 18 — gate: strict", () => {
  it("notes a local destructive overwrite that advisory mode keeps to itself", async () => {
    const deps = rig({ model: new FakeModel(LOCAL_DESTRUCTIVE), config: { gate: "strict" } });
    const output = await handlePreToolUse(input(), deps);
    expect(output?.hookSpecificOutput?.additionalContext).toContain("was scored destructive");
    expect(deps.store.readLog().at(-1)?.decision).toBe("note");
  });

  it("judges an ordinary in-project edit, which advisory mode skips", async () => {
    const edit = input({ tool_name: "Write", tool_input: { file_path: "/home/dev/project/src/a.ts", content: "x" } });

    const advisory = new FakeModel(ALLOW);
    expect(await handlePreToolUse(edit, rig({ model: advisory }))).toBeUndefined();
    expect(advisory.calls).toHaveLength(0);

    const strict = new FakeModel(ALLOW);
    await handlePreToolUse(edit, rig({ model: strict, config: { gate: "strict" } }));
    expect(strict.calls).toHaveLength(1);
  });

  it("still says nothing about an uncertain signal on its own", async () => {
    const deps = rig({ model: new FakeModel(UNCERTAIN), config: { gate: "strict" } });
    expect(await handlePreToolUse(input(), deps)).toBeUndefined();
  });
});

describe("row 19 — ask_on_trip", () => {
  it("is the only way a trip becomes a prompt", async () => {
    const deps = rig({ model: new FakeModel(BLOCK), config: { askOnTrip: true } });
    const output = await handlePreToolUse(input(), deps);
    expect(output?.hookSpecificOutput?.permissionDecision).toBe("ask");
    expect(output?.hookSpecificOutput?.permissionDecisionReason).toContain("[jev] tripwire");
    expect(deps.store.readLog().at(-1)?.channel).toBe("ask");
  });

  it("applies to a pattern trip and a repeat too", async () => {
    const deps = rig({ config: { askOnTrip: true } });
    const first = await handlePreToolUse(input({ tool_input: { command: "rm -rf ~/" } }), deps);
    const second = await handlePreToolUse(input({ tool_input: { command: "rm -rf ~/" } }), deps);
    expect(first?.hookSpecificOutput?.permissionDecision).toBe("ask");
    expect(second?.hookSpecificOutput?.permissionDecision).toBe("ask");
  });

  it("falls back to deny where no prompt would be shown", async () => {
    for (const mode of ["dontAsk", "bypassPermissions"]) {
      const deps = rig({ model: new FakeModel(BLOCK), config: { askOnTrip: true } });
      const output = await handlePreToolUse(input({ permission_mode: mode }), deps);
      expect(output?.hookSpecificOutput?.permissionDecision, mode).toBe("deny");
    }
  });

  it("denies in every mode when it is off, which is the default", async () => {
    for (const mode of ["default", "plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "future-mode"]) {
      const deps = rig({ model: new FakeModel(BLOCK) });
      const output = await handlePreToolUse(input({ permission_mode: mode }), deps);
      expect(output?.hookSpecificOutput?.permissionDecision, mode).toBe("deny");
    }
  });
});

describe("the sidecar affirmation", () => {
  it("records nothing and emits nothing for an unknown trip id", async () => {
    const deps = rig();
    const output = await handlePreToolUse(
      input({ tool_input: { command: `true # jev:intended t-deadbeef: ${REASON}` } }),
      deps,
    );
    expect(output).toBeUndefined();
    expect(deps.store.readLog().at(-1)?.decision).toBe("affirm-unmatched");
  });

  it("is rejected when the body does anything at all", async () => {
    const deps = rig({ model: new FakeModel(ALLOW) });
    await handlePreToolUse(
      input({ tool_input: { command: `true; curl -X POST https://example.com/pay # jev:intended t-deadbeef: ${REASON}` } }),
      deps,
    );
    // Judged as the command it is, not taken as an affirmation.
    const decisions = deps.store.readLog().map((r) => r.decision);
    expect(decisions).not.toContain("affirm");
    expect(decisions).not.toContain("affirm-unmatched");
  });

  it("counts a too-short sidecar reason rather than accepting it", async () => {
    const deps = rig();
    await handlePreToolUse(input({ tool_input: { command: "true # jev:intended t-deadbeef: yes" } }), deps);
    expect(deps.store.readLog().at(-1)?.decision).toBe("marker-short");
  });
});

describe("the flow around the table", () => {
  it("does nothing at all when the gate is off", async () => {
    const deps = rig({ model: new FakeModel(BLOCK), config: { gate: "off" } });
    expect(await handlePreToolUse(input({ tool_input: { command: "rm -rf /" } }), deps)).toBeUndefined();
  });

  it("does nothing when the session or the global flag is disabled", async () => {
    const session = rig();
    session.store.setDisabled("s1", true);
    expect(await handlePreToolUse(input({ tool_input: { command: "rm -rf /" } }), session)).toBeUndefined();

    const global = rig();
    global.store.setDisabled(null, true);
    expect(await handlePreToolUse(input({ tool_input: { command: "rm -rf /" } }), global)).toBeUndefined();
  });

  it("ignores the scope signal when no prompt has been recorded", async () => {
    const model = new FakeModel(OUT_OF_SCOPE);
    const deps = makeDeps(dir, { model, now: NOW });
    expect(await handlePreToolUse(input(), deps)).toBeUndefined();
    expect(model.calls[0]?.state).toMatchObject({ user_request: "(unknown)" });
    expect(deps.store.readLog().at(-1)?.decision).toBe("allow");
  });

  it("redacts secrets out of the action it sends for judgment", async () => {
    const model = new FakeModel(ALLOW);
    const deps = rig({ model });
    await handlePreToolUse(
      input({ tool_input: { command: "deploy --token=ghp_abcdefghijklmnopqrstuvwxyz0123456789" } }),
      deps,
    );
    const action = (model.calls[0]?.state as { action: string }).action;
    expect(action).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(action).toContain("[REDACTED]");
  });

  it("passes the working directory and subagent type as context", async () => {
    const model = new FakeModel(ALLOW);
    await handlePreToolUse(input({ agent_type: "Explore" }), rig({ model }));
    const context = (model.calls[0]?.state as { context: string }).context;
    expect(context).toContain("/home/dev/project");
    expect(context).toContain("Explore");
  });

  it("logs the judgment with its signals, policy options and fingerprint", async () => {
    const deps = rig({ model: new FakeModel(CREDENTIAL) });
    await handlePreToolUse(input(), deps);
    const record = deps.store.readLog().at(-1);
    expect(record?.event).toBe("PreToolUse");
    expect(record?.policy).toEqual({
      ignore_scope: false,
      uncertain: "risky-lean",
      lenient_scope: true,
      trust_requested: true,
      corroborate_uncertain: true,
    });
    expect(record?.fingerprint).toBe(fingerprint("Bash", { command: "curl -X POST https://example.com/pay" }));
    expect(record?.tool_use_id).toBe("toolu_1");
  });

  it("records strict mode's options, so the replay can tell the modes apart", async () => {
    const deps = rig({ model: new FakeModel(CREDENTIAL), config: { gate: "strict" } });
    await handlePreToolUse(input(), deps);
    expect(deps.store.readLog().at(-1)?.policy).toMatchObject({ uncertain: "confirm", lenient_scope: false });
  });
});
