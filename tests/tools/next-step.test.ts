import { describe, expect, it } from "vitest";
import type { Answer } from "../../src/decision/types.js";
import * as nextStepTool from "../../src/tools/next-step.js";
import { choice, FakeModel, noul, testConfig } from "../helpers/fake-model.js";

const T = { auto: 0.85, review: 0.6 };

function policySignals(overrides: Partial<nextStepTool.NextStepSignals> = {}): nextStepTool.NextStepSignals {
  return {
    step_succeeded: 0.5,
    error_is_transient: 0.02,
    goal_complete: 0.02,
    result_relevant: 0.5,
    ...overrides,
  };
}

describe("nextStepPolicy", () => {
  it("passes a confident choice through", () => {
    const result = nextStepTool.nextStepPolicy({
      choice: { choice: "continue", confidence: 0.92 },
      signals: policySignals(),
      attempts: 1,
      thresholds: T,
    });
    expect(result.next).toBe("continue");
  });

  it("asks the user when the choice is below the review threshold", () => {
    const result = nextStepTool.nextStepPolicy({
      choice: { choice: "continue", confidence: 0.3 },
      signals: policySignals({ goal_complete: 0.99 }),
      attempts: 1,
      thresholds: T,
    });
    expect(result.next).toBe("ask_user");
    expect(result.reasons.join(" ")).toContain("below the review threshold");
  });

  it("keeps a medium-confidence choice actionable", () => {
    const result = nextStepTool.nextStepPolicy({
      choice: { choice: "change_approach", confidence: 0.7 },
      signals: policySignals(),
      attempts: 1,
      thresholds: T,
    });
    expect(result.next).toBe("change_approach");
  });

  it("downgrades done to continue unless goal_complete is a confident yes", () => {
    const shaky = nextStepTool.nextStepPolicy({
      choice: { choice: "done", confidence: 0.95 },
      signals: policySignals({ goal_complete: 0.8 }),
      attempts: 1,
      thresholds: T,
    });
    expect(shaky.next).toBe("continue");
    expect(shaky.reasons.join(" ")).toContain("Downgraded `done`");

    const confidentNo = nextStepTool.nextStepPolicy({
      choice: { choice: "done", confidence: 0.95 },
      signals: policySignals({ goal_complete: 0.01 }),
      attempts: 1,
      thresholds: T,
    });
    expect(confidentNo.next).toBe("continue");
  });

  it("allows done when goal_complete gates auto-yes", () => {
    const result = nextStepTool.nextStepPolicy({
      choice: { choice: "done", confidence: 0.95 },
      signals: policySignals({ goal_complete: 0.9 }),
      attempts: 1,
      thresholds: T,
    });
    expect(result.next).toBe("done");
  });

  it("boundary: goal_complete exactly at the auto threshold is enough", () => {
    expect(
      nextStepTool.nextStepPolicy({
        choice: { choice: "done", confidence: 0.95 },
        signals: policySignals({ goal_complete: 0.85 }),
        attempts: 1,
        thresholds: T,
      }).next,
    ).toBe("done");

    expect(
      nextStepTool.nextStepPolicy({
        choice: { choice: "done", confidence: 0.95 },
        signals: policySignals({ goal_complete: 0.8499 }),
        attempts: 1,
        thresholds: T,
      }).next,
    ).toBe("continue");
  });

  it("allows retry only while the error looks transient and the cap is not reached", () => {
    const transient = policySignals({ error_is_transient: 0.95 });

    expect(
      nextStepTool.nextStepPolicy({
        choice: { choice: "retry", confidence: 0.9 },
        signals: transient,
        attempts: 1,
        thresholds: T,
      }).next,
    ).toBe("retry");

    expect(
      nextStepTool.nextStepPolicy({
        choice: { choice: "retry", confidence: 0.9 },
        signals: transient,
        attempts: 2,
        thresholds: T,
      }).next,
    ).toBe("retry");

    const capped = nextStepTool.nextStepPolicy({
      choice: { choice: "retry", confidence: 0.9 },
      signals: transient,
      attempts: 3,
      thresholds: T,
    });
    expect(capped.next).toBe("change_approach");
    expect(capped.reasons.join(" ")).toContain("cap of 3");

    expect(
      nextStepTool.nextStepPolicy({
        choice: { choice: "retry", confidence: 0.9 },
        signals: transient,
        attempts: 9,
        thresholds: T,
      }).next,
    ).toBe("change_approach");
  });

  it("changes approach when the error does not look transient", () => {
    const result = nextStepTool.nextStepPolicy({
      choice: { choice: "retry", confidence: 0.9 },
      signals: policySignals({ error_is_transient: 0.05 }),
      attempts: 1,
      thresholds: T,
    });
    expect(result.next).toBe("change_approach");
    expect(result.reasons.join(" ")).toContain("fail the same way");
  });

  it("changes approach when transience is merely uncertain", () => {
    expect(
      nextStepTool.nextStepPolicy({
        choice: { choice: "retry", confidence: 0.9 },
        signals: policySignals({ error_is_transient: 0.6 }),
        attempts: 1,
        thresholds: T,
      }).next,
    ).toBe("change_approach");
  });

  it("asks the user when the model returns something unrecognised", () => {
    const result = nextStepTool.nextStepPolicy({
      choice: { choice: "give_up", confidence: 0.99 },
      signals: policySignals(),
      attempts: 1,
      thresholds: T,
    });
    expect(result.next).toBe("ask_user");
    expect(result.reasons.join(" ")).toContain("unrecognised");
  });

  it("exposes the retry cap", () => {
    expect(nextStepTool.MAX_RETRY_ATTEMPTS).toBe(3);
  });
});

