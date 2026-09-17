/**
 * PreToolUse: the permission gate.
 *
 * Order matters. The prefilter runs first and decides whether Jev is consulted
 * at all, so the common case — reading files, running tests — costs one process
 * start and no network. Only what the prefilter cannot vouch for reaches the
 * model, and only an escalation ever reaches stdout.
 *
 * `allow` is not in the vocabulary. The worst outcome of this hook is a prompt
 * the user did not need; the worst outcome of the alternative is a model that
 * was argued into granting permission.
 */

import { runGateAction } from "../../tools/gate-action-core.js";
import { prefilter } from "../prefilter.js";
import { compactJson, redactAndClamp } from "../redact.js";
import type { DecisionRecord } from "../store.js";
import type { Deps, EscalatingDecision, HookInput, HookOutput } from "../types.js";

/** Longest tool input we will pay to have judged. */
const MAX_ACTION_CHARS = 4000;
const MAX_SUBJECT_CHARS = 300;
/** Modes where nobody is watching, so an `ask` would be answered by nobody. */
const UNATTENDED_MODES = new Set(["dontAsk", "bypassPermissions"]);

function escalation(mode: string | undefined): EscalatingDecision {
  return UNATTENDED_MODES.has(mode ?? "default") ? "deny" : "ask";
}

function askOutput(decision: EscalatingDecision, reason: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

/** One sentence a human can act on, with the probabilities that drove it. */
export function explain(reasons: string[], signals: Record<string, number>): string {
  const top = reasons.slice(0, 3).join(" ");
  const probabilities = Object.entries(signals)
    .filter(([, p]) => p >= 0.5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, p]) => `${name.replace(/_/g, " ")} ${p.toFixed(2)}`)
    .join(", ");
  const tail = probabilities === "" ? "" : ` (${probabilities})`;
  return `[jev] ${top}${tail} Approve only if this is what you wanted.`;
}

export async function handlePreToolUse(input: HookInput, deps: Deps): Promise<HookOutput | undefined> {
  const { config, store } = deps;
  if (config.gateMode === "off") return undefined;

  const sessionId = input.session_id ?? "unknown";
  const toolName = input.tool_name;
  if (toolName === undefined || toolName === "") return undefined;
  if (store.isDisabled(sessionId)) return undefined;

  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
  const cwd = input.cwd ?? process.cwd();
  const verdict = prefilter({ toolName, toolInput, cwd, strict: config.gateMode === "strict" });

  if (verdict.kind === "skip") return undefined;

  const subject = redactAndClamp(`${toolName} ${compactJson(toolInput)}`, MAX_SUBJECT_CHARS);
  const base = {
    ts: new Date(deps.now()).toISOString(),
    session_id: sessionId,
    event: "PreToolUse",
    tool_name: toolName,
    subject,
    prefilter: verdict.reason,
  } satisfies Partial<DecisionRecord> & { ts: string; session_id: string; event: string; decision?: string };

  if (verdict.kind === "escalate") {
    const decision = escalation(input.permission_mode);
    const reason = `[jev] Blocked pattern: ${verdict.reason}. This was matched by a rule in code, not by a model. Confirm explicitly or choose a safer command.`;
    store.append({ ...base, decision, reasons: [verdict.reason] });
    if (input.tool_use_id !== undefined) {
      store.rememberAsk(sessionId, { tool_use_id: input.tool_use_id, ts: deps.now(), tool_name: toolName });
    }
    return askOutput(decision, reason);
  }

  // From here on a judgment is needed. No model means no opinion.
  if (deps.model === null) return undefined;

  const session = store.readSession(sessionId);
  const knownRequest = session.prompts.length > 0;
  const userRequest = knownRequest ? session.prompts.join("\n---\n") : "(unknown)";

  const contextParts = [`Working directory: ${cwd}`];
  if (input.agent_type !== undefined) contextParts.push(`Running inside subagent: ${input.agent_type}`);
  if (input.permission_mode !== undefined) contextParts.push(`Permission mode: ${input.permission_mode}`);

  const policyOptions = {
    ignoreScope: !knownRequest,
    uncertain: config.gateMode === "strict" ? ("confirm" as const) : ("risky-lean" as const),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const result = await runGateAction(
      deps.model,
      {
        action: redactAndClamp(`${toolName} ${compactJson(toolInput)}`, MAX_ACTION_CHARS),
        user_request: redactAndClamp(userRequest, MAX_ACTION_CHARS),
        context: contextParts.join(". "),
        policy: policyOptions,
      },
      {
        model: config.model,
        thresholds: { auto: config.autoThreshold, review: config.reviewThreshold },
        maxConcurrency: 1,
      },
      controller.signal,
    );

    const record: DecisionRecord = {
      ...base,
      decision: result.decision,
      signals: { ...result.signals, blast_radius: result.blast_radius.score },
      policy: { ignore_scope: policyOptions.ignoreScope, uncertain: policyOptions.uncertain },
      reasons: result.reasons,
      model: result.model,
      latency_ms: result.latency_ms,
      input_tokens: result.usage.input_tokens,
    };

    if (result.decision === "allow") {
      store.append(record);
      return undefined;
    }

    // `confirm` asks the user. `block` asks too, unless nobody is there to
    // answer — then it has to be a deny, addressed to Claude instead.
    const decision: EscalatingDecision =
      result.decision === "block" ? escalation(input.permission_mode) : "ask";
    const mapped: DecisionRecord = { ...record, decision };
    if (input.tool_use_id !== undefined) mapped.tool_use_id = input.tool_use_id;
    store.append(mapped);
    if (input.tool_use_id !== undefined) {
      store.rememberAsk(sessionId, { tool_use_id: input.tool_use_id, ts: deps.now(), tool_name: toolName });
    }

    const reason =
      decision === "deny"
        ? `[jev] This action was flagged: ${result.reasons.slice(0, 3).join(" ")} The session runs without permission prompts, so there is no one to confirm it. Get explicit confirmation from the user, or choose a narrower alternative.`
        : explain(result.reasons, { ...result.signals, blast_radius: result.blast_radius.score });

    return askOutput(decision, reason);
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
