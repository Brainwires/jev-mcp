/**
 * The `/jev:status`, `/jev:why` and `/jev:calibrate` reports.
 *
 * Two properties matter most, and both are negative: the API key never appears
 * in any of them, and nothing in `/jev:calibrate` claims to measure whether a
 * judgment was correct. Nobody is prompted in 0.3, so there is no human verdict
 * to score against, and a report that implied otherwise would be the most
 * expensive kind of wrong.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { calibrateReport, statusReport, USD_PER_MTOK, whyReport } from "../../src/hooks/report.js";
import type { DecisionRecord } from "../../src/hooks/store.js";
import { Store } from "../../src/hooks/store.js";
import { cleanup, tempDir, testConfig } from "./helpers.js";

const NOW = Date.parse("2026-09-17T12:00:00.000Z");

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    ts: new Date(NOW - 60_000).toISOString(),
    session_id: "s1",
    event: "PreToolUse",
    tool_name: "Bash",
    subject: "Bash {}",
    decision: "note",
    channel: "note",
    firm: ["destructive"],
    emitted: "[jev] The Bash call above (rm -rf build) was scored destructive by the jev classifier (p=0.95).",
    fingerprint: "1111111111111111",
    signals: { destructive: 0.95, outward_facing: 0.02, in_scope: 0.9, credential_exposure: 0.01, blast_radius: 1.2 },
    policy: { ignore_scope: false, uncertain: "risky-lean" },
    reasons: ["The action destroys or overwrites existing data."],
    model: "jev-1.13",
    latency_ms: 240,
    input_tokens: 900,
    ...overrides,
  };
}

/** A code-pattern trip: no model, so no signals and no policy options. */
function patternTrip(prefilter: string, overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  const base = record({
    decision: "trip",
    source: "pattern",
    channel: "deny",
    trip_id: "t-aaaaaaaa",
    prefilter,
    reasons: [prefilter],
    emitted: `[jev] tripwire t-aaaaaaaa: this Bash call was not run because it matched the code rule "${prefilter}".`,
    ...overrides,
  });
  delete base.signals;
  delete base.policy;
  delete base.firm;
  return base;
}

function prompt(offsetMs: number): DecisionRecord {
  return {
    ts: new Date(NOW - offsetMs).toISOString(),
    session_id: "s1",
    event: "UserPromptSubmit",
    decision: "prompt",
  };
}

let dir: string;
let store: Store;
beforeEach(() => {
  dir = tempDir();
  store = new Store(dir);
});
afterEach(() => {
  cleanup(dir);
});

