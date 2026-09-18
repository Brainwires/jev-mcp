/**
 * Stop: the truth table, and the loop protections around it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  endsWithQuestion,
  handleStop,
  MIN_MESSAGE_CHARS,
  stopPolicy,
  unfinishedClause,
  UNFINISHED_REASONS,
  type StopSignals,
} from "../../src/hooks/handlers/stop.js";
import { BANNED_IMPERATIVES } from "../../src/hooks/wording.js";
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

/**
 * The seven Nouls, driven through the one the 0.4.x compound stood in for.
 *
 * `unfinished` lands on `says_part_not_done` — the literal question closest to
 * what `admits_unfinished` was trying to ask — so every case below still reads
 * as the case it was written as.
 */
function answers(
  complete: number,
  unfinished: number,
  asks: number,
  addresses: number,
  verified = 0.02,
): Record<string, ReturnType<typeof noul>> {
  return {
    claims_complete: noul(complete),
    says_part_not_done: noul(unfinished),
    says_step_deferred: noul(NO),
    says_check_failing: noul(NO),
    asks_user: noul(asks),
    addresses_request: noul(addresses),
    claims_verified: noul(verified),
  };
}

/** The seven, as `StopSignals`, for the policy truth table. */
function signals(overrides: Partial<StopSignals> = {}): StopSignals {
  return {
    claims_complete: NO,
    says_part_not_done: NO,
    says_step_deferred: NO,
    says_check_failing: NO,
    asks_user: NO,
    addresses_request: YES,
    claims_verified: NO,
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

describe("stopPolicy truth table", () => {
  const cases: [Partial<StopSignals>, boolean, string][] = [
    [{ claims_complete: YES }, false, "a clean done is never second-guessed"],
    [{ says_part_not_done: YES }, true, "says a part of the requested work is not done"],
    [{ says_step_deferred: YES }, true, "defers a requested step"],
    [{ says_check_failing: YES }, true, "reports a check still failing"],
    [{ says_part_not_done: YES, says_step_deferred: YES }, true, "two of the three at once"],
    [{ says_part_not_done: YES, asks_user: YES }, false, "says work remains but is waiting on the user"],
    [{ says_part_not_done: YES, asks_user: MAYBE }, false, "unsure whether it is waiting on the user"],
    [{ says_part_not_done: MAYBE }, false, "unsure whether work remains"],
    [{ addresses_request: NO }, false, "nothing fired"],
    [{ claims_complete: YES, says_part_not_done: YES }, true, "claims done and also names a gap"],
    [{ claims_complete: YES, says_part_not_done: YES, asks_user: YES }, false, "claims done, names a gap, asks"],
    [{ says_part_not_done: 0.84 }, false, "just below the threshold"],
    [{ says_part_not_done: 0.86 }, true, "just above the threshold"],
    [{ says_step_deferred: 0.84, says_check_failing: 0.84 }, false, "two near misses do not add up"],
    [{ says_part_not_done: YES, asks_user: 0.16 }, false, "asks_user just above 1 - auto"],
    [{ says_part_not_done: YES, asks_user: 0.15 }, true, "asks_user exactly at 1 - auto"],
  ];

  for (const [overrides, expected, label] of cases) {
    it(`${expected ? "block" : "allow"}: ${label}`, () => {
      expect(stopPolicy(signals(overrides), AUTO).block).toBe(expected);
    });
  }

  it("names the Noul that fired, so the block text can say which it was", () => {
    expect(stopPolicy(signals({ says_part_not_done: YES }), AUTO).unfinished_by).toBe("says_part_not_done");
    expect(stopPolicy(signals({ says_step_deferred: YES }), AUTO).unfinished_by).toBe("says_step_deferred");
    expect(stopPolicy(signals({ says_check_failing: YES }), AUTO).unfinished_by).toBe("says_check_failing");
    // Two fired: the stronger one gets to speak.
    expect(
      stopPolicy(signals({ says_part_not_done: 0.9, says_check_failing: 0.99 }), AUTO).unfinished_by,
    ).toBe("says_check_failing");
    expect(stopPolicy(signals(), AUTO).unfinished_by).toBeUndefined();
  });

  it("explains itself when it blocks", () => {
    const result = stopPolicy(signals({ says_part_not_done: YES }), AUTO);
    expect(result.reasons.join(" ")).toContain("names a part of the requested work as not done");
  });

  /**
   * A stop block is agent-facing text like a note or a trip, so it is held to
   * the same rule: imperative "system command" phrasing in injected context
   * trips Claude's own injection defenses.
   */
  it("says what it found without giving orders, in all three shapes", () => {
    for (const reason of UNFINISHED_REASONS) {
      const clause = unfinishedClause(reason, 0.94);
      const text = `[jev] Your final message ${clause} and is not waiting on the user. Continue with the remaining work, or state explicitly what blocks you.`;
      const match = BANNED_IMPERATIVES.exec(text);
      expect(match?.[0], `"${match?.[0]}" in: ${text}`).toBeUndefined();
    }
  });
});

/**
 * The nine live offers, as fixtures.
 *
 * Every one of these is a shape that scored `admits_unfinished` at 0.85 or
 * more in the first live week, and every one of them is an *offer* — extra work
 * on top of what was asked for. Only `asks_user` stopped them being wrong
 * blocks, and one record sat a threshold tick from one. Split into three
 * literal Nouls with the offer written into `not_for`, `says_part_not_done`
 * reads them low; and even if it did not, `asks_user` is high on all nine.
 *
 * The messages are what the shapes actually look like. The signals are the
 * fixture: this is a test of the policy, not of the classifier.
 */
describe("the nine offer shapes stay allow", () => {
  const OFFERS = [
    "Done — the three handlers log the new field and the tests pass. Say the word and I'll ship it.",
    "That's the parser fixed and green. I can also add a changelog entry if you want one.",
    "All four files are updated. Want me to run the full suite before you commit?",
    "The migration script is in place and tested. Happy to wire it into CI too — your call.",
    "Everything you asked for is done. I could extract the shared helper as well, if that's useful.",
    "Fix is in, type-check is clean. Let me know if you'd like the same treatment for the other module.",
    "The README section now matches the code. I can do the same pass on the docs folder if you like.",
    "Both hooks are wired up and passing. Shall I bump the version, or is that yours to do?",
    "That's the refactor complete. I can follow it with the dead-code sweep whenever you want.",
  ];

  for (const [index, message] of OFFERS.entries()) {
    it(`offer ${index + 1} is allowed: ${message.slice(0, 40)}…`, () => {
      // An offer is not requested work left undone, and it asks the user.
      const result = stopPolicy(
        signals({ claims_complete: YES, says_part_not_done: 0.08, asks_user: 0.93 }),
        AUTO,
      );
      expect(result.block, message).toBe(false);
      expect(result.unfinished_by, message).toBeUndefined();
    });
  }

  /**
   * The record that was one tick away. `admits_unfinished` 0.96 with
   * `asks_user` 0.24 blocked only because 0.24 > 0.15; at `auto` 0.80 it would
   * have been a wrong block. With the split, `says_part_not_done` is what has
   * to be high, and on an offer it is not.
   */
  it("does not depend on asks_user to get the near-miss record right", () => {
    for (const auto of [0.75, 0.8, 0.85, 0.9]) {
      expect(
        stopPolicy(signals({ claims_complete: YES, says_part_not_done: 0.08, asks_user: 0.24 }), auto).block,
        `auto ${auto}`,
      ).toBe(false);
    }
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
    // The block names the Noul that fired rather than a compound verdict.
    expect(output?.reason).toContain("names a part of the requested work as not done (p=0.97)");
    expect(output?.reason).toContain("is not waiting on the user");
    expect(deps.store.readLog().at(-1)?.unfinished_by).toBe("says_part_not_done");
  });

  it("names a deferral or a failing check when that is what fired", () => {
    const deferred = new FakeModel(() => ({
      ...answers(NO, NO, NO, YES),
      says_step_deferred: noul(YES),
    }));
    const depsA = makeDeps(dir, { model: deferred });
    withPrompt(depsA);
    return handleStop(input(), depsA).then(async (output) => {
      expect(output?.reason).toContain("defers a requested step");

      const failing = new FakeModel(() => ({
        ...answers(NO, NO, NO, YES),
        says_check_failing: noul(YES),
      }));
      const depsB = makeDeps(dir, { model: failing });
      depsB.store.updateSession("s2", (s) => ({ ...s, prompts: ["fix the failing parser test"] }));
      const second = await handleStop(input({ session_id: "s2" }), depsB);
      expect(second?.reason).toContain("reports a check still failing");
    });
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
      "request",
    ]);
    expect(model.calls[0]!.state).toMatchObject({
      request: { latest: "refactor the parser and migrate the call sites", previous: [] },
    });
  });
});

