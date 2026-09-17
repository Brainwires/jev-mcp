/**
 * Local validation of a question map, run before a request goes out.
 *
 * The API returns 422 for the same problems, but a local check names the
 * offending question id in a message the caller can act on without a round
 * trip — and without spending tokens.
 */

import type { Instructions, Question } from "./types.js";

/** Thrown when a question map is malformed. Names the offending question id. */
export class ValidationError extends Error {
  /** The question that failed, or `null` for whole-map problems. */
  readonly questionId: string | null;

  constructor(message: string, questionId: string | null = null) {
    super(message);
    this.name = "ValidationError";
    this.questionId = questionId;
  }
}

function hasContent(instructions: Instructions | undefined): boolean {
  if (instructions === undefined || instructions === null) return false;
  if (typeof instructions === "string") return instructions.trim().length > 0;
  if (Array.isArray(instructions)) return instructions.length > 0;
  if (typeof instructions === "object") return Object.keys(instructions).length > 0;
  return false;
}

/**
 * Validate every question in a request.
 *
 * Checks: at least one question; non-empty instructions on each; at least two
 * options on a Choice; at least two levels on a Score. Returns nothing and
 * throws `ValidationError` on the first problem found.
 */
export function validateQuestions(questions: Record<string, Question>): void {
  const ids = Object.keys(questions);
  if (ids.length === 0) {
    throw new ValidationError("No questions provided: an evaluate request needs at least one question.");
  }

  for (const id of ids) {
    const question = questions[id];
    if (question === undefined || question === null || typeof question !== "object") {
      throw new ValidationError(`Question "${id}" is not a question object.`, id);
    }

    if (!hasContent(question.instructions)) {
      throw new ValidationError(
        `Question "${id}" has empty instructions. Write the full question in \`instructions\` — ` +
          `the question id is never sent to the model.`,
        id,
      );
    }

    switch (question.type) {
      case "choice": {
        const options = question.criteria === null || typeof question.criteria !== "object" ? [] : Object.keys(question.criteria);
        if (options.length < 2) {
          throw new ValidationError(
            `Choice question "${id}" has ${options.length} option${options.length === 1 ? "" : "s"}; ` +
              `a choice needs at least 2. Consider adding an "other" or "none" option too.`,
            id,
          );
        }
        break;
      }
      case "score": {
        const levels = Array.isArray(question.criteria) ? question.criteria : [];
        if (levels.length < 2) {
          throw new ValidationError(
            `Score question "${id}" has ${levels.length} level${levels.length === 1 ? "" : "s"}; ` +
              `a score needs at least 2 ordered level descriptions, lowest first.`,
            id,
          );
        }
        break;
      }
      case "noul":
        break;
      default:
        throw new ValidationError(
          `Question "${id}" has unknown type ${JSON.stringify((question as { type?: unknown }).type)}; ` +
            `expected "choice", "score", or "noul".`,
          id,
        );
    }
  }
}
