/**
 * `jev_gate_action` — pre-flight judgment on an action an agent is about to take.
 *
 * Five judgments in one request, then a deterministic policy in code turns them
 * into allow / confirm / block. The policy is a pure function so it can be
 * exercised as a truth table without a network.
 *
 * The questions, the policy, and `run` itself live in `gate-action-core.ts`,
 * which imports nothing outside the decision contract. This module is the MCP
 * face of it: zod schemas, the tool description, and the wire types. The
 * Claude Code hook bundle uses the core directly so it does not ship zod.
 *
 * This is an advisory layer, not a security boundary. Jev is not hardened
 * against adversarial text in the state (see the jev-1.13 jaggedness notes), so
 * a `user_request` or `context` crafted to argue for its own approval can move
 * these probabilities. Real enforcement belongs in the harness.
 */

import { z } from "zod";
import type { DecisionModel, Json } from "../decision/types.js";
import {
  DECISIONS,
  runGateAction,
  type GateActionCoreInput,
  type GateActionPolicyOptions,
  type GateActionRunConfig,
} from "./gate-action-core.js";
import { envelopeShape, thresholdsSchema } from "./shared.js";

export {
  DECISIONS,
  GATE_ACTION_RISK_SIGNAL_NAMES,
  GATE_ACTION_SIGNAL_NAMES,
  gateActionPolicy,
  HIGH_BLAST_RADIUS,
  isWide,
  name,
  QUESTIONS,
  runGateAction,
  scopeFromAnswer,
  type ActionDecision,
  type BlastRadiusResult,
  type GateAction,
  type GateActionCoreInput,
  type GateActionCoreResult,
  type GateActionPolicyInput,
  type GateActionPolicyOptions,
  type GateActionPolicyResult,
  type GateActionRunConfig,
  type GateActionSignals,
  type GateContext,
  type GateRequest,
  type ScopeSignals,
  type UncertainMode,
} from "./gate-action-core.js";

export const description = [
  "Advisory pre-flight check on an action you are about to take: judges whether it is destructive, outward-facing or credential-touching, how far it reaches, and how it relates to what the user asked for — then returns allow / confirm / block from a deterministic policy in code.",
  "NOT A SECURITY BOUNDARY. It is a judgment layer that catches plausible mistakes, and Jev is not hardened against adversarial text: an action or context written to argue for its own approval can shift the result. Never rely on it to contain untrusted input, and never let `allow` stand in for a real permission check.",
  "Use it just before something you cannot cheaply undo: deleting or overwriting files, git history rewrites, installs, deploys, messages, payments, anything touching an external system.",
  "Pass `action` as the concrete call, not a paraphrase: one line with the tool name and arguments, or the fields `{tool, command, file_path, target_paths, …}`, which scores scope better. Pass `user_request` in the user's own words, as a string or `{latest, previous}`.",
  "`confirm` means ask the user first. `block` means it looks both unrelated to the request and consequential; re-read the request rather than retrying.",
].join("\n");

const actionObjectSchema = z
  .object({
    tool: z.string().min(1).describe("The tool name, e.g. Bash, Write, or an mcp__ tool."),
    command: z.string().optional().describe("Bash: the command as written."),
    file_path: z.string().optional(),
    old_string: z.string().optional(),
    new_string: z.string().optional(),
    content_head: z.string().optional().describe("Write: the head of the content."),
    content_chars: z.number().optional(),
    input: z.record(z.string(), z.unknown()).optional().describe("Anything else the tool was given."),
    target_paths: z
      .array(z.string())
      .default([])
      .describe("Path-shaped arguments, relative to the working directory. Scope is judged against these."),
    text: z.string().optional().describe("The whole action as one line, when that is all you have."),
  })
  .describe("The action as fields. Preferred over a string: the scope questions compare its names against the prompts.");

const requestObjectSchema = z
  .object({
    latest: z.string().min(1).describe("The request that is current."),
    previous: z.array(z.string()).default([]).describe("Earlier requests, oldest first. Context for the latest one."),
  })
  .describe("The user's request, as the current one plus what came before it.");

const contextObjectSchema = z
  .object({
    cwd: z.string().optional(),
    subagent: z.string().optional().describe("The subagent type, when this call is happening inside one."),
    permission_mode: z.string().optional(),
    notes: z.string().optional().describe("Anything else worth knowing: the task, the relevant prior step."),
  })
  .describe("Where the action is running.");

