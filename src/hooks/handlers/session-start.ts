/**
 * SessionStart: say once, clearly, when the plugin is installed but inert.
 *
 * A gate that silently does nothing is worse than no gate, because the user
 * believes they have one. This is the only place the plugin volunteers
 * anything, and it says nothing at all when it is working.
 */

import type { Deps, HookInput, HookOutput } from "../types.js";

export async function handleSessionStart(input: HookInput, deps: Deps): Promise<HookOutput | undefined> {
  const { config, store } = deps;
  if (config.apiKey !== null) return undefined;
  if (config.gate === "off") return undefined;

  const sessionId = input.session_id ?? "unknown";
  const session = store.readSession(sessionId);
  if (session.key_warned === true) return undefined;
  store.writeSession(sessionId, { ...session, key_warned: true }, deps.now());

  const message =
    "jev hooks are inactive: no TypeSafe API key is configured. Set it with `/plugin` (jev → api_key) or by exporting TYPESAFE_API_KEY, then restart the session.";

  return {
    systemMessage: `[jev] ${message}`,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `[jev] The jev plugin's judgment hooks are installed but inactive, because no TypeSafe API key is configured. Deterministic pattern checks still run. ${message}`,
    },
  };
}
