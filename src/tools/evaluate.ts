/**
 * `jev_evaluate` — the generic primitive.
 *
 * Everything the other tools do is a special case of this: one state, a map of
 * typed questions, one round trip, and a deterministic gate computed in code
 * from the returned certainty.
 */

import { z } from "zod";
import { gate, gateNoul, resolveThresholds } from "../decision/policy.js";
import type { Answer, DecisionModel, EvaluateRequest, Gate, Question } from "../decision/types.js";
import {
  envelopeShape,
  gateSchema,
  questionSchema,
  stateSchema,
  thresholdsSchema,
  toQuestion,
  toState,
  type ToolConfig,
} from "./shared.js";

export const name = "jev_evaluate";

/**
 * Kept under the 1200-character cap `tests/server.test.ts` holds every tool
 * description to. 0.5.0 spends some of that budget on the structured-criteria
 * bullet; the Choice escape-hatch coaching it displaced now lives only on the
 * `criteria` field's own schema description, where a caller writing one reads it.
 */
export const description = [
  "Ask Jev — a fast, calibrated judgment model — many typed questions about one shared state; returns probabilities plus a gate computed in code. Use it when no other jev_* tool fits.",
  "Writing questions (Jev reads literally):",
  "- State the exact condition in `instructions`; put boundary cases in `criteria`.",
  "- Criteria accept JSON: Choice options and Noul sides as {what, not_for, examples}; Score levels as {summary, signals}. Put lookalike cases under not_for on the side they would wrongly land on.",
  "- One judgment per question; split compound ones and combine in code.",
  "- Batch every question sharing a state into ONE call. They run in parallel and cost only their own tokens, so speculative questions are nearly free.",
  "- Send only the state the question needs; point at parts by path, e.g. `ticket.messages[0].text`.",
  "- Never ask it to count, do arithmetic, or compare dates/numbers — compute those in code and pass the result in.",
  "Answers: it selects from your options and never generates text; `noul` is P(yes), ~0.5 means unsure; choice/score carry `confidence`; `gate` is auto/review/escalate.",
  "Budget: ~64k tokens state + all questions, ~32k state + longest question.",
].join("\n");

export const inputShape = {
  state: stateSchema,
  questions: z
    .record(z.string(), questionSchema)
    .describe("Map of question id -> question. Ids are yours; answers come back under the same ids."),
  model: z.string().optional().describe("Override the configured model, e.g. `jev-1.13.0` to pin a version."),
  thresholds: thresholdsSchema,
} as const;

export const inputSchema = z.object(inputShape);
export type EvaluateToolInput = z.infer<typeof inputSchema>;

const gatedAnswerSchema = z.discriminatedUnion("type", [
  z.looseObject({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
    gate: gateSchema,
  }),
  z.looseObject({
    type: z.literal("score"),
    score: z.number(),
    legend: z.record(z.string(), z.string()).optional(),
    probabilities: z.record(z.string(), z.number()).optional(),
    confidence: z.number(),
    gate: gateSchema,
  }),
  z.looseObject({
    type: z.literal("noul"),
    noul: z.number(),
    certainty: z.number(),
    verdict: z.enum(["yes", "no"]),
    gate: gateSchema,
  }),
]);

export const outputShape = {
  answers: z
    .record(z.string(), gatedAnswerSchema)
    .describe("One answer per question id, each augmented with a `gate` computed in code."),
  thresholds: z.object({ auto: z.number(), review: z.number() }).describe("The thresholds actually applied."),
  ...envelopeShape,
} as const;

export const outputSchema = z.object(outputShape);
export type EvaluateToolOutput = z.infer<typeof outputSchema>;

/** An answer plus the policy fields code derived from it. */
export type GatedAnswer = Answer & { gate: Gate; certainty?: number; verdict?: "yes" | "no" };

export async function run(
  model: DecisionModel,
  input: EvaluateToolInput,
  config: ToolConfig,
  signal?: AbortSignal,
): Promise<EvaluateToolOutput> {
  const thresholds = resolveThresholds(config.thresholds, input.thresholds);

  const questions: Record<string, Question> = {};
  for (const [id, question] of Object.entries(input.questions)) {
    questions[id] = toQuestion(question);
  }

  const request: EvaluateRequest = { state: toState(input.state), questions };
  if (input.model !== undefined) request.model = input.model;
  if (signal !== undefined) request.signal = signal;

  const result = await model.evaluate(request);

  const answers: Record<string, GatedAnswer> = {};
  for (const [id, answer] of Object.entries(result.answers as Record<string, Answer>)) {
    answers[id] = augment(answer, thresholds);
  }

  return {
    answers: answers as EvaluateToolOutput["answers"],
    thresholds,
    model: result.model,
    usage: result.usage,
    latency_ms: result.latency_ms,
  };
}

/**
 * Attach the gate. Choice and Score gate on `confidence`. A Noul has no
 * confidence, so it gates two-sided on `max(p, 1 - p)` and reports which side
 * it landed on — a confident "no" is 0.02, which must not read as low certainty.
 */
export function augment(answer: Answer, thresholds: { auto: number; review: number }): GatedAnswer {
  if (answer.type === "noul") {
    const { gate: band, certainty, verdict } = gateNoul(answer.noul, thresholds);
    return { ...answer, gate: band, certainty, verdict };
  }
  return { ...answer, gate: gate(answer.confidence, thresholds) };
}
