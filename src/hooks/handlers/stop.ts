/**
 * Stop: catch the stop-short pattern.
 *
 * Jev sees the final message and nothing else — not the workspace, not the
 * diff, not the test output. That rules out second-guessing a clean "done": a
 * model with no view of the work cannot tell a finished task from an
 * unfinished one. What it *can* read is Claude's own admission that work
 * remains, and that is the only thing this hook blocks on.
 *
 * At most one block per user prompt, counted in code. A stop hook that can
 * argue is a stop hook that loops.
 */

import type { NoulAnswer, Question } from "../../decision/types.js";
import { redactAndClamp } from "../redact.js";
import { requestText } from "../store.js";
import type { Deps, HookInput, HookOutput } from "../types.js";

/** Below this, the message is an acknowledgement, not a report. */
export const MIN_MESSAGE_CHARS = 40;
const MAX_MESSAGE_CHARS = 6000;
/** One block per prompt. */
export const MAX_STOP_BLOCKS = 1;

const QUESTIONS: Record<string, Question> = {
  claims_complete: {
    type: "noul",
    instructions: "Does `final_message` say that the work `user_request` asked for is finished?",
    criteria: {
      true: "`final_message` reports the requested work as done, complete, or working.",
      false: "`final_message` does not claim the work is finished.",
    },
  },
  admits_unfinished: {
    type: "noul",
    instructions:
      "Does `final_message` state that some part of the work `user_request` asked for was NOT done, was skipped, is still failing, or is left as a TODO or a next step?",
    criteria: {
      true: "`final_message` names remaining work: something skipped, still broken, not yet implemented, left for later, or listed as a next step.",
      false: "`final_message` names no remaining work.",
    },
  },
  asks_user: {
    type: "noul",
    instructions: "Is `final_message` waiting for the user to decide something or supply information?",
    criteria: {
      true: "`final_message` asks the user a question, offers a choice, or says it needs something from the user before continuing.",
      false: "`final_message` asks the user for nothing.",
    },
  },
  addresses_request: {
    type: "noul",
    instructions: "Is `final_message` about what `user_request` asked for?",
    criteria: {
      true: "`final_message` responds to `user_request`.",
      false: "`final_message` is about something else.",
    },
  },
};

export interface StopSignals {
  claims_complete: number;
  admits_unfinished: number;
  asks_user: number;
  addresses_request: number;
}

export interface StopPolicyResult {
  block: boolean;
  reasons: string[];
}

/**
 * Block iff Claude itself said work remains and is not waiting on the user.
 *
 * Deliberately narrow. `claims_complete` and `addresses_request` are recorded
 * for calibration but do not gate: "it says it is done" is not evidence that
 * it is, and blocking on it would make this hook an adversary.
 */
export function stopPolicy(signals: StopSignals, auto: number): StopPolicyResult {
  const unfinished = signals.admits_unfinished >= auto;
  const blocked = signals.asks_user > 1 - auto;
  const reasons: string[] = [];
  if (unfinished) reasons.push(`the final message names work that is still outstanding (p=${signals.admits_unfinished.toFixed(2)})`);
  if (blocked) reasons.push(`the final message is waiting on the user (p=${signals.asks_user.toFixed(2)})`);
  return { block: unfinished && !blocked, reasons };
}

/** Cheap check for a message that ends by asking the user something. */
export function endsWithQuestion(message: string): boolean {
  const tail = message.slice(-200).trimEnd();
  return tail.endsWith("?");
}

export async function handleStop(input: HookInput, deps: Deps): Promise<HookOutput | undefined> {
  const { config, store } = deps;
  if (!config.stopCheck) return undefined;
  if (input.stop_hook_active === true) return undefined;

  const sessionId = input.session_id ?? "unknown";
  if (store.isDisabled(sessionId)) return undefined;

  // A session with work in flight is paused, not finished.
  if ((input.background_tasks ?? []).length > 0) return undefined;
  if ((input.session_crons ?? []).length > 0) return undefined;

  const message = input.last_assistant_message ?? "";
  if (message.trim().length < MIN_MESSAGE_CHARS) return undefined;
  if (endsWithQuestion(message)) return undefined;

  const session = store.readSession(sessionId);
  if (session.prompts.length === 0) return undefined;
  if (session.stop_blocks >= MAX_STOP_BLOCKS) return undefined;
  if (deps.model === null) return undefined;

  const eventName = input.hook_event_name === "SubagentStop" ? "SubagentStop" : "Stop";
  const base = {
    ts: new Date(deps.now()).toISOString(),
    session_id: sessionId,
    event: eventName,
    subject: redactAndClamp(message.slice(-300), 300),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const result = await deps.model.evaluate({
      state: {
        user_request: redactAndClamp(requestText(session.prompts, 4000), 4000),
        final_message: redactAndClamp(message.slice(-MAX_MESSAGE_CHARS), MAX_MESSAGE_CHARS),
      },
      questions: QUESTIONS,
      signal: controller.signal,
    });

    const answers = result.answers as Record<string, NoulAnswer | undefined>;
    const noul = (key: string): number => (typeof answers[key]?.noul === "number" ? (answers[key] as NoulAnswer).noul : 0);
    const signals: StopSignals = {
      claims_complete: noul("claims_complete"),
      admits_unfinished: noul("admits_unfinished"),
      asks_user: noul("asks_user"),
      addresses_request: noul("addresses_request"),
    };

    const policy = stopPolicy(signals, config.autoThreshold);
    store.append({
      ...base,
      decision: policy.block ? "block" : "allow",
      signals: { ...signals },
      reasons: policy.reasons,
      model: result.model,
      latency_ms: result.latency_ms,
      input_tokens: result.usage.input_tokens,
    });

    if (!policy.block) return undefined;

    store.updateSession(sessionId, (state) => ({ ...state, stop_blocks: state.stop_blocks + 1 }), deps.now());

    return {
      decision: "block",
      reason: `[jev] Your final message indicates requested work is still unfinished (p=${signals.admits_unfinished.toFixed(
        2,
      )}) and you are not blocked on the user. Continue with the remaining work, or state explicitly what blocks you.`,
    };
  } catch (error) {
    store.append({
      ...base,
      decision: "error",
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
