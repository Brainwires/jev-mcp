/**
 * Provider-agnostic model-catalog contract.
 *
 * Kept separate from `types.ts` (the decision contract) because listing models
 * is an account/provider concern, not part of making a judgment. A tool that
 * wants the catalog depends on `ModelCatalog`, never on a concrete client.
 */

export interface ModelInfo {
  /** The id or alias, as accepted by a request's `model` field. */
  name: string;
  description: string;
  release_date: string;
}

export interface ListModelsResult {
  models: ModelInfo[];
}

export interface ModelCatalog {
  listModels(signal?: AbortSignal): Promise<ListModelsResult>;
}

/** Structural check, so tools can accept a `DecisionModel` that may also list. */
export function isModelCatalog(value: unknown): value is ModelCatalog {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { listModels?: unknown }).listModels === "function"
  );
}
