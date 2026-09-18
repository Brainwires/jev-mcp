/**
 * UserPromptSubmit: the bookkeeping, and the two thresholds the advisory line
 * is gated on.
 *
 * Both gates changed in 0.5.0, and for the same reason: a Choice's
 * `confidence` and a Score's expectation are not probabilities of a binary
 * event, so neither belongs against the certainty threshold the Nouls use. The
 * kind line gets its own bar; the ambiguity line reads the top level's mass.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Answer } from "../../src/decision/types.js";
import { handleUserPromptSubmit } from "../../src/hooks/handlers/user-prompt-submit.js";
import type { HookInput } from "../../src/hooks/types.js";
import { choice, FakeModel, score } from "../helpers/fake-model.js";
import { cleanup, makeDeps, tempDir } from "./helpers.js";

const PROMPT = "add a daemon to the plugin and wire the http hooks up to it, then measure the latency";

function input(overrides: Partial<HookInput> = {}): HookInput {
  return { session_id: "s1", hook_event_name: "UserPromptSubmit", prompt: PROMPT, ...overrides };
}

/** A kind answer plus an ambiguity Score, with or without level probabilities. */
function answers(confidence: number, ambiguityScore: number, probabilities?: Record<string, number>): Record<string, Answer> {
  const ambiguity = score(ambiguityScore, ["clear", "a detail open", "materially open"], 0.9) as Answer & {
    probabilities?: Record<string, number>;
  };
  if (probabilities !== undefined) ambiguity.probabilities = probabilities;
  return {
    kind: choice("multi_file_implementation", { multi_file_implementation: confidence, other: 1 - confidence }, confidence),
    ambiguity,
  };
}

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => {
  cleanup(dir);
});

describe("the prompt-kind line", () => {
  it("is gated on confidence_threshold rather than on auto_threshold", async () => {
    // Below the choice bar, above the certainty bar: the two now disagree, and
    // the choice bar is the one that decides.
    const model = new FakeModel(() => answers(0.8, 0.2));
    const deps = makeDeps(dir, { model, config: { routePrompts: true, confidenceThreshold: 0.9, autoThreshold: 0.75 } });
    expect(await handleUserPromptSubmit(input(), deps)).toBeUndefined();

    const record = deps.store.readLog().at(-1);
    expect(record?.decision).toBe("low-confidence");
    expect(record?.policy).toEqual({ confidence_threshold: 0.9 });
    expect(record?.thresholds).toEqual({ auto: 0.75, review: 0.6, confidence: 0.9 });
  });

  it("prints the line once the choice bar is met", async () => {
    const model = new FakeModel(() => answers(0.92, 0.2));
    const deps = makeDeps(dir, { model, config: { routePrompts: true, confidenceThreshold: 0.9 } });
    const output = await handleUserPromptSubmit(input(), deps);
    expect(output?.hookSpecificOutput?.additionalContext).toContain("[jev] task kind: multi_file_implementation");
    expect(deps.store.readLog().at(-1)?.decision).toBe("multi_file_implementation");
  });

  it("records kind_confidence on both sides of the bar", async () => {
    for (const confidence of [0.5, 0.97]) {
      const deps = makeDeps(dir, {
        model: new FakeModel(() => answers(confidence, 0.2)),
        config: { routePrompts: true },
      });
      await handleUserPromptSubmit(input(), deps);
      expect(deps.store.readLog().at(-1)?.signals?.kind_confidence, String(confidence)).toBe(confidence);
    }
  });
});

describe("the ambiguity line", () => {
  const line = "[jev] the request is ambiguous";

  it("fires on P(materially open) at auto, not on the expectation", async () => {
    // Expectation 1.5, but split between "clear" and "materially open": two
    // readings that disagree completely. The 0.4.x rule printed the line here.
    const bimodal = new FakeModel(() => answers(0.97, 1.5, { "0": 0.5, "1": 0, "2": 0.5 }));
    const deps = makeDeps(dir, { model: bimodal, config: { routePrompts: true } });
    const output = await handleUserPromptSubmit(input(), deps);
    expect(output?.hookSpecificOutput?.additionalContext).not.toContain(line);
    expect(deps.store.readLog().at(-1)?.signals?.ambiguity_p_high).toBe(0.5);
  });

  it("fires when the top level really does carry the mass", async () => {
    const decided = new FakeModel(() => answers(0.97, 1.9, { "0": 0.02, "1": 0.06, "2": 0.92 }));
    const deps = makeDeps(dir, { model: decided, config: { routePrompts: true } });
    const output = await handleUserPromptSubmit(input(), deps);
    expect(output?.hookSpecificOutput?.additionalContext).toContain(line);
    expect(deps.store.readLog().at(-1)?.signals?.ambiguity_p_high).toBe(0.92);
  });

  it("falls back to the 0.4.x expectation rule when no probabilities came back", async () => {
    const withMass = new FakeModel(() => answers(0.97, 1.8));
    const deps = makeDeps(dir, { model: withMass, config: { routePrompts: true } });
    expect((await handleUserPromptSubmit(input(), deps))?.hookSpecificOutput?.additionalContext).toContain(line);
    expect(deps.store.readLog().at(-1)?.signals?.ambiguity_p_high).toBeUndefined();

    const clear = new FakeModel(() => answers(0.97, 0.4));
    const deps2 = makeDeps(dir, { model: clear, config: { routePrompts: true } });
    expect((await handleUserPromptSubmit(input(), deps2))?.hookSpecificOutput?.additionalContext).not.toContain(line);
  });

  it("logs the expectation alongside the mass, so both are calibratable", async () => {
    const model = new FakeModel(() => answers(0.97, 1.9, { "0": 0.02, "1": 0.06, "2": 0.92 }));
    const deps = makeDeps(dir, { model, config: { routePrompts: true } });
    await handleUserPromptSubmit(input(), deps);
    expect(deps.store.readLog().at(-1)?.signals).toMatchObject({ ambiguity: 1.9, ambiguity_p_high: 0.92 });
  });
});

describe("the bookkeeping half", () => {
  it("records the prompt and resets the note budget with route_prompts off", async () => {
    const model = new FakeModel(() => answers(0.97, 0.2));
    const deps = makeDeps(dir, { model });
    deps.store.updateSession("s1", (s) => ({ ...s, notes_this_prompt: 4, stop_blocks: 1 }));
    expect(await handleUserPromptSubmit(input(), deps)).toBeUndefined();

    const session = deps.store.readSession("s1");
    expect(session.prompts).toEqual([PROMPT]);
    expect(session.notes_this_prompt).toBe(0);
    expect(session.stop_blocks).toBe(0);
    expect(model.calls).toHaveLength(0);
    expect(deps.store.readLog().at(-1)?.decision).toBe("prompt");
  });
});
