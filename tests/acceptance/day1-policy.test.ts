/**
 * Acceptance test against the first day of real use.
 *
 * `tests/fixtures/day1-decisions.jsonl` holds the 32 judged PreToolUse records
 * from the day 0.1.x was first run against live work: signals and policy
 * options only, subjects stripped. Ten of the twenty-three escalations that day
 * were a single uncertain signal on an ordinary in-project edit, which is what
 * sections C.1 and C.2 of `docs/DESIGN_0.2.md` set out to fix.
 *
 * Two things have to be true at once, and they pull in opposite directions:
 *
 *  (a) every record with a *firm* signal still escalates — the fix must not buy
 *      quiet by going blind;
 *  (b) at most two of the uncertain-only records escalate — otherwise nothing
 *      was fixed.
 *
 * The recorded `decision` on each line is NOT the expectation: those decisions
 * came from older policy versions (thirteen of the lines predate `lenientScope`
 * and `trustRequested` entirely). Firm versus uncertain-only is classified from
 * the signals, per the spec.
 *
 * The counts are in the test names on purpose. A noise fix whose effect nobody
 * can see is a noise fix nobody can argue with.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lean } from "../../src/decision/policy.js";
import { gateOutcome } from "../../src/hooks/advisory.js";
import {
  gateActionPolicy,
  HIGH_BLAST_RADIUS,
  type GateActionPolicyOptions,
  type GateActionSignals,
} from "../../src/tools/gate-action-core.js";

const THRESHOLDS = { auto: 0.85, review: 0.6 };

interface Record_ {
  decision: string;
  signals: GateActionSignals & { blast_radius: number };
  policy: { ignore_scope: boolean; uncertain: string; lenient_scope?: boolean; trust_requested?: boolean };
}

const FIXTURE = fileURLToPath(new URL("../fixtures/day1-decisions.jsonl", import.meta.url));

const RECORDS: Record_[] = readFileSync(FIXTURE, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as Record_);

/** What standard mode sends to the policy in 0.2.0. */
const STANDARD_0_2: GateActionPolicyOptions = {
  uncertain: "risky-lean",
  lenientScope: true,
  trustRequested: true,
  corroborateUncertain: true,
};

/**
 * Standard mode with the noise fix switched off, which is exactly what 0.1.4
 * sent: the honest "before" for `corroborateUncertain`.
 */
const WITHOUT_CORROBORATION: GateActionPolicyOptions = {
  uncertain: "risky-lean",
  lenientScope: true,
  trustRequested: true,
};

function replay(record: Record_, options: GateActionPolicyOptions): string {
  const { blast_radius, ...signals } = record.signals;
  return gateActionPolicy({
    signals,
    blast_radius,
    thresholds: THRESHOLDS,
    // Every fixture line was logged with a known user request.
    options: { ...options, ignoreScope: record.policy.ignore_scope },
  }).decision;
}

const escalates = (record: Record_, options: GateActionPolicyOptions): boolean =>
  replay(record, options) !== "allow";

/** What 0.3.0's advisory mode would have done with one logged record. */
function advisoryOutcome(record: Record_): "silent" | "note" | "trip" {
  const { blast_radius, ...signals } = record.signals;
  const policy = gateActionPolicy({
    signals,
    blast_radius,
    thresholds: THRESHOLDS,
    options: { ...STANDARD_0_2, ignoreScope: record.policy.ignore_scope },
  });
  return gateOutcome({ decision: policy.decision, signals, blast_radius, thresholds: THRESHOLDS }).outcome;
}

/**
 * Is this record one that must still escalate?
 *
 * A firm signal — any risk signal at or above `auto`, a firm out-of-scope
 * reading, or a blast radius of 2 or more — *unless* the action is one the user
 * asked for, which `requested` defines as `in_scope >= review` with neither
 * `destructive` nor `credential_exposure` leaning yes.
 *
 * That exception is the point of `trustRequested`, not a loophole in it. Reach
 * and radius are not reasons to prompt about work the user requested; a risk
 * signal always is, which is why `destructive` and `credential_exposure` at or
 * above 0.5 take the exception away.
 *
 * `requested` is spelled out here rather than imported so the criterion cannot
 * drift silently with the policy it is judging.
 */
export function isRequested(signals: Record_["signals"]): boolean {
  return (
    signals.in_scope >= THRESHOLDS.review &&
    signals.destructive < 0.5 &&
    signals.credential_exposure < 0.5
  );
}

export function hasFirmSignal(record: Record_): boolean {
  const { destructive, outward_facing, in_scope, credential_exposure, blast_radius } = record.signals;
  if (isRequested(record.signals)) return false;
  if (Math.max(destructive, outward_facing, credential_exposure) >= THRESHOLDS.auto) return true;
  if (lean(in_scope, THRESHOLDS.auto) === "no") return true;
  return blast_radius >= HIGH_BLAST_RADIUS;
}

const FIRM = RECORDS.filter(hasFirmSignal);
const UNCERTAIN_ONLY = RECORDS.filter((record) => !hasFirmSignal(record));

