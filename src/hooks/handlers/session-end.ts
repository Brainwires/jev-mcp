/**
 * SessionEnd: nothing, on purpose.
 *
 * The event is wired up for one reason — it is how the daemon learns a session
 * is over, so it can drop the session's config snapshot and, if that was the
 * last one, arm its exit timer. That bookkeeping belongs to the daemon (it owns
 * the registry), which is why this handler has no body: the daemon's route runs
 * it and then ends the session itself.
 *
 * Deliberately not a place to do work. SessionEnd hooks share a 1.5-second
 * budget across every plugin, Claude Code discards their output, and the user
 * is on their way out. Pruning, rotation and reports all happen somewhere the
 * user is not waiting.
 */

import type { Deps, HookInput, HookOutput } from "../types.js";

export async function handleSessionEnd(_input: HookInput, _deps: Deps): Promise<HookOutput | undefined> {
  return undefined;
}
