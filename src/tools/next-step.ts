/**
 * `jev_next_step` — agent control flow as a judgment plus a policy.
 *
 * One request asks what to do next and four supporting yes/no questions. Code
 * then overrides the choice where a model must not have the last word: it may
 * not declare the goal done unless the completion signal is confidently yes,
 * and it may not retry forever. The attempt count never goes to the model —
 * Jev does not compare numbers reliably, so the cap is enforced in code.
 */

import { z } from "zod";
import { gate, gateNoul, lean, resolveThresholds } from "../decision/policy.js";
import type {
  ChoiceAnswer,
  DecisionModel,
  EvaluateRequest,
  GateThresholds,
  Json,
  NoulAnswer,
  Question,
} from "../decision/types.js";
import { envelopeShape, thresholdsSchema, type ToolConfig } from "./shared.js";

export const name = "jev_next_step";

export const description = [
  "Decide what an agent should do next after a step: continue / retry / change_approach / ask_user / done, with the reasoning signals behind it.",
  "Use it when a loop has stalled and you are about to guess: a tool returned an error you are unsure how to read, a search came back thin, you have tried the same thing more than once, or you are about to tell the user you are finished.",
  "It is deliberately conservative about `done`: the verdict is downgraded to `continue` unless the completion signal comes back a confident yes, so a premature 'task complete' turns into another step instead. `retry` is capped in code — pass `attempts` and it becomes `change_approach` once you have tried enough.",
  "Pass `result` truncated to the part that matters (the error text, the head of the output); a huge dump lowers accuracy. Pass `last_step` as what you actually ran, and `goal` as the user's objective rather than the current sub-task.",
  "Read `reasons` before acting: it names every code-level override, which is usually more informative than the verdict itself.",
].join("\n");

export const inputShape = {
  goal: z.string().min(1).describe("The objective being pursued, in the user's terms."),
  last_step: z.string().min(1).describe("What was just attempted, concretely."),
  result: z
    .string()
    .min(1)
    .describe("What came back: tool output or error text. Truncate it yourself to the part that matters."),
  attempts: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("How many times this same step has already been attempted, including the one just made. Default 1."),
  thresholds: thresholdsSchema,
} as const;

export const inputSchema = z.object(inputShape);
export type NextStepToolInput = z.infer<typeof inputSchema>;

export const NEXT_STEPS = ["continue", "retry", "change_approach", "ask_user", "done"] as const;
export type NextStep = (typeof NEXT_STEPS)[number];

export const outputShape = {
  next: z.enum(NEXT_STEPS).describe("What to do, after code-level overrides."),
  reasons: z.array(z.string()).describe("Why, including every override code applied to the model's choice."),
  signals: z
    .object({
      step_succeeded: z.number(),
      error_is_transient: z.number(),
      goal_complete: z.number(),
      result_relevant: z.number(),
    })
    .describe("Raw P(yes) for each supporting judgment. Near 0.5 means unsure."),
  choice_probabilities: z
    .record(z.string(), z.number())
    .describe("The model's distribution over the five next-step options."),
  confidence: z.number().describe("How peaked that distribution is."),
  thresholds: z.object({ auto: z.number(), review: z.number() }),
  ...envelopeShape,
} as const;

export const outputSchema = z.object(outputShape);
export type NextStepToolOutput = z.infer<typeof outputSchema>;

/** Retries allowed before the policy forces a different approach. */
export const MAX_RETRY_ATTEMPTS = 3;

const CRITERIA: Record<NextStep, string> = {
  continue:
    "`last_step` did what it was meant to do, and `goal` needs further steps. Keep going with the same plan.",
  retry:
    "`last_step` failed for a reason that might not happen again — a timeout, a rate limit, a temporary " +
    "network or service error — so running the very same step again unchanged is worth trying.",
  change_approach:
    "`last_step` failed for a reason that would happen again, or produced nothing useful. A different " +
    "method, tool, or set of inputs is needed.",
  ask_user:
    "Making progress needs a decision or information only the user has, or `goal` is ambiguous enough " +
    "that guessing risks doing the wrong work.",
  done: "`goal` is fully achieved by what has already happened. Nothing remains to do.",
};

const QUESTIONS: Record<string, Question> = {
  next: {
    type: "choice",
    instructions: "Given `goal`, what was attempted in `last_step`, and what came back in `result`, what should be done next?",
    criteria: { ...CRITERIA },
  },
  step_succeeded: {
    type: "noul",
    instructions: "Does `result` show that `last_step` completed successfully?",
    criteria: {
      true: "`result` shows the intended effect of `last_step`, or output consistent with it succeeding.",
      false: "`result` reports an error, a failure, or output showing `last_step` did not do what it intended.",
    },
  },
  error_is_transient: {
    type: "noul",
    instructions:
      "Does `result` describe a failure that could succeed if the very same step ran again unchanged?",
    criteria: {
      true: "A timeout, a rate limit, a temporary network or service error, a lock, or a busy resource.",
      false:
        "There is no failure in `result` at all, or the failure was caused by wrong input, a missing " +
        "permission, a bug, or something that does not exist — repeating it would fail the same way.",
    },
  },
  goal_complete: {
    type: "noul",
    instructions: "Taking `last_step` and `result` together, has `goal` been fully achieved?",
    criteria: {
      true: "Everything `goal` asks for has been done, and `result` shows it.",
      false: "Any part of `goal` is still outstanding, or `result` does not show that it was done.",
    },
  },
  result_relevant: {
    type: "noul",
    instructions: "Does `result` contain information that helps achieve `goal`?",
    criteria: {
      true: "`result` contains something usable for `goal`.",
      false: "`result` is empty, off-topic, or only restates what was already known.",
    },
  },
};

