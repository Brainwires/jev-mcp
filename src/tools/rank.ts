/**
 * `jev_rank` — relevance-rank candidate texts against a query.
 *
 * One Noul per candidate, batched into as few requests as the context budget
 * allows. The model never sees candidate ids: ids are arbitrary caller strings
 * and would be both a distractor in the state and unsafe as question keys, so
 * candidates go in as an index-keyed array and the indices are mapped back to
 * ids in code.
 */

import { z } from "zod";
import { BudgetError, DEFAULT_BUDGET_LIMITS, estimateBudget, fitsBudget, type BudgetLimits } from "../decision/budget.js";
import type { DecisionModel, EvaluateRequest, Json, NoulAnswer, Question, State } from "../decision/types.js";
import { envelopeShape, mapWithConcurrency, sumUsage, type ToolConfig } from "./shared.js";

export const name = "jev_rank";

export const description = [
  "Rank up to 500 candidate texts by how well each helps answer a query, using Jev's calibrated yes/no judgment (one question per candidate, batched).",
  "Use it to triage search hits, retrieved passages, files, tool results or skills before you spend reading budget on them — and to find out whether *anything* in the set is relevant at all (`any_relevant`).",
  "Candidates are judged independently and in parallel, so ranking 200 is barely slower than ranking 5. Oversized sets are auto-chunked to fit the context budget.",
  "Pass short, self-contained candidate texts (a snippet, a docstring, a summary); a whole file per candidate wastes budget and dilutes the judgment. Candidate text is NOT echoed back — keep your own id -> text map.",
  "`relevance` is P(helps answer the query): near 1 relevant, near 0 not, near 0.5 the model is unsure. Use `min_relevance` to drop the tail rather than trusting the ordering of near-ties.",
].join("\n");

const candidateSchema = z.object({
  id: z.string().min(1).describe("Your identifier for this candidate. Returned as-is; never shown to the model."),
  text: z.string().describe("The candidate text to judge. Keep it to the part that could answer the query."),
});

export const inputShape = {
  query: z.string().min(1).describe("What you are trying to find out."),
  candidates: z.array(candidateSchema).min(1).max(500).describe("The candidates to rank, 1 to 500."),
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

export const inputSchema = z.object(inputShape);
export type RankToolInput = z.infer<typeof inputSchema>;

export const outputShape = {
  ranked: z
    .array(
      z.object({
        id: z.string(),
        relevance: z.number().describe("P(this candidate helps answer the query), 0..1."),
        rank: z.number().int().describe("1-based position after sorting and filtering."),
      }),
    )
    .describe("Sorted by relevance descending; ties keep input order. Candidate text is not echoed back."),
  any_relevant: z
    .number()
    .describe("P(at least one candidate helps answer the query), the maximum across chunks. Low means: look elsewhere."),
  chunks: z.number().int().describe("How many API requests the candidate set was split into."),
  total_candidates: z.number().int().describe("How many candidates were judged, before top_k/min_relevance."),
  ...envelopeShape,
} as const;

export const outputSchema = z.object(outputShape);
export type RankToolOutput = z.infer<typeof outputSchema>;

const ANY_RELEVANT_ID = "any_relevant";
const DEFAULT_TOP_K = 10;

export interface Entry {
  id: string;
  text: string;
  /** Position in the caller's input array; the stable tie-break. */
  index: number;
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
 * Greedily pack candidates into chunks that each fit the budget. Every chunk
 * carries the query and only its own candidates, so the per-chunk state stays
 * small — which is also what the model wants (unrelated state costs accuracy).
 */
export function chunkCandidates(
  query: string,
  entries: readonly Entry[],
  extra: string | undefined,
  limits: BudgetLimits = DEFAULT_BUDGET_LIMITS,
): Entry[][] {
  const chunks: Entry[][] = [];
  let current: Entry[] = [];

  for (const entry of entries) {
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

export async function run(
  model: DecisionModel,
  input: RankToolInput,
  config: ToolConfig,
  signal?: AbortSignal,
): Promise<RankToolOutput> {
  const entries: Entry[] = input.candidates.map((candidate, index) => ({
    id: candidate.id,
    text: candidate.text,
    index,
  }));

  const chunks = chunkCandidates(input.query, entries, input.instructions);
  const started = Date.now();

  const results = await mapWithConcurrency(chunks, config.maxConcurrency, async (chunk) => {
    const { state, questions } = buildRequest(input.query, chunk, input.instructions);
    const request: EvaluateRequest = { state, questions };
    if (signal !== undefined) request.signal = signal;
    const result = await model.evaluate(request);
    return { chunk, result };
  });

  const scored: { id: string; relevance: number; index: number }[] = [];
  let anyRelevant = 0;

  for (const { chunk, result } of results) {
    const answers = result.answers as Record<string, NoulAnswer | undefined>;
    chunk.forEach((entry, localIndex) => {
      const answer = answers[`cand_${localIndex}`];
      scored.push({ id: entry.id, relevance: answer?.noul ?? 0, index: entry.index });
    });
    const any = answers[ANY_RELEVANT_ID]?.noul;
    if (typeof any === "number" && any > anyRelevant) anyRelevant = any;
  }

  const minRelevance = input.min_relevance ?? 0;
  const topK = input.top_k ?? DEFAULT_TOP_K;

  const ranked = scored
    .filter((item) => item.relevance >= minRelevance)
    .sort((a, b) => b.relevance - a.relevance || a.index - b.index)
    .slice(0, topK)
    .map((item, position) => ({ id: item.id, relevance: item.relevance, rank: position + 1 }));

  return {
    ranked,
    any_relevant: anyRelevant,
    chunks: chunks.length,
    total_candidates: entries.length,
    model: results[0]?.result.model ?? model.name,
    usage: sumUsage(results.map(({ result }) => result.usage)),
    latency_ms: Date.now() - started,
  };
}
