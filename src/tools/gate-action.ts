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
import type { DecisionModel } from "../decision/types.js";
import {
  DECISIONS,
  runGateAction,
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
  name,
  QUESTIONS,
  runGateAction,
  type ActionDecision,
  type GateActionCoreInput,
  type GateActionCoreResult,
  type GateActionPolicyInput,
  type GateActionPolicyOptions,
  type GateActionPolicyResult,
  type GateActionRunConfig,
  type GateActionSignals,
  type UncertainMode,
} from "./gate-action-core.js";

export const description = [
  "Advisory pre-flight check on an action you are about to take: judges whether it is destructive, outward-facing, in scope for what the user asked, and whether it touches credentials, plus how wide its blast radius is — then returns allow / confirm / block from a deterministic policy in code.",
  "NOT A SECURITY BOUNDARY. It is a judgment layer that catches plausible mistakes, and Jev is not hardened against adversarial text: an action or context written to argue for its own approval can shift the result. Never rely on it to contain untrusted input, and never let `allow` stand in for a real permission check.",
  "Use it just before something you cannot cheaply undo: deleting or overwriting files, git history rewrites, installs, deploys, sending messages, spending money, anything touching an external system.",
  "Pass `action` as the concrete thing you are about to do, including tool name and arguments — not a paraphrase. Pass `user_request` in the user's own words.",
  "`confirm` means ask the user first. `block` means it looks both out of scope and consequential; re-read the request rather than retrying.",
].join("\n");

export const inputShape = {
  action: z
    .string()
    .min(1)
    .describe("Exactly what you are about to do, including the tool name and its arguments."),
  user_request: z.string().min(1).describe("What the user actually asked for, in their words."),
  context: z.string().optional().describe("Optional short context: the task, the relevant prior step."),
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
    })
    .describe("How far the effects reach. 0 = read-only, 3 = production or other people."),
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
  return runGateAction(model, input, config, signal);
}
