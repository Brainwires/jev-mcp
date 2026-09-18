/**
 * `jev_verify` — check claims against supplied evidence, and only that evidence.
 *
 * One Choice per claim over supported / contradicted / not_addressed. The whole
 * point of the rubric is the third option: without it the model is forced to
 * pick a side on a claim the evidence never mentions.
 *
 * `evidence_path` is the cheap way in. The caller names the file it wants its
 * draft held to and the server reads it, so the evidence never passes through
 * the caller's context on its way to being checked. Evidence too large for one
 * request is split, every claim is judged against every piece, and the pieces
 * are merged in code — because "which chunk was most sure" is arithmetic, and
 * arithmetic is not something to ask a classifier.
 */

import { z } from "zod";
import { DEFAULT_BUDGET_LIMITS, estimateTokens, fitsBudget, type BudgetLimits } from "../decision/budget.js";
import { gate, gateChoice, resolveThresholds } from "../decision/policy.js";
import { estimateCostUsd } from "../decision/pricing.js";
import type {
  ChoiceAnswer,
  DecisionModel,
  EvaluateRequest,
  Gate,
  GateThresholds,
  Json,
  Question,
} from "../decision/types.js";
import {
  FileSelectionError,
  MAX_INPUT_TOKENS,
  readTextFile,
  resolveInsideRoot,
  rootOf,
  type FileAccessOptions,
} from "../files/index.js";
import { envelopeShape, gateSchema, mapWithConcurrency, sumUsage, thresholdsSchema, type ToolConfig } from "./shared.js";

export const name = "jev_verify";

export const description = [
  "Check up to 100 claims against one body of evidence: supported / contradicted / not_addressed per claim, with a calibrated confidence.",
  "Pass `evidence_path` for anything you have not already read — do NOT read a file in order to pass its text. The server reads it, chunks it if it is large, checks every claim against every chunk and returns line ranges. Use `evidence` only for text you already hold.",
  "Use it before you assert something to the user or write it into a file: hold your draft's claims to the source, or check a summary against the document it summarises.",
  "The rubric is strictly literal and closed-world: supported only if the evidence states or entails it. A claim that is true in the world but absent from the evidence comes back `not_addressed` — which is the answer you want when hunting unsupported assertions. `conflicting` means one part of the evidence firmly supports it and another firmly contradicts it.",
  "Claims should be single, self-contained statements — split compound sentences and resolve pronouns first.",
  "`all_supported` is true only when every claim is supported AND the model was confident about each; treat `review`/`escalate` gates as claims a human should look at.",
].join("\n");

export const inputShape = {
  claims: z
    .array(z.string().min(1))
    .min(1)
    .max(100)
    .describe("Self-contained statements to check, one per entry. Split compound claims."),
  evidence: z.string().min(1).optional().describe("Text you already hold. The only material the claims are judged against."),
  evidence_path: z
    .string()
    .min(1)
    .optional()
    .describe("A file for the server to read, relative to the project root. Preferred over pasting file text."),
  start_line: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("With `evidence_path`: first line to use, 1-based inclusive. Default 1."),
  end_line: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("With `evidence_path`: last line to use, 1-based inclusive. Default end of file."),
  thresholds: thresholdsSchema,
} as const;

export const inputSchema = z.object(inputShape).refine(
  (value) => [value.evidence, value.evidence_path].filter((v) => v !== undefined).length === 1,
  {
    message:
      "Pass exactly one of `evidence` or `evidence_path`. Use `evidence_path` for a file you have not read " +
      "(the server reads it); `evidence` only for text you already hold.",
  },
);
export type VerifyToolInput = z.infer<typeof inputSchema>;

