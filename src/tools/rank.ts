/**
 * `jev_rank` — relevance-rank candidate texts, or the caller's own files,
 * against a query.
 *
 * One Noul per candidate, batched into as few requests as the context budget
 * allows. The model never sees candidate ids: ids are arbitrary caller strings
 * and would be both a distractor in the state and unsafe as question keys, so
 * candidates go in as an index-keyed array and the indices are mapped back to
 * ids in code.
 *
 * With `paths` or `glob` the server does the reading. That is the whole point
 * of those two arguments: the caller spends no context emitting file text and
 * none ingesting the chunks that turned out to be irrelevant. What comes back
 * is `path:start-end` plus a score, so a 400-file search costs the caller a few
 * hundred tokens of output. File text is never echoed back, in either mode.
 */

import { z } from "zod";
import { BudgetError, DEFAULT_BUDGET_LIMITS, estimateBudget, fitsBudget, type BudgetLimits } from "../decision/budget.js";
import { estimateCostUsd } from "../decision/pricing.js";
import type { DecisionModel, EvaluateRequest, Json, NoulAnswer, Question, State } from "../decision/types.js";
import {
  collectChunks,
  emptySkipped,
  enforceSelection,
  FileSelectionError,
  type FileAccessOptions,
  type SkippedCounts,
} from "../files/index.js";
import { envelopeShape, mapWithConcurrency, sumUsage, type ToolConfig } from "./shared.js";

export const name = "jev_rank";

export const description = [
  "Rank files or texts by how well each helps answer a query, using Jev's calibrated yes/no judgment (one question per item, batched and parallel).",
  "Pass `glob` or `paths` for anything you have not already read — do NOT read files in order to pass their text. The server reads and chunks them itself and returns only `path:start_line-end_line` + score, so a 300-file search costs you almost no context in either direction.",
  "Pass `candidates` (id + text) only for text you already hold: search hits, retrieved passages, tool results.",
  "`unit`: `chunk` (default) ranks line ranges, `file` ranks whole files by their best chunk.",
  "Sensitive files (.env, keys, credentials), binaries, generated output and anything outside the project root are never read; they come back counted in `skipped`.",
  "`relevance` is P(helps answer the query). Trust the top 1-3, not the order of the tail; a low `any_relevant` means look elsewhere.",
  "If `score_spread` (top minus median) is below 0.15 the ranking is not informative — narrow the glob or rephrase the query.",
].join("\n");

const candidateSchema = z.object({
  id: z.string().min(1).describe("Your identifier for this candidate. Returned as-is; never shown to the model."),
  text: z.string().describe("The candidate text to judge. Keep it to the part that could answer the query."),
});

export const UNITS = ["chunk", "file"] as const;
export type RankUnit = (typeof UNITS)[number];

export const inputShape = {
  query: z.string().min(1).describe("What you are trying to find out."),
  candidates: z
    .array(candidateSchema)
    .min(1)
    .max(500)
    .optional()
    .describe("Text you already hold, 1 to 500. Use this only when you did not have to read a file to get it."),
  paths: z
    .array(z.string().min(1))
    .min(1)
    .max(1000)
    .optional()
    .describe("Files for the server to read, relative to the project root (absolute paths inside it are fine)."),
  glob: z
    .string()
    .min(1)
    .optional()
    .describe('A glob for the server to expand and read, e.g. "src/**/*.ts". Supports * ** ? [abc] {a,b}.'),
  unit: z
    .enum(UNITS)
    .optional()
    .describe("For paths/glob: `chunk` (default) ranks line ranges, `file` ranks whole files by their best chunk."),
  top_k: z.number().int().min(1).max(500).optional().describe("How many ranked results to return. Default 10."),
  min_relevance: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Drop candidates whose relevance is below this. Default 0 (keep everything)."),
  instructions: z
    .string()
    .optional()
    .describe("Optional extra definition of what counts as relevant here, folded into every question."),
} as const;

/** Exactly one source. Two sources is a caller bug, not something to merge. */
export const inputSchema = z.object(inputShape).refine(
  (value) => [value.candidates, value.paths, value.glob].filter((v) => v !== undefined).length === 1,
  {
    message:
      "Pass exactly one of `candidates`, `paths` or `glob`. Use `glob`/`paths` for files you have not read " +
      "(the server reads them), and `candidates` only for text you already hold.",
  },
);
export type RankToolInput = z.infer<typeof inputSchema>;

const skippedSchema = z
  .object({
    binary: z.number().int(),
    too_large: z.number().int(),
    sensitive: z.number().int().describe("Files holding credentials. Never read, never sent, whatever named them."),
    outside_root: z.number().int().describe("Paths that resolved outside the project root, symlinks included."),
    not_found: z.number().int(),
    ignored: z.number().int().describe("Lockfiles, `*.min.*`, sourcemaps and ignored directories."),
  })
  .describe("Why files were not read. Nothing is dropped silently.");