export const inputShape = {
  action: z
    .union([z.string().min(1), actionObjectSchema])
    .describe("Exactly what you are about to do, including the tool name and its arguments."),
  user_request: z
    .union([z.string().min(1), requestObjectSchema])
    .describe("What the user actually asked for, in their words."),
  context: z
    .union([z.string(), contextObjectSchema])
    .optional()
    .describe("Optional short context: the working directory, the task, the relevant prior step."),
  thresholds: thresholdsSchema,
} as const;

export const inputSchema = z.object(inputShape);
export type GateActionToolInput = z.infer<typeof inputSchema>;

const leanSchema = z.enum(["yes", "no", "uncertain"]);

export const outputShape = {
  decision: z.enum(DECISIONS).describe("allow: proceed. confirm: ask the user first. block: do not run it."),
  reasons: z.array(z.string()).describe("Which policy rules fired, in plain language."),
  signals: z
    .object({
      destructive: z.number(),
      outward_facing: z.number(),
      in_scope: z.number(),
      credential_exposure: z.number(),
    })
    .describe("Raw P(yes) for each signal. Near 0.5 means the model is unsure."),
  signal_leans: z
    .object({
      destructive: leanSchema,
      outward_facing: leanSchema,
      in_scope: leanSchema,
      credential_exposure: leanSchema,
    })
    .describe("How each signal was read: yes / no / uncertain, using the auto threshold."),
  blast_radius: z
    .object({
      score: z.number().describe("Probability-weighted level, 0..3. Can fall between levels."),
      legend: z.record(z.string(), z.string()).optional(),
      confidence: z.number(),
      level: z.number().describe("The level the answer picked."),
      p_level: z.number().describe("Probability of that level."),
      p_high: z.number().optional().describe("P(level 2) + P(level 3). Absent when no probabilities came back."),
      source: z.enum(["probabilities", "expectation"]),
    })
    .describe("How far the effects reach. 0 = read-only, 3 = production or other people."),
  scope: z
    .object({
      unrelated: z.number().describe("P(no request asks for this and the work does not need it)."),
      step: z.number().describe("P(an ordinary step of the requested work, not named in any request)."),
      requested: z.number().describe("P(a request asks for this action, or names its target and this operation)."),
      mentions_target: z.number().describe("P(a request names what this action acts on)."),
      same_task_area: z.number().describe("P(this action touches the part of the project the request is about)."),
      source: z.enum(["probabilities", "expectation"]),
    })
    .describe("What the scope reading was made of. `signals.in_scope` is `step + requested`."),
  thresholds: z.object({ auto: z.number(), review: z.number() }),
  ...envelopeShape,
} as const;

export const outputSchema = z.object(outputShape);
export type GateActionToolOutput = z.infer<typeof outputSchema>;

/**
 * Run the tool.
 *
 * `input.policy` and `config.gatePolicy` carry the policy options (see
 * `GateActionPolicyOptions`). Neither is part of `inputSchema`, so the MCP
 * tool's public contract is unchanged and only in-process callers — the hooks —
 * can reach them.
 */
export async function run(
  model: DecisionModel,
  input: GateActionToolInput & { policy?: GateActionPolicyOptions | undefined },
  config: GateActionRunConfig,
  signal?: AbortSignal,
): Promise<GateActionToolOutput> {
  return runGateAction(model, coreInput(input), config, signal);
}

/**
 * The parsed tool input as a `GateActionCoreInput`.
 *
 * Only two things actually differ: zod widens an optional field to `T |
 * undefined`, and it types a free-form record as `unknown`-valued where the
 * core wants `Json`. Both are narrowed here rather than by loosening the core's
 * types, so the hook path — which builds a `GateAction` directly and never sees
 * zod — keeps the stricter contract.
 */
function coreInput(
  input: GateActionToolInput & { policy?: GateActionPolicyOptions | undefined },
): GateActionCoreInput {
  const action: GateActionCoreInput["action"] =
    typeof input.action === "string"
      ? input.action
      : { ...input.action, input: input.action.input as Record<string, Json> | undefined };
  return {
    action,
    user_request: input.user_request,
    ...(input.context !== undefined ? { context: input.context } : {}),
    ...(input.thresholds !== undefined ? { thresholds: input.thresholds } : {}),
    ...(input.policy !== undefined ? { policy: input.policy } : {}),
  };
}