/** What the day actually did, as logged. */
const RECORDED = RECORDS.filter((r) => r.decision !== "allow").length;
const RECORDED_UNCERTAIN = UNCERTAIN_ONLY.filter((r) => r.decision !== "allow").length;

const BEFORE = RECORDS.filter((r) => escalates(r, WITHOUT_CORROBORATION)).length;
const AFTER = RECORDS.filter((r) => escalates(r, STANDARD_0_2)).length;
const FIRM_AFTER = FIRM.filter((r) => escalates(r, STANDARD_0_2)).length;
const UNCERTAIN_AFTER = UNCERTAIN_ONLY.filter((r) => escalates(r, STANDARD_0_2)).length;
const UNCERTAIN_BEFORE = UNCERTAIN_ONLY.filter((r) => escalates(r, WITHOUT_CORROBORATION)).length;

/** At most this many uncertain-only records may still escalate. */
const UNCERTAIN_BUDGET = 2;

describe(`day-one replay: ${RECORDS.length} judged records, ${RECORDED} escalations as logged, ${AFTER} under 0.2.0`, () => {
  it(`has ${FIRM.length} records with a firm signal and ${UNCERTAIN_ONLY.length} uncertain-only`, () => {
    expect(RECORDS).toHaveLength(32);
    expect(FIRM.length + UNCERTAIN_ONLY.length).toBe(RECORDS.length);
    expect(FIRM.length).toBeGreaterThan(0);
    expect(UNCERTAIN_ONLY.length).toBeGreaterThan(0);
  });

  it(`(a) still escalates every firm-signal record: ${FIRM_AFTER}/${FIRM.length}`, () => {
    const missed = FIRM.filter((record) => !escalates(record, STANDARD_0_2)).map((record) => record.signals);
    // Named in the failure, because "one of thirteen" is not actionable.
    expect(missed).toEqual([]);
    expect(FIRM_AFTER).toBe(FIRM.length);
  });

  /**
   * The two records this criterion is most easily misread on.
   *
   * Both are push-shaped: `outward_facing` 0.97 and a blast radius near 2.8,
   * which looks firm until you notice `in_scope` 0.78-0.81 with nothing
   * destructive and no credential exposure. The user asked for these. Staying
   * silent on them is `trustRequested` doing its job — the option was added
   * after a user was prompted for a push they had requested — and an earlier
   * pass at this release wrongly made them escalate by raising the scope bar to
   * `auto`, which would have made the option unreachable in practice.
   */
  it("stays silent on the two requested-push records, by index", () => {
    for (const index of [4, 12]) {
      const record = RECORDS[index]!;
      expect(isRequested(record.signals), `record ${index} should read as requested`).toBe(true);
      expect(hasFirmSignal(record), `record ${index} should not count as firm`).toBe(false);
      expect(replay(record, STANDARD_0_2), `record ${index} (${JSON.stringify(record.signals)})`).toBe("allow");
    }
  });

  it("still escalates a push once anything destructive or credential-touching appears", () => {
    const push = RECORDS[4]!;
    for (const override of [{ destructive: 0.6 }, { credential_exposure: 0.7 }, { in_scope: 0.4 }]) {
      const signals = { ...push.signals, ...override };
      expect(
        replay({ ...push, signals }, STANDARD_0_2),
        JSON.stringify(override),
      ).not.toBe("allow");
    }
  });

  it(`(b) escalates at most ${UNCERTAIN_BUDGET} uncertain-only records: ${UNCERTAIN_AFTER}/${UNCERTAIN_ONLY.length} (was ${UNCERTAIN_BEFORE})`, () => {
    const fired = UNCERTAIN_ONLY.filter((record) => escalates(record, STANDARD_0_2)).map((record) => record.signals);
    expect(fired.length).toBeLessThanOrEqual(UNCERTAIN_BUDGET);
    expect(UNCERTAIN_AFTER).toBeLessThan(UNCERTAIN_BEFORE);
  });

  it("is a strict improvement: nothing that used to escalate on a firm signal stopped", () => {
    for (const record of FIRM) {
      if (escalates(record, WITHOUT_CORROBORATION)) {
        expect(escalates(record, STANDARD_0_2), JSON.stringify(record.signals)).toBe(true);
      }
    }
  });

  it("before/after counts, so a regression is visible in the diff", () => {
    expect({
      records: RECORDS.length,
      firm: FIRM.length,
      uncertain_only: UNCERTAIN_ONLY.length,
      escalations_as_logged: RECORDED,
      escalations_without_corroboration: BEFORE,
      escalations_0_2_0: AFTER,
      firm_escalated_0_2_0: FIRM_AFTER,
      uncertain_only_escalated_as_logged: RECORDED_UNCERTAIN,
      uncertain_only_escalated_without_corroboration: UNCERTAIN_BEFORE,
      uncertain_only_escalated_0_2_0: UNCERTAIN_AFTER,
    }).toMatchInlineSnapshot(`
      {
        "escalations_0_2_0": 11,
        "escalations_as_logged": 24,
        "escalations_without_corroboration": 21,
        "firm": 11,
        "firm_escalated_0_2_0": 11,
        "records": 32,
        "uncertain_only": 21,
        "uncertain_only_escalated_0_2_0": 0,
        "uncertain_only_escalated_as_logged": 13,
        "uncertain_only_escalated_without_corroboration": 10,
      }
    `);
  });

  it("strict mode is unchanged by the noise fix: it still asks about every uncertain signal", () => {
    const strict: GateActionPolicyOptions = { uncertain: "confirm" };
    const strictEscalations = RECORDS.filter((r) => escalates(r, strict)).length;
    expect(strictEscalations).toBeGreaterThanOrEqual(AFTER);
  });

  /**
   * 0.3.0: the same day, through the advisory table.
   *
   * The 0.2.0 numbers above are about *escalations* — every one of which was a
   * permission prompt. This is the number that matters now: how much of that
   * day would have reached the user at all (none of it) and how much would have
   * reached Claude, and as what.
   *
   * The counts are in the test name on purpose. A release whose whole claim is
   * "no prompts, fewer interruptions" has to state the size of the change
   * somewhere a regression would show up in the diff.
   */
  it(`24 escalations as logged → ${
    RECORDS.filter((r) => advisoryOutcome(r) === "note").length
  } notes + ${RECORDS.filter((r) => advisoryOutcome(r) === "trip").length} trips, 0 prompts`, () => {
    const counts = {
      notes: 0,
      trips: 0,
      silent_allow: 0,
      silent_local_destructive: 0,
      silent_scope: 0,
      silent_uncertain: 0,
    };
    for (const record of RECORDS) {
      const { blast_radius, ...signals } = record.signals;
      const policy = gateActionPolicy({
        signals,
        blast_radius,
        thresholds: THRESHOLDS,
        options: { ...STANDARD_0_2, ignoreScope: record.policy.ignore_scope },
      });
      const outcome = gateOutcome({
        decision: policy.decision,
        signals,
        blast_radius,
        thresholds: THRESHOLDS,
      });
      if (outcome.outcome === "note") counts.notes += 1;
      else if (outcome.outcome === "trip") counts.trips += 1;
      else if (outcome.suppressed === "allow") counts.silent_allow += 1;
      else if (outcome.suppressed === "local-destructive") counts.silent_local_destructive += 1;
      else if (outcome.suppressed === "scope") counts.silent_scope += 1;
      else if (outcome.suppressed === "uncertain") counts.silent_uncertain += 1;
    }

    expect(counts).toMatchInlineSnapshot(`
      {
        "notes": 9,
        "silent_allow": 21,
        "silent_local_destructive": 1,
        "silent_scope": 0,
        "silent_uncertain": 0,
        "trips": 1,
      }
    `);
    // Every record is accounted for, so a row that silently stopped matching
    // cannot hide inside the totals.
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(RECORDS.length);
  });

  /**
   * 0.5.0's `mentions_target` veto, measured on the only trip in the fixture.
   *
   * The records predate the question, so the number is synthetic and the test
   * is about the veto's *effect size*, not about what Jev would say: a firm
   * "the user named this target" turns the day's one trip into a note, and
   * changes nothing else. A veto that also moved a silent record, or that left
   * the trip standing, would show up here.
   */
  it("the mentions_target veto turns the day's one trip into a note: 1 trip → 0, 9 notes → 10", () => {
    const counts = { notes: 0, trips: 0, silent: 0 };
    for (const record of RECORDS) {
      const { blast_radius, ...signals } = record.signals;
      // Only the record that actually tripped gets the synthetic answer, which
      // is the point: the veto is a downgrade of a trip, never of a silence.
      const tripped = advisoryOutcome(record) === "trip";
      const vetoed = tripped ? { mentions_target: 0.95 } : {};
      const policy = gateActionPolicy({
        signals,
        blast_radius,
        ...vetoed,
        thresholds: THRESHOLDS,
        options: { ...STANDARD_0_2, ignoreScope: record.policy.ignore_scope },
      });
      const outcome = gateOutcome({
        decision: policy.decision,
        signals,
        blast_radius,
        ...vetoed,
        thresholds: THRESHOLDS,
      });
      if (outcome.outcome === "note") counts.notes += 1;
      else if (outcome.outcome === "trip") counts.trips += 1;
      else counts.silent += 1;
    }

    expect(counts).toEqual({ notes: 10, trips: 0, silent: 22 });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(RECORDS.length);
  });

  it("nothing in that day would have prompted the user", () => {
    // `ask` is reachable only through `ask_on_trip`, which is off by default,
    // and `gateOutcome` cannot express a prompt at all: the three outcomes are
    // silence, a note, and a trip.
    const outcomes = new Set(RECORDS.map((record) => advisoryOutcome(record)));
    expect([...outcomes].sort()).toEqual(["note", "silent", "trip"]);
  });

  it("the MCP tool's default policy is untouched by any of this", () => {
    // No options at all: the shape `jev_gate_action` has always had.
    const bare = RECORDS.filter(
      (record) =>
        gateActionPolicy({
          signals: { ...record.signals },
          blast_radius: record.signals.blast_radius,
          thresholds: THRESHOLDS,
        }).decision !== "allow",
    ).length;
    expect(bare).toBeGreaterThanOrEqual(AFTER);
  });
});