export const outputShape = {
  ranked: z
    .array(
      z.object({
        id: z.string().optional().describe("Present for `candidates` sources: your own id, as passed."),
        path: z.string().optional().describe("Present for file sources: path relative to the project root."),
        start_line: z.number().int().optional().describe("1-based, inclusive."),
        end_line: z.number().int().optional().describe("1-based, inclusive."),
        relevance: z.number().describe("P(this item helps answer the query), 0..1."),
        rank: z.number().int().describe("1-based position after sorting and filtering."),
      }),
    )
    .describe("Sorted by relevance descending; ties keep input order. Text is never echoed back."),
  any_relevant: z
    .number()
    .describe(
      "P(at least one candidate helps answer the query), as the MAXIMUM across requests. Low means: look elsewhere. " +
        "Being a maximum, it is biased upward as the set grows, because a large set is split into more requests and " +
        "each contributes a sample — so read a high value as weak evidence and a low value as strong evidence. " +
        "`score_spread` is the better diagnostic.",
    ),
  score_spread: z
    .number()
    .describe(
      "Top relevance minus median relevance, 2 decimals. How much the ranking actually discriminated. " +
        "Below 0.15 the scores are effectively flat and the ordering is not informative: narrow the glob or " +
        "rephrase the query rather than trusting the order.",
    ),
  chunks: z.number().int().describe("How many API requests the item set was split into."),
  total_candidates: z.number().int().describe("How many items were judged, before top_k/min_relevance."),
  files_scanned: z.number().int().optional().describe("File sources only: files actually read."),
  chunks_scored: z.number().int().optional().describe("File sources only: line-range chunks judged."),
  skipped: skippedSchema.optional().describe("File sources only."),
  est_cost_usd: z.number().optional().describe("File sources only: estimated input-token cost of this call."),
  ...envelopeShape,
} as const;

export const outputSchema = z.object(outputShape);
export type RankToolOutput = z.infer<typeof outputSchema>;

const ANY_RELEVANT_ID = "any_relevant";
const DEFAULT_TOP_K = 10;
/** Default fan-out for file sources; `JEV_MAX_CONCURRENCY` overrides it. */
export const FILE_CONCURRENCY = 8;

/**
 * Most candidates per request, whatever the source.
 *
 * Packing a request to the context budget alone puts ~50 candidates in one
 * call, and at that width Jev stops discriminating between them. Measured
 * against this repo with the query "where are retries and backoff implemented",
 * over 159 file chunks:
 *
 *   per request | requests | input tokens | best true-hit rank | top-median spread
 *            53 |        3 |      103,448 | not in the top six |              0.03
 *            32 |        5 |      103,762 |                  2 |              0.62
 *            16 |       10 |      105,012 |                  1 |              0.73
 *             8 |       20 |      107,635 |                  1 |              0.83
 *
 * That is the jaggedness the vendor notes describe: accuracy per question falls
 * as unrelated state grows. At 53 per request the scores were uniform noise
 * between 0.84 and 0.87.
 *
 * It costs nothing to fix. The candidate texts are the whole of the payload and
 * each is sent exactly once either way; only the query and the one-line
 * questions repeat, which measured as a 2.5% token increase and *lower*
 * wall-clock time, because ten requests across an eight-wide fan-out finish
 * sooner than three big ones.
 *
 * The budget check still applies: a request is whichever is smaller, this many
 * candidates or as many as fit.
 */
export const MAX_CANDIDATES_PER_REQUEST = 16;

export interface Entry {
  id: string;
  text: string;
  /** Position in the caller's input array; the stable tie-break. */
  index: number;
  /** File sources only: where this text came from. */
  where?: { path: string; start_line: number; end_line: number } | undefined;
}

function candidateQuestion(localIndex: number, extra: string | undefined): Question {
  const suffix = extra === undefined || extra.trim() === "" ? "" : ` Relevant here means: ${extra.trim()}`;
  return {
    type: "noul",
    instructions:
      `Does \`candidates[${localIndex}]\` contain information that helps answer \`query\`?${suffix}`,
    criteria: {
      true: `The text in \`candidates[${localIndex}]\` states something that helps answer \`query\`, even if it is only part of the answer.`,
      false: `The text in \`candidates[${localIndex}]\` is about something else, or is too generic to help answer \`query\`.`,
    },
  };
}

function anyRelevantQuestion(extra: string | undefined): Question {
  const suffix = extra === undefined || extra.trim() === "" ? "" : ` Relevant here means: ${extra.trim()}`;
  return {
    type: "noul",
    instructions: `Does at least one entry in \`candidates\` contain information that helps answer \`query\`?${suffix}`,
    criteria: {
      true: "At least one entry states something that helps answer `query`.",
      false: "No entry helps answer `query`.",
    },
  };
}