export interface NextStepSignals {
  step_succeeded: number;
  error_is_transient: number;
  goal_complete: number;
  result_relevant: number;
}

export interface NextStepPolicyInput {
  /** The model's choice: which option and how peaked the distribution was. */
  choice: { choice: string; confidence: number };
  signals: NextStepSignals;
  /** Attempts already made at this step. Compared in code, never by the model. */
  attempts: number;
  thresholds: GateThresholds;
}

export interface NextStepPolicyResult {
  next: NextStep;
  reasons: string[];
}

/**
 * Deterministic control-flow policy. Pure.
 *
 * Order matters: a choice the model was not confident about becomes `ask_user`
 * before anything else is considered, because the downstream overrides all
 * assume the choice meant something.
 */
export function nextStepPolicy(input: NextStepPolicyInput): NextStepPolicyResult {
  const reasons: string[] = [];
  const known = (NEXT_STEPS as readonly string[]).includes(input.choice.choice);

  if (!known) {
    return {
      next: "ask_user",
      reasons: [`The model returned an unrecognised next step (${JSON.stringify(input.choice.choice)}).`],
    };
  }

  let next = input.choice.choice as NextStep;
  reasons.push(`Model suggested \`${next}\` (confidence ${input.choice.confidence.toFixed(2)}).`);

  if (gate(input.choice.confidence, input.thresholds) === "escalate") {
    return {
      next: "ask_user",
      reasons: [
        ...reasons,
        `Confidence is below the review threshold (${input.thresholds.review}), so the choice is not actionable; asking the user instead.`,
      ],
    };
  }

  if (next === "done") {
    const complete = gateNoul(input.signals.goal_complete, input.thresholds);
    if (!(complete.gate === "auto" && complete.verdict === "yes")) {
      next = "continue";
      reasons.push(
        `Downgraded \`done\` to \`continue\`: goal_complete is ${input.signals.goal_complete.toFixed(2)}, ` +
          `which does not clear the auto threshold (${input.thresholds.auto}) as a yes.`,
      );
    }
  }

  if (next === "retry") {
    const transient = lean(input.signals.error_is_transient, input.thresholds.auto);
    if (transient !== "yes") {
      next = "change_approach";
      reasons.push(
        `Downgraded \`retry\` to \`change_approach\`: error_is_transient is ${input.signals.error_is_transient.toFixed(2)}, ` +
          `so repeating the step would likely fail the same way.`,
      );
    } else if (input.attempts >= MAX_RETRY_ATTEMPTS) {
      next = "change_approach";
      reasons.push(
        `Downgraded \`retry\` to \`change_approach\`: ${input.attempts} attempt(s) already made, at or over the cap of ${MAX_RETRY_ATTEMPTS}.`,
      );
    }
  }

  return { next, reasons };
}

export async function run(
  model: DecisionModel,
  input: NextStepToolInput,
  config: ToolConfig,
  signal?: AbortSignal,
): Promise<NextStepToolOutput> {
  const thresholds = resolveThresholds(config.thresholds, input.thresholds);

  // `attempts` is deliberately absent from the state: the cap is a numeric
  // comparison, which is exactly what Jev should not be asked to do.
  const state: Record<string, Json> = {
    goal: input.goal,
    last_step: input.last_step,
    result: input.result,
  };

  const request: EvaluateRequest = { state, questions: QUESTIONS };
  if (signal !== undefined) request.signal = signal;

  const result = await model.evaluate(request);
  const answers = result.answers as Record<string, ChoiceAnswer | NoulAnswer | undefined>;

  const choiceAnswer = answers.next as ChoiceAnswer | undefined;
  const choice = {
    choice: choiceAnswer?.choice ?? "",
    confidence: typeof choiceAnswer?.confidence === "number" ? choiceAnswer.confidence : 0,
  };

  const signals: NextStepSignals = {
    step_succeeded: noul(answers.step_succeeded),
    error_is_transient: noul(answers.error_is_transient),
    goal_complete: noul(answers.goal_complete),
    result_relevant: noul(answers.result_relevant),
  };

  const policy = nextStepPolicy({
    choice,
    signals,
    attempts: input.attempts ?? 1,
    thresholds,
  });

  return {
    next: policy.next,
    reasons: policy.reasons,
    signals,
    choice_probabilities: choiceAnswer?.probabilities ?? {},
    confidence: choice.confidence,
    thresholds,
    model: result.model,
    usage: result.usage,
    latency_ms: result.latency_ms,
  };
}

/** A missing or wrong-typed answer reads as maximally uncertain. */
function noul(answer: ChoiceAnswer | NoulAnswer | undefined): number {
  return answer !== undefined && answer.type === "noul" && typeof answer.noul === "number" ? answer.noul : 0.5;
}
