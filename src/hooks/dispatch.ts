/**
 * Event dispatch, shared by the command path and the daemon.
 *
 * This was the top of `main.ts` until 0.4.0. It moved because the daemon has to
 * run the same handlers, byte for byte, and `main.ts` now also imports the
 * daemon — which would close an import cycle. `main.ts` re-exports `HANDLERS`
 * and `runEvent`, so nothing that imported them from there had to change.
 *
 * The point of sharing this rather than reimplementing it is pinned by
 * `tests/hooks/conformance.test.ts`: the same input through `node hook.mjs
 * PreToolUse` and through `POST /v1/hook/PreToolUse` must produce identical
 * bytes. Two code paths that agree by construction beat two that agree because
 * somebody remembered.
 */

import { handleApproval, handlePostToolUse } from "./handlers/post-tool-use.js";
import { handlePreToolUse } from "./handlers/pre-tool-use.js";
import { handleSessionEnd } from "./handlers/session-end.js";
import { handleSessionStart } from "./handlers/session-start.js";
import { handleStop } from "./handlers/stop.js";
import { handleUserPromptSubmit } from "./handlers/user-prompt-submit.js";
import type { Deps, Handler, HookInput, HookOutput } from "./types.js";

/** Hard ceiling for a handler, under the 5 s hooks.json timeout. */
export const WALL_CLOCK_MS = 3500;

/**
 * Every event this plugin answers.
 *
 * `Approval` is not a Claude Code event: it is this repo's label for the
 * bookkeeping-only path wired up to `PostToolUse` and `PostToolUseFailure`, and
 * it is in here because the daemon exposes one route per key of this object.
 */
export const HANDLERS: Record<string, Handler> = {
  PreToolUse: handlePreToolUse,
  PostToolUse: handlePostToolUse,
  PostToolUseFailure: handlePostToolUse,
  /** Correlation bookkeeping only. Answers nothing. */
  Approval: handleApproval,
  UserPromptSubmit: handleUserPromptSubmit,
  Stop: handleStop,
  SubagentStop: handleStop,
  SessionStart: handleSessionStart,
  SessionEnd: handleSessionEnd,
};

/** Resolve `undefined` rather than reject when the handler overruns. */
export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Dispatch one event. Exported for the tests, which inject `deps`. */
export async function runEvent(event: string, raw: string, deps: Deps): Promise<HookOutput | undefined> {
  const handler = HANDLERS[event];
  if (handler === undefined) return undefined;

  let input: HookInput;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    input = parsed as HookInput;
  } catch {
    // Malformed stdin is not this plugin's problem to report.
    return undefined;
  }

  if (input.hook_event_name === undefined) input.hook_event_name = event;
  return handler(input, deps);
}