function buildRequest(
  query: string,
  entries: readonly Entry[],
  extra: string | undefined,
): { state: State; questions: Record<string, Question> } {
  const state: Record<string, Json> = { query, candidates: entries.map((entry) => entry.text) };
  const questions: Record<string, Question> = {};
  entries.forEach((_entry, localIndex) => {
    questions[`cand_${localIndex}`] = candidateQuestion(localIndex, extra);
  });
  questions[ANY_RELEVANT_ID] = anyRelevantQuestion(extra);
  return { state, questions };
}

/**
 * Greedily pack candidates into chunks, bounded by two things: the context
 * budget, and `MAX_CANDIDATES_PER_REQUEST`. Whichever binds first wins.
 *
 * Every chunk carries the query and only its own candidates, so the per-chunk
 * state stays small — which is also what the model wants, and the count cap is
 * there because the budget alone is far too generous to keep it that way.
 */
export function chunkCandidates(
  query: string,
  entries: readonly Entry[],
  extra: string | undefined,
  limits: BudgetLimits = DEFAULT_BUDGET_LIMITS,
  maxPerRequest: number = MAX_CANDIDATES_PER_REQUEST,
): Entry[][] {
  const chunks: Entry[][] = [];
  let current: Entry[] = [];

  for (const entry of entries) {
    if (current.length >= maxPerRequest) {
      chunks.push(current);
      current = [];
    }
    const solo = buildRequest(query, [entry], extra);
    if (!fitsBudget(solo.state, solo.questions, limits)) {
      const estimate = estimateBudget(solo.state, solo.questions);
      throw new BudgetError(
        `Candidate "${entry.id}" is too large to rank on its own: the query plus that one candidate is ` +
          `~${estimate.total_tokens} estimated tokens, over the ${limits.total}-token limit. ` +
          `Shorten or split that candidate's text before ranking.`,
        "total",
        limits,
        estimate,
      );
    }

    const attempt = [...current, entry];
    const request = buildRequest(query, attempt, extra);
    if (fitsBudget(request.state, request.questions, limits)) {
      current = attempt;
    } else {
      chunks.push(current);
      current = [entry];
    }
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

interface Source {
  entries: Entry[];
  /** Absent for `candidates`, so that output stays byte-identical to 0.1.x. */
  files?:
    | { files_scanned: number; chunks_scored: number; skipped: SkippedCounts; est_cost_usd: number }
    | undefined;
  fromFiles: boolean;
}

/**
 * Exactly one source, checked here as well as in the zod refine.
 *
 * The MCP server registers `inputShape`, the raw shape, so the refine on
 * `inputSchema` only runs for callers who parse it themselves. A cross-field
 * rule that is not enforced on the path the tool is actually called on is not
 * enforced at all.
 */
export function validateSource(input: Pick<RankToolInput, "candidates" | "paths" | "glob" | "unit">): void {
  const named = (["candidates", "paths", "glob"] as const).filter((key) => input[key] !== undefined);
  if (named.length !== 1) {
    throw new FileSelectionError(
      "bad_source",
      named.length === 0
        ? "Pass exactly one of `candidates`, `paths` or `glob`. Use `glob` or `paths` for files you have not " +
          "read — the server reads them — and `candidates` only for text you already hold."
        : `Pass exactly one of \`candidates\`, \`paths\` or \`glob\`; got ${named.join(" and ")}.`,
    );
  }
  if (input.unit !== undefined && input.candidates !== undefined) {
    throw new FileSelectionError(
      "bad_source",
      "`unit` applies to `paths`/`glob` only: a `candidates` entry is already the unit you chose.",
    );
  }
}

/** Build the entry list from whichever source the caller passed. */
function buildSource(input: RankToolInput, fileOptions: FileAccessOptions): Source {
  validateSource(input);
  if (input.candidates !== undefined) {
    return {
      entries: input.candidates.map((candidate, index) => ({ id: candidate.id, text: candidate.text, index })),
      fromFiles: false,
    };
  }

  const selection =
    input.glob !== undefined
      ? collectChunks({ glob: input.glob }, fileOptions)
      : collectChunks({ paths: input.paths ?? [] }, fileOptions);
  // Priced and refused here, before a single request goes out.
  enforceSelection(selection, fileOptions);

  const entries: Entry[] = selection.chunks.map((chunk, index) => ({
    id: `${chunk.path}:${chunk.start_line}-${chunk.end_line}`,
    text: chunk.text,
    index,
    where: { path: chunk.path, start_line: chunk.start_line, end_line: chunk.end_line },
  }));

  return {
    entries,
    files: {
      files_scanned: selection.files_scanned,
      chunks_scored: selection.chunks.length,
      skipped: selection.skipped,
      est_cost_usd: selection.est_cost_usd,
    },
    fromFiles: true,
  };
}

interface Scored {
  entry: Entry;
  relevance: number;
}

/**
 * How much the scores actually spread: top minus median, 2 decimals.
 *
 * The honest diagnostic for whether a ranking means anything. A run whose
 * candidates all score 0.84 to 0.87 has a spread near zero and an ordering that
 * is noise, however confident the top number looks. Pure.
 */
export function scoreSpread(relevances: readonly number[]): number {
  if (relevances.length === 0) return 0;
  const sorted = [...relevances].sort((a, b) => b - a);
  const median = sorted[Math.floor(sorted.length / 2)] as number;
  return Math.round(((sorted[0] as number) - median) * 100) / 100;
}

/** Below this, the ordering is not informative. Quoted in the tool description. */
export const UNINFORMATIVE_SPREAD = 0.15;

/** One row per file, scored by its best chunk, keeping that chunk's range. */
export function foldToFiles(scored: readonly Scored[]): Scored[] {
  const best = new Map<string, Scored>();
  for (const item of scored) {
    const path = item.entry.where?.path;
    if (path === undefined) continue;
    const current = best.get(path);
    if (current === undefined || item.relevance > current.relevance) best.set(path, item);
  }
  return [...best.values()];
}

export async function run(
  model: DecisionModel,
  input: RankToolInput,
  config: ToolConfig,
  signal?: AbortSignal,
): Promise<RankToolOutput> {
  const fileOptions: FileAccessOptions = config.files ?? {};
  const source = buildSource(input, fileOptions);
  const entries = source.entries;

  const chunks = chunkCandidates(input.query, entries, input.instructions);
  // File sources fan out wider by default: the work is one request per batch of
  // chunks, and a 400-file glob is otherwise serialised four at a time.
  const concurrency =
    source.fromFiles && config.maxConcurrencyExplicit !== true
      ? Math.max(config.maxConcurrency, FILE_CONCURRENCY)
      : config.maxConcurrency;
  const started = Date.now();

  const results = await mapWithConcurrency(chunks, concurrency, async (chunk) => {
    const { state, questions } = buildRequest(input.query, chunk, input.instructions);
    const request: EvaluateRequest = { state, questions };
    if (signal !== undefined) request.signal = signal;
    const result = await model.evaluate(request);
    return { chunk, result };
  });

  const scored: Scored[] = [];
  let anyRelevant = 0;

  for (const { chunk, result } of results) {
    const answers = result.answers as Record<string, NoulAnswer | undefined>;
    chunk.forEach((entry, localIndex) => {
      const answer = answers[`cand_${localIndex}`];
      scored.push({ entry, relevance: answer?.noul ?? 0 });
    });
    const any = answers[ANY_RELEVANT_ID]?.noul;
    if (typeof any === "number" && any > anyRelevant) anyRelevant = any;
  }

  const unit: RankUnit = input.unit ?? "chunk";
  const rows = source.fromFiles && unit === "file" ? foldToFiles(scored) : scored;

  const minRelevance = input.min_relevance ?? 0;
  const topK = input.top_k ?? DEFAULT_TOP_K;

  const ranked = rows
    .filter((item) => item.relevance >= minRelevance)
    .sort((a, b) => b.relevance - a.relevance || a.entry.index - b.entry.index)
    .slice(0, topK)
    .map((item, position) => {
      const row: RankToolOutput["ranked"][number] = { relevance: item.relevance, rank: position + 1 };
      if (item.entry.where === undefined) {
        row.id = item.entry.id;
      } else {
        row.path = item.entry.where.path;
        row.start_line = item.entry.where.start_line;
        row.end_line = item.entry.where.end_line;
      }
      return row;
    });

  const output: RankToolOutput = {
    ranked,
    any_relevant: anyRelevant,
    // Over everything judged, not just the rows that survived top_k: the
    // question it answers is whether the model discriminated at all.
    score_spread: scoreSpread(rows.map((row) => row.relevance)),
    chunks: chunks.length,
    total_candidates: rows.length,
    model: results[0]?.result.model ?? model.name,
    usage: sumUsage(results.map(({ result }) => result.usage)),
    latency_ms: Date.now() - started,
  };

  if (source.files !== undefined) {
    output.files_scanned = source.files.files_scanned;
    output.chunks_scored = source.files.chunks_scored;
    output.skipped = source.files.skipped;
    // The estimate is what the ceiling was enforced against; `usage` below is
    // what the API actually billed.
    output.est_cost_usd = source.files.est_cost_usd;
  }

  return output;
}

/** Re-exported for tests that build a selection without touching a model. */
export { emptySkipped, estimateCostUsd };