/**
 * A subagent's final message is about the task its parent gave it, not about
 * the user's last prompt — the user never saw the task. `SubagentStop` is also
 * the event that says the task is finished with.
 */
describe("handleStop inside a subagent", () => {
  const TASK = "find every call site of resolveDataDir and list them with line numbers";

  it("judges the final message against the captured task, then drops it", async () => {
    const model = new FakeModel(() => answers(YES, NO, NO, YES));
    const deps = makeDeps(dir, { model });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["why is the data directory wrong after an upgrade?"] }));
    deps.store.rememberSubagentTask("s1", { agent_type: "Explore", prompt: TASK, ts: deps.now() }, deps.now());

    await handleStop(input({ hook_event_name: "SubagentStop", agent_type: "Explore" }), deps);
    expect(model.calls[0]!.state).toMatchObject({ request: { latest: TASK } });
    expect(deps.store.readLog().at(-1)?.subagent).toBe("Explore");
    // Consumed: the subagent has stopped, so its task is nobody's request now.
    expect(deps.store.readSession("s1").subagent_tasks).toBeUndefined();
  });

  it("falls back to the user's prompts when no task was captured", async () => {
    const model = new FakeModel(() => answers(YES, NO, NO, YES));
    const deps = makeDeps(dir, { model });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["refactor the parser"] }));
    await handleStop(input({ hook_event_name: "SubagentStop", agent_type: "Explore" }), deps);
    expect(model.calls[0]!.state).toMatchObject({ request: { latest: "refactor the parser" } });
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
    expect(output?.reason).toContain("names a part of the requested work as not done");
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
      "asks_user",
      "claims_complete",
      "claims_verified",
      "says_check_failing",
      "says_part_not_done",
      "says_step_deferred",
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