/** The rubric the model chooses from. */
export const VERDICTS = ["supported", "contradicted", "not_addressed"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** What a merge across chunks can conclude, which the rubric alone cannot. */
export const MERGED_VERDICTS = [...VERDICTS, "conflicting"] as const;
export type MergedVerdict = (typeof MERGED_VERDICTS)[number];

const verdictSchema = z.enum(MERGED_VERDICTS);

export const outputShape = {
  claims: z
    .array(
      z.object({
        claim: z.string(),
        verdict: verdictSchema,
        probabilities: z.record(z.string(), z.number()),
        confidence: z.number(),
        gate: gateSchema,
        where: z
          .object({ start_line: z.number().int(), end_line: z.number().int() })
          .optional()
          .describe("Which lines of the evidence settled it. Present when the evidence came from a file or was chunked."),
      }),
    )
    .describe("One result per input claim, in input order."),
  summary: z
    .object({
      supported: z.number().int(),
      contradicted: z.number().int(),
      not_addressed: z.number().int(),
      conflicting: z.number().int().describe("Firmly supported by one part of the evidence and contradicted by another."),
      needs_review: z.number().int().describe("Claims whose gate is not `auto`."),
    })
    .describe("Counts across all claims."),
  all_supported: z
    .boolean()
    .describe("True only if every claim is `supported` and every gate is `auto`."),
  thresholds: z.object({ auto: z.number(), review: z.number() }),
  evidence_chunks: z.number().int().describe("How many requests the evidence was split into. 1 unless it was large."),
  evidence_path: z.string().optional().describe("Present when the evidence was read from a file; relative to the root."),
  est_cost_usd: z.number().optional().describe("Present for file evidence: estimated input-token cost of this call."),
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
  verdict: MergedVerdict;
  probabilities: Record<string, number>;
  confidence: number;
  gate: Gate;
  where?: { start_line: number; end_line: number } | undefined;
}

/** `all_supported` demands both the verdict and the certainty. Pure. */
export function allSupported(results: readonly ClaimResult[]): boolean {
  return results.length > 0 && results.every((r) => r.verdict === "supported" && r.gate === "auto");
}

// ------------------------------------------------------------ evidence pieces

export interface EvidencePiece {
  text: string;
  /** 1-based inclusive, in the coordinates of the original file or string. */
  start_line: number;
  end_line: number;
}

/** Lines shared by two neighbouring pieces, so a split cannot hide support. */
const PIECE_OVERLAP_LINES = 5;

/**
 * Split evidence into pieces that each fit one request alongside every claim.
 *
 * Greedy and line-based: lines are added until the next one would not fit, then
 * a new piece starts a few lines back. A single line that does not fit on its
 * own is a request the caller has to narrow, and says so.
 */
export function packEvidence(
  text: string,
  claims: readonly string[],
  firstLine = 1,
  limits: BudgetLimits = DEFAULT_BUDGET_LIMITS,
): EvidencePiece[] {
  const questions: Record<string, Question> = {};
  claims.forEach((_claim, index) => {
    questions[questionId(index)] = claimQuestion(index);
  });
  const fits = (body: string): boolean =>
    fitsBudget({ evidence: body, claims: [...claims] } as unknown as Record<string, Json>, questions, limits);

  if (fits(text)) {
    const lineCount = text.split("\n").length;
    return [{ text, start_line: firstLine, end_line: firstLine + lineCount - 1 }];
  }

  const lines = text.split("\n");
  const pieces: EvidencePiece[] = [];
  let start = 0;

  while (start < lines.length) {
    let end = start;
    let accepted = "";
    while (end < lines.length) {
      const attempt = lines.slice(start, end + 1).join("\n");
      if (!fits(attempt)) break;
      accepted = attempt;
      end += 1;
    }

    if (end === start) {
      throw new FileSelectionError(
        "cost_ceiling",
        `Line ${firstLine + start} of the evidence is too long to verify on its own against ` +
          `${claims.length} claim${claims.length === 1 ? "" : "s"}. Pass fewer claims, or narrow the evidence ` +
          `with \`start_line\`/\`end_line\`.`,
      );
    }

    pieces.push({ text: accepted, start_line: firstLine + start, end_line: firstLine + end - 1 });
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - PIECE_OVERLAP_LINES);
  }

  return pieces;
}

interface PieceAnswer {
  piece: EvidencePiece;
  answer: ChoiceAnswer | undefined;
}

/**
 * Merge one claim's verdicts across evidence pieces.
 *
 * The rule, in order:
 *  - a piece that firmly supports and a piece that firmly contradicts means
 *    the evidence disagrees with itself: `conflicting`, and never automatic;
 *  - otherwise the piece that was most sure of *something* wins, measured as
 *    max(supported, contradicted), because `not_addressed` is the answer every
 *    piece gives about the parts of the document it does not contain;
 *  - `not_addressed` survives only if every piece said it.
 */
