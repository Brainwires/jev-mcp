/**
 * The advisory decision table as a truth table.
 *
 * Every row of section 1 of `docs/DESIGN_0.3.md` that `gateOutcome` owns — 7
 * through 18 — has a case here, named by its row number, plus the two
 * properties that have to hold whatever the rows say:
 *
 *   note  ⇒ at least one firm reason (nothing is said with nothing to say)
 *   ¬silent ⇒ the policy did not return `allow`
 */

import { describe, expect, it } from "vitest";
import { bands, gateOutcome, MAX_NOTES_PER_PROMPT, type GateOutcomeInput } from "../../src/hooks/advisory.js";
import { gateActionPolicy, type GateActionSignals } from "../../src/tools/gate-action-core.js";

const THRESHOLDS = { auto: 0.85, review: 0.6 };
const YES = 0.97;
const NO = 0.02;
const UNSURE = 0.6;

function signals(destructive: number, outward: number, inScope: number, creds: number): GateActionSignals {
  return { destructive, outward_facing: outward, in_scope: inScope, credential_exposure: creds };
}

function run(overrides: Partial<GateOutcomeInput> & Pick<GateOutcomeInput, "decision" | "signals">): ReturnType<
  typeof gateOutcome
> {
  return gateOutcome({ blast_radius: 0, thresholds: THRESHOLDS, ...overrides });
}

describe("bands", () => {
  it("reads requested, requestedish, wide and out-of-scope the way the table does", () => {
    expect(bands({ signals: signals(NO, YES, 0.7, NO), blast_radius: 2.5, thresholds: THRESHOLDS })).toEqual({
      requested: true,
      requestedish: true,
      wide: true,
      outOfScope: false,
    });
    // `requested` needs more than plausible scope: nothing destructive, no
    // credentials. `requestedish` is the weaker reading that only knows scope.
    expect(bands({ signals: signals(0.6, YES, 0.7, NO), blast_radius: 1, thresholds: THRESHOLDS })).toMatchObject({
      requested: false,
      requestedish: true,
    });
    expect(bands({ signals: signals(NO, NO, NO, NO), blast_radius: 1, thresholds: THRESHOLDS })).toMatchObject({
      outOfScope: true,
      requestedish: false,
    });
  });

  /**
   * 0.5.0: `wide` reads the mass of the top two blast levels when the answer
   * carries probabilities, and the expectation only when it does not. The two
   * disagree exactly where the release intends them to — a 1.95 expectation
   * with 0.9 of its mass on levels 2 and 3 is wide; the same expectation spread
   * between levels 1 and 2 is not.
   */
  it("reads wide off the level mass when there is one, and the expectation when there is not", () => {
    const narrow = { signals: signals(NO, NO, 0.3, NO), blast_radius: 2.4, thresholds: THRESHOLDS };
    expect(bands(narrow).wide, "expectation only").toBe(true);
    expect(bands({ ...narrow, blast_p_high: 0.6 }).wide, "mass below auto").toBe(false);
    expect(bands({ ...narrow, blast_radius: 1.95, blast_p_high: 0.9 }).wide, "mass at auto").toBe(true);
  });

  /** A target the user literally named is not out of scope, whatever the score. */
  it("lets mentions_target veto a firm out-of-scope reading", () => {
    const input = { signals: signals(NO, NO, NO, NO), blast_radius: 1, thresholds: THRESHOLDS };
    expect(bands(input).outOfScope).toBe(true);
    expect(bands({ ...input, mentions_target: 0.95 }).outOfScope).toBe(false);
    // Below the firm bar it vetoes nothing: an uncertain match is not a match.
    expect(bands({ ...input, mentions_target: 0.6 }).outOfScope).toBe(true);
  });
});

