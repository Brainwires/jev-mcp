import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  gate,
  gateChoice,
  gateNoul,
  gateScore,
  isUncertain,
  lean,
  resolveThresholds,
} from "../src/decision/policy.js";
import type { ChoiceAnswer, ScoreAnswer } from "../src/decision/types.js";

const T = { auto: 0.85, review: 0.6 };

describe("gate", () => {
  it("maps each band", () => {
    expect(gate(0.99, T)).toBe("auto");
    expect(gate(0.7, T)).toBe("review");
    expect(gate(0.1, T)).toBe("escalate");
  });

  it("is inclusive at the bottom of each band", () => {
    expect(gate(0.85, T)).toBe("auto");
    expect(gate(0.8499999, T)).toBe("review");
    expect(gate(0.6, T)).toBe("review");
    expect(gate(0.5999999, T)).toBe("escalate");
  });

  it("handles the 0 and 1 extremes", () => {
    expect(gate(0, T)).toBe("escalate");
    expect(gate(1, T)).toBe("auto");
  });

  it("escalates on NaN rather than silently passing", () => {
    expect(gate(Number.NaN, T)).toBe("escalate");
  });

  it("defaults to the documented thresholds", () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ auto: 0.85, review: 0.6 });
    expect(gate(0.86)).toBe("auto");
    expect(gate(0.61)).toBe("review");
  });
});

describe("gateChoice / gateScore", () => {
  it("gates on confidence, not on the value", () => {
    const answer: ChoiceAnswer = {
      type: "choice",
      choice: "a",
      probabilities: { a: 0.9, b: 0.1 },
      confidence: 0.4,
    };
    expect(gateChoice(answer, T)).toBe("escalate");

    const scored: ScoreAnswer = { type: "score", score: 2.9, legend: {}, confidence: 0.9 };
    expect(gateScore(scored, T)).toBe("auto");
  });
});

describe("gateNoul", () => {
  it("is two-sided: a confident no gates auto", () => {
    expect(gateNoul(0.02, T)).toEqual({ gate: "auto", certainty: 0.98, direction: "no", verdict: "no" });
  });

  it("a confident yes gates auto", () => {
    expect(gateNoul(0.97, T)).toEqual({
      gate: "auto",
      certainty: 0.97,
      direction: "yes",
      verdict: "yes",
    });
  });

  it("0.5 is maximally uncertain", () => {
    const result = gateNoul(0.5, T);
    expect(result.certainty).toBe(0.5);
    expect(result.gate).toBe("escalate");
  });

  it("boundaries: exactly at auto on both sides", () => {
    expect(gateNoul(0.85, T).gate).toBe("auto");
    expect(gateNoul(0.15, T).gate).toBe("auto");
    expect(gateNoul(0.84, T).gate).toBe("review");
    expect(gateNoul(0.16, T).gate).toBe("review");
  });

  it("splits direction at 0.5", () => {
    expect(gateNoul(0.5, T).direction).toBe("yes");
    expect(gateNoul(0.4999, T).direction).toBe("no");
  });
});

describe("lean", () => {
  it("has a three-valued band", () => {
    expect(lean(0.9, 0.85)).toBe("yes");
    expect(lean(0.85, 0.85)).toBe("yes");
    expect(lean(0.15, 0.85)).toBe("no");
    expect(lean(0.1, 0.85)).toBe("no");
    expect(lean(0.5, 0.85)).toBe("uncertain");
    expect(lean(0.84, 0.85)).toBe("uncertain");
    expect(lean(0.16, 0.85)).toBe("uncertain");
  });

  it("isUncertain agrees with lean", () => {
    expect(isUncertain(0.5)).toBe(true);
    expect(isUncertain(0.99)).toBe(false);
    expect(isUncertain(0.01)).toBe(false);
  });
});

describe("resolveThresholds", () => {
  it("keeps defaults when no override is given", () => {
    expect(resolveThresholds(T)).toEqual(T);
    expect(resolveThresholds(T, {})).toEqual(T);
  });

  it("applies a partial override", () => {
    expect(resolveThresholds(T, { auto: 0.95 })).toEqual({ auto: 0.95, review: 0.6 });
    expect(resolveThresholds(T, { review: 0.2 })).toEqual({ auto: 0.85, review: 0.2 });
  });
});
