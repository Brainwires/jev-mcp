import { describe, expect, it } from "vitest";
import { BudgetError } from "../../src/decision/budget.js";
import type { Answer, Question } from "../../src/decision/types.js";
import * as rankTool from "../../src/tools/rank.js";
import { FakeModel, noul, testConfig } from "../helpers/fake-model.js";

/** Answer each `cand_N` from the text it points at, via the chunk's own state. */
function relevanceResponder(scoreFor: (text: string) => number) {
  return (call: { state: unknown; questions: Record<string, Question> }): Record<string, Answer> => {
    const state = call.state as { query: string; candidates: string[] };
    const answers: Record<string, Answer> = {};
    let best = 0;
    for (const id of Object.keys(call.questions)) {
      if (id === "any_relevant") continue;
      const index = Number(id.slice("cand_".length));
      const value = scoreFor(state.candidates[index] as string);
      answers[id] = noul(value);
      if (value > best) best = value;
    }
    answers.any_relevant = noul(best);
    return answers;
  };
}

describe("jev_rank", () => {
  it("ranks candidates, maps indices back to ids, and hides the text", async () => {
    const model = new FakeModel(
      relevanceResponder((text) => (text.includes("retry") ? 0.95 : text.includes("token") ? 0.6 : 0.05)),
    );

    const result = await rankTool.run(
      model,
      {
        query: "How do I handle rate limits?",
        candidates: [
          { id: "doc:a", text: "unrelated prose about cheese" },
          { id: "doc:b", text: "retry with exponential backoff on 429" },
          { id: "doc:c", text: "token budget notes" },
        ],
      },
      testConfig,
    );

    expect(result.chunks).toBe(1);
    expect(result.total_candidates).toBe(3);
    expect(result.ranked).toEqual([
      { id: "doc:b", relevance: 0.95, rank: 1 },
      { id: "doc:c", relevance: 0.6, rank: 2 },
      { id: "doc:a", relevance: 0.05, rank: 3 },
    ]);
    expect(result.any_relevant).toBe(0.95);
    expect(JSON.stringify(result)).not.toContain("cheese");
  });

  it("never puts caller ids in the state or in question keys", async () => {
    const model = new FakeModel(relevanceResponder(() => 0.5));

    await rankTool.run(
      model,
      {
        query: "q",
        candidates: [
          { id: "candidates", text: "first" },
          { id: "__proto__", text: "second" },
        ],
      },
      testConfig,
    );

    const call = model.calls[0]!;
    expect(call.state).toEqual({ query: "q", candidates: ["first", "second"] });
    expect(Object.keys(call.questions).sort()).toEqual(["any_relevant", "cand_0", "cand_1"]);
    expect(JSON.stringify(call)).not.toContain("__proto__");
  });

  it("breaks ties by input order", async () => {
    const model = new FakeModel(relevanceResponder(() => 0.7));

    const result = await rankTool.run(
      model,
      {
        query: "q",
        candidates: [
          { id: "z", text: "a" },
          { id: "y", text: "b" },
          { id: "x", text: "c" },
        ],
      },
      testConfig,
    );

    expect(result.ranked.map((r) => r.id)).toEqual(["z", "y", "x"]);
    expect(result.ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("applies top_k after sorting and min_relevance before it", async () => {
    const values = [0.9, 0.2, 0.8, 0.05];
    const model = new FakeModel(relevanceResponder((text) => values[Number(text)] as number));
    const candidates = values.map((_value, index) => ({ id: `c${index}`, text: String(index) }));

    const topTwo = await rankTool.run(model, { query: "q", candidates, top_k: 2 }, testConfig);
    expect(topTwo.ranked.map((r) => r.id)).toEqual(["c0", "c2"]);

    const filtered = await rankTool.run(model, { query: "q", candidates, min_relevance: 0.5 }, testConfig);
    expect(filtered.ranked.map((r) => r.id)).toEqual(["c0", "c2"]);
  });

  it("defaults to the top 10", async () => {
    const model = new FakeModel(relevanceResponder(() => 0.5));
    const candidates = Array.from({ length: 25 }, (_v, i) => ({ id: `c${i}`, text: `text ${i}` }));

    const result = await rankTool.run(model, { query: "q", candidates }, testConfig);
    expect(result.ranked).toHaveLength(10);
    expect(result.total_candidates).toBe(25);
  });

  it("chunks oversized candidate sets, carrying the query into every chunk", async () => {
    const model = new FakeModel(relevanceResponder((text) => (text.startsWith("A") ? 0.9 : 0.1)));
    // ~8.7k tokens each: seven fit in 64k, so 20 needs three chunks.
    const big = (marker: string): string => marker + "x".repeat(30_000);
    const candidates = Array.from({ length: 20 }, (_v, i) => ({
      id: `c${i}`,
      text: big(i === 13 ? "A" : "B"),
    }));

    const result = await rankTool.run(model, { query: "how?", candidates, top_k: 3 }, testConfig);

    expect(result.chunks).toBeGreaterThan(1);
    expect(model.calls).toHaveLength(result.chunks);
    for (const call of model.calls) {
      expect((call.state as { query: string }).query).toBe("how?");
    }
    // Every candidate is judged exactly once across the chunks.
    const judged = model.calls.reduce(
      (total, call) => total + Object.keys(call.questions).length - 1,
      0,
    );
    expect(judged).toBe(20);
    expect(result.total_candidates).toBe(20);
    expect(result.ranked[0]!.id).toBe("c13");
  });

  it("merges usage across chunks and takes the max any_relevant", async () => {
    let call = 0;
    const model = new FakeModel((request) => {
      call += 1;
      const answers: Record<string, Answer> = {};
      for (const id of Object.keys(request.questions)) {
        answers[id] = noul(id === "any_relevant" ? (call === 2 ? 0.93 : 0.11) : 0.2);
      }
      return answers;
    });
    const candidates = Array.from({ length: 20 }, (_v, i) => ({
      id: `c${i}`,
      text: "y".repeat(30_000),
    }));

    const result = await rankTool.run(model, { query: "q", candidates }, testConfig);

    expect(result.any_relevant).toBe(0.93);
    expect(result.usage.input_tokens).toBe(100 * result.chunks);
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("names the candidate that cannot fit on its own", async () => {
    const model = new FakeModel(relevanceResponder(() => 0.5));

    try {
      await rankTool.run(
        model,
        {
          query: "q",
          candidates: [
            { id: "ok", text: "short" },
            { id: "the-huge-one", text: "z".repeat(400_000) },
          ],
        },
        testConfig,
      );
      expect.unreachable("expected a BudgetError");
    } catch (error) {
      expect(error).toBeInstanceOf(BudgetError);
      expect((error as Error).message).toContain('"the-huge-one"');
      expect((error as Error).message).toContain("Shorten or split");
    }
    expect(model.calls).toHaveLength(0);
  });

  it("folds extra instructions into every question", async () => {
    const model = new FakeModel(relevanceResponder(() => 0.5));

    await rankTool.run(
      model,
      { query: "q", candidates: [{ id: "a", text: "t" }], instructions: "only API reference pages count" },
      testConfig,
    );

    const questions = model.calls[0]!.questions;
    expect(String(questions.cand_0!.instructions)).toContain("only API reference pages count");
    expect(String(questions.any_relevant!.instructions)).toContain("only API reference pages count");
  });

  it("asks one noul per candidate plus any_relevant, referencing the candidate by path", async () => {
    const model = new FakeModel(relevanceResponder(() => 0.5));
    await rankTool.run(model, { query: "q", candidates: [{ id: "a", text: "t" }] }, testConfig);

    const questions = model.calls[0]!.questions;
    expect(questions.cand_0!.type).toBe("noul");
    expect(String(questions.cand_0!.instructions)).toContain("`candidates[0]`");
    expect(String(questions.cand_0!.instructions)).toContain("`query`");
  });

  it("scores a missing answer as 0 rather than throwing", async () => {
    const model = new FakeModel(() => ({ any_relevant: noul(0.4) }));
    const result = await rankTool.run(model, { query: "q", candidates: [{ id: "a", text: "t" }] }, testConfig);
    expect(result.ranked).toEqual([{ id: "a", relevance: 0, rank: 1 }]);
  });

  it("validates its input bounds", () => {
    expect(rankTool.inputSchema.safeParse({ query: "q", candidates: [] }).success).toBe(false);
    expect(
      rankTool.inputSchema.safeParse({
        query: "q",
        candidates: Array.from({ length: 501 }, () => ({ id: "a", text: "b" })),
      }).success,
    ).toBe(false);
    expect(rankTool.inputSchema.safeParse({ query: "", candidates: [{ id: "a", text: "b" }] }).success).toBe(false);
  });

  it("produces output that satisfies its output schema", async () => {
    const model = new FakeModel(relevanceResponder(() => 0.5));
    const result = await rankTool.run(model, { query: "q", candidates: [{ id: "a", text: "t" }] }, testConfig);
    expect(rankTool.outputSchema.safeParse(result).success).toBe(true);
  });

  it("keeps descriptions compact", () => {
    expect(rankTool.description.length).toBeLessThanOrEqual(1200);
  });
});
