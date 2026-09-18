/**
 * The advisory decision table, as one pure function.
 *
 * Rows 7 to 18 of the table in `docs/DESIGN_0.3.md` live here. The rows above
 * them are flow — the prefilter, the tripwire, a missing key — and belong to the
 * handler; the rows below are the two configuration switches.
 *
 * It is pure so that `/jev:calibrate` can replay the whole log through it at
 * other thresholds and get the exact counts, not an estimate.
 *
 * Nothing in here can produce an approval. The three outcomes are "say nothing",
 * "hand the agent a note next to the tool result", and "do not run the call".
 */

import { lean } from "../decision/policy.js";
import type { GateThresholds } from "../decision/types.js";
import { HIGH_BLAST_RADIUS, type ActionDecision, type GateActionSignals } from "../tools/gate-action-core.js";

/** Notes handed to the agent between two user prompts. */
export const MAX_NOTES_PER_PROMPT = 5;
/** A second note about the identical action inside this window is dropped. */
export const NOTE_DEDUPE_TTL_MS = 30 * 60 * 1000;

export type Outcome = "silent" | "note" | "trip";

/**
 * Why a note was not emitted. Every one of these is logged, so the suppression
 * rate is measurable rather than a claim in a README.
 */
export type Suppression = "allow" | "uncertain" | "scope" | "local-destructive" | "dup" | "cap";

/**
 * What drove a note. `scope` is reachable only in `gate: strict`, where a firm
 * out-of-scope reading is a note on its own; in `advisory` it never appears
 * without one of the other three.
 */
export type FirmReason = "credential" | "outward" | "destructive" | "wide" | "scope";

/** Priority order: the first one present writes the note's opening clause. */
export const FIRM_REASONS: readonly FirmReason[] = ["credential", "outward", "destructive", "wide", "scope"];

export interface GateOutcomeInput {
  /** What the deterministic policy in `gate-action-core.ts` returned. */
  decision: ActionDecision;
  signals: GateActionSignals;
  /** Probability-weighted blast-radius level, 0..3. */
  blast_radius: number;
  thresholds: GateThresholds;
  /** `gate: strict`: rows 13 and 14 become notes instead of silence. */
  strict?: boolean | undefined;
  /** This fingerprint was already noted inside `NOTE_DEDUPE_TTL_MS`. */
  duplicate?: boolean | undefined;
  /** Notes already emitted since the last user prompt. */
  notes_this_prompt?: number | undefined;
}

export interface GateOutcomeResult {
  outcome: Outcome;
  /** The firm, uncancelled reasons, in `FIRM_REASONS` order. */
  firm: FirmReason[];
  suppressed?: Suppression;
}

export interface Bands {
  /** The user asked for it and nothing risky fired: `trustRequested`. */
  requested: boolean;
  /** Scope is at least plausible: `in_scope >= review`. */
  requestedish: boolean;
  /** Blast radius 2 of 3 or more: shared, external, or production state. */
  wide: boolean;
  /** A firm out-of-scope reading. */
  outOfScope: boolean;
}

/** The three derived predicates the table is written in terms of. Pure. */
export function bands(
  signals: GateActionSignals,
  blastRadius: number,
  thresholds: GateThresholds,
): Bands {
  const requestedish = signals.in_scope >= thresholds.review;
  return {
    requestedish,
    requested: requestedish && signals.destructive < 0.5 && signals.credential_exposure < 0.5,
    wide: blastRadius >= HIGH_BLAST_RADIUS,
    outOfScope: lean(signals.in_scope, thresholds.auto) === "no",
  };
}

/**
 * Rows 7 to 18. First match wins, exactly as written.
 *
 * The firm tests are `lean(p, auto) === "yes"`, i.e. the model said so rather
 * than leant that way: an uncertain-band signal never produces a note and never
 * appears in one's text, because a note whose content is "the classifier does
 * not know" costs the agent context and tells it nothing.
 */
export function gateOutcome(input: GateOutcomeInput): GateOutcomeResult {
  const { signals, thresholds } = input;
  const auto = thresholds.auto;
  const { requested, requestedish, wide, outOfScope } = bands(signals, input.blast_radius, thresholds);

  const firm: FirmReason[] = [];
  // Row 9.
  if (lean(signals.credential_exposure, auto) === "yes") firm.push("credential");
  // Row 10.
  if (lean(signals.outward_facing, auto) === "yes" && !requested) firm.push("outward");
  // Row 11 — and its complement, row 13, which is silence in `advisory`.
  if (lean(signals.destructive, auto) === "yes" && (!requestedish || wide)) firm.push("destructive");
  // Row 12.
  if (wide && !requested) firm.push("wide");

  // Row 7: the policy already found an out-of-scope, consequential action.
  if (input.decision === "block") return { outcome: "trip", firm };
  // Row 8.
  if (input.decision === "allow") return { outcome: "silent", firm: [], suppressed: "allow" };

  if (firm.length > 0) {
    // Row 16 before row 17: a duplicate was never going to be new information,
    // whether or not the cap had room for it.
    if (input.duplicate === true) return { outcome: "silent", firm, suppressed: "dup" };
    if ((input.notes_this_prompt ?? 0) >= MAX_NOTES_PER_PROMPT) {
      return { outcome: "silent", firm, suppressed: "cap" };
    }
    return { outcome: "note", firm };
  }

  // Row 13: a local overwrite of something the user asked about. Strict mode
  // says so anyway; advisory mode treats it as the edit it is.
  if (lean(signals.destructive, auto) === "yes") {
    return input.strict === true
      ? { outcome: "note", firm: ["destructive"] }
      : { outcome: "silent", firm: ["destructive"], suppressed: "local-destructive" };
  }

  // Row 14: firm out-of-scope with no firm risk signal.
  if (outOfScope) {
    return input.strict === true
      ? { outcome: "note", firm: ["scope"] }
      : { outcome: "silent", firm: [], suppressed: "scope" };
  }

  // Row 15: uncertain signals only. Never a note, in any mode: there is no
  // declarative sentence to write that is not "the classifier is unsure",
  // which the design rules out of note text everywhere.
  return { outcome: "silent", firm: [], suppressed: "uncertain" };
}
