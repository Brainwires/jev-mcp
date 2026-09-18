/**
 * The before/after fixture pair, replayed.
 *
 * 0.5.0 rewrites every question, so the probabilities it logs are not
 * comparable to the ones 0.4.x logged: the `/jev:calibrate` replay cannot score
 * this release offline, and neither can this file. What it can do is put the
 * numbers from each captured fixture in the diff, so a policy change after the
 * questions settle shows its size rather than being argued about.
 *
 * Every `tests/fixtures/{before,after}-*.jsonl` is replayed. Today that is the
 * one captured on the 0.4.x questions the week before this release
 * (`npm run capture`); the "after" fixture is captured after a week on the new
 * ones, and the snapshot below is what the two are read against.
 *
 * The replay path is the legacy one for the before fixture, by construction:
 * those records carry neither `blast_p_high` nor `mentions_target`, so they
 * replay on the expectation rule and an un-vetoed out-of-scope reading — which
 * is what they actually decided on.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gateOutcome } from "../../src/hooks/advisory.js";
import { gateActionPolicy, type GateActionSignals } from "../../src/tools/gate-action-core.js";

const THRESHOLDS = { auto: 0.85, review: 0.6 };
const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

interface Row {
  event?: string;
  decision?: string;
  signals?: Record<string, number>;
  policy?: Record<string, string | number | boolean>;
}

function readFixture(name: string): Row[] {
  return readFileSync(join(FIXTURES, name), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Row);
}

function num(row: Row, name: string): number | undefined {
  const value = row.signals?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function flag(row: Row, name: string): boolean {
  return row.policy?.[name] === true;
}

/** The gate outcome one captured record would get, at the fixture's own thresholds. */
function replayGate(row: Row): "note" | "trip" | "silent" {
  const signals: GateActionSignals = {
    destructive: num(row, "destructive") ?? 0.5,
    outward_facing: num(row, "outward_facing") ?? 0.5,
    in_scope: num(row, "in_scope") ?? 0.5,
    credential_exposure: num(row, "credential_exposure") ?? 0.5,
  };
  const blast = num(row, "blast_radius") ?? 2;
  const pHigh = num(row, "blast_p_high");
  const mentions = num(row, "mentions_target");
  const zeroFive = {
    ...(pHigh !== undefined ? { blast_p_high: pHigh } : {}),
    ...(mentions !== undefined ? { mentions_target: mentions } : {}),
  };
  const strict = row.policy?.uncertain === "confirm";
  const policy = gateActionPolicy({
    signals,
    blast_radius: blast,
    ...zeroFive,
    thresholds: THRESHOLDS,
    options: {
      ignoreScope: flag(row, "ignore_scope"),
      uncertain: strict ? "confirm" : "risky-lean",
      lenientScope: flag(row, "lenient_scope"),
      trustRequested: flag(row, "trust_requested"),
      corroborateUncertain: flag(row, "corroborate_uncertain"),
    },
  });
  return gateOutcome({ decision: policy.decision, signals, blast_radius: blast, ...zeroFive, thresholds: THRESHOLDS, strict })
    .outcome;
}

/** The stop outcome, off the three 0.5.0 Nouls or the 0.4.x compound. */
function replayStop(row: Row): "block" | "allow" {
  const split = ["says_part_not_done", "says_step_deferred", "says_check_failing"]
    .map((name) => num(row, name))
    .filter((value): value is number => value !== undefined);
  const unfinished = split.length > 0 ? Math.max(...split) : num(row, "admits_unfinished");
  if (unfinished === undefined) return "allow";
  return unfinished >= THRESHOLDS.auto && !((num(row, "asks_user") ?? 0) > 1 - THRESHOLDS.auto) ? "block" : "allow";
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1
      ? (sorted[middle] as number)
      : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  return Math.round(value * 100) / 100;
}

/** The numbers the 0.5.0 plan set as targets, from one fixture. */
function summarize(rows: Row[]): Record<string, number | null> {
  const gate = rows.filter((row) => row.event === "PreToolUse" && row.signals?.destructive !== undefined);
  const stops = rows.filter((row) => row.event === "Stop" || row.event === "SubagentStop");
  const screens = rows.filter((row) => row.event === "PostToolUse" && num(row, "injection") !== undefined);

  const outcomes = gate.map((row) => replayGate(row));
  const silentByReason = gate.filter((row) => (row.decision ?? "").startsWith("silent-"));
  const allowed = gate.filter((row) => row.decision === "allow" || (row.decision ?? "").startsWith("silent-"));

  return {
    gate_records: gate.length,
    notes: outcomes.filter((outcome) => outcome === "note").length,
    trips: outcomes.filter((outcome) => outcome === "trip").length,
    silent: outcomes.filter((outcome) => outcome === "silent").length,
    silent_by_reason: silentByReason.length,
    silent_scope: gate.filter((row) => row.decision === "silent-scope").length,
    stop_records: stops.length,
    stop_blocks: stops.filter((row) => replayStop(row) === "block").length,
    screen_records: screens.length,
    screen_flagged: screens.filter((row) => (num(row, "injection") ?? 0) >= THRESHOLDS.auto).length,
    screen_contradicts: screens.filter((row) => (num(row, "contradicts_premise") ?? 0) >= THRESHOLDS.auto).length,
    allowed_in_scope_median: median(
      allowed.map((row) => num(row, "in_scope")).filter((value): value is number => value !== undefined),
    ),
    silent_scope_share_pct:
      gate.length === 0 ? null : Math.round((1000 * gate.filter((row) => row.decision === "silent-scope").length) / gate.length) / 10,
  };
}

const NAMES = readdirSync(FIXTURES)
  .filter((name) => /^(before|after)-.*\.jsonl$/.test(name))
  .sort();

describe("captured fixtures", () => {
  it("finds at least the before fixture this release was planned against", () => {
    expect(NAMES).toContain("before-0.5.0.jsonl");
  });

  for (const name of NAMES) {
    describe(name, () => {
      const rows = readFixture(name);

      it("carries judged records and nothing that could identify a session", () => {
        expect(rows.length).toBeGreaterThan(0);
        const text = JSON.stringify(rows);
        for (const field of ["session_id", "subject", "emitted", "affirmation", "fingerprint", "trip_id"]) {
          expect(text, field).not.toContain(`"${field}"`);
        }
      });

      it("replays to the same numbers, so a policy change shows its size", () => {
        expect(summarize(rows)).toMatchSnapshot();
      });
    });
  }
});
