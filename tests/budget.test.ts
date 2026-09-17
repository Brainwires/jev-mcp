import { describe, expect, it } from "vitest";
import {
  BudgetError,
  CHARS_PER_TOKEN,
  checkBudget,
  DEFAULT_BUDGET_LIMITS,
  estimateBudget,
  estimateTokens,
  fitsBudget,
} from "../src/decision/budget.js";
import type { Question } from "../src/decision/types.js";

const tinyNoul: Question = { type: "noul", instructions: "Is it urgent?" };

describe("estimateTokens", () => {
  it("measures strings directly at the conservative ratio", () => {
    expect(estimateTokens("x".repeat(350))).toBe(Math.ceil(350 / CHARS_PER_TOKEN));
  });

  it("measures non-strings as the JSON that will be sent", () => {
    const value = { a: "hello", b: [1, 2, 3] };
    expect(estimateTokens(value)).toBe(Math.ceil(JSON.stringify(value).length / CHARS_PER_TOKEN));
  });

  it("is conservative relative to the documented ~4.7 chars/token", () => {
    expect(estimateTokens("y".repeat(4700))).toBeGreaterThan(1000);
  });

  it("treats undefined as free", () => {
    expect(estimateTokens(undefined)).toBe(0);
  });
});

describe("checkBudget", () => {
  it("passes a small request and reports the estimate", () => {
    const estimate = checkBudget("a short ticket", { urgent: tinyNoul });
    expect(estimate.longest_question_id).toBe("urgent");
    expect(estimate.total_tokens).toBe(estimate.state_tokens + estimate.questions_tokens);
    expect(estimate.state_plus_longest_tokens).toBe(estimate.state_tokens + estimate.longest_question_tokens);
  });

  it("names the total limit when state + all questions is too big", () => {
    // Small state, but thousands of questions.
    const questions: Record<string, Question> = {};
    for (let i = 0; i < 4000; i += 1) {
      questions[`q${i}`] = { type: "noul", instructions: `Does \`items[${i}]\` mention a fruit in a sentence?` };
    }

    try {
      checkBudget("tiny", questions);
      expect.unreachable("expected a BudgetError");
    } catch (error) {
      expect(error).toBeInstanceOf(BudgetError);
      const budgetError = error as BudgetError;
      expect(budgetError.limit).toBe("total");
      expect(budgetError.message).toContain("total context limit");
      expect(budgetError.message).toContain(String(DEFAULT_BUDGET_LIMITS.total));
      expect(budgetError.estimate.total_tokens).toBeGreaterThan(DEFAULT_BUDGET_LIMITS.total);
    }
  });

  it("names the state + longest-question limit, and names the question", () => {
    const state = "z".repeat(Math.ceil(31_000 * CHARS_PER_TOKEN));

    try {
      checkBudget(state, { small: tinyNoul, big: { type: "noul", instructions: "q".repeat(8000) } });
      expect.unreachable("expected a BudgetError");
    } catch (error) {
      expect(error).toBeInstanceOf(BudgetError);
      const budgetError = error as BudgetError;
      expect(budgetError.limit).toBe("state_plus_longest_question");
      expect(budgetError.message).toContain("state + longest-question");
      expect(budgetError.message).toContain('question "big"');
      expect(budgetError.message).toContain("32000");
    }
  });

  it("checks the total limit before the per-question one", () => {
    const state = "z".repeat(Math.ceil(63_000 * CHARS_PER_TOKEN));
    try {
      checkBudget(state, { big: { type: "noul", instructions: "q".repeat(40_000) } });
      expect.unreachable("expected a BudgetError");
    } catch (error) {
      expect((error as BudgetError).limit).toBe("total");
    }
  });

  it("honours overridden limits", () => {
    expect(() => checkBudget("hello world", { urgent: tinyNoul }, { total: 1, statePlusLongestQuestion: 1 })).toThrow(
      BudgetError,
    );
    const huge = { total: 10_000_000, statePlusLongestQuestion: 10_000_000 };
    expect(() => checkBudget("x".repeat(500_000), { urgent: tinyNoul }, huge)).not.toThrow();
  });
});

describe("fitsBudget", () => {
  it("is the non-throwing form of checkBudget", () => {
    expect(fitsBudget("small", { urgent: tinyNoul })).toBe(true);
    expect(fitsBudget("x".repeat(400_000), { urgent: tinyNoul })).toBe(false);
  });
});

describe("estimateBudget", () => {
  it("reports no longest question for an empty map", () => {
    const estimate = estimateBudget("hi", {});
    expect(estimate.longest_question_id).toBeNull();
    expect(estimate.questions_tokens).toBe(0);
  });

  it("counts criteria towards a question's size", () => {
    const bare = estimateBudget("hi", { q: { type: "noul", instructions: "Is it urgent?" } });
    const withCriteria = estimateBudget("hi", {
      q: {
        type: "noul",
        instructions: "Is it urgent?",
        criteria: { true: "Explicitly time-sensitive", false: "No urgency expressed" },
      },
    });
    expect(withCriteria.longest_question_tokens).toBeGreaterThan(bare.longest_question_tokens);
  });
});
