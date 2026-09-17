/**
 * A `DecisionModel` that answers from a function instead of a network.
 *
 * Tools are written against the contract, so this is all they need — no HTTP
 * stubbing, no fixtures for the wire format.
 */

import type { ListModelsResult, ModelCatalog, ModelInfo } from "../../src/decision/models.js";
import type {
  Answer,
  ChoiceAnswer,
  ChoiceQuestion,
  DecisionModel,
  EvaluateRequest,
  EvaluateResult,
  NoulQuestion,
  Question,
  ScoreAnswer,
  ScoreQuestion,
  State,
  Usage,
} from "../../src/decision/types.js";

export interface RecordedCall {
  state: State;
  questions: Record<string, Question>;
  model?: string | undefined;
}

export type Responder = (call: RecordedCall) => Record<string, Answer>;

export interface FakeModelOptions {
  /** Reported as the answering model. */
  answeredBy?: string;
  usage?: Usage;
  latencyMs?: number;
  models?: ModelInfo[];
}

export class FakeModel implements DecisionModel, ModelCatalog {
  readonly name = "fake-latest";
  readonly calls: RecordedCall[] = [];

  private readonly responder: Responder;
  private readonly options: FakeModelOptions;

  constructor(responder: Responder, options: FakeModelOptions = {}) {
    this.responder = responder;
    this.options = options;
  }

  async evaluate<Q extends Record<string, Question>>(request: EvaluateRequest<Q>): Promise<EvaluateResult<Q>> {
    const call: RecordedCall = {
      state: request.state,
      questions: request.questions as Record<string, Question>,
      model: request.model,
    };
    this.calls.push(call);
    return {
      model: this.options.answeredBy ?? "fake-1.0.0",
      answers: this.responder(call) as EvaluateResult<Q>["answers"],
      usage: this.options.usage ?? { input_tokens: 100, output_tokens: 10 },
      latency_ms: this.options.latencyMs ?? 7,
    };
  }

  async choice(state: State, question: Omit<ChoiceQuestion, "type">): Promise<ChoiceAnswer> {
    const result = await this.evaluate({ state, questions: { q: { type: "choice", ...question } } });
    return result.answers.q;
  }

  async score(state: State, question: Omit<ScoreQuestion, "type">): Promise<ScoreAnswer> {
    const result = await this.evaluate({ state, questions: { q: { type: "score", ...question } } });
    return result.answers.q;
  }

  async probability(state: State, question: Omit<NoulQuestion, "type">): Promise<number> {
    const result = await this.evaluate({ state, questions: { q: { type: "noul", ...question } } });
    return result.answers.q.noul;
  }

  async listModels(): Promise<ListModelsResult> {
    return { models: this.options.models ?? [] };
  }
}

/** Answer every question of a request by type, using fixed values. */
export function noul(value: number): Answer {
  return { type: "noul", noul: value };
}

export function choice(picked: string, probabilities: Record<string, number>, confidence: number): Answer {
  return { type: "choice", choice: picked, probabilities, confidence };
}

export function score(value: number, levels: string[], confidence: number): Answer {
  const legend: Record<string, string> = {};
  levels.forEach((level, index) => {
    legend[String(index)] = level;
  });
  return { type: "score", score: value, legend, confidence };
}

/** Config slice the tools take. */
export const testConfig = {
  model: "jev-latest",
  thresholds: { auto: 0.85, review: 0.6 },
  maxConcurrency: 4,
};
