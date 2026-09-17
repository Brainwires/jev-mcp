/**
 * Hook I/O types.
 *
 * `permissionDecision` is typed `"ask" | "deny"` on purpose. Invariant 1 of the
 * plugin spec says a Jev judgment must never grant permission — Jev is not
 * injection-hardened, so a tool input written to argue for its own approval
 * must not be able to produce an approval. Making `"allow"` unrepresentable is
 * the cheapest possible enforcement: a code path that tries to emit it does
 * not compile.
 */

import type { DecisionModel } from "../decision/types.js";
import type { HookConfig } from "./config.js";
import type { Store } from "./store.js";

export type PermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "auto"
  | "dontAsk"
  | "bypassPermissions"
  | (string & {});

/** Every field is optional: stdin comes from outside and may be anything. */
export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: PermissionMode;
  hook_event_name?: string;
  agent_id?: string;
  agent_type?: string;
  /** PreToolUse / PostToolUse / PostToolUseFailure. */
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
  /** UserPromptSubmit. */
  prompt?: string;
  /** Stop / SubagentStop. */
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  background_tasks?: unknown[];
  session_crons?: unknown[];
  /** SessionStart. */
  source?: string;
}

/** The only permission decisions this plugin may emit. */
export type EscalatingDecision = "ask" | "deny";

export interface HookOutput {
  /** Stop / SubagentStop only. */
  decision?: "block";
  reason?: string;
  /** Shown to the user, on every event. */
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: string;
    permissionDecision?: EscalatingDecision;
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
}

export interface Deps {
  /** `null` when no API key is configured: every judging path must fail open. */
  model: DecisionModel | null;
  config: HookConfig;
  store: Store;
  now: () => number;
}

export type Handler = (input: HookInput, deps: Deps) => Promise<HookOutput | undefined>;
