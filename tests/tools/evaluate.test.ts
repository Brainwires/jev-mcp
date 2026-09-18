import { describe, expect, it } from "vitest";
import * as evaluateTool from "../../src/tools/evaluate.js";
import { choice, FakeModel, noul, score, testConfig } from "../helpers/fake-model.js";

describe("jev_evaluate", () => {
  it("passes the state and questions through and gates every answer", async () => {
    const model = new FakeModel(() => ({
      urgent: noul(0.92),
      team: choice("technical", { billing: 0.05, technical: 0.9, other: 0.05 }, 0.88),
      frustration: score(1.6, ["Calm", "Frustrated", "Very angry"], 0.62),
    }));

    const result = await evaluateTool.run(
      model,
      {
        state: { ticket: "Payouts failing for 3 days" },
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
            criteria: ["Calm", "Frustrated", "Very angry"],
          },
        },
      },
      testConfig,
    );

    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.state).toEqual({ ticket: "Payouts failing for 3 days" });
    expect(Object.keys(model.calls[0]!.questions)).toEqual(["urgent", "team", "frustration"]);

    expect(result.answers.urgent).toMatchObject({ type: "noul", noul: 0.92, gate: "auto", verdict: "yes" });
    expect(result.answers.team).toMatchObject({ type: "choice", choice: "technical", gate: "auto" });
    expect(result.answers.frustration).toMatchObject({ type: "score", gate: "review" });

    expect(result.model).toBe("fake-1.0.0");
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 10 });
    expect(result.latency_ms).toBe(7);
    expect(result.thresholds).toEqual({ auto: 0.85, review: 0.6 });
  });

  it("gates a noul two-sided: a confident no is `auto`", async () => {
    const model = new FakeModel(() => ({ q: noul(0.03) }));
    const result = await evaluateTool.run(
      model,
      { state: "s", questions: { q: { type: "noul", instructions: "Is it urgent?" } } },
      testConfig,
    );

    expect(result.answers.q).toMatchObject({ gate: "auto", verdict: "no", certainty: 0.97 });
  });

  it("escalates a noul near 0.5", async () => {
    const model = new FakeModel(() => ({ q: noul(0.51) }));
    const result = await evaluateTool.run(
      model,
      { state: "s", questions: { q: { type: "noul", instructions: "Is it urgent?" } } },
      testConfig,
    );
    expect(result.answers.q!.gate).toBe("escalate");
  });

  it("honours a per-call thresholds override", async () => {
    const model = new FakeModel(() => ({ q: noul(0.7) }));
    const result = await evaluateTool.run(
      model,
      {
        state: "s",
        questions: { q: { type: "noul", instructions: "Is it urgent?" } },
        thresholds: { auto: 0.65 },
      },
      testConfig,
    );

    expect(result.answers.q!.gate).toBe("auto");
    expect(result.thresholds).toEqual({ auto: 0.65, review: 0.6 });
  });

  it("forwards a model override", async () => {
    const model = new FakeModel(() => ({ q: noul(0.5) }));
    await evaluateTool.run(
      model,
      { state: "s", questions: { q: { type: "noul", instructions: "Is it urgent?" } }, model: "jev-1.13.0" },
      testConfig,
    );
    expect(model.calls[0]!.model).toBe("jev-1.13.0");
  });

  it("strips an all-undefined noul criteria rather than sending `criteria: {}`", async () => {
    const model = new FakeModel(() => ({ q: noul(0.5) }));
    await evaluateTool.run(
      model,
      { state: "s", questions: { q: { type: "noul", instructions: "Is it urgent?", criteria: {} } } },
      testConfig,
    );
    expect(model.calls[0]!.questions.q).toEqual({ type: "noul", instructions: "Is it urgent?" });
  });

  it("keeps a partial noul criteria", async () => {
    const model = new FakeModel(() => ({ q: noul(0.5) }));
    await evaluateTool.run(
      model,
      {
        state: "s",
        questions: { q: { type: "noul", instructions: "Is it urgent?", criteria: { true: "time-sensitive" } } },
      },
      testConfig,
    );
    expect(model.calls[0]!.questions.q).toEqual({
      type: "noul",
      instructions: "Is it urgent?",
      criteria: { true: "time-sensitive" },
    });
  });

  /**
   * Structured criteria, 0.5.0. The whole point is that the structure survives
   * the schema and `toQuestion` untouched: Jev reads `not_for` on the side a
   * lookalike case would wrongly land on, and a stringified rubric loses that.
   */
  describe("structured criteria", () => {
    const CHOICE_ENTRY = { what: "Payments, refunds", not_for: "An outage", examples: ["a double charge"] };
    const SCORE_ENTRY = { summary: "Calm", signals: ["no exclamation marks"] };
    const NOUL_ENTRY = { what: "Time-sensitive", not_for: "A deadline already passed", examples: ["today"] };

    it("round-trips JSON entries through all three question types", async () => {
      const model = new FakeModel(() => ({
        a: noul(0.9),
        b: choice("billing", { billing: 0.9, other: 0.1 }, 0.9),
        c: score(0.5, ["Calm", "Angry"], 0.5),
      }));
      await evaluateTool.run(
        model,
        {
          state: "s",
          questions: {
            a: { type: "noul", instructions: "Is it urgent?", criteria: { true: NOUL_ENTRY, false: null } },
            b: {
              type: "choice",
              instructions: "Which team?",
              criteria: { billing: CHOICE_ENTRY, other: null },
            },
            c: { type: "score", instructions: "How frustrated?", criteria: [SCORE_ENTRY, "Angry"] },
          },
        },
        testConfig,
      );

      expect(model.calls[0]!.questions).toEqual({
        a: { type: "noul", instructions: "Is it urgent?", criteria: { true: NOUL_ENTRY, false: null } },
        b: { type: "choice", instructions: "Which team?", criteria: { billing: CHOICE_ENTRY, other: null } },
        c: { type: "score", instructions: "How frustrated?", criteria: [SCORE_ENTRY, "Angry"] },
      });
    });

    it("keeps a `null` noul side, which is a value rather than an absence", async () => {
      const model = new FakeModel(() => ({ q: noul(0.5) }));
      await evaluateTool.run(
        model,
        { state: "s", questions: { q: { type: "noul", instructions: "Is it urgent?", criteria: { false: null } } } },
        testConfig,
      );
      expect(model.calls[0]!.questions.q).toEqual({
        type: "noul",
        instructions: "Is it urgent?",
        criteria: { false: null },
      });
    });

    it("is accepted by the input schema in every arm", () => {
      const ok = evaluateTool.inputSchema.safeParse({
        state: "s",
        questions: {
          a: { type: "noul", instructions: "q", criteria: { true: NOUL_ENTRY } },
          b: { type: "choice", instructions: "q", criteria: { x: CHOICE_ENTRY, y: null } },
          c: { type: "score", instructions: "q", criteria: [SCORE_ENTRY, { summary: "Angry", signals: [] }] },
          d: { type: "score", instructions: "q", criteria: [["a", "b"], "plain"] },
        },
      });
      expect(ok.success, JSON.stringify(ok.error?.issues)).toBe(true);
    });

    it("still rejects a score with fewer than two levels", () => {
      expect(
        evaluateTool.inputSchema.safeParse({
          state: "s",
          questions: { c: { type: "score", instructions: "q", criteria: [SCORE_ENTRY] } },
        }).success,
      ).toBe(false);
    });
  });

  it("validates its own input schema", () => {
    expect(evaluateTool.inputSchema.safeParse({ state: "s", questions: {} }).success).toBe(true);
    expect(evaluateTool.inputSchema.safeParse({ state: 42, questions: {} }).success).toBe(false);
    expect(
      evaluateTool.inputSchema.safeParse({
        state: "s",
        questions: { q: { type: "bogus", instructions: "x" } },
      }).success,
    ).toBe(false);
    expect(evaluateTool.inputSchema.safeParse({ state: "s", questions: {}, thresholds: { auto: 2 } }).success).toBe(
      false,
    );
  });

  it("produces output that satisfies its own output schema", async () => {
    const model = new FakeModel(() => ({
      a: noul(0.9),
      b: choice("x", { x: 0.9, y: 0.1 }, 0.9),
      c: score(0.5, ["low", "high"], 0.5),
    }));
    const result = await evaluateTool.run(
      model,
      {
        state: "s",
        questions: {
          a: { type: "noul", instructions: "yes?" },
          b: { type: "choice", instructions: "which?", criteria: { x: null, y: null } },
          c: { type: "score", instructions: "how much?", criteria: ["low", "high"] },
        },
      },
      testConfig,
    );

    expect(evaluateTool.outputSchema.safeParse(result).success).toBe(true);
  });

  it("has a description that coaches question writing and stays compact", () => {
    expect(evaluateTool.description.length).toBeLessThanOrEqual(1200);
    expect(evaluateTool.description).toMatch(/literal/i);
    expect(evaluateTool.description).toMatch(/ONE call/);
    expect(evaluateTool.description).toMatch(/arithmetic/i);
  });
});