describe("gateOutcome", () => {
  it("row 7: a policy block is a trip", () => {
    const outcome = run({ decision: "block", signals: signals(YES, NO, NO, NO), blast_radius: 2 });
    expect(outcome.outcome).toBe("trip");
    expect(outcome.suppressed).toBeUndefined();
  });

  it("row 8: a policy allow is silence, recorded as such", () => {
    expect(run({ decision: "allow", signals: signals(NO, NO, YES, NO) })).toEqual({
      outcome: "silent",
      firm: [],
      suppressed: "allow",
    });
  });

  it("row 9: firm credential exposure is a note, even on requested work", () => {
    const outcome = run({ decision: "confirm", signals: signals(NO, NO, YES, YES) });
    expect(outcome.outcome).toBe("note");
    expect(outcome.firm).toEqual(["credential"]);
  });

  it("row 10: firm outward-facing is a note unless the user asked for it", () => {
    expect(run({ decision: "confirm", signals: signals(NO, YES, NO, NO) }).firm).toEqual(["outward"]);
    // Requested, nothing destructive, no credentials: reach is not a reason.
    expect(run({ decision: "confirm", signals: signals(NO, YES, 0.7, NO) })).toMatchObject({
      outcome: "silent",
      suppressed: "uncertain",
    });
  });

  it("row 11: firm destructive is a note when scope is thin or the radius is wide", () => {
    expect(run({ decision: "confirm", signals: signals(YES, NO, 0.3, NO) }).firm).toEqual(["destructive"]);
    expect(
      run({ decision: "confirm", signals: signals(YES, NO, 0.7, NO), blast_radius: 2.4 }).firm,
    ).toEqual(["destructive", "wide"]);
  });

  it("row 12: a wide blast radius on unrequested work is a note by itself", () => {
    const outcome = run({ decision: "confirm", signals: signals(NO, NO, 0.3, NO), blast_radius: 2.1 });
    expect(outcome.outcome).toBe("note");
    expect(outcome.firm).toEqual(["wide"]);
  });

  it("row 13: a local overwrite the user asked about is silent in advisory mode", () => {
    expect(run({ decision: "confirm", signals: signals(YES, NO, 0.7, NO), blast_radius: 1 })).toEqual({
      outcome: "silent",
      firm: ["destructive"],
      suppressed: "local-destructive",
    });
  });

  it("row 14: a firm out-of-scope reading with no risk signal is silent", () => {
    expect(run({ decision: "confirm", signals: signals(NO, NO, NO, NO) })).toEqual({
      outcome: "silent",
      firm: [],
      suppressed: "scope",
    });
  });

  it("row 15: uncertain signals only are never a note", () => {
    expect(run({ decision: "confirm", signals: signals(UNSURE, UNSURE, UNSURE, NO) })).toEqual({
      outcome: "silent",
      firm: [],
      suppressed: "uncertain",
    });
  });

  it("row 16: a duplicate fingerprint is silent, with the firm reasons still recorded", () => {
    const outcome = run({ decision: "confirm", signals: signals(NO, NO, YES, YES), duplicate: true });
    expect(outcome).toEqual({ outcome: "silent", firm: ["credential"], suppressed: "dup" });
  });

  it("row 17: the per-prompt cap is a suppression, not a silence with no reason", () => {
    expect(
      run({ decision: "confirm", signals: signals(NO, NO, YES, YES), notes_this_prompt: MAX_NOTES_PER_PROMPT }),
    ).toMatchObject({ outcome: "silent", suppressed: "cap" });
    expect(
      run({ decision: "confirm", signals: signals(NO, NO, YES, YES), notes_this_prompt: MAX_NOTES_PER_PROMPT - 1 }),
    ).toMatchObject({ outcome: "note" });
  });

  it("row 16 wins over row 17: a duplicate was not going to be new information", () => {
    expect(
      run({
        decision: "confirm",
        signals: signals(NO, NO, YES, YES),
        duplicate: true,
        notes_this_prompt: MAX_NOTES_PER_PROMPT,
      }).suppressed,
    ).toBe("dup");
  });

  describe("row 18: strict", () => {
    it("turns a local destructive overwrite into a note", () => {
      expect(
        run({ decision: "confirm", signals: signals(YES, NO, 0.7, NO), blast_radius: 1, strict: true }),
      ).toEqual({ outcome: "note", firm: ["destructive"] });
    });

    it("turns a firm out-of-scope reading into a note", () => {
      expect(run({ decision: "confirm", signals: signals(NO, NO, NO, NO), strict: true })).toEqual({
        outcome: "note",
        firm: ["scope"],
      });
    });

    /**
     * Deliberately NOT a note, and the one place this implementation reads the
     * design against itself: row 18 says rows 13 to 15 become notes in strict
     * mode, and section 3 says an uncertain-band signal never produces a note
     * and never appears in a note's text. Section 3 wins, because the note row
     * 15 would produce has nothing declarative to say — "the classifier is
     * unsure" is the sentence the design rules out everywhere else.
     */
    it("still says nothing about uncertain signals alone", () => {
      expect(run({ decision: "confirm", signals: signals(UNSURE, UNSURE, UNSURE, NO), strict: true })).toEqual({
        outcome: "silent",
        firm: [],
        suppressed: "uncertain",
      });
    });

    it("leaves a policy allow alone", () => {
      expect(run({ decision: "allow", signals: signals(NO, NO, YES, NO), strict: true }).outcome).toBe("silent");
    });
  });

  /**
   * §9: the 0.3 rows, re-asserted with `blast_p_high` present.
   *
   * The 0.5.0 `wide` rule changes what the table is told, never what the table
   * does with it. A row whose outcome moved when the same reading arrives as a
   * level mass instead of an expectation would mean otherwise.
   */
  describe("the rows hold when wide arrives as a level mass", () => {
    const rows: [string, GateActionSignals, number, number, string][] = [
      ["row 9, credential", signals(NO, NO, YES, YES), 0, 0.01, "note"],
      ["row 10, outward", signals(NO, YES, NO, NO), 1, 0.02, "note"],
      ["row 11, destructive, thin scope", signals(YES, NO, 0.3, NO), 1, 0.03, "note"],
      ["row 11, destructive, wide", signals(YES, NO, 0.7, NO), 2.4, 0.97, "note"],
      ["row 12, wide alone", signals(NO, NO, 0.3, NO), 2.1, 0.93, "note"],
      ["row 13, local destructive", signals(YES, NO, 0.7, NO), 1, 0.02, "silent"],
      ["row 14, out of scope alone", signals(NO, NO, NO, NO), 0, 0.01, "silent"],
      ["row 15, uncertain only", signals(UNSURE, UNSURE, UNSURE, NO), 0, 0.01, "silent"],
    ];

    for (const [label, s, blast, pHigh, expected] of rows) {
      it(`${label} is still ${expected}`, () => {
        const outcome = run({ decision: "confirm", signals: s, blast_radius: blast, blast_p_high: pHigh });
        expect(outcome.outcome).toBe(expected);
        // And the same reading without the mass, which is the legacy path.
        expect(run({ decision: "confirm", signals: s, blast_radius: blast }).outcome).toBe(expected);
      });
    }
  });

  /**
   * The two push records from the first day of real use: `outward_facing` 0.97
   * and a blast radius near 2.8, which looks firm until you notice the user
   * asked for them. `trustRequested` is what keeps them silent, and it has to
   * keep doing so now that `wide` reads a level mass that is all but certain.
   */
  it("stays silent on the two requested pushes from day one, mass rule and all", () => {
    for (const in_scope of [0.78, 0.81]) {
      const push: GateActionSignals = {
        destructive: 0.1,
        outward_facing: 0.97,
        in_scope,
        credential_exposure: 0.02,
      };
      const shared = { signals: push, blast_radius: 2.8, blast_p_high: 0.99, thresholds: THRESHOLDS };
      const policy = gateActionPolicy({
        ...shared,
        options: { uncertain: "risky-lean", lenientScope: true, trustRequested: true, corroborateUncertain: true },
      });
      expect(policy.decision, `in_scope ${in_scope}`).toBe("allow");
      expect(gateOutcome({ ...shared, decision: policy.decision }).outcome, `in_scope ${in_scope}`).toBe("silent");
    }
  });

  it("joins several firm reasons into one note, in priority order", () => {
    const outcome = run({
      decision: "confirm",
      signals: signals(YES, YES, 0.3, YES),
      blast_radius: 3,
    });
    expect(outcome.outcome).toBe("note");
    expect(outcome.firm).toEqual(["credential", "outward", "destructive", "wide"]);
  });

  describe("properties, over the whole signal space", () => {
    const LEVELS = [0, 0.2, 0.5, 0.6, 0.86, 1];
    const BLASTS = [0, 1, 1.9, 2, 3];
    const cases: GateOutcomeInput[] = [];
    for (const destructive of LEVELS) {
      for (const outward of LEVELS) {
        for (const inScope of LEVELS) {
          for (const creds of LEVELS) {
            for (const blast of BLASTS) {
              for (const decision of ["allow", "confirm", "block"] as const) {
                for (const strict of [false, true]) {
                  cases.push({
                    decision,
                    signals: signals(destructive, outward, inScope, creds),
                    blast_radius: blast,
                    thresholds: THRESHOLDS,
                    strict,
                  });
                }
              }
            }
          }
        }
      }
    }

    it(`covers ${cases.length} combinations`, () => {
      expect(cases.length).toBeGreaterThan(5000);
    });

    /** Collected rather than asserted per case, so a failure names the input. */
    function violations(holds: (input: GateOutcomeInput, outcome: ReturnType<typeof gateOutcome>) => boolean): string[] {
      const bad: string[] = [];
      for (const input of cases) {
        const outcome = gateOutcome(input);
        if (!holds(input, outcome)) bad.push(`${JSON.stringify(input)} -> ${JSON.stringify(outcome)}`);
      }
      return bad.slice(0, 5);
    }

    it("never emits a note with no firm reason behind it", () => {
      expect(violations((_input, outcome) => outcome.outcome !== "note" || outcome.firm.length > 0)).toEqual([]);
    });

    it("never says anything about a call the policy allowed", () => {
      expect(
        violations(
          (input, outcome) =>
            input.decision !== "allow" || (outcome.outcome === "silent" && outcome.suppressed === "allow"),
        ),
      ).toEqual([]);
    });

    it("trips only on a policy block", () => {
      expect(violations((input, outcome) => outcome.outcome !== "trip" || input.decision === "block")).toEqual([]);
    });

    it("always records why, when it stays silent", () => {
      expect(violations((_input, outcome) => outcome.outcome !== "silent" || outcome.suppressed !== undefined)).toEqual(
        [],
      );
    });

    it("is silent or a note on everything the policy merely wanted confirmed", () => {
      expect(
        violations((input, outcome) => input.decision !== "confirm" || outcome.outcome !== "trip"),
      ).toEqual([]);
    });
  });
});
