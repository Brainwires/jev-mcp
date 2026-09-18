/**
 * PreToolUse: prefilter routing, decision mapping, and fail-open behavior.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Answer } from "../../src/decision/types.js";
import { explain, handlePreToolUse } from "../../src/hooks/handlers/pre-tool-use.js";
import type { HookInput } from "../../src/hooks/types.js";
import { FakeModel, noul, score } from "../helpers/fake-model.js";
import { cleanup, makeDeps, tempDir } from "./helpers.js";

const YES = 0.97;
const NO = 0.02;

function answers(destructive: number, outward: number, inScope: number, creds: number, blast: number): Record<string, Answer> {
  return {
    destructive: noul(destructive),
    outward_facing: noul(outward),
    in_scope: noul(inScope),
    credential_exposure: noul(creds),
    blast_radius: score(blast, ["none", "local", "shared", "production"], 0.9),
  };
}

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

describe("handlePreToolUse", () => {
  it("returns nothing and calls no model for a read-only command", async () => {
    const model = new FakeModel(() => answers(YES, YES, NO, YES, 3));
    const deps = makeDeps(dir, { model });
    const output = await handlePreToolUse(input({ tool_input: { command: "ls -la" } }), deps);
    expect(output).toBeUndefined();
    expect(model.calls).toHaveLength(0);
  });

  it("asks on a hard pattern without calling the model", async () => {
    const model = new FakeModel(() => answers(NO, NO, YES, NO, 0));
    const deps = makeDeps(dir, { model });
    const output = await handlePreToolUse(input({ tool_input: { command: "rm -rf ~/" } }), deps);
    expect(model.calls).toHaveLength(0);
    expect(output?.hookSpecificOutput?.permissionDecision).toBe("ask");
    expect(output?.hookSpecificOutput?.permissionDecisionReason).toContain("[jev]");
    expect(output?.hookSpecificOutput?.permissionDecisionReason).toContain("not by a model");
  });

  it("does nothing at all when gate_mode is off", async () => {
    const model = new FakeModel(() => answers(NO, NO, YES, NO, 0));
    const deps = makeDeps(dir, { model, config: { gateMode: "off" } });
    expect(await handlePreToolUse(input({ tool_input: { command: "rm -rf /" } }), deps)).toBeUndefined();
  });

  it("does nothing when the session is disabled", async () => {
    const deps = makeDeps(dir);
    deps.store.setDisabled("s1", true);
    expect(await handlePreToolUse(input({ tool_input: { command: "rm -rf /" } }), deps)).toBeUndefined();
  });

  it("does nothing when a global disable flag is set", async () => {
    const deps = makeDeps(dir);
    deps.store.setDisabled(null, true);
    expect(await handlePreToolUse(input({ tool_input: { command: "rm -rf /" } }), deps)).toBeUndefined();
  });

  it("fails open with no api key, even for something it would judge", async () => {
    const deps = makeDeps(dir, { model: null, config: { apiKey: null } });
    expect(await handlePreToolUse(input(), deps)).toBeUndefined();
  });

  it("still applies hard patterns with no api key", async () => {
    const deps = makeDeps(dir, { model: null, config: { apiKey: null } });
    const output = await handlePreToolUse(input({ tool_input: { command: "rm -rf /" } }), deps);
    expect(output?.hookSpecificOutput?.permissionDecision).toBe("ask");
  });

  it("maps a model allow to no output", async () => {
    const model = new FakeModel(() => answers(NO, NO, YES, NO, 0));
    const deps = makeDeps(dir, { model });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["pay the invoice with curl"] }));
    expect(await handlePreToolUse(input(), deps)).toBeUndefined();
    expect(model.calls).toHaveLength(1);
  });

  it("maps confirm to ask", async () => {
    // Destructive and in scope: requested or not, a human confirms it.
    const model = new FakeModel(() => answers(YES, NO, YES, NO, 1));
    const deps = makeDeps(dir, { model });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["wipe the cache"] }));
    const output = await handlePreToolUse(input(), deps);
    expect(output?.hookSpecificOutput?.permissionDecision).toBe("ask");
  });

  describe("requested outward-facing work", () => {
    it("stays silent for an in-scope, non-destructive push, even with a wide blast radius", async () => {
      const model = new FakeModel(() => answers(0.1, YES, 0.81, NO, 2.77));
      const deps = makeDeps(dir, { model });
      deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["bump version and push"] }));
      expect(await handlePreToolUse(input(), deps)).toBeUndefined();
      expect(deps.store.readLog().at(-1)?.decision).toBe("allow");
    });

    it("still asks when the same action leans destructive, exposes credentials, or is weakly in scope", async () => {
      for (const shape of [answers(0.6, YES, 0.81, NO, 2.77), answers(0.1, YES, 0.81, 0.6, 2.77), answers(0.1, YES, 0.55, NO, 2.77)]) {
        const deps = makeDeps(dir, { model: new FakeModel(() => shape) });
        deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["bump version and push"] }));
        const output = await handlePreToolUse(input(), deps);
        expect(output?.hookSpecificOutput?.permissionDecision).toBe("ask");
      }
    });

    it("still asks in strict mode, and when the request is unknown", async () => {
      const model = new FakeModel(() => answers(0.1, YES, 0.81, NO, 2.77));
      const strict = makeDeps(dir, { model, config: { gateMode: "strict" } });
      strict.store.updateSession("s1", (s) => ({ ...s, prompts: ["bump version and push"] }));
      expect((await handlePreToolUse(input(), strict))?.hookSpecificOutput?.permissionDecision).toBe("ask");
      const unknown = makeDeps(tempDir(), { model });
      expect((await handlePreToolUse(input(), unknown))?.hookSpecificOutput?.permissionDecision).toBe("ask");
    });
  });

  describe("scope uncertainty", () => {
    it("does not ask for an uncertain scope with nothing else behind it", async () => {
      const model = new FakeModel(() => answers(0.12, 0.31, 0.37, 0.03, 1.93));
      const deps = makeDeps(dir, { model });
      deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["fix the date parser test"] }));
      expect(await handlePreToolUse(input({ tool_input: { command: "npm install --save-dev date-fns" } }), deps)).toBeUndefined();
    });

    /**
     * 0.2.0 (`corroborateUncertain`): one uncertain signal cannot corroborate
     * another. `outward_facing: 0.6` is a reading the policy would not act on
     * by itself, so it is not evidence that an uncertain scope matters either.
     * Ten of twenty-three day-one escalations were this shape.
     */
    it("does not ask when the only corroboration is a second uncertain signal", async () => {
      const model = new FakeModel(() => answers(0.12, 0.6, 0.37, 0.03, 1));
      const deps = makeDeps(dir, { model });
      deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["fix the date parser test"] }));
      expect(await handlePreToolUse(input(), deps)).toBeUndefined();
      expect(deps.store.readLog().at(-1)?.decision).toBe("allow");
    });

    it("asks when the uncertain scope is corroborated by a wide blast radius", async () => {
      const model = new FakeModel(() => answers(0.12, 0.6, 0.37, 0.03, 2.3));
      const deps = makeDeps(dir, { model });
      deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["fix the date parser test"] }));
      expect((await handlePreToolUse(input(), deps))?.hookSpecificOutput?.permissionDecision).toBe("ask");
    });

    it("asks when the uncertain scope is corroborated by a firm risk signal", async () => {
      const model = new FakeModel(() => answers(YES, NO, 0.37, NO, 1));
      const deps = makeDeps(dir, { model });
      deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["fix the date parser test"] }));
      expect((await handlePreToolUse(input(), deps))?.hookSpecificOutput?.permissionDecision).toBe("ask");
    });

    it("asks on a firm out-of-scope reading by itself", async () => {
      const model = new FakeModel(() => answers(NO, NO, NO, NO, 0));
      const deps = makeDeps(dir, { model });
      deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["fix the date parser test"] }));
      expect((await handlePreToolUse(input(), deps))?.hookSpecificOutput?.permissionDecision).toBe("ask");
    });
  });

  describe("auto mode", () => {
    const confirmGrade = () => answers(YES, NO, YES, NO, 1);

    it("advises instead of asking, and emits no permission decision at all", async () => {
      const deps = makeDeps(dir, { model: new FakeModel(confirmGrade) });
      deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["wipe the cache"] }));
      const output = await handlePreToolUse(input({ permission_mode: "auto" }), deps);
      expect(output?.hookSpecificOutput?.permissionDecision).toBeUndefined();
      expect(output?.hookSpecificOutput?.additionalContext).toContain("[jev] Advisory");
      expect(deps.store.readLog().at(-1)?.decision).toBe("advise");
      expect(deps.store.readSession("s1").pending_asks ?? []).toHaveLength(0);
    });

    it("asks when auto_mode is set to ask", async () => {
      const deps = makeDeps(dir, { model: new FakeModel(confirmGrade), config: { autoMode: "ask" } });
      deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["wipe the cache"] }));
      const output = await handlePreToolUse(input({ permission_mode: "auto" }), deps);
      expect(output?.hookSpecificOutput?.permissionDecision).toBe("ask");
    });

    it("only applies to auto mode", async () => {
      const deps = makeDeps(dir, { model: new FakeModel(confirmGrade) });
      deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["wipe the cache"] }));
      for (const mode of ["default", "plan", "acceptEdits", "dontAsk", "bypassPermissions"]) {
        const output = await handlePreToolUse(input({ permission_mode: mode }), deps);
        expect(output?.hookSpecificOutput?.permissionDecision, mode).toBe("ask");
      }
    });

    it("still asks for a hard-coded pattern", async () => {
      const deps = makeDeps(dir);
      const output = await handlePreToolUse(input({ permission_mode: "auto", tool_input: { command: "rm -rf ~/" } }), deps);
      expect(output?.hookSpecificOutput?.permissionDecision).toBe("ask");
    });
  });

  it("maps block to ask in an interactive mode", async () => {
    const model = new FakeModel(() => answers(YES, YES, NO, NO, 3));
    const deps = makeDeps(dir, { model });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["run the tests"] }));
    for (const mode of ["default", "plan", "acceptEdits", "auto"]) {
      const output = await handlePreToolUse(input({ permission_mode: mode }), deps);
      expect(output?.hookSpecificOutput?.permissionDecision, mode).toBe("ask");
    }
  });

  it("maps block to deny only where no one would see an ask", async () => {
    const model = new FakeModel(() => answers(YES, YES, NO, NO, 3));
    const deps = makeDeps(dir, { model });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["run the tests"] }));
    for (const mode of ["dontAsk", "bypassPermissions"]) {
      const output = await handlePreToolUse(input({ permission_mode: mode }), deps);
      expect(output?.hookSpecificOutput?.permissionDecision, mode).toBe("deny");
      expect(output?.hookSpecificOutput?.permissionDecisionReason).toMatch(/explicit confirmation|narrower/);
    }
  });

  it("escalates a hard pattern to deny in an unattended mode", async () => {
    const deps = makeDeps(dir);
    const output = await handlePreToolUse(
      input({ permission_mode: "bypassPermissions", tool_input: { command: "rm -rf /" } }),
      deps,
    );
    expect(output?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("ignores the scope signal when no prompt has been recorded", async () => {
    const model = new FakeModel(() => answers(NO, NO, NO, NO, 0));
    const deps = makeDeps(dir, { model });
    // in_scope leans "no", which would force at least a confirm — but with an
    // unknown request the signal is meaningless and must not fire.
    expect(await handlePreToolUse(input(), deps)).toBeUndefined();
    expect(model.calls[0]?.state).toMatchObject({ user_request: "(unknown)" });
  });

  it("uses the scope signal once a prompt is known", async () => {
    const model = new FakeModel(() => answers(NO, NO, NO, NO, 0));
    const deps = makeDeps(dir, { model });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["update the README"] }));
    const output = await handlePreToolUse(input(), deps);
    expect(output?.hookSpecificOutput?.permissionDecision).toBe("ask");
  });

  it("stays silent for an uncertain risk signal with nothing corroborating it", async () => {
    for (const shape of [answers(0.4, NO, YES, NO, 0), answers(0.6, NO, YES, NO, 0)]) {
      const deps = makeDeps(dir, { model: new FakeModel(() => shape) });
      deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["do the thing"] }));
      expect(await handlePreToolUse(input(), deps)).toBeUndefined();
      expect(deps.store.readLog().at(-1)?.decision).toBe("allow");
    }
  });

  it("asks once a second risk signal corroborates the uncertain one", async () => {
    const deps = makeDeps(dir, { model: new FakeModel(() => answers(0.6, 0.55, YES, NO, 0)) });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["do the thing"] }));
    const output = await handlePreToolUse(input(), deps);
    expect(output?.hookSpecificOutput?.permissionDecision).toBe("ask");
    expect(output?.hookSpecificOutput?.permissionDecisionReason).toContain("unsure");
  });

  it("treats any uncertain signal as a confirm in strict mode", async () => {
    const model = new FakeModel(() => answers(0.4, NO, YES, NO, 0));
    const deps = makeDeps(dir, { model, config: { gateMode: "strict" } });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["do the thing"] }));
    const output = await handlePreToolUse(input(), deps);
    expect(output?.hookSpecificOutput?.permissionDecision).toBe("ask");
  });

  it("judges an ordinary in-project edit only in strict mode", async () => {
    const edit = input({ tool_name: "Write", tool_input: { file_path: "/home/dev/project/src/a.ts", content: "x" } });

    const standard = new FakeModel(() => answers(NO, NO, YES, NO, 0));
    expect(await handlePreToolUse(edit, makeDeps(dir, { model: standard }))).toBeUndefined();
    expect(standard.calls).toHaveLength(0);

    const strict = new FakeModel(() => answers(NO, NO, YES, NO, 0));
    await handlePreToolUse(edit, makeDeps(dir, { model: strict, config: { gateMode: "strict" } }));
    expect(strict.calls).toHaveLength(1);
  });

  it("redacts secrets out of the action it sends for judgment", async () => {
    const model = new FakeModel(() => answers(NO, NO, YES, NO, 0));
    const deps = makeDeps(dir, { model });
    await handlePreToolUse(
      input({ tool_input: { command: "deploy --token=ghp_abcdefghijklmnopqrstuvwxyz0123456789" } }),
      deps,
    );
    const action = (model.calls[0]?.state as { action: string }).action;
    expect(action).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(action).toContain("[REDACTED]");
  });

  it("fails open when the model throws, and logs the error", async () => {
    const model = new FakeModel(() => {
      throw new Error("connection reset");
    });
    const deps = makeDeps(dir, { model });
    expect(await handlePreToolUse(input(), deps)).toBeUndefined();
    const log = deps.store.readLog();
    expect(log.at(-1)?.decision).toBe("error");
    expect(log.at(-1)?.error).toContain("connection reset");
  });

  it("logs the judgment with its signals and policy options", async () => {
    const model = new FakeModel(() => answers(YES, YES, YES, NO, 1));
    const deps = makeDeps(dir, { model });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["send it"] }));
    await handlePreToolUse(input(), deps);
    const record = deps.store.readLog().at(-1);
    expect(record?.event).toBe("PreToolUse");
    expect(record?.decision).toBe("ask");
    expect(record?.signals?.outward_facing).toBe(YES);
    expect(record?.policy).toEqual({
      ignore_scope: false,
      uncertain: "risky-lean",
      lenient_scope: true,
      trust_requested: true,
      corroborate_uncertain: true,
    });
    expect(record?.tool_use_id).toBe("toolu_1");
  });

  it("remembers an escalated call so PostToolUse can correlate it", async () => {
    const deps = makeDeps(dir);
    await handlePreToolUse(input({ tool_input: { command: "rm -rf /" } }), deps);
    expect(deps.store.readSession("s1").pending_asks?.[0]?.tool_use_id).toBe("toolu_1");
  });

  it("does not log a line for a skipped call", async () => {
    const deps = makeDeps(dir);
    await handlePreToolUse(input({ tool_input: { command: "ls" } }), deps);
    expect(deps.store.readLog()).toHaveLength(0);
  });

  it("passes the working directory and subagent type as context", async () => {
    const model = new FakeModel(() => answers(NO, NO, YES, NO, 0));
    const deps = makeDeps(dir, { model });
    await handlePreToolUse(input({ agent_type: "Explore" }), deps);
    const context = (model.calls[0]?.state as { context: string }).context;
    expect(context).toContain("/home/dev/project");
    expect(context).toContain("Explore");
  });
});

describe("explain", () => {
  it("names the reasons and the probabilities that drove them", () => {
    const text = explain(["The action destroys or overwrites existing data."], { destructive: 0.96, in_scope: 0.1 });
    expect(text.startsWith("[jev] ")).toBe(true);
    expect(text).toContain("destroys");
    expect(text).toContain("destructive 0.96");
    expect(text).not.toContain("in_scope");
  });

  it("stays readable when nothing is above a half", () => {
    expect(explain(["Something."], { destructive: 0.1 })).toBe("[jev] Something. Approve only if this is what you wanted.");
  });
});
