/**
 * `jev_list_models` — passthrough of `GET /v1/models`.
 *
 * Depends on the `ModelCatalog` shape rather than on the Jev client, so a fake
 * decision model in a test (or a different provider) can satisfy it, and a
 * provider that cannot list models gets a clear error instead of a crash.
 */

import { z } from "zod";
import { isModelCatalog } from "../decision/models.js";
import type { DecisionModel } from "../decision/types.js";
import { envelopeShape, type ToolConfig } from "./shared.js";

export const name = "jev_list_models";

export const description = [
  "List the model names and aliases this account can send in the `model` field, with each one's description and release date.",
  "Use it before pinning a version: `jev-latest` is an alias that moves when a new release ships, so if you have tuned thresholds against one model's calibration, pass the versioned id (e.g. `jev-1.13.0`) to `jev_evaluate`'s `model` instead.",
  "Versioned ids are accepted whether or not they appear in this list. Costs no tokens.",
].join("\n");

export const inputShape = {} as const;
export const inputSchema = z.object(inputShape);
export type ListModelsToolInput = z.infer<typeof inputSchema>;

export const outputShape = {
  models: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        release_date: z.string(),
      }),
    )
    .describe("One entry per model or alias, exactly as the API returned it."),
  ...envelopeShape,
} as const;

export const outputSchema = z.object(outputShape);
export type ListModelsToolOutput = z.infer<typeof outputSchema>;

export async function run(
  model: DecisionModel,
  _input: ListModelsToolInput,
  config: ToolConfig,
  signal?: AbortSignal,
): Promise<ListModelsToolOutput> {
  if (!isModelCatalog(model)) {
    throw new Error("This decision model cannot list models: it does not implement a model catalog.");
  }

  const started = Date.now();
  const result = await model.listModels(signal);

  return {
    models: result.models,
    // `GET /v1/models` evaluates nothing, so there is no model that "answered"
    // and no tokens were spent. The envelope stays uniform: the configured
    // default model, and zero usage.
    model: config.model,
    usage: { input_tokens: 0, output_tokens: 0 },
    latency_ms: Date.now() - started,
  };
}
