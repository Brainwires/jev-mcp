import { describe, expect, it } from "vitest";
import type { DecisionModel } from "../../src/decision/types.js";
import * as listModelsTool from "../../src/tools/list-models.js";
import { FakeModel, testConfig } from "../helpers/fake-model.js";

const MODELS = [
  { name: "jev-latest", description: "The most recent stable release", release_date: "2026-09-01" },
  { name: "jev-preview", description: "The most recent release", release_date: "2026-09-01" },
];

describe("jev_list_models", () => {
  it("passes the catalog straight through", async () => {
    const model = new FakeModel(() => ({}), { models: MODELS });
    const result = await listModelsTool.run(model, {}, testConfig);

    expect(result.models).toEqual(MODELS);
    expect(result.model).toBe("jev-latest");
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(listModelsTool.outputSchema.safeParse(result).success).toBe(true);
  });

  it("depends on the catalog shape, not on the Jev client", async () => {
    const bare = {
      name: "bare",
      evaluate: async () => {
        throw new Error("unused");
      },
      choice: async () => {
        throw new Error("unused");
      },
      score: async () => {
        throw new Error("unused");
      },
      probability: async () => {
        throw new Error("unused");
      },
    } as unknown as DecisionModel;

    await expect(listModelsTool.run(bare, {}, testConfig)).rejects.toThrow(/cannot list models/);
  });

  it("takes no input", () => {
    expect(listModelsTool.inputSchema.safeParse({}).success).toBe(true);
    expect(Object.keys(listModelsTool.inputShape)).toHaveLength(0);
  });
});