describe("statusReport", () => {
  it("says whether a key is configured without printing it", () => {
    const report = statusReport(testConfig(dir, { apiKey: "sk-super-secret" }), store, NOW);
    expect(report).toContain("API key: configured");
    expect(report).not.toContain("sk-super-secret");
  });

  it("says plainly when there is no key", () => {
    expect(statusReport(testConfig(dir, { apiKey: null }), store, NOW)).toContain("not configured");
  });

  it("prints the gate level and whether anything can prompt", () => {
    const report = statusReport(testConfig(dir), store, NOW);
    expect(report).toContain("gate: advisory");
    expect(report).toContain("ask_on_trip: false");
    expect(report).toContain("the user is not prompted");
    expect(statusReport(testConfig(dir, { askOnTrip: true }), store, NOW)).toContain("ask_on_trip: true");
  });

  it("counts notes, trips and re-issues in the last 24 hours", () => {
    store.append(record());
    store.append(record());
    store.append(patternTrip("fork bomb"));
    store.append(record({ decision: "trip-repeat" }));
    store.append(record({ decision: "reissue", affirmation: "the request says clean the build" }));
    store.append(record({ decision: "reissue-ran" }));
    store.append(record({ decision: "silent-uncertain", suppressed: "uncertain" }));

    const report = statusReport(testConfig(dir), store, NOW);
    expect(report).toContain("notes handed to Claude: 2   suppressed: 1");
    expect(report).toContain("tripwires: 1 opened, 1 repeats, 1 re-issued (1 ran, 0 failed)");
  });

  it("counts the marker hygiene lines", () => {
    store.append(record({ decision: "marker-unmatched" }));
    store.append(record({ decision: "marker-short" }));
    store.append(record({ decision: "affirm" }));
    expect(statusReport(testConfig(dir), store, NOW)).toContain(
      "markers: 1 sidecar affirmations, 1 on untripped calls, 1 too short",
    );
  });

  it("counts the last 24 hours by event and decision", () => {
    store.append(record());
    store.append(record({ decision: "allow" }));
    store.append(record({ event: "Stop", decision: "block" }));
    store.append(record({ ts: new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString() }));

    const report = statusReport(testConfig(dir), store, NOW);
    expect(report).toContain("Last 24 h (3 logged decisions of 4 total)");
    expect(report).toMatch(/PreToolUse: 2/);
    expect(report).toMatch(/Stop: 1/);
  });

  it("reports latency percentiles and an estimated cost", () => {
    for (const latency of [100, 200, 300, 400, 5000]) {
      store.append(record({ latency_ms: latency, input_tokens: 1_000_000 }));
    }
    const report = statusReport(testConfig(dir), store, NOW);
    expect(report).toContain("p50 300 ms");
    expect(report).toContain("p95 5000 ms");
    expect(report).toContain(`$${(5 * USD_PER_MTOK).toFixed(4)}`);
  });

  it("keeps re-issue bookkeeping out of the latency figures", () => {
    // A `reissue-ran` latency is the tool's own run time, not a Jev call.
    store.append(record({ latency_ms: 400 }));
    const { model: _model, signals: _signals, policy: _policy, ...bare } = record();
    store.append({ ...bare, event: "PostToolUse", decision: "reissue-ran", latency_ms: 32_342 });
    expect(statusReport(testConfig(dir), store, NOW)).toContain("p95 400 ms (1 calls)");
  });

  it("reports the error count and the last error", () => {
    store.append(record());
    store.append(record({ decision: "error", error: "JevTimeoutError: deadline" }));
    const report = statusReport(testConfig(dir), store, NOW);
    expect(report).toContain("errors: 1");
    expect(report).toContain("JevTimeoutError: deadline");
  });

  it("surfaces the gate_mode migration warning rather than hiding it", () => {
    const config = testConfig(dir, {
      warnings: ['gate_mode is deprecated; read as gate=advisory. Set "gate" in /plugin config.'],
    });
    const report = statusReport(config, store, NOW);
    expect(report).toContain("option warnings");
    expect(report).toContain("gate_mode is deprecated");
  });

  it("reads an empty log without complaining", () => {
    expect(statusReport(testConfig(dir), store, NOW)).toContain("0 logged decisions");
  });
});

describe("whyReport", () => {
  it("explains that nothing has happened yet", () => {
    expect(whyReport(store)).toContain("no note, trip and error records yet");
  });

  it("prints the exact text the agent was handed", () => {
    store.append(record());
    const report = whyReport(store, 1);
    expect(report).toContain("said to Claude: [jev] The Bash call above (rm -rf build) was scored destructive");
    expect(report).toContain("driven by: destructive");
  });

  it("prints the trip id and its source", () => {
    store.append(patternTrip("fork bomb"));
    const report = whyReport(store, 1);
    expect(report).toContain("tripwire: t-aaaaaaaa (pattern)");
    expect(report).toContain("prefilter: fork bomb");
  });

  it("prints the marker text and the trip it answered, for a re-issue", () => {
    store.append(
      record({
        decision: "reissue",
        trip_id: "t-aaaaaaaa",
        source: "model",
        affirmation: 'the request says "reset the dev database before seeding"',
      }),
    );
    const report = whyReport(store, 1);
    expect(report).toContain("→  reissue");
    expect(report).toContain("tripwire: t-aaaaaaaa (model)");
    expect(report).toContain("marker text: the request says");
  });

  it("names every policy option in force", () => {
    store.append(
      record({
        policy: {
          ignore_scope: false,
          uncertain: "risky-lean",
          lenient_scope: true,
          trust_requested: true,
          corroborate_uncertain: true,
        },
      }),
    );
    const report = whyReport(store, 1);
    expect(report).toContain("uncertain=risky-lean");
    expect(report).toContain("in_scope used");
    expect(report).toContain("lenient_scope=true");
    expect(report).toContain("trust_requested=true");
    expect(report).toContain("corroborate_uncertain=true");
  });

  it("omits an option that was not recorded, rather than guessing a default", () => {
    store.append(record({ policy: { ignore_scope: true, uncertain: "confirm" } }));
    const report = whyReport(store, 1);
    expect(report).toContain("in_scope ignored");
    expect(report).not.toContain("corroborate_uncertain");
  });

  it("shows the most recent records newest first and leaves silence out", () => {
    store.append(record({ subject: "subject-alpha" }));
    store.append(record({ subject: "subject-beta" }));
    store.append(record({ subject: "subject-silent", decision: "silent-uncertain", suppressed: "uncertain" }));
    const report = whyReport(store, 2);
    expect(report.indexOf("subject-beta")).toBeLessThan(report.indexOf("subject-alpha"));
    expect(report).not.toContain("subject-silent");
    expect(report).toContain("destructive=0.95");
  });

  it("honours the count", () => {
    for (const n of [1, 2, 3, 4, 5]) store.append(record({ subject: `s${n}` }));
    expect(whyReport(store, 1)).toContain("last 1 note");
  });

  describe("filters", () => {
    beforeEach(() => {
      store.append(record({ subject: "a-note" }));
      store.append(patternTrip("fork bomb", { subject: "a-trip" }));
      store.append(record({ subject: "a-reissue", decision: "reissue", trip_id: "t-aaaaaaaa" }));
      store.append(record({ subject: "an-error", decision: "error", error: "boom" }));
    });

    it("notes only", () => {
      const report = whyReport(store, 10, "notes");
      expect(report).toContain("a-note");
      expect(report).not.toContain("a-trip");
      expect(report).not.toContain("an-error");
    });

    it("trips only, including how each one ended", () => {
      const report = whyReport(store, 10, "trips");
      expect(report).toContain("a-trip");
      expect(report).toContain("a-reissue");
      expect(report).not.toContain("a-note");
    });

    it("everything the agent was told, plus errors, by default", () => {
      const report = whyReport(store, 10);
      for (const subject of ["a-note", "a-trip", "a-reissue", "an-error"]) expect(report).toContain(subject);
    });
  });
});

