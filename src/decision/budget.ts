/**
 * Context budgeting for a single evaluate request.
 *
 * Jev ingests the state once and then answers every question against it in
 * parallel, so its context limit has two parts rather than one:
 *
 *   - 64k tokens for the state plus *all* questions together
 *   - 32k tokens for the state plus the *single longest* question
 *
 * Both are checked before a request goes out, so an oversized request fails
 * locally with a message naming the limit instead of coming back as a 422.
 *
 * Token counts are estimates. TypeSafe publishes no tokenizer, so we use a
 * deliberately pessimistic 3.5 characters per token — the docs put 32k tokens
 * at roughly 150k characters of English (≈4.7 chars/token), so this leaves
 * headroom rather than eating into it.
 */

import type { Instructions, Question, State } from "./types.js";

/** Characters per token. Lower is more conservative. */
export const CHARS_PER_TOKEN = 3.5;

export interface BudgetLimits {
  /** Ceiling for state + every question in the request. */
  total: number;
  /** Ceiling for state + the longest single question. */
  statePlusLongestQuestion: number;
}

export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  total: 64_000,
  statePlusLongestQuestion: 32_000,
};

export interface BudgetEstimate {
  state_tokens: number;
  questions_tokens: number;
  longest_question_tokens: number;
  /** Id of the question that drives `state_plus_longest_tokens`. */
  longest_question_id: string | null;
  /** state + all questions. */
  total_tokens: number;
  /** state + the longest single question. */
  state_plus_longest_tokens: number;
}

export type BudgetLimitName = "total" | "state_plus_longest_question";

/** Thrown when a request would exceed a context limit. Never retryable. */
export class BudgetError extends Error {
  readonly limit: BudgetLimitName;
  readonly limits: BudgetLimits;
  readonly estimate: BudgetEstimate;

  constructor(message: string, limit: BudgetLimitName, limits: BudgetLimits, estimate: BudgetEstimate) {
    super(message);
    this.name = "BudgetError";
    this.limit = limit;
    this.limits = limits;
    this.estimate = estimate;
  }
}

/**
 * Conservative token estimate for any JSON-serializable value.
 *
 * Strings are measured directly; anything else is measured as the JSON that
 * will actually be sent on the wire, so keys and punctuation are counted.
 */
export function estimateTokens(value: unknown): number {
  if (value === undefined) return 0;
  const text = typeof value === "string" ? value : stringify(value);
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Tokens a single question contributes: its instructions plus its criteria. */
export function estimateQuestionTokens(question: Question): number {
  const instructions = estimateTokens(question.instructions as Instructions);
  const criteria = "criteria" in question ? estimateTokens(question.criteria) : 0;
  // A few tokens of JSON scaffolding per question (`type`, braces, the id).
  return instructions + criteria + 8;
}

/** Measure a request without enforcing anything. */
export function estimateBudget(state: State, questions: Record<string, Question>): BudgetEstimate {
  const stateTokens = estimateTokens(state);

  let questionsTokens = 0;
  let longestTokens = 0;
  let longestId: string | null = null;

  for (const [id, question] of Object.entries(questions)) {
    const tokens = estimateQuestionTokens(question);
    questionsTokens += tokens;
    if (tokens > longestTokens) {
      longestTokens = tokens;
      longestId = id;
    }
  }

  return {
    state_tokens: stateTokens,
    questions_tokens: questionsTokens,
    longest_question_tokens: longestTokens,
    longest_question_id: longestId,
    total_tokens: stateTokens + questionsTokens,
    state_plus_longest_tokens: stateTokens + longestTokens,
  };
}

/**
 * Enforce both limits. Returns the estimate on success; throws `BudgetError`
 * naming the limit that was exceeded, with both the estimate and the ceiling.
 */
export function checkBudget(
  state: State,
  questions: Record<string, Question>,
  limits: BudgetLimits = DEFAULT_BUDGET_LIMITS,
): BudgetEstimate {
  const estimate = estimateBudget(state, questions);
  const count = Object.keys(questions).length;

  if (estimate.total_tokens > limits.total) {
    throw new BudgetError(
      `Request exceeds the total context limit (state + all questions): ` +
        `~${estimate.total_tokens} estimated tokens against a limit of ${limits.total} ` +
        `(state ~${estimate.state_tokens}, ${count} question${count === 1 ? "" : "s"} ~${estimate.questions_tokens}). ` +
        `Send a smaller state, or split the questions across requests.`,
      "total",
      limits,
      estimate,
    );
  }

  if (estimate.state_plus_longest_tokens > limits.statePlusLongestQuestion) {
    const which = estimate.longest_question_id === null ? "the longest question" : `question "${estimate.longest_question_id}"`;
    throw new BudgetError(
      `Request exceeds the state + longest-question context limit: ` +
        `~${estimate.state_plus_longest_tokens} estimated tokens against a limit of ${limits.statePlusLongestQuestion} ` +
        `(state ~${estimate.state_tokens}, ${which} ~${estimate.longest_question_tokens}). ` +
        `Shrink the state or shorten that question's instructions and criteria.`,
      "state_plus_longest_question",
      limits,
      estimate,
    );
  }

  return estimate;
}

/** Non-throwing form, for chunkers that need to probe a candidate packing. */
export function fitsBudget(
  state: State,
  questions: Record<string, Question>,
  limits: BudgetLimits = DEFAULT_BUDGET_LIMITS,
): boolean {
  const estimate = estimateBudget(state, questions);
  return (
    estimate.total_tokens <= limits.total &&
    estimate.state_plus_longest_tokens <= limits.statePlusLongestQuestion
  );
}
