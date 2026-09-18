#!/usr/bin/env tsx
/**
 * Sample the live decision log into a fixture that can be committed.
 *
 *   npm run capture -- --n 200 --out tests/fixtures/before-0.5.0.jsonl
 *   npm run capture -- --summary tests/fixtures/before-0.5.0.jsonl
 *
 * Why this exists: 0.5.0 rewrites every question, so the probabilities it logs
 * are not comparable to the ones 0.4.x logged and the calibrate replay cannot
 * score the change offline. The honest measurement is a pair of fixtures —
 * one captured before the questions change, one after a week on the new ones —
 * summarised by the same function. The summary prints the numbers the 0.5.0
 * plan set as targets so "did it work" is one command per fixture.
 *
 * What is kept: the judged records (those with `signals`), most recent first,
 * with their signals, policy, thresholds, decision, reasons and cost. What is
 * dropped: everything that could identify a session or quote a command —
 * `session_id`, `tool_use_id`, `subject`, `emitted`, `affirmation`,
 * `fingerprint`, `trip_id`, `error`. `ts` becomes an `ordinal` so ordering
 * survives without a timestamp. The keep-list is explicit rather than a
 * drop-list so a field added later has to be named here before it can leak.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Fields copied verbatim when present. Add here, deliberately, never by default. */
const KEEP = [
  "event",
  "tool_name",
  "prefilter",
  "decision",
  "signals",
  "policy",
  "thresholds",
  "reasons",
  "firm",
  "suppressed",
  "channel",
  "source",
  "model",
  "latency_ms",
  "input_tokens",
  "memo",
  // 0.5.0 gate fields
  "scope_source",
  "blast_source",
  "subagent",
  // 0.5.0 stop / screen / prompt fields
  "unfinished_by",
  "chunks_total",
  "chunks_judged",
  "chunks_failed",
  "kind",
] as const;

type Row = Record<string, unknown>;

export interface FixtureRow extends Row {
  ordinal: number;
  event: string;
  decision: string;
  signals: Record<string, number>;
}

export function parseArgs(argv: string[]): {
  n: number;
  log?: string;
  out?: string;
  summary?: string;
} {
  const out: { n: number; log?: string; out?: string; summary?: string } = { n: 200 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "--n") out.n = Number(next());
    else if (arg === "--log") out.log = next();
    else if (arg === "--out") out.out = next();
    else if (arg === "--summary") out.summary = next();
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!Number.isInteger(out.n) || out.n < 1) throw new Error("--n must be a positive integer");
  return out;
}

/**
 * The newest `decisions.jsonl` under `~/.claude/plugins/data/jev-*`. The data
 * directory is named after the marketplace the plugin was installed from, and a
 * machine that switched marketplaces has two; the one written to most recently
 * is the live one.
 */
export function findLiveLog(home = homedir()): string | undefined {
  const root = join(home, ".claude", "plugins", "data");
  if (!existsSync(root)) return undefined;
  const candidates = readdirSync(root)
    .filter((name) => name === "jev" || name.startsWith("jev-"))
    .map((name) => join(root, name, "decisions.jsonl"))
    .filter((path) => existsSync(path))
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.path;
}

export function readLog(path: string): Row[] {
  const rows: Row[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) rows.push(parsed as Row);
    } catch {
      // A torn last line from a crash is not a reason to lose the rest.
    }
  }
  return rows;
}

function isJudged(row: Row): boolean {
  const s = row.signals;
  return s !== null && typeof s === "object" && !Array.isArray(s) && Object.keys(s as object).length > 0;
}

/**
 * The `n` most recent judged rows *per event*, in log order, reduced to the
 * keep-list. Per event because gate records outnumber Stop records thirty to
 * one and a flat tail of 200 would carry two stops — and the stop question is
 * one of the things 0.5.0 changes.
 */
