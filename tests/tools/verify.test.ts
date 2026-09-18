import { describe, expect, it } from "vitest";
import type { Answer } from "../../src/decision/types.js";
import * as verifyTool from "../../src/tools/verify.js";
import { choice, FakeModel, testConfig, type RecordedCall } from "../helpers/fake-model.js";

function verdicts(list: { verdict: verifyTool.Verdict; confidence: number }[]) {
  return (call: RecordedCall): Record<string, Answer> => {
    const answers: Record<string, Answer> = {};
    Object.keys(call.questions).forEach((id) => {
      const index = Number(id.slice("claim_".length));
      const spec = list[index]!;
      const probabilities: Record<string, number> = {
        supported: 0,
        contradicted: 0,
        not_addressed: 0,
      };
      probabilities[spec.verdict] = spec.confidence;
      answers[id] = choice(spec.verdict, probabilities, spec.confidence);
    });
    return answers;
  };
}

describe("jev_verify", () => {
  it("returns one result per claim in input order with gates", async () => {
    const model = new FakeModel(
      verdicts([
        { verdict: "supported", confidence: 0.95 },
        { verdict: "contradicted", confidence: 0.7 },
        { verdict: "not_addressed", confidence: 0.4 },
      ]),
    );

    const result = await verifyTool.run(
      model,
      {
        claims: ["The sky is blue.", "Payouts settle in 2 days.", "Refunds take a week."],
        evidence: "Payouts settle in 5 days.",
      },
      testConfig,
    );

    expect(result.claims.map((c) => c.claim)).toEqual([
      "The sky is blue.",
      "Payouts settle in 2 days.",
      "Refunds take a week.",
    ]);
    expect(result.claims.map((c) => c.verdict)).toEqual(["supported", "contradicted", "not_addressed"]);
    expect(result.claims.map((c) => c.gate)).toEqual(["auto", "review", "escalate"]);
    expect(result.summary).toEqual({
      supported: 1,
      contradicted: 1,
      not_addressed: 1,
      conflicting: 0,
      needs_review: 2,
    });
    expect(result.all_supported).toBe(false);
  });

  it("sends one choice question per claim, with a three-way rubric", async () => {
    const model = new FakeModel(verdicts([{ verdict: "supported", confidence: 0.9 }]));
    await verifyTool.run(model, { claims: ["c"], evidence: "e" }, testConfig);

    const call = model.calls[0]!;
    expect(call.state).toEqual({ evidence: "e", claims: ["c"] });
    expect(Object.keys(call.questions)).toEqual(["claim_0"]);
    const question = call.questions.claim_0!;
    expect(question.type).toBe("choice");
    expect(Object.keys((question as { criteria: Record<string, unknown> }).criteria).sort()).toEqual([
      "contradicted",
      "not_addressed",
      "supported",
    ]);
    expect(String(question.instructions)).toContain("only");
    expect(String(question.instructions)).toContain("`claims[0]`");
  });

  it("states in the rubric that outside knowledge does not count", async () => {
    const model = new FakeModel(verdicts([{ verdict: "supported", confidence: 0.9 }]));
    await verifyTool.run(model, { claims: ["c"], evidence: "e" }, testConfig);
    const criteria = (model.calls[0]!.questions.claim_0 as { criteria: Record<string, string> }).criteria;
    expect(criteria.supported).toContain("Outside knowledge does not count");
    expect(criteria.not_addressed).toContain("true in the world but not stated");
  });

  it("all_supported is true only when every claim is supported and confident", async () => {
    const confident = new FakeModel(
      verdicts([
        { verdict: "supported", confidence: 0.95 },
        { verdict: "supported", confidence: 0.9 },
      ]),
    );
    const allGood = await verifyTool.run(confident, { claims: ["a", "b"], evidence: "e" }, testConfig);
    expect(allGood.all_supported).toBe(true);
    expect(allGood.summary.needs_review).toBe(0);

    const shaky = new FakeModel(
      verdicts([
        { verdict: "supported", confidence: 0.95 },
        { verdict: "supported", confidence: 0.7 },
      ]),
    );
    const notQuite = await verifyTool.run(shaky, { claims: ["a", "b"], evidence: "e" }, testConfig);
    expect(notQuite.all_supported).toBe(false);
    expect(notQuite.summary.supported).toBe(2);
    expect(notQuite.summary.needs_review).toBe(1);
  });

  it("allSupported is a pure function and rejects an empty list", () => {
    expect(verifyTool.allSupported([])).toBe(false);
    expect(
      verifyTool.allSupported([
        { claim: "a", verdict: "supported", probabilities: {}, confidence: 1, gate: "auto" },
      ]),
    ).toBe(true);
    expect(
      verifyTool.allSupported([
        { claim: "a", verdict: "supported", probabilities: {}, confidence: 1, gate: "auto" },
        { claim: "b", verdict: "not_addressed", probabilities: {}, confidence: 1, gate: "auto" },
      ]),
    ).toBe(false);
    expect(
      verifyTool.allSupported([
        { claim: "a", verdict: "supported", probabilities: {}, confidence: 0.7, gate: "review" },
      ]),
    ).toBe(false);
  });

  it("honours a thresholds override", async () => {
    const model = new FakeModel(verdicts([{ verdict: "supported", confidence: 0.7 }]));
    const result = await verifyTool.run(
      model,
      { claims: ["a"], evidence: "e", thresholds: { auto: 0.65 } },
      testConfig,
    );
    expect(result.claims[0]!.gate).toBe("auto");
    expect(result.all_supported).toBe(true);
  });

  it("treats an unrecognised choice value as not_addressed", async () => {
    const model = new FakeModel(() => ({ claim_0: choice("maybe", { maybe: 1 }, 0.99) }));
    const result = await verifyTool.run(model, { claims: ["a"], evidence: "e" }, testConfig);
    expect(result.claims[0]!.verdict).toBe("not_addressed");
    expect(result.all_supported).toBe(false);
  });

  it("validates its input bounds", () => {
    expect(verifyTool.inputSchema.safeParse({ claims: [], evidence: "e" }).success).toBe(false);
    expect(verifyTool.inputSchema.safeParse({ claims: ["a"], evidence: "" }).success).toBe(false);
    expect(
      verifyTool.inputSchema.safeParse({
        claims: Array.from({ length: 101 }, () => "a"),
        evidence: "e",
      }).success,
    ).toBe(false);
  });

  it("produces output that satisfies its output schema", async () => {
    const model = new FakeModel(verdicts([{ verdict: "supported", confidence: 0.9 }]));
    const result = await verifyTool.run(model, { claims: ["a"], evidence: "e" }, testConfig);
    expect(verifyTool.outputSchema.safeParse(result).success).toBe(true);
  });

  it("keeps its description compact", () => {
    expect(verifyTool.description.length).toBeLessThanOrEqual(1200);
  });
});
