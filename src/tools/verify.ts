/**
 * `jev_verify` — check claims against supplied evidence, and only that evidence.
 *
 * One Choice per claim over supported / contradicted / not_addressed. The whole
 * point of the rubric is the third option: without it the model is forced to
 * pick a side on a claim the evidence never mentions.
 */

import { z } from "zod";
import { gateChoice, resolveThresholds } from "../decision/policy.js";
import type { ChoiceAnswer, DecisionModel, EvaluateRequest, Gate, Json, Question } from "../decision/types.js";
import { envelopeShape, gateSchema, thresholdsSchema, type ToolConfig } from "./shared.js";

export const name = "jev_verify";

export const description = [
  "Check each of up to 100 claims against one block of evidence, and get supported / contradicted / not_addressed per claim with a calibrated confidence.",
  "Use it before you assert something to the user or write it into a file: verify your draft's factual claims against the source you actually read, or check a summary against the document it summarises.",
  "The rubric is strictly literal and closed-world: a claim counts as supported only if the evidence states or directly entails it. A claim that is true in the world but absent from the evidence comes back `not_addressed`, which is the answer you want when you are checking for unsupported assertions.",
  "Claims should be single, self-contained statements — split compound sentences, and resolve pronouns before sending. Evidence should be the passage you want to hold the claims to, nothing more.",
  "`all_supported` is true only when every claim is supported AND the model was confident about each one; treat `review`/`escalate` gates as claims a human should look at.",
].join("\n");

export const inputShape = {
  claims: z
    .array(z.string().min(1))
    .min(1)
    .max(100)
    .describe("Self-contained statements to check, one per entry. Split compound claims."),
  evidence: z.string().min(1).describe("The only material the claims are judged against."),
  thresholds: thresholdsSchema,
} as const;

export const inputSchema = z.object(inputShape);
export type VerifyToolInput = z.infer<typeof inputSchema>;

export const VERDICTS = ["supported", "contradicted", "not_addressed"] as const;
export type Verdict = (typeof VERDICTS)[number];

const verdictSchema = z.enum(VERDICTS);

export const outputShape = {
  claims: z
    .array(
      z.object({
        claim: z.string(),
        verdict: verdictSchema,
        probabilities: z.record(z.string(), z.number()),
        confidence: z.number(),
        gate: gateSchema,
      }),
    )
    .describe("One result per input claim, in input order."),
  summary: z
    .object({
      supported: z.number().int(),
      contradicted: z.number().int(),
      not_addressed: z.number().int(),
      needs_review: z.number().int().describe("Claims whose gate is not `auto`."),
    })
    .describe("Counts across all claims."),
  all_supported: z
    .boolean()
    .describe("True only if every claim is `supported` and every gate is `auto`."),
  thresholds: z.object({ auto: z.number(), review: z.number() }),
  ...envelopeShape,
} as const;

export const outputSchema = z.object(outputShape);
export type VerifyToolOutput = z.infer<typeof outputSchema>;

/**
 * The rubric. Written so each option says what must be *present in the
 * evidence*, because Jev reads the instructions literally and will otherwise
 * fall back on world knowledge.
 */
const CRITERIA: Record<Verdict, string> = {
  supported:
    "`evidence` explicitly states the claim, or states something that directly entails it. " +
    "Outside knowledge does not count, no matter how obviously true the claim is.",
  contradicted:
    "`evidence` explicitly states something that cannot be true at the same time as the claim.",
  not_addressed:
    "`evidence` says nothing that settles the claim either way. Choose this when the claim is merely " +
    "plausible, when it is true in the world but not stated in `evidence`, or when `evidence` only " +
    "touches a related but different point.",
};

function claimQuestion(index: number): Question {
  return {
    type: "choice",
    instructions:
      `Considering only the text in \`evidence\`, how does \`evidence\` treat the statement in \`claims[${index}]\`?`,
    criteria: { ...CRITERIA },
  };
}

function questionId(index: number): string {
  return `claim_${index}`;
}

export interface ClaimResult {
  claim: string;
  verdict: Verdict;
  probabilities: Record<string, number>;
  confidence: number;
  gate: Gate;
}

/** `all_supported` demands both the verdict and the certainty. Pure. */
export function allSupported(results: readonly ClaimResult[]): boolean {
  return results.length > 0 && results.every((r) => r.verdict === "supported" && r.gate === "auto");
}

export async function run(
  model: DecisionModel,
  input: VerifyToolInput,
  config: ToolConfig,
  signal?: AbortSignal,
): Promise<VerifyToolOutput> {
  const thresholds = resolveThresholds(config.thresholds, input.thresholds);

  const state: Record<string, Json> = { evidence: input.evidence, claims: [...input.claims] };
  const questions: Record<string, Question> = {};
  input.claims.forEach((_claim, index) => {
    questions[questionId(index)] = claimQuestion(index);
  });

  const request: EvaluateRequest = { state, questions };
  if (signal !== undefined) request.signal = signal;

  const result = await model.evaluate(request);
  const answers = result.answers as Record<string, ChoiceAnswer | undefined>;

  const claims: ClaimResult[] = input.claims.map((claim, index) => {
    const answer = answers[questionId(index)];
    if (answer === undefined) {
      // The client verifies ids before we get here; this is belt and braces.
      return { claim, verdict: "not_addressed", probabilities: {}, confidence: 0, gate: "escalate" };
    }
    return {
      claim,
      verdict: normalizeVerdict(answer.choice),
      probabilities: answer.probabilities,
      confidence: answer.confidence,
      gate: gateChoice(answer, thresholds),
    };
  });

  const summary = {
    supported: claims.filter((c) => c.verdict === "supported").length,
    contradicted: claims.filter((c) => c.verdict === "contradicted").length,
    not_addressed: claims.filter((c) => c.verdict === "not_addressed").length,
    needs_review: claims.filter((c) => c.gate !== "auto").length,
  };

  return {
    claims,
    summary,
    all_supported: allSupported(claims),
    thresholds,
    model: result.model,
    usage: result.usage,
    latency_ms: result.latency_ms,
  };
}

function normalizeVerdict(choice: string): Verdict {
  return (VERDICTS as readonly string[]).includes(choice) ? (choice as Verdict) : "not_addressed";
}
