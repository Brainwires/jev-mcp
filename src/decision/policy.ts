/**
 * Deterministic policy over decision-model answers.
 *
 * Jev returns calibrated probabilities; it does not return decisions. Turning a
 * probability into an action is code's job, and it lives here so it is testable
 * without a network and identical everywhere it is used.
 *
 * Everything in this module is a pure function of its arguments.
 */

import type { ChoiceAnswer, Gate, GateThresholds, ScoreAnswer } from "./types.js";

/** Conservative defaults. Override per deployment; see `src/config.ts`. */
export const DEFAULT_THRESHOLDS: GateThresholds = { auto: 0.85, review: 0.6 };

/**
 * Map a 0..1 certainty onto an action band.
 *
 * Boundaries are inclusive at the bottom of each band: `value === auto` gates
 * `"auto"`, `value === review` gates `"review"`.
 */
export function gate(value: number, thresholds: GateThresholds = DEFAULT_THRESHOLDS): Gate {
  if (Number.isNaN(value)) return "escalate";
  if (value >= thresholds.auto) return "auto";
  if (value >= thresholds.review) return "review";
  return "escalate";
}

/** Choice answers gate on `confidence` — how peaked the distribution is. */
export function gateChoice(answer: ChoiceAnswer, thresholds: GateThresholds = DEFAULT_THRESHOLDS): Gate {
  return gate(answer.confidence, thresholds);
}

/** Score answers gate on `confidence`, not on the score value itself. */
export function gateScore(answer: ScoreAnswer, thresholds: GateThresholds = DEFAULT_THRESHOLDS): Gate {
  return gate(answer.confidence, thresholds);
}

/**
 * Sum of the probabilities of the named levels, or `undefined` when the answer
 * carries none.
 *
 * A level set's mass is the probability of a binary event — "the answer is one
 * of these levels" — which is the same kind of quantity a Noul returns, so
 * `auto`/`review` apply to it directly. The expectation (`score`) is not: a
 * bimodal 0.5/0.5 over levels 0 and 2 averages to the middle level the model
 * never chose, which is why policy reads mass rather than rounding.
 *
 * A level the answer does not mention contributes nothing. An empty
 * distribution reads as absent rather than as zero, because zero would say
 * "certainly not these levels" about an answer that said nothing at all.
 */
export function levelMass(
  answer: Pick<ScoreAnswer, "probabilities">,
  levels: readonly number[],
): number | undefined {
  const probabilities = answer.probabilities;
  if (probabilities === null || typeof probabilities !== "object") return undefined;
  const keys = Object.keys(probabilities);
  if (keys.length === 0) return undefined;
  let mass = 0;
  for (const level of levels) {
    const value = probabilities[String(level)];
    if (typeof value === "number" && Number.isFinite(value)) mass += value;
  }
  // Four places: the provider reports two, and a sum such as 0.83 + 0.1 must
  // not reach the log as 0.9299999999999999.
  return Math.round(Math.min(1, Math.max(0, mass)) * 1e4) / 1e4;
}

/** The level a Score answer picked, and how much of the distribution sat on it. */
export interface TopLevel {
  level: number;
  /** Probability of that level. */
  p: number;
}

/**
 * The most likely level of a Score answer.
 *
 * With `probabilities` it is the argmax, ties going to the lower level. Without
 * them, the expectation is read the way the docs' no-interpolation rule allows:
 * a score of 2.83 is a distribution over the two adjacent levels 2 and 3, so
 * level 3 carries 0.83. That is the mass the expectation implies rather than an
 * invented number, and it is all an answer without probabilities can say.
 */
export function topLevel(answer: Pick<ScoreAnswer, "score" | "probabilities">): TopLevel {
  const probabilities = answer.probabilities;
  if (probabilities !== null && typeof probabilities === "object") {
    let best: TopLevel | undefined;
    for (const [key, value] of Object.entries(probabilities)) {
      const level = Number(key);
      if (!Number.isInteger(level) || typeof value !== "number" || !Number.isFinite(value)) continue;
      if (best === undefined || value > best.p || (value === best.p && level < best.level)) {
        best = { level, p: value };
      }
    }
    if (best !== undefined) return best;
  }
  const score = typeof answer.score === "number" && Number.isFinite(answer.score) ? answer.score : 0;
  const level = Math.round(score);
  return { level, p: Math.min(1, Math.max(0, 1 - Math.abs(score - level))) };
}

/** Which side of a Noul the probability falls on. `p >= 0.5` reads as yes. */
export type NoulDirection = "yes" | "no";

export interface NoulGate {
  /** Band for the certainty, not for P(yes). */
  gate: Gate;
  /** `max(p, 1 - p)`: how far from 0.5 the answer is, on a 0.5..1 scale. */
  certainty: number;
  /** The side the answer falls on. */
  direction: NoulDirection;
  /** Alias of `direction`, named for the way tool output reads. */
  verdict: NoulDirection;
}

/**
 * Gate a Noul two-sided. A Noul has no `confidence`; a confident *no* is 0.02
 * and a confident *yes* is 0.98, so the certainty is the distance from 0.5 and
 * the side is reported separately. Note that `certainty` can never fall below
 * 0.5, so a `review` threshold under 0.5 makes `escalate` unreachable here.
 */
export function gateNoul(noul: number, thresholds: GateThresholds = DEFAULT_THRESHOLDS): NoulGate {
  const certainty = Math.max(noul, 1 - noul);
  const direction: NoulDirection = noul >= 0.5 ? "yes" : "no";
  return { gate: gate(certainty, thresholds), certainty, direction, verdict: direction };
}

/** A Noul read as a three-valued signal rather than a boolean. */
export type Lean = "yes" | "no" | "uncertain";

/**
 * Which way a Noul leans, with an explicit uncertain band.
 *
 * `p >= auto` leans yes, `p <= 1 - auto` leans no, and everything between is
 * uncertain — the band where the model is telling you it does not know. Policy
 * that must not guess should treat `"uncertain"` like the unsafe answer.
 */
export function lean(noul: number, auto: number = DEFAULT_THRESHOLDS.auto): Lean {
  if (Number.isNaN(noul)) return "uncertain";
  if (noul >= auto) return "yes";
  if (noul <= 1 - auto) return "no";
  return "uncertain";
}

/** True when the Noul sits in the band where neither side is established. */
export function isUncertain(noul: number, auto: number = DEFAULT_THRESHOLDS.auto): boolean {
  return lean(noul, auto) === "uncertain";
}

/** Merge a partial per-call override onto the configured defaults. */
export function resolveThresholds(
  defaults: GateThresholds,
  override?: { auto?: number | undefined; review?: number | undefined },
): GateThresholds {
  return {
    auto: override?.auto ?? defaults.auto,
    review: override?.review ?? defaults.review,
  };
}