describe("calibrateReport", () => {
  it("says there is nothing to calibrate on an empty log", () => {
    const report = calibrateReport(testConfig(dir), store);
    expect(report).toContain("Nothing judged by the model yet");
  });

  it("reports what Claude was told, and what was suppressed", () => {
    store.append(prompt(120_000));
    store.append(record());
    store.append(record({ fingerprint: "2222", subject: "other" }));
    store.append(record({ decision: "silent-uncertain", suppressed: "uncertain" }));
    store.append(record({ decision: "silent-dup", suppressed: "dup" }));
    store.append(record({ decision: "allow", suppressed: "allow" }));

    const report = calibrateReport(testConfig(dir), store);
    expect(report).toContain("1. What Claude was told");
    expect(report).toContain("notes emitted: 2");
    expect(report).toContain("uncertain: 1");
    expect(report).toContain("dup: 1");
    expect(report).toContain("notes by driving signal:");
    expect(report).toContain("destructive: 2");
    expect(report).toContain("notes per user prompt: mean 2.00, max 2 (cap 5, 1 prompts)");
  });

  it("says so plainly when no prompt has been recorded", () => {
    store.append(record());
    expect(calibrateReport(testConfig(dir), store)).toContain("notes per user prompt: no prompts recorded yet");
  });

  it("reports the tripwire lifecycle", () => {
    store.append(patternTrip("fork bomb"));
    store.append(record({ decision: "trip-repeat", trip_id: "t-aaaaaaaa" }));
    store.append(
      record({
        decision: "reissue",
        trip_id: "t-aaaaaaaa",
        ts: new Date(NOW - 30_000).toISOString(),
        affirmation: "the request says remove the build directory",
      }),
    );
    store.append(record({ decision: "reissue-ran", trip_id: "t-aaaaaaaa" }));
    store.append(record({ decision: "trip", source: "model", trip_id: "t-bbbbbbbb", firm: ["outward"] }));

    const report = calibrateReport(testConfig(dir), store);
    expect(report).toContain("2. Tripwires");
    expect(report).toContain("opened: 2   repeats: 1   re-issued: 1   not re-issued: 1");
    expect(report).toContain("pattern: 1");
    expect(report).toContain("model: 1");
    expect(report).toContain("by code rule:");
    expect(report).toContain("by top signal (model trips):");
    expect(report).toContain("re-issues that ran: 1, that failed: 0");
    expect(report).toContain("median trip → re-issue: 30s");
  });

  it("reports a deny loop rather than capping it", () => {
    store.append(patternTrip("fork bomb"));
    store.append(record({ decision: "trip-repeat", trip_id: "t-aaaaaaaa" }));
    store.append(record({ decision: "trip-repeat", trip_id: "t-aaaaaaaa" }));
    const report = calibrateReport(testConfig(dir), store);
    expect(report).toContain("stuck (3+ denies of the same call): 1");
    expect(report).toContain("a cap that went silent would be a bypass");
  });

  it("reports marker hygiene as the reflex metric", () => {
    store.append(record({ decision: "marker-unmatched" }));
    store.append(record({ decision: "marker-unmatched" }));
    store.append(record({ decision: "marker-short" }));
    store.append(record({ decision: "affirm-unmatched" }));
    const report = calibrateReport(testConfig(dir), store);
    expect(report).toContain("markers on calls that were never tripped: 2");
    expect(report).toContain("markers too short to count as a reason: 1");
    expect(report).toContain("sidecar affirmations naming an unknown trip: 1");
    expect(report).toContain("the reflex metric");
  });

  it("splits the signal histograms by what the gate did", () => {
    store.append(record());
    store.append(record({ decision: "trip", source: "model" }));
    store.append(record({ decision: "allow", suppressed: "allow" }));
    const report = calibrateReport(testConfig(dir), store);
    expect(report).toContain("4. Signal distributions, by what the gate did");
    expect(report).toContain("note (1)");
    expect(report).toContain("trip (1)");
    expect(report).toContain("silent (1)");
    expect(report).toContain("destructive");
    expect(report).toContain("blast_radius");
  });

  it("replays notes and trips at other thresholds, exactly", () => {
    // A 0.95 destructive, in scope, local: a note at every replayed threshold
    // up to 0.95, because `lean` reads p >= auto as firm.
    store.append(
      record({
        signals: { destructive: 0.95, outward_facing: 0.01, in_scope: 0.3, credential_exposure: 0.01, blast_radius: 0.1 },
      }),
    );
    const report = calibrateReport(testConfig(dir), store);
    expect(report).toContain("5. Replay at other auto thresholds");
    expect(report).toMatch(/auto 0\.85: 1 notes \+ 0 trips = 1/);
    expect(report).toMatch(/auto 0\.95: 1 notes \+ 0 trips = 1/);
    expect(report).toContain("the per-session duplicate check and the five-note");
  });

  it("writes a zero delta as 0%, not -0%", () => {
    store.append(record());
    const report = calibrateReport(testConfig(dir), store);
    expect(report).not.toContain("-0%");
    expect(report).toContain("0% vs now");
  });

  it("prints the evidence hierarchy, and no claim to measure correctness", () => {
    store.append(record({ decision: "trip", source: "model", trip_id: "t-cccccccc" }));
    const report = calibrateReport(testConfig(dir), store);
    expect(report).toContain("6. How to read this");
    expect(report).toContain("A pattern trip is certain by construction");
    expect(report).toContain("was NOT re-issued (1) is the strongest");
    expect(report).toContain("A note is post-hoc by construction");
    expect(report).toContain("Nothing here measures correctness");
    // The approval correlation is gone: there are no approvals to correlate.
    expect(report).not.toContain("approved");
    expect(report).not.toContain("Approval correlation");
  });

  it("lists the newest marker texts, so a re-issue is auditable", () => {
    for (const n of [1, 2, 3, 4, 5, 6]) {
      store.append(record({ decision: "reissue", trip_id: `t-${n}`, affirmation: `reason number ${n}` }));
    }
    const report = calibrateReport(testConfig(dir), store);
    expect(report).toContain("Newest marker texts");
    expect(report).toContain("reason number 6");
    expect(report).not.toContain("reason number 1");
  });

  it("counts code-pattern trips separately from judged decisions", () => {
    store.append(patternTrip("fork bomb"));
    // A repeat of the same pattern trip is not a second tripwire.
    store.append({ ...patternTrip("fork bomb"), decision: "trip-repeat" });
    store.append(record());
    const report = calibrateReport(testConfig(dir), store);
    expect(report).toContain("tripwires from a code pattern (no model): 1");
    expect(report).toContain("gate decisions judged by the model: 1");
  });

  it("prints a marker text once, not once per record that carries it", () => {
    store.append(record({ decision: "affirm", trip_id: "t-dddddddd", affirmation: "the request says do it" }));
    store.append(record({ decision: "reissue", trip_id: "t-dddddddd", affirmation: "the request says do it" }));
    const report = calibrateReport(testConfig(dir), store);
    expect(report.match(/the request says do it/g)).toHaveLength(1);
  });

  it("never prints the key", () => {
    store.append(record());
    expect(calibrateReport(testConfig(dir, { apiKey: "sk-super-secret" }), store)).not.toContain("sk-super-secret");
  });
});
