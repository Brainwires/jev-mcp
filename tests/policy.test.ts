import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  gate,
  gateChoice,
  gateNoul,
  gateScore,
  isUncertain,
  lean,
  levelMass,
  resolveThresholds,
  topLevel,
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

/**
 * A level set's mass is the probability of a binary event, which is what makes
 * it a thing `auto`/`review` can be applied to. The expectation is not: a
 * bimodal answer averages to a level the model never chose.
 */
describe("levelMass", () => {
  const scored = (probabilities?: Record<string, number>): Pick<ScoreAnswer, "probabilities"> =>
    probabilities === undefined ? {} : { probabilities };

  it("sums the named levels", () => {
    expect(levelMass(scored({ "0": 0.1, "1": 0.2, "2": 0.5, "3": 0.2 }), [2, 3])).toBeCloseTo(0.7);
    expect(levelMass(scored({ "0": 0.1, "1": 0.9 }), [0])).toBeCloseTo(0.1);
  });

  it("is undefined when the answer carries no probabilities at all", () => {
    expect(levelMass(scored(), [2, 3])).toBeUndefined();
    expect(levelMass(scored({}), [2, 3])).toBeUndefined();
  });

  it("treats a level the answer never mentioned as contributing nothing", () => {
    expect(levelMass(scored({ "0": 0.4, "1": 0.6 }), [2, 3])).toBe(0);
    expect(levelMass(scored({ "1": 0.6, "3": 0.4 }), [2, 3])).toBeCloseTo(0.4);
  });

  it("ignores a value that is not a finite number", () => {
    expect(levelMass(scored({ "2": Number.NaN, "3": 0.3 }), [2, 3])).toBeCloseTo(0.3);
  });

  it("stays inside 0..1 even when the distribution does not", () => {
    expect(levelMass(scored({ "2": 0.9, "3": 0.9 }), [2, 3])).toBe(1);
  });
});

describe("topLevel", () => {
  it("is the argmax when there are probabilities, ties going to the lower level", () => {
    expect(topLevel({ score: 2.1, probabilities: { "0": 0.1, "2": 0.6, "3": 0.3 } })).toEqual({ level: 2, p: 0.6 });
    expect(topLevel({ score: 1.5, probabilities: { "1": 0.5, "2": 0.5 } })).toEqual({ level: 1, p: 0.5 });
  });

  it("reads an expectation as a split over the two adjacent levels", () => {
    expect(topLevel({ score: 2.83 }).level).toBe(3);
    expect(topLevel({ score: 2.83 }).p).toBeCloseTo(0.83);
    expect(topLevel({ score: 2.4 })).toMatchObject({ level: 2 });
    expect(topLevel({ score: 2.4 }).p).toBeCloseTo(0.6);
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
