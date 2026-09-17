import { describe, expect, it } from "vitest";
import type { Question } from "../src/decision/types.js";
import { validateQuestions, ValidationError } from "../src/decision/validate.js";

describe("validateQuestions", () => {
  it("accepts a well-formed mixed map", () => {
    expect(() =>
      validateQuestions({
        urgent: { type: "noul", instructions: "Does the message convey urgency?" },
        team: {
          type: "choice",
          instructions: "Which team should handle this?",
          criteria: { billing: "Payments", technical: null, other: "None of the above" },
        },
        frustration: {
          type: "score",
          instructions: "How frustrated is the customer?",
          criteria: ["Calm", "Frustrated", "Very angry"],
        },
      }),
    ).not.toThrow();
  });

  it("rejects an empty map", () => {
    expect(() => validateQuestions({})).toThrow(/at least one question/);
  });

  it("rejects empty instructions and names the id", () => {
    try {
      validateQuestions({ blank: { type: "noul", instructions: "   " } });
      expect.unreachable("expected a ValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).questionId).toBe("blank");
      expect((error as Error).message).toContain('"blank"');
    }
  });

  it("accepts structured instructions", () => {
    expect(() =>
      validateQuestions({ q: { type: "noul", instructions: { ask: "Is it urgent?" } } }),
    ).not.toThrow();
    expect(() => validateQuestions({ q: { type: "noul", instructions: {} } })).toThrow(ValidationError);
    expect(() => validateQuestions({ q: { type: "noul", instructions: ["Is it urgent?"] } })).not.toThrow();
    expect(() => validateQuestions({ q: { type: "noul", instructions: [] } })).toThrow(ValidationError);
  });

  it("requires at least two choice options", () => {
    try {
      validateQuestions({
        route: { type: "choice", instructions: "Which team?", criteria: { billing: "Payments" } },
      });
      expect.unreachable("expected a ValidationError");
    } catch (error) {
      expect((error as ValidationError).questionId).toBe("route");
      expect((error as Error).message).toContain("at least 2");
    }
  });

  it("requires at least two score levels", () => {
    try {
      validateQuestions({ sev: { type: "score", instructions: "How severe?", criteria: ["Low"] } });
      expect.unreachable("expected a ValidationError");
    } catch (error) {
      expect((error as ValidationError).questionId).toBe("sev");
      expect((error as Error).message).toContain("at least 2");
    }
  });

  it("rejects an unknown type", () => {
    expect(() =>
      validateQuestions({ q: { type: "vibes", instructions: "hm" } as unknown as Question }),
    ).toThrow(/unknown type/);
  });

  it("rejects a non-object question", () => {
    expect(() => validateQuestions({ q: null as unknown as Question })).toThrow(/not a question object/);
  });
});