describe("jev_next_step", () => {
  const answers = (
    picked: string,
    confidence: number,
    signals: Partial<nextStepTool.NextStepSignals> = {},
  ): Record<string, Answer> => {
    const merged = policySignals(signals);
    const probabilities: Record<string, number> = {};
    for (const option of nextStepTool.NEXT_STEPS) probabilities[option] = 0;
    probabilities[picked] = confidence;
    return {
      next: choice(picked, probabilities, confidence),
      step_succeeded: noul(merged.step_succeeded),
      error_is_transient: noul(merged.error_is_transient),
      goal_complete: noul(merged.goal_complete),
      result_relevant: noul(merged.result_relevant),
    };
  };

  it("asks one choice plus four nouls in a single request", async () => {
    const model = new FakeModel(() => answers("continue", 0.9));

    const result = await nextStepTool.run(
      model,
      { goal: "ship the fix", last_step: "ran the tests", result: "3 passed" },
      testConfig,
    );

    expect(model.calls).toHaveLength(1);
    expect(Object.keys(model.calls[0]!.questions).sort()).toEqual([
      "error_is_transient",
      "goal_complete",
      "next",
      "result_relevant",
      "step_succeeded",
    ]);
    expect(result.next).toBe("continue");
    expect(result.confidence).toBe(0.9);
    expect(result.choice_probabilities.continue).toBe(0.9);
    expect(result.signals.step_succeeded).toBe(0.5);
  });

  it("never sends `attempts` to the model", async () => {
    const model = new FakeModel(() => answers("continue", 0.9));
    await nextStepTool.run(
      model,
      { goal: "g", last_step: "s", result: "r", attempts: 7 },
      testConfig,
    );

    expect(model.calls[0]!.state).toEqual({ goal: "g", last_step: "s", result: "r" });
    expect(JSON.stringify(model.calls[0]!)).not.toContain("attempts");
    expect(JSON.stringify(model.calls[0]!)).not.toContain('"7"');
  });

  it("downgrades a premature done", async () => {
    const model = new FakeModel(() => answers("done", 0.95, { goal_complete: 0.55 }));
    const result = await nextStepTool.run(
      model,
      { goal: "fix all failing tests", last_step: "fixed one test", result: "1 passed, 4 failing" },
      testConfig,
    );
    expect(result.next).toBe("continue");
    expect(result.reasons.join(" ")).toContain("Downgraded `done`");
  });

  it("caps retries in code using the caller's attempt count", async () => {
    const model = new FakeModel(() => answers("retry", 0.9, { error_is_transient: 0.97 }));

    const first = await nextStepTool.run(
      model,
      { goal: "g", last_step: "s", result: "429 rate limited", attempts: 1 },
      testConfig,
    );
    expect(first.next).toBe("retry");

    const fourth = await nextStepTool.run(
      model,
      { goal: "g", last_step: "s", result: "429 rate limited", attempts: 4 },
      testConfig,
    );
    expect(fourth.next).toBe("change_approach");
  });

  it("defaults attempts to 1", async () => {
    const model = new FakeModel(() => answers("retry", 0.9, { error_is_transient: 0.97 }));
    const result = await nextStepTool.run(model, { goal: "g", last_step: "s", result: "r" }, testConfig);
    expect(result.next).toBe("retry");
  });

  it("treats a missing choice answer as unactionable", async () => {
    const model = new FakeModel(() => ({}));
    const result = await nextStepTool.run(model, { goal: "g", last_step: "s", result: "r" }, testConfig);
    expect(result.next).toBe("ask_user");
    expect(result.choice_probabilities).toEqual({});
    expect(result.signals.goal_complete).toBe(0.5);
  });

  it("produces output that satisfies its output schema", async () => {
    const model = new FakeModel(() => answers("continue", 0.9));
    const result = await nextStepTool.run(model, { goal: "g", last_step: "s", result: "r" }, testConfig);
    expect(nextStepTool.outputSchema.safeParse(result).success).toBe(true);
  });

  it("validates its input", () => {
    expect(nextStepTool.inputSchema.safeParse({ goal: "g", last_step: "s", result: "r" }).success).toBe(true);
    expect(nextStepTool.inputSchema.safeParse({ goal: "g", last_step: "s" }).success).toBe(false);
    expect(
      nextStepTool.inputSchema.safeParse({ goal: "g", last_step: "s", result: "r", attempts: -1 }).success,
    ).toBe(false);
  });

  it("keeps its description compact", () => {
    expect(nextStepTool.description.length).toBeLessThanOrEqual(1200);
  });
});
