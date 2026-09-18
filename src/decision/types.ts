/**
 * Provider-agnostic decision-model contract.
 *
 * A DecisionModel answers typed questions about a shared `state`. It never
 * generates free text: every answer is drawn from an answer space the caller
 * defined. Jev is one implementation; an LLM structured-output adapter can
 * implement the same interface.
 *
 * Wire shapes below intentionally mirror TypeSafe's /v1/systemone API so the
 * Jev implementation is a passthrough.
 */

/** JSON-serializable content. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** The content being judged. A string, or structured data questions can reference by path. */
export type State = string | Json[] | { [key: string]: Json };

/** Instructions accept plain text or JSON structure. */
export type Instructions = string | Json[] | { [key: string]: Json };

/**
 * What one rubric entry may be.
 *
 * Prose or JSON structure, because the same jaggedness that makes structured
 * *instructions* work applies to criteria: `{what, not_for, examples}` on the
 * side a lookalike case would wrongly land on moves answers that a paragraph
 * does not. `null` is a value, not an absence — it says "the name says it all".
 */
export type EntryType = string | Json[] | { [key: string]: Json } | null;

export interface ChoiceQuestion {
  type: "choice";
  instructions: Instructions;
  /** option -> rubric entry (null when the option name is self-explanatory). */
  criteria: Record<string, EntryType>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: Instructions;
  /** Ordered level descriptions, lowest first. At least two. */
  criteria: EntryType[];
}

export interface NoulQuestion {
  type: "noul";
  instructions: Instructions;
  criteria?: { true?: EntryType; false?: EntryType };
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  /** 0..1, how peaked the distribution is. */
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  /** Probability-weighted level index; may fall between levels. */
  score: number;
  legend: Record<string, string>;
  /** Absent from some provider responses. */
  probabilities?: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: "noul";
  /** P(yes), 0..1. Has no separate confidence. */
  noul: number;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export type AnswerFor<Q extends Question> = Q extends ChoiceQuestion
  ? ChoiceAnswer
  : Q extends ScoreQuestion
    ? ScoreAnswer
    : Q extends NoulQuestion
      ? NoulAnswer
      : never;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface EvaluateRequest<Q extends Record<string, Question> = Record<string, Question>> {
  state: State;
  questions: Q;
  /** Overrides the model configured on the DecisionModel. */
  model?: string;
  signal?: AbortSignal;
}

export interface EvaluateResult<Q extends Record<string, Question> = Record<string, Question>> {
  /** Versioned model id that actually answered. */
  model: string;
  answers: { [K in keyof Q]: AnswerFor<Q[K]> };
  usage: Usage;
  /** Wall-clock time including retries. */
  latency_ms: number;
  /**
   * Set by a caching wrapper when this answer came from its cache rather than
   * from the provider. Absent means "this call really happened".
   *
   * It is here rather than in the wrapper's own type because the whole point is
   * that a caller logging cost and latency can tell the difference: a hit
   * reports `latency_ms: 0` and `input_tokens: 0`, and without this flag those
   * zeroes would be indistinguishable from an implausibly fast real call.
   */
  memo?: boolean;
}

export interface DecisionModel {
  readonly name: string;

  /**
   * Evaluate many independent questions against one state in a single call.
   * This is the primitive; prefer it over the single-question helpers whenever
   * several judgments share a state.
   */
  evaluate<Q extends Record<string, Question>>(request: EvaluateRequest<Q>): Promise<EvaluateResult<Q>>;

  choice(state: State, question: Omit<ChoiceQuestion, "type">): Promise<ChoiceAnswer>;
  score(state: State, question: Omit<ScoreQuestion, "type">): Promise<ScoreAnswer>;
  /** P(yes) for a yes/no question. */
  probability(state: State, question: Omit<NoulQuestion, "type">): Promise<number>;
}

/** What deterministic policy does with a judgment. */
export type Gate = "auto" | "review" | "escalate";

export interface GateThresholds {
  /** At or above: act automatically. */
  auto: number;
  /** At or above (and below `auto`): proceed with caution / confirm. Below: escalate. */
  review: number;
}
