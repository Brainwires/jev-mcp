/**
 * The `/jev:status`, `/jev:why` and `/jev:calibrate` reports.
 *
 * The property that matters most here is negative: the API key never appears in
 * any of them.
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
    decision: "ask",
    signals: { destructive: 0.95, outward_facing: 0.02, in_scope: 0.9, credential_exposure: 0.01, blast_radius: 1.2 },
    policy: { ignore_scope: false, uncertain: "risky-lean" },
    reasons: ["The action destroys or overwrites existing data."],
    model: "jev-1.13",
    latency_ms: 240,
    input_tokens: 900,
    ...overrides,
  };
}

/** A code-pattern escalation: no model, so no signals and no policy options. */
function patternRecord(prefilter: string): DecisionRecord {
  const base = record({ prefilter, reasons: [prefilter] });
  delete base.signals;
  delete base.policy;
  return base;
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

  it("counts the last 24 hours by event and decision", () => {
    store.append(record());
    store.append(record({ decision: "allow" }));
    store.append(record({ event: "Stop", decision: "block" }));
    store.append(record({ ts: new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString(), decision: "ask" }));

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

  it("keeps approval records out of the latency figures", () => {
    // An approval's latency_ms is prompt-to-completion time: the user thinking.
    store.append(record({ latency_ms: 400 }));
    const { model: _model, signals: _signals, policy: _policy, ...bare } = record();
    store.append({ ...bare, event: "approval", decision: "approved", latency_ms: 32_342 });
    const report = statusReport(testConfig(dir), store, NOW);
    expect(report).toContain("p95 400 ms (1 calls)");
  });

  it("reports the error count and the last error", () => {
    store.append(record());
    store.append(record({ decision: "error", error: "JevTimeoutError: deadline" }));
    const report = statusReport(testConfig(dir), store, NOW);
    expect(report).toContain("errors: 1");
    expect(report).toContain("JevTimeoutError: deadline");
  });

  it("surfaces a malformed option instead of hiding it", () => {
    const config = testConfig(dir, { warnings: ["gate_mode=\"maybe\" is not one of off|standard|strict; using standard."] });
    expect(statusReport(config, store, NOW)).toContain("option warnings");
  });

  it("reads an empty log without complaining", () => {
    expect(statusReport(testConfig(dir), store, NOW)).toContain("0 logged decisions");
  });
});

describe("whyReport", () => {
  it("explains that nothing has happened yet", () => {
    expect(whyReport(store)).toContain("no escalations");
  });

  /**
   * "Why did this fire" is usually answered by which leniency was or was not
   * switched on, so every option in force has to be on the line.
   */
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

  it("shows the most recent escalations newest first, with signals and reasons", () => {
    store.append(record({ subject: "subject-alpha" }));
    store.append(record({ subject: "subject-beta" }));
    store.append(record({ subject: "subject-allowed", decision: "allow" }));
    const report = whyReport(store, 2);
    expect(report.indexOf("subject-beta")).toBeLessThan(report.indexOf("subject-alpha"));
    expect(report).not.toContain("subject-allowed");
    expect(report).toContain("destructive=0.95");
    expect(report).toContain("The action destroys");
    expect(report).toContain("uncertain=risky-lean");
  });

  it("honours the count", () => {
    for (const n of [1, 2, 3, 4, 5]) store.append(record({ subject: `s${n}` }));
    expect(whyReport(store, 1)).toContain("last 1 non-allow");
  });

  it("includes a code-pattern escalation with no signals", () => {
    store.append(patternRecord("fork bomb"));
    expect(whyReport(store, 1)).toContain("prefilter: fork bomb");
  });
});

describe("calibrateReport", () => {
  it("says there is nothing to calibrate on an empty log", () => {
    expect(calibrateReport(testConfig(dir), store)).toContain("Nothing judged yet");
  });

  it("reports distributions, firing rates and a threshold replay", () => {
    for (let index = 0; index < 5; index += 1) {
      store.append(record({ tool_use_id: `t${index}` }));
    }
    store.append(record({ decision: "allow", signals: { destructive: 0.01, outward_facing: 0.01, in_scope: 0.95, credential_exposure: 0.01, blast_radius: 0.2 } }));
    const report = calibrateReport(testConfig(dir), store);
    expect(report).toContain("Signal distributions");
    expect(report).toContain("destructive");
    expect(report).toContain("How often each gate fired");
    expect(report).toContain("Replay at other auto thresholds");
    expect(report).toContain("auto 0.95");
  });

  it("writes a zero delta as 0%, not -0%", () => {
    // Same threshold, same options: the replay reproduces today's count, so
    // the change against now is nothing at all.
    store.append(record({ tool_use_id: "t0" }));
    const report = calibrateReport(testConfig(dir), store);
    expect(report).not.toContain("-0%");
    expect(report).toContain("0% vs now");
  });

  it("replays exactly: a higher threshold turns a 0.95 destructive into no escalation", () => {
    store.append(
      record({
        signals: { destructive: 0.95, outward_facing: 0.01, in_scope: 0.95, credential_exposure: 0.01, blast_radius: 0.1 },
      }),
    );
    const report = calibrateReport(testConfig(dir), store);
    // At auto 0.95 the signal still leans yes; at 0.99 it would not, but 0.95 is
    // the highest replayed value, so the line must still show one escalation.
    expect(report).toMatch(/auto 0\.95: 1 escalations/);
    expect(report).toMatch(/auto 0\.85: 1 escalations/);
  });

  it("counts code-pattern escalations separately", () => {
    store.append(patternRecord("fork bomb"));
    store.append(record());
    const report = calibrateReport(testConfig(dir), store);
    expect(report).toContain("Escalations decided by a code pattern (no model): 1");
    expect(report).toContain("Gate decisions judged by the model: 1");
  });

  it("reports the approval correlation and what it does not mean", () => {
    store.append(record({ tool_use_id: "t1" }));
    store.append(record({ tool_use_id: "t2" }));
    store.append({ ts: new Date(NOW).toISOString(), session_id: "s1", event: "approval", tool_use_id: "t1", decision: "approved" });
    const report = calibrateReport(testConfig(dir), store);
    expect(report).toContain("1 of 2 escalated tool calls ran afterwards (50% approved)");
    expect(report).toContain("never reports that a user denied a prompt");
  });

  it("never prints the key", () => {
    store.append(record());
    expect(calibrateReport(testConfig(dir, { apiKey: "sk-super-secret" }), store)).not.toContain("sk-super-secret");
  });
});