export function mergeClaim(
  claim: string,
  answers: readonly PieceAnswer[],
  thresholds: GateThresholds,
  reportWhere: boolean,
): ClaimResult {
  const present = answers.filter((a): a is { piece: EvidencePiece; answer: ChoiceAnswer } => a.answer !== undefined);
  if (present.length === 0) {
    // The client verifies ids before we get here; this is belt and braces.
    return { claim, verdict: "not_addressed", probabilities: {}, confidence: 0, gate: "escalate" };
  }

  const decisiveness = (a: ChoiceAnswer): number =>
    Math.max(a.probabilities.supported ?? 0, a.probabilities.contradicted ?? 0);

  const firmlySupports = present.some(
    (a) => normalizeVerdict(a.answer.choice) === "supported" && (a.answer.probabilities.supported ?? 0) >= thresholds.auto,
  );
  const firmlyContradicts = present.some(
    (a) =>
      normalizeVerdict(a.answer.choice) === "contradicted" && (a.answer.probabilities.contradicted ?? 0) >= thresholds.auto,
  );

  const best = present.reduce((a, b) => (decisiveness(b.answer) > decisiveness(a.answer) ? b : a));

  if (firmlySupports && firmlyContradicts) {
    const result: ClaimResult = {
      claim,
      verdict: "conflicting",
      probabilities: best.answer.probabilities,
      confidence: best.answer.confidence,
      gate: "escalate",
    };
    if (reportWhere) result.where = { start_line: best.piece.start_line, end_line: best.piece.end_line };
    return result;
  }

  const result: ClaimResult = {
    claim,
    verdict: normalizeVerdict(best.answer.choice),
    probabilities: best.answer.probabilities,
    confidence: best.answer.confidence,
    gate: gateChoice(best.answer, thresholds),
  };
  if (reportWhere) result.where = { start_line: best.piece.start_line, end_line: best.piece.end_line };
  return result;
}

// -------------------------------------------------------------------- the run

/**
 * Exactly one evidence source, checked here as well as in the zod refine: the
 * MCP server registers the raw shape, so the refine does not run on that path.
 */
export function validateSource(
  input: Pick<VerifyToolInput, "evidence" | "evidence_path" | "start_line" | "end_line">,
): void {
  const named = (["evidence", "evidence_path"] as const).filter((key) => input[key] !== undefined);
  if (named.length !== 1) {
    throw new FileSelectionError(
      "bad_source",
      named.length === 0
        ? "Pass exactly one of `evidence` or `evidence_path`. Use `evidence_path` for a file you have not read — " +
          "the server reads it — and `evidence` only for text you already hold."
        : "Pass exactly one of `evidence` or `evidence_path`; got both.",
    );
  }
  if (input.evidence !== undefined && (input.start_line !== undefined || input.end_line !== undefined)) {
    throw new FileSelectionError(
      "bad_source",
      "`start_line`/`end_line` select a window in `evidence_path`; they do not apply to inline `evidence`.",
    );
  }
}

/** Read `evidence_path`, honouring the line window and every refusal rule. */
function readEvidenceFile(input: VerifyToolInput, options: FileAccessOptions): { text: string; firstLine: number; path: string } {
  const root = rootOf(options);
  const named = input.evidence_path as string;
  const resolution = resolveInsideRoot(root, named);
  if (resolution.kind === "sensitive") {
    throw new FileSelectionError(
      "sensitive",
      `${named} holds credentials, so it is never read. Nothing was sent.`,
    );
  }
  if (resolution.kind === "outside_root") {
    throw new FileSelectionError(
      "outside_root",
      `${named} resolves outside the project root (${root}), so it is never read. Nothing was sent.`,
    );
  }
  if (resolution.kind === "not_found") {
    throw new FileSelectionError("not_found", `${named} is not a readable file under ${root}.`);
  }

  const read = readTextFile(resolution.absolute, options.maxFileBytes);
  if (read.kind === "binary") {
    throw new FileSelectionError("nothing_readable", `${resolution.relative} looks like a binary file.`);
  }
  if (read.kind === "too_large") {
    throw new FileSelectionError(
      "nothing_readable",
      `${resolution.relative} is over the size limit for one call. Use \`start_line\`/\`end_line\` to name a window.`,
    );
  }
  if (read.kind === "not_found") {
    throw new FileSelectionError("not_found", `${resolution.relative} could not be read.`);
  }

  const lines = read.text.split("\n");
  const first = Math.min(input.start_line ?? 1, lines.length);
  const last = Math.min(input.end_line ?? lines.length, lines.length);
  if (last < first) {
    throw new FileSelectionError(
      "bad_source",
      `end_line (${input.end_line}) is before start_line (${input.start_line}) in ${resolution.relative}.`,
    );
  }
  const text = lines.slice(first - 1, last).join("\n");
  if (text.trim() === "") {
    throw new FileSelectionError(
      "nothing_readable",
      `Lines ${first}-${last} of ${resolution.relative} contain no text to verify against.`,
    );
  }
  return { text, firstLine: first, path: resolution.relative };
}

