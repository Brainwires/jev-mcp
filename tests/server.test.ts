import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, MISSING_API_KEY_MESSAGE, type Config } from "../src/config.js";
import { JevValidationError } from "../src/jev/errors.js";
import { createServer } from "../src/server.js";
import type { DecisionModel } from "../src/decision/types.js";
import { choice, FakeModel, noul, score } from "./helpers/fake-model.js";

const TOOL_NAMES = [
  "jev_evaluate",
  "jev_rank",
  "jev_verify",
  "jev_gate_action",
  "jev_next_step",
  "jev_list_models",
];

async function connect(model: DecisionModel | null, config: Config): Promise<Client> {
  const server = createServer(model, config);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const baseConfig = loadConfig({ TYPESAFE_API_KEY: "sk-secret-value-12345" });

describe("createServer", () => {
  let model: FakeModel;

  beforeEach(() => {
    model = new FakeModel(
      () => ({
        urgent: noul(0.93),
        team: choice("technical", { billing: 0.05, technical: 0.9, other: 0.05 }, 0.9),
        frustration: score(1.2, ["Calm", "Frustrated", "Angry"], 0.8),
      }),
      {
        models: [{ name: "jev-latest", description: "Flagship", release_date: "2026-09-01" }],
      },
    );
  });

  it("registers exactly the six tools, each with a description and schemas", async () => {
    const client = await connect(model, baseConfig);
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());

    for (const tool of tools) {
      expect(tool.description, `${tool.name} needs a description`).toBeTruthy();
      expect(tool.description!.length, `${tool.name} description length`).toBeLessThanOrEqual(1200);
      expect(tool.inputSchema, `${tool.name} needs an input schema`).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema, `${tool.name} needs an output schema`).toBeTruthy();
      expect(tool.outputSchema!.type).toBe("object");
    }
  });

  it("calls jev_evaluate and returns structuredContent plus a JSON text block", async () => {
    const client = await connect(model, baseConfig);

    const result = await client.callTool({
      name: "jev_evaluate",
      arguments: {
        state: { ticket: "Payouts have been failing for 3 days" },
        questions: {
          urgent: { type: "noul", instructions: "Does `ticket` convey urgency?" },
          team: {
            type: "choice",
            instructions: "Which team should handle `ticket`?",
            criteria: { billing: "Payments", technical: "Bugs", other: "None of the above" },
          },
          frustration: {
            type: "score",
            instructions: "How frustrated is the customer in `ticket`?",
            criteria: ["Calm", "Frustrated", "Angry"],
          },
        },
      },
    });

    expect(result.isError).toBeFalsy();

    const structured = result.structuredContent as {
      answers: Record<string, { gate: string; verdict?: string }>;
      model: string;
      usage: { input_tokens: number };
      latency_ms: number;
    };
    expect(structured.answers.urgent).toMatchObject({ gate: "auto", verdict: "yes" });
    expect(structured.answers.team!.gate).toBe("auto");
    expect(structured.answers.frustration!.gate).toBe("review");
    expect(structured.model).toBe("fake-1.0.0");
    expect(structured.usage.input_tokens).toBe(100);
    expect(structured.latency_ms).toBe(7);

    const content = result.content as { type: string; text: string }[];
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe("text");
    expect(JSON.parse(content[0]!.text)).toEqual(structured);

    // Only one request, even though three questions were asked.
    expect(model.calls).toHaveLength(1);
  });

  it("calls jev_list_models", async () => {
    const client = await connect(model, baseConfig);
    const result = await client.callTool({ name: "jev_list_models", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { models: unknown[] }).models).toEqual([
      { name: "jev-latest", description: "Flagship", release_date: "2026-09-01" },
    ]);
  });

  it("calls jev_gate_action end to end", async () => {
    const gateModel = new FakeModel(() => ({
      destructive: noul(0.98),
      outward_facing: noul(0.02),
      in_scope: noul(0.03),
      credential_exposure: noul(0.01),
      blast_radius: score(2.8, ["none", "local", "shared", "production"], 0.9),
    }));
    const client = await connect(gateModel, baseConfig);

    const result = await client.callTool({
      name: "jev_gate_action",
      arguments: { action: "Bash(rm -rf /)", user_request: "list the files in src" },
    });

    expect((result.structuredContent as { decision: string }).decision).toBe("block");
  });

  it("returns isError with an actionable message when no API key is configured", async () => {
    const config = loadConfig({});
    expect(config.apiKey).toBeNull();

    const client = await connect(null, config);

    // The server still starts and still advertises its tools.
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(6);

    for (const name of TOOL_NAMES) {
      const result = await client.callTool({
        name,
        arguments:
          name === "jev_evaluate"
            ? { state: "s", questions: { q: { type: "noul", instructions: "Is it urgent?" } } }
            : name === "jev_rank"
              ? { query: "q", candidates: [{ id: "a", text: "t" }] }
              : name === "jev_verify"
                ? { claims: ["c"], evidence: "e" }
                : name === "jev_gate_action"
                  ? { action: "a", user_request: "r" }
                  : name === "jev_next_step"
                    ? { goal: "g", last_step: "s", result: "r" }
                    : {},
      });

      expect(result.isError, `${name} should report the missing key`).toBe(true);
      const content = result.content as { text: string }[];
      expect(content[0]!.text).toBe(MISSING_API_KEY_MESSAGE);
      expect(content[0]!.text).toContain("TYPESAFE_API_KEY");
    }
  });

  it("turns a thrown API error into a concise isError result", async () => {
    const angry = new FakeModel(() => {
      throw new JevValidationError("TypeSafe rejected the request body as invalid.", {
        status: 422,
        body: { detail: "questions.q.criteria: at least two options" },
      });
    });
    const client = await connect(angry, baseConfig);

    const result = await client.callTool({
      name: "jev_evaluate",
      arguments: { state: "s", questions: { q: { type: "noul", instructions: "Is it urgent?" } } },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).toContain("HTTP 422");
    expect(text).toContain("at least two options");
    expect(text).not.toContain("at JevDecisionModel");
    expect(text.split("\n")).toHaveLength(1);
  });

  it("never leaks the API key into an error message", async () => {
    const leaky = new FakeModel(() => {
      throw new Error(`upstream said: Bearer sk-secret-value-12345 is invalid`);
    });
    const client = await connect(leaky, baseConfig);

    const result = await client.callTool({
      name: "jev_evaluate",
      arguments: { state: "s", questions: { q: { type: "noul", instructions: "Is it urgent?" } } },
    });

    const text = (result.content as { text: string }[])[0]!.text;
    expect(result.isError).toBe(true);
    expect(text).not.toContain("sk-secret-value-12345");
    expect(text).toContain("[redacted]");
  });

  it("rejects input that does not match a tool's schema", async () => {
    const client = await connect(model, baseConfig);
    const result = await client.callTool({ name: "jev_verify", arguments: { claims: [], evidence: "e" } });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toContain("claims");
    // The schema rejected it before the model was ever asked.
    expect(model.calls).toHaveLength(0);
  });
});
