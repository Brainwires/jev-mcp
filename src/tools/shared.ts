/**
 * Pieces every tool shares: zod fragments, the state/question normalizers that
 * keep `exactOptionalPropertyTypes` happy, and a bounded-concurrency mapper.
 *
 * Nothing here imports the Jev client. Tools are written against the
 * `DecisionModel` contract so they can be tested with a fake and reused with a
 * different provider.
 */

import { z } from "zod";
import type { EntryType, GateThresholds, Instructions, Json, Question, State } from "../decision/types.js";
import type { FileAccessOptions } from "../files/index.js";

// --------------------------------------------------------------- zod fragments

/** A JSON value, one level of structure deep enough for state and criteria. */
const jsonValue = z.unknown();

export const stateSchema = z
  .union([z.string(), z.array(jsonValue), z.record(z.string(), jsonValue)])
  .describe("The content to judge: a plain string, or structured data that questions reference by path.");

export const instructionsSchema = z
  .union([z.string(), z.array(jsonValue), z.record(z.string(), jsonValue)])
  .describe("The question itself. Write it in full; question ids are never sent to the model.");

export const thresholdsSchema = z
  .object({
    auto: z.number().min(0).max(1).optional().describe("At or above this certainty, act automatically."),
    review: z.number().min(0).max(1).optional().describe("At or above this certainty (but below auto), proceed with care."),
  })
  .optional()
  .describe("Override the server's configured gating thresholds for this call only.");

export const gateSchema = z.enum(["auto", "review", "escalate"]);

export const usageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
});

/** Fields every tool result carries, as a raw shape to spread into outputs. */
export const envelopeShape = {
  model: z.string().describe("The versioned model id that actually answered."),
  usage: usageSchema.describe("Token usage. Jev charges for input tokens only."),
  latency_ms: z.number().describe("Wall-clock time for the underlying API call(s), including retries."),
} as const;

// ---------------------------------------------------------------- normalizers

/**
 * `z.infer` on an optional field yields `T | undefined`, which
 * `exactOptionalPropertyTypes` will not assign to an `Instructions` field. These
 * helpers rebuild the contract types with the undefined-valued keys omitted.
 */
export function toState(value: string | unknown[] | Record<string, unknown>): State {
  return value as State;
}

export function toInstructions(value: string | unknown[] | Record<string, unknown>): Instructions {
  return value as Instructions;
}

/** One entry of a rubric: an alias, so the three arms stay in step. */
type EntryInput = string | unknown[] | Record<string, unknown> | null;

export type QuestionInput =
  | {
      type: "choice";
      instructions: string | unknown[] | Record<string, unknown>;
      criteria: Record<string, EntryInput>;
    }
  | {
      type: "score";
      instructions: string | unknown[] | Record<string, unknown>;
      criteria: EntryInput[];
    }
  | {
      type: "noul";
      instructions: string | unknown[] | Record<string, unknown>;
      criteria?: { true?: EntryInput | undefined; false?: EntryInput | undefined } | undefined;
    };

function toEntry(value: EntryInput): EntryType {
  return value as EntryType;
}

/** Turn a parsed tool input question into a contract `Question`. */
export function toQuestion(input: QuestionInput): Question {
  switch (input.type) {
    case "choice": {
      const criteria: Record<string, EntryType> = {};
      for (const [option, entry] of Object.entries(input.criteria)) criteria[option] = toEntry(entry);
      return { type: "choice", instructions: toInstructions(input.instructions), criteria };
    }
    case "score":
      return {
        type: "score",
        instructions: toInstructions(input.instructions),
        criteria: input.criteria.map((entry) => toEntry(entry)),
      };
    case "noul": {
      // `null` is an entry, not an absence, so the test is against `undefined`
      // rather than truthiness.
      const criteria: { true?: EntryType; false?: EntryType } = {};
      if (input.criteria?.true !== undefined) criteria.true = toEntry(input.criteria.true);
      if (input.criteria?.false !== undefined) criteria.false = toEntry(input.criteria.false);
      const question: Question = { type: "noul", instructions: toInstructions(input.instructions) };
      return Object.keys(criteria).length === 0 ? question : { ...question, criteria };
    }
  }
}

/**
 * A rubric entry, prose or structure.
 *
 * Non-recursive on purpose: `z.unknown()` inside the array and record arms
 * means zod 4 inlines the whole union, so the JSON Schema the MCP client sees
 * carries no `$ref` — and a `$ref` is what some clients silently drop.
 */
const entrySchema = z
  .union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown()), z.null()])
  .describe(
    "A rubric entry: a string, or JSON structure such as {what, not_for, examples} / {summary, signals}.",
  );

export const choiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: instructionsSchema,
  criteria: z
    .record(z.string(), entrySchema)
    .describe("option -> rubric. Use null when the option name says it all. At least 2 options; add an 'other'/'none' escape hatch."),
});

export const scoreQuestionSchema = z.object({
  type: z.literal("score"),
  instructions: instructionsSchema,
  criteria: z.array(entrySchema).min(2).describe("Ordered level descriptions, lowest first. At least 2."),
});

export const noulQuestionSchema = z.object({
  type: z.literal("noul"),
  instructions: instructionsSchema,
  criteria: z
    .object({ true: entrySchema.optional(), false: entrySchema.optional() })
    .optional()
    .describe("Optional clarification of what yes and no mean. Keep them aligned with the instructions."),
});

export const questionSchema = z.discriminatedUnion("type", [
  choiceQuestionSchema,
  scoreQuestionSchema,
  noulQuestionSchema,
]);

// ------------------------------------------------------------------- utilities

/** Read-only slice of `Config` the tools actually use. */
export interface ToolConfig {
  /** Default model name, for results that report one without evaluating. */
  model: string;
  thresholds: GateThresholds;
  maxConcurrency: number;
  /**
   * True when `JEV_MAX_CONCURRENCY` was set explicitly. File sources fan out
   * wider than the default, but an operator who named a number meant it.
   */
  maxConcurrencyExplicit?: boolean | undefined;
  /**
   * Overrides for the file layer: the project root, the caps, the cost ceiling.
   * Tests point `root` at a temp directory; production leaves it unset and the
   * root comes from `CLAUDE_PROJECT_DIR` or the cwd.
   *
   * Imported as a type only, so nothing here pulls `node:fs` into a bundle
   * that must not have it.
   */
  files?: FileAccessOptions | undefined;
}

/**
 * Map over items with at most `limit` promises in flight. Results keep input
 * order. The first rejection wins; in-flight work is left to settle.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const width = Math.max(1, Math.min(Math.floor(limit), items.length));
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

/** Sum token usage across several requests. */
export function sumUsage(parts: readonly { input_tokens: number; output_tokens: number }[]): {
  input_tokens: number;
  output_tokens: number;
} {
  return parts.reduce(
    (acc, part) => ({
      input_tokens: acc.input_tokens + part.input_tokens,
      output_tokens: acc.output_tokens + part.output_tokens,
    }),
    { input_tokens: 0, output_tokens: 0 },
  );
}

/** Narrow a `Json`-typed record for building structured state. */
export function jsonRecord(value: Record<string, Json>): Record<string, Json> {
  return value;
}