export async function run(
  model: DecisionModel,
  input: VerifyToolInput,
  config: ToolConfig,
  signal?: AbortSignal,
): Promise<VerifyToolOutput> {
  validateSource(input);
  const thresholds = resolveThresholds(config.thresholds, input.thresholds);
  const fileOptions: FileAccessOptions = config.files ?? {};

  const fromFile = input.evidence_path !== undefined;
  const source = fromFile
    ? readEvidenceFile(input, fileOptions)
    : { text: input.evidence as string, firstLine: 1, path: undefined };

  const pieces = packEvidence(source.text, input.claims, source.firstLine);

  // Priced before anything is sent: every piece carries every claim, so the
  // cost is the product, not the sum.
  const estimated = pieces.reduce(
    (sum, piece) => sum + estimateTokens(piece.text) + estimateTokens(input.claims) + 60 * input.claims.length,
    0,
  );
  const ceiling = fileOptions.maxInputTokens ?? MAX_INPUT_TOKENS;
  if (estimated > ceiling) {
    throw new FileSelectionError(
      "cost_ceiling",
      `Verifying ${input.claims.length} claims against ${pieces.length} pieces of this evidence would send an ` +
        `estimated ${estimated.toLocaleString("en-US")} input tokens (about $${estimateCostUsd(estimated).toFixed(2)}), ` +
        `over the ${ceiling.toLocaleString("en-US")}-token ceiling for one call. Nothing was sent. ` +
        `Narrow the evidence with \`start_line\`/\`end_line\`, or check fewer claims at once.`,
    );
  }

  const questions: Record<string, Question> = {};
  input.claims.forEach((_claim, index) => {
    questions[questionId(index)] = claimQuestion(index);
  });

  const started = Date.now();
  const results = await mapWithConcurrency(pieces, config.maxConcurrency, async (piece) => {
    const state: Record<string, Json> = { evidence: piece.text, claims: [...input.claims] };
    const request: EvaluateRequest = { state, questions };
    if (signal !== undefined) request.signal = signal;
    const result = await model.evaluate(request);
    return { piece, result };
  });

  // Report a line range whenever it means something: file evidence always, and
  // a chunked string because the caller can then see which part decided it.
  const reportWhere = fromFile || pieces.length > 1;

  const claims: ClaimResult[] = input.claims.map((claim, index) =>
    mergeClaim(
      claim,
      results.map(({ piece, result }) => ({
        piece,
        answer: (result.answers as Record<string, ChoiceAnswer | undefined>)[questionId(index)],
      })),
      thresholds,
      reportWhere,
    ),
  );

  const summary = {
    supported: claims.filter((c) => c.verdict === "supported").length,
    contradicted: claims.filter((c) => c.verdict === "contradicted").length,
    not_addressed: claims.filter((c) => c.verdict === "not_addressed").length,
    conflicting: claims.filter((c) => c.verdict === "conflicting").length,
    needs_review: claims.filter((c) => c.gate !== "auto").length,
  };

  const output: VerifyToolOutput = {
    claims,
    summary,
    all_supported: allSupported(claims),
    thresholds,
    evidence_chunks: pieces.length,
    model: results[0]?.result.model ?? model.name,
    usage: sumUsage(results.map(({ result }) => result.usage)),
    latency_ms: Date.now() - started,
  };
  if (source.path !== undefined) {
    output.evidence_path = source.path;
    output.est_cost_usd = estimateCostUsd(estimated);
  }
  return output;
}

function normalizeVerdict(choice: string): Verdict {
  return (VERDICTS as readonly string[]).includes(choice) ? (choice as Verdict) : "not_addressed";
}

/** Re-exported so callers can gate a merged confidence the same way. */
export { gate };