export function capture(rows: Row[], n: number): FixtureRow[] {
  const judged = rows.filter(isJudged);
  const perEvent = new Map<string, number>();
  for (const row of judged) perEvent.set(String(row.event), (perEvent.get(String(row.event)) ?? 0) + 1);
  const seen = new Map<string, number>();
  const tail = judged.filter((row) => {
    const event = String(row.event);
    const index = (seen.get(event) ?? 0) + 1;
    seen.set(event, index);
    return index > (perEvent.get(event) ?? 0) - n;
  });
  return tail.map((row, index) => {
    const out: Row = { ordinal: index };
    for (const key of KEEP) if (row[key] !== undefined) out[key] = row[key];
    // The prefilter reason can quote the argument that matched, e.g.
    // "argument names sensitive material (~/.ssh/id_rsa)". The class of reason
    // is what the summary needs; the argument is the part that could name a
    // machine or a person.
    if (typeof out.prefilter === "string") out.prefilter = out.prefilter.replace(/\s*\(.*\)\s*$/, "");
    return out as FixtureRow;
  });
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] ?? 0;
  const lo = sorted[mid - 1] ?? hi;
  return sorted.length % 2 === 1 ? hi : (lo + hi) / 2;
}

function pct(part: number, whole: number): string {
  return whole === 0 ? "n/a" : `${((100 * part) / whole).toFixed(1)}%`;
}

function fmt(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toFixed(2);
}

/**
 * The numbers the 0.5.0 plan set as targets, from a fixture. Each line is
 * labelled with what it is a count *of* so a before and an after can be read
 * side by side without re-reading the plan.
 */
export function summarize(rows: FixtureRow[]): string {
  const gate = rows.filter((r) => r.event === "PreToolUse");
  const allowed = gate.filter((r) => r.decision === "allow");
  const silentScope = gate.filter((r) => r.decision === "silent-scope");
  const trips = gate.filter((r) => r.decision === "trip");
  const logsSubagent = gate.some((r) => r.subagent !== undefined);
  const subagentTrips = trips.filter((r) => r.subagent !== undefined && r.subagent !== null);
  const stops = rows.filter((r) => r.event === "Stop");
  const stopBlocks = stops.filter((r) => r.decision === "block");
  const screens = rows.filter((r) => r.event === "PostToolUse");

  const byDecision = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.event}/${r.decision}`;
    byDecision.set(key, (byDecision.get(key) ?? 0) + 1);
  }

  const inScope = (list: FixtureRow[]) =>
    list.map((r) => r.signals.in_scope).filter((v): v is number => typeof v === "number");
  const lines = [
    `records: ${rows.length} (gate ${gate.length}, stop ${stops.length}, screen ${screens.length})`,
    ...[...byDecision.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `  ${k}: ${v}`),
    "",
    `gate: in_scope median on allowed actions = ${fmt(median(inScope(allowed)))} (target > 0.70; n=${allowed.length})`,
    `gate: silent-scope share of judged gate records = ${pct(silentScope.length, gate.length)} (target < 2%)`,
    `gate: trips = ${trips.length}, of which inside a subagent = ${
      logsSubagent ? subagentTrips.length : "unknown (field logged from 0.5.0)"
    } (target 0 instrumental)`,
    `stop: blocks = ${stopBlocks.length} of ${stops.length}`,
  ];
  const injection = screens
    .map((r) => r.signals.injection)
    .filter((v): v is number => typeof v === "number");
  if (injection.length > 0) lines.push(`screen: injection max = ${fmt(Math.max(...injection))} over ${injection.length}`);
  const memo = rows.filter((r) => r.memo === true).length;
  const latency = rows
    .filter((r) => r.memo !== true)
    .map((r) => r.latency_ms)
    .filter((v): v is number => typeof v === "number");
  lines.push(`cost: memo hits ${memo}, judged latency median ${fmt(median(latency))} ms`);
  return lines.join("\n");
}

export function readFixture(path: string): FixtureRow[] {
  return readLog(path).filter((r) => typeof r.event === "string" && typeof r.decision === "string") as FixtureRow[];
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.summary !== undefined) {
    process.stdout.write(summarize(readFixture(args.summary)) + "\n");
    return;
  }
  const log = args.log ?? findLiveLog();
  if (log === undefined) throw new Error("no decision log found; pass --log <path>");
  const rows = capture(readLog(log), args.n);
  const out = args.out ?? `tests/fixtures/capture-${new Date().toISOString().slice(0, 10)}.jsonl`;
  writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  process.stdout.write(`${rows.length} judged records from ${log}\n→ ${out}\n\n${summarize(rows)}\n`);
}

if (process.argv[1]?.endsWith("capture-fixture.ts")) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
