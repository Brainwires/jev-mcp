/**
 * The reports behind `/jev:status`, `/jev:why` and `/jev:calibrate`.
 *
 * These are plain functions over the decision log so they can be tested
 * without a process. They print text, not JSON: the audience is a person
 * reading a slash command's output.
 *
 * The API key is never printed, not even partially. "configured" or "not
 * configured" is the whole of what a status report needs to say about it.
 */

import { USD_PER_MTOK } from "../decision/pricing.js";
import { gateActionPolicy, type GateActionSignals } from "../tools/gate-action-core.js";
import type { HookConfig } from "./config.js";
import type { DecisionRecord, Store } from "./store.js";

/** TypeSafe bills input tokens only. Defined in `src/decision/pricing.ts`. */
export { USD_PER_MTOK };
const DAY_MS = 24 * 60 * 60 * 1000;

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] as number;
}

function tally(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function formatTally(counts: Map<string, number>): string {
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "  (none)";
  return entries.map(([key, count]) => `  ${key}: ${count}`).join("\n");
}

function within(records: DecisionRecord[], now: number, windowMs: number): DecisionRecord[] {
  return records.filter((record) => {
    const ts = Date.parse(record.ts ?? "");
    return Number.isFinite(ts) && now - ts <= windowMs;
  });
}

export function statusReport(config: HookConfig, store: Store, now: number = Date.now()): string {
  const all = store.readLog();
  const recent = within(all, now, DAY_MS);
  // Model calls only. An `approval` record's latency_ms is the time from the
  // prompt to the tool finishing — the user's thinking time, not Jev's.
  const latencies = recent
    .filter((r) => r.model !== undefined)
    .map((r) => r.latency_ms)
    .filter((n): n is number => typeof n === "number");
  const tokens = recent.reduce((sum, r) => sum + (r.input_tokens ?? 0), 0);
  const errors = recent.filter((r) => r.decision === "error" || r.error !== undefined);
  const lastError = errors[errors.length - 1];

  const lines: string[] = [
    "jev — Claude Code plugin status",
    "",
    "Configuration",
    `  API key: ${config.apiKey === null ? "not configured (judgment hooks inactive)" : "configured"}`,
    `  model: ${config.model}`,
    `  base url: ${config.baseUrl}`,
    `  gate_mode: ${config.gateMode}`,
    `  auto_mode: ${config.autoMode} (what a confirm-grade judgment does in auto mode)`,
    `  stop_check: ${config.stopCheck}   screen_results: ${config.screenResults}   route_prompts: ${config.routePrompts}`,
    `  thresholds: auto ${config.autoThreshold}, review ${config.reviewThreshold}`,
    `  per-call timeout: ${config.timeoutMs} ms, retries: ${config.maxRetries}`,
    `  data dir: ${config.dataDir}`,
    `  hooks disabled by env: ${config.disabled}`,
  ];
  if (config.warnings.length > 0) {
    lines.push("  option warnings:");
    for (const warning of config.warnings) lines.push(`    ${warning}`);
  }

  lines.push(
    "",
    `Last 24 h (${recent.length} logged decisions of ${all.length} total)`,
    " by event:",
    formatTally(tally(recent.map((r) => r.event ?? "?"))),
    " by decision:",
    formatTally(tally(recent.map((r) => r.decision ?? "?"))),
    "",
    "Latency and cost",
    `  p50 ${Math.round(percentile(latencies, 50))} ms, p95 ${Math.round(percentile(latencies, 95))} ms (${latencies.length} calls)`,
    `  input tokens: ${tokens} → about $${((tokens / 1_000_000) * USD_PER_MTOK).toFixed(4)} at $${USD_PER_MTOK}/Mtok`,
    `  errors: ${errors.length}`,
  );
  if (lastError !== undefined) {
    lines.push(`  last error: ${lastError.ts} ${lastError.event} ${lastError.error ?? "(unspecified)"}`);
  }

  return lines.join("\n");
}

export function whyReport(store: Store, limit = 3): string {
  const interesting = store
    .readLog()
    .filter((r) => r.decision !== "allow" && r.decision !== "clean" && r.decision !== "approved" && r.decision !== "low-confidence");
  const slice = interesting.slice(-Math.max(1, limit)).reverse();
  if (slice.length === 0) return "jev — no escalations, blocks or errors recorded yet.";

  const lines = [`jev — last ${slice.length} non-allow decision(s), newest first`, ""];
  for (const record of slice) {
    lines.push(`${record.ts}  ${record.event}  →  ${record.decision}`);
    if (record.tool_name !== undefined) lines.push(`  tool: ${record.tool_name}`);
    if (record.subject !== undefined) lines.push(`  subject: ${record.subject}`);
    if (record.prefilter !== undefined) lines.push(`  prefilter: ${record.prefilter}`);
    if (record.signals !== undefined) {
      lines.push(
        `  signals: ${Object.entries(record.signals)
          .map(([name, value]) => `${name}=${value.toFixed(2)}`)
          .join(", ")}`,
      );
    }
    if (record.policy !== undefined) {
      // Every option in force, because "why did this fire" usually turns out
      // to be "which leniency was or was not switched on".
      const options = [
        `uncertain=${record.policy.uncertain}`,
        `in_scope ${record.policy.ignore_scope ? "ignored" : "used"}`,
      ];
      const flags: [string, boolean | undefined][] = [
        ["lenient_scope", record.policy.lenient_scope],
        ["trust_requested", record.policy.trust_requested],
        ["corroborate_uncertain", record.policy.corroborate_uncertain],
      ];
      for (const [name, value] of flags) {
        if (value !== undefined) options.push(`${name}=${value}`);
      }
      lines.push(`  policy: ${options.join(", ")}`);
    }
    for (const reason of record.reasons ?? []) lines.push(`  - ${reason}`);
    if (record.error !== undefined) lines.push(`  error: ${record.error}`);
    if (record.model !== undefined) {
      lines.push(`  ${record.model}, ${record.latency_ms ?? "?"} ms, ${record.input_tokens ?? "?"} input tokens`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

const BUCKETS = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.01];

function histogram(values: number[]): string {
  if (values.length === 0) return "(no samples)";
  const counts = BUCKETS.slice(0, -1).map(
    (low, index) => values.filter((v) => v >= low && v < (BUCKETS[index + 1] as number)).length,
  );
  return counts
    .map((count, index) => `${(BUCKETS[index] as number).toFixed(2)}–${(BUCKETS[index + 1] as number).toFixed(2)}: ${count}`)
    .join("  ");
}

const GATE_SIGNALS = ["destructive", "outward_facing", "in_scope", "credential_exposure"] as const;

export function calibrateReport(config: HookConfig, store: Store): string {
  const log = store.readLog();
  const judged = log.filter(
    (r) => r.event === "PreToolUse" && r.signals !== undefined && r.signals.destructive !== undefined,
  );
  const escalated = log.filter(
    (r) => r.event === "PreToolUse" && r.signals === undefined && r.decision !== "error",
  );
  const approvals = new Set(log.filter((r) => r.event === "approval").map((r) => r.tool_use_id));

  const lines = [
    "jev — calibration report",
    "",
    `Gate decisions judged by the model: ${judged.length}`,
    `Escalations decided by a code pattern (no model): ${escalated.length}`,
    "",
  ];

  if (judged.length === 0) {
    lines.push("Nothing judged yet. Run a few sessions with gate_mode=standard and try again.");
    return lines.join("\n");
  }

  lines.push("Signal distributions (all judged gate decisions)");
  for (const signal of GATE_SIGNALS) {
    const values = judged.map((r) => r.signals?.[signal]).filter((n): n is number => typeof n === "number");
    lines.push(`  ${signal.padEnd(20)} ${histogram(values)}`);
  }
  const blast = judged.map((r) => r.signals?.blast_radius).filter((n): n is number => typeof n === "number");
  if (blast.length > 0) {
    const mean = blast.reduce((a, b) => a + b, 0) / blast.length;
    lines.push(`  blast_radius         mean ${mean.toFixed(2)} of 3, p95 ${percentile(blast, 95).toFixed(2)}`);
  }

  lines.push("", "How often each gate fired");
  lines.push(formatTally(tally(judged.map((r) => r.decision ?? "?"))));

  // Replay the same signals at other thresholds. The signals, the blast radius
  // and the policy options are all in the log, so this is an exact replay of
  // the pure policy function, not an estimate.
  // `advise` is a confirm-grade judgment that auto mode turned into a note; the
  // replay below counts it, so the baseline has to as well.
  const asksNow = judged.filter((r) => r.decision === "ask" || r.decision === "deny" || r.decision === "advise").length;
  lines.push("", `Replay at other auto thresholds (currently ${config.autoThreshold}; ${asksNow} escalations)`);
  for (const auto of [0.75, 0.8, 0.85, 0.9, 0.95]) {
    let escalations = 0;
    for (const record of judged) {
      const signals = record.signals as Record<string, number>;
      const gate = gateActionPolicy({
        signals: {
          destructive: signals.destructive ?? 0.5,
          outward_facing: signals.outward_facing ?? 0.5,
          in_scope: signals.in_scope ?? 0.5,
          credential_exposure: signals.credential_exposure ?? 0.5,
        } satisfies GateActionSignals,
        blast_radius: signals.blast_radius ?? 2,
        thresholds: { auto, review: Math.min(config.reviewThreshold, auto) },
        options: {
          ignoreScope: record.policy?.ignore_scope ?? false,
          uncertain: record.policy?.uncertain === "confirm" ? "confirm" : "risky-lean",
          lenientScope: record.policy?.lenient_scope ?? false,
          trustRequested: record.policy?.trust_requested ?? false,
          corroborateUncertain: record.policy?.corroborate_uncertain ?? false,
        },
      });
      if (gate.decision !== "allow") escalations += 1;
    }
    const delta = asksNow === 0 ? 0 : Math.round(((asksNow - escalations) / asksNow) * 100);
    // A zero delta is "0%", not "-0%".
    const change = delta === 0 ? "0%" : `${delta > 0 ? "-" : "+"}${Math.abs(delta)}%`;
    lines.push(`  auto ${auto.toFixed(2)}: ${escalations} escalations (${change} vs now)`);
  }

  // Approval correlation. PostToolUse for a tool call we escalated means it
  // ran, which means the user approved it. The reverse is not true — a denial,
  // an interrupt, and a user who changed their mind look identical from here —
  // so the unmatched share is an upper bound on rejections, not a measurement.
  const correlatable = judged.filter((r) => r.tool_use_id !== undefined && (r.decision === "ask" || r.decision === "deny"));
  lines.push("", "Approval correlation");
  if (correlatable.length === 0) {
    lines.push("  No escalation carried a tool_use_id yet, so nothing can be correlated.");
  } else {
    const approved = correlatable.filter((r) => approvals.has(r.tool_use_id));
    lines.push(
      `  ${approved.length} of ${correlatable.length} escalated tool calls ran afterwards (${Math.round(
        (approved.length / correlatable.length) * 100,
      )}% approved).`,
    );
    lines.push("  By top signal of the escalation:");
    for (const signal of GATE_SIGNALS) {
      const bucket = correlatable.filter((r) => (r.signals?.[signal] ?? 0) >= config.autoThreshold);
      if (bucket.length === 0) continue;
      const yes = bucket.filter((r) => approvals.has(r.tool_use_id)).length;
      lines.push(`    ${signal.padEnd(20)} ${yes}/${bucket.length} approved`);
    }
  }
  lines.push(
    "",
    "Read this as a firing-rate report. Claude Code reports that an escalated call",
    "later ran, but never reports that a user denied a prompt (PermissionDenied",
    "fires only for auto-mode classifier denials), so an escalation with no",
    "matching run may have been denied, interrupted, or simply abandoned.",
  );

  return lines.join("\n");
}
