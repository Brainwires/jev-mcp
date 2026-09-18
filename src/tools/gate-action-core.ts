/**
 * `jev_gate_action` without zod.
 *
 * The questions, the deterministic policy, and the `run` that ties them
 * together live here so that callers who must stay dependency-free — the
 * Claude Code hook bundle in `src/hooks`, which may not pull in zod or the MCP
 * SDK — can reuse the exact same judgment the MCP tool exposes. `gate-action.ts`
 * adds the zod schemas and the tool description on top and re-exports all of
 * this; nothing is forked.
 *
 * This is an advisory layer, not a security boundary. Jev is not hardened
 * against adversarial text in the state (see the jev-1.13 jaggedness notes), so
 * a `user_request` or `context` crafted to argue for its own approval can move
 * these probabilities. Real enforcement belongs in the harness.
 */

import { lean, resolveThresholds, type Lean } from "../decision/policy.js";
import type {
  DecisionModel,
  EvaluateRequest,
  GateThresholds,
  Json,
  NoulAnswer,
  Question,
  ScoreAnswer,
} from "../decision/types.js";
import type { ToolConfig } from "./shared.js";

export const name = "jev_gate_action";

export const DECISIONS = ["allow", "confirm", "block"] as const;
export type ActionDecision = (typeof DECISIONS)[number];

/** At or above this blast-radius score, confirm even if nothing else fires. */
export const HIGH_BLAST_RADIUS = 2;

const BLAST_RADIUS_LEVELS = [
  "No effect outside this conversation: reading, listing, searching, or computing something.",
  "Affects only files or state the user is directly working on, and the change is easy to undo.",
  "Affects shared project state or many files at once: a commit, a dependency change, a schema migration, a bulk edit.",
  "Affects production, other people, or anything beyond this machine: a deploy, a sent message, a payment, published data, deleted history.",
];

export const QUESTIONS: Record<string, Question> = {
  destructive: {
    type: "noul",
    instructions: "Does `action` delete, overwrite, or irreversibly change data or state that already exists?",
    criteria: {
      true: "Running `action` destroys or replaces something that exists, and getting it back would need a backup or a rewrite.",
      false: "`action` only reads, lists, or adds something new, or any change it makes is trivially reversible.",
    },
  },
  outward_facing: {
    type: "noul",
    instructions:
      "Does `action` send, publish, spend, or otherwise affect other people or systems outside the machine it runs on?",
    criteria: {
      true: "`action` transmits something outward, spends money, or changes state that other people can see.",
      false: "`action`'s effects stay on the local machine. Read-only network fetches count as false.",
    },
  },
  in_scope: {
    type: "noul",
    instructions: "Does `user_request` ask for `action`, or plainly require it as a step?",
    criteria: {
      true: "`action` is something `user_request` asked for, or an obvious step towards it.",
      false: "`action` goes beyond `user_request`, or is about something `user_request` never mentioned.",
    },
  },
  credential_exposure: {
    type: "noul",
    instructions:
      "Does `action` read, transmit, or print a secret such as an API key, password, access token, private key, or credentials file?",
    criteria: {
      true: "A secret value, or a file whose purpose is holding secrets, is read, sent somewhere, or written into output.",
      false: "`action` does not touch secret values.",
    },
  },
  blast_radius: {
    type: "score",
    instructions: "How far do the effects of `action` reach?",
    criteria: BLAST_RADIUS_LEVELS,
  },
};

export interface GateActionSignals {
  destructive: number;
  outward_facing: number;
  in_scope: number;
  credential_exposure: number;
}

const RISK_SIGNALS = ["destructive", "outward_facing", "credential_exposure"] as const;
const SIGNAL_NAMES = ["destructive", "outward_facing", "in_scope", "credential_exposure"] as const;

/** How an uncertain signal is treated. */
export type UncertainMode = "confirm" | "risky-lean";

export interface GateActionPolicyOptions {
  /**
   * Drop `in_scope` from every rule and from the reasons. For callers that do
   * not know what the user asked for — a permission hook sees a tool call, not
   * a request — a scope judgment against an unknown request is noise, and
   * noise that fires a prompt is worse than no signal at all.
   */
  ignoreScope?: boolean | undefined;
  /**
   * What an uncertain signal does. `"confirm"` (the default, and the behavior
   * the MCP tool has always had) treats not-knowing as a reason for a human to
   * decide. `"risky-lean"` confirms only when the uncertain signal leans the
   * unsafe way — `p >= 0.5` for a risk signal, `p < 0.5` for `in_scope` —
   * because prompt fatigue is the main failure mode of an automatic gate.
   */
  uncertain?: UncertainMode | undefined;
  /**
   * An uncertain `in_scope` fires only when something corroborates it: another
   * risk signal at `p >= 0.5`, or a wide blast radius. Jev reads scope
   * literally, so supporting work the request never named — installing a
   * dependency, committing — lands in the uncertain band on its own, and a
   * prompt for each of those teaches the user to stop reading prompts. A firm
   * out-of-scope reading still confirms by itself.
   */
  lenientScope?: boolean | undefined;
  /**
   * Do not confirm an action merely for reaching outside the machine when the
   * user asked for it: `in_scope >= thresholds.review`, and neither
   * `destructive` nor `credential_exposure` leans yes (`p < 0.5`). Outward
   * reach and blast radius then stop being reasons to ask. The caller abstains
   * rather than approves, so the host's own permission flow still applies.
   *
   * The scope bar is `review`, not `auto`, and that is the whole point of the
   * option. A push the user asked for is exactly the case this exists to stay
   * silent on — it was added because a user was prompted for one — and Jev
   * scores genuinely requested pushes at `in_scope` 0.72 to 0.81 in the logged
   * data. An `auto` bar would almost never be met and the option would be dead
   * code. A firm out-of-scope reading, anything destructive, and anything
   * touching credentials all still escalate: `requested` cancels only the
   * reach-and-radius reasons, never a risk signal.
   */
  trustRequested?: boolean | undefined;
  /**
   * Raise the bar for an *uncertain* signal to fire at all.
   *
   * An uncertain risk signal — `destructive`, `outward_facing` or
   * `credential_exposure` in the uncertain band — fires only when something
   * corroborates it: a wide blast radius, a second risk signal at `p >= 0.5`,
   * or `in_scope` leaning no. And an uncertain `in_scope` under
   * `lenientScope` needs corroboration that is *firm*, not merely leaning: a
   * signal the policy would not act on alone cannot be what makes another one
   * act.
   *
   * This is the noise fix. On the first day of real use, ten of twenty-three
   * escalations were a single uncertain signal on an ordinary in-project edit,
   * and a prompt for each of those is how a user learns to approve without
   * reading. Hook-only: the MCP tool leaves it off, so its behaviour is
   * unchanged.
   */
  corroborateUncertain?: boolean | undefined;
}

export interface GateActionPolicyInput {
  signals: GateActionSignals;
  /** Probability-weighted blast-radius level, 0..3. */
  blast_radius: number;
  thresholds: GateThresholds;
  options?: GateActionPolicyOptions | undefined;
}

export interface GateActionPolicyResult {
  decision: ActionDecision;
  reasons: string[];
  leans: Record<keyof GateActionSignals, Lean>;
}

/** Does an uncertain signal sitting at `p` lean towards the unsafe side? */
function leansRisky(signal: keyof GateActionSignals, p: number): boolean {
  return signal === "in_scope" ? p < 0.5 : p >= 0.5;
}

/**
 * Deterministic policy. Pure: same signals in, same decision out.
 *
 * - **block** when the action does not look like something the user asked for
 *   *and* it is destructive or outward-facing. Being merely uncertain about
 *   scope is not enough to block; it is enough to confirm.
 * - **confirm** when any risk signal leans yes, when the blast radius is high,
 *   when the action looks out of scope, or when a signal sits in the uncertain
 *   band — a model that does not know is exactly when a human should decide.
 *   `options.uncertain: "risky-lean"` narrows that last rule to the uncertain
 *   signals that lean unsafe.
 * - **allow** otherwise.
 *
 * With `options.ignoreScope`, `in_scope` takes part in nothing: no block, no
 * confirm, no reason. Its raw probability and lean are still reported.
 */
export function gateActionPolicy(input: GateActionPolicyInput): GateActionPolicyResult {
  const auto = input.thresholds.auto;
  const ignoreScope = input.options?.ignoreScope === true;
  const uncertainMode: UncertainMode = input.options?.uncertain ?? "confirm";
  const lenientScope = input.options?.lenientScope === true;
  const { signals } = input;

  const corroborateUncertain = input.options?.corroborateUncertain === true;

  const requested =
    input.options?.trustRequested === true &&
    !ignoreScope &&
    signals.in_scope >= input.thresholds.review &&
    signals.destructive < 0.5 &&
    signals.credential_exposure < 0.5;
  const wideBlast = input.blast_radius >= HIGH_BLAST_RADIUS;
  /**
   * What counts as something else agreeing. With `corroborateUncertain` the
   * corroborating signal has to be one the policy would act on by itself;
   * otherwise a leaning-but-uncertain reading is enough, as in 0.1.x.
   */
  const corroborated = corroborateUncertain
    ? wideBlast || RISK_SIGNALS.some((name) => signals[name] >= auto)
    : wideBlast || RISK_SIGNALS.some((name) => signals[name] >= 0.5);

  const leans = {
    destructive: lean(input.signals.destructive, auto),
    outward_facing: lean(input.signals.outward_facing, auto),
    in_scope: lean(input.signals.in_scope, auto),
    credential_exposure: lean(input.signals.credential_exposure, auto),
  } satisfies Record<keyof GateActionSignals, Lean>;

  const reasons: string[] = [];

  if (leans.destructive === "yes") reasons.push("The action destroys or overwrites existing data.");
  if (leans.outward_facing === "yes" && !requested) {
    reasons.push("The action affects people or systems outside this machine.");
  }
  if (leans.credential_exposure === "yes") reasons.push("The action touches credentials or secret values.");
  if (wideBlast && !requested) {
    reasons.push(`The blast radius is wide (${input.blast_radius.toFixed(2)} of 3).`);
  }
  const outOfScope = !ignoreScope && leans.in_scope === "no";
  if (outOfScope) reasons.push("The action does not look like something the user asked for.");

  const uncertainSignals = SIGNAL_NAMES.filter((signal) => {
    if (leans[signal] !== "uncertain") return false;
    if (ignoreScope && signal === "in_scope") return false;
    if (signal === "in_scope" && (requested || (lenientScope && !corroborated))) return false;
    if (signal === "outward_facing" && requested) return false;
    if (uncertainMode !== "confirm" && !leansRisky(signal, input.signals[signal])) return false;
    // An uncertain risk signal on its own is the single biggest source of
    // prompts nobody needed. It has to be corroborated by something.
    if (corroborateUncertain && (RISK_SIGNALS as readonly string[]).includes(signal)) {
      const secondRiskSignal = RISK_SIGNALS.some((other) => other !== signal && signals[other] >= 0.5);
      if (!wideBlast && !secondRiskSignal && leans.in_scope !== "no") return false;
    }
    return true;
  });

  for (const signal of uncertainSignals) {
    reasons.push(
      `The model is unsure whether the action is ${signal.replace(/_/g, " ")} (${input.signals[signal].toFixed(2)}).`,
    );
  }

  const consequential = leans.destructive === "yes" || (leans.outward_facing === "yes" && !requested);

  if (outOfScope && consequential) {
    return { decision: "block", reasons, leans };
  }

  const needsConfirm =
    consequential ||
    leans.credential_exposure === "yes" ||
    (wideBlast && !requested) ||
    outOfScope ||
    uncertainSignals.length > 0;

  if (needsConfirm) return { decision: "confirm", reasons, leans };

  const nothingFired = ignoreScope
    ? "No risk signal fired."
    : requested && (leans.outward_facing === "yes" || wideBlast)
      ? "The action reaches outside this machine, but it is what the user asked for and nothing destructive fired."
      : "No risk signal fired and the action is in scope.";
  return {
    decision: "allow",
    reasons: reasons.length > 0 ? reasons : [nothingFired],
    leans,
  };
}

/** What `runGateAction` needs. A plain `ToolConfig` satisfies it. */
export type GateActionRunConfig = ToolConfig & {
  /** Policy options applied unless the call overrides them with `input.policy`. */
  gatePolicy?: GateActionPolicyOptions | undefined;
};

export interface GateActionCoreInput {
  action: string;
  user_request: string;
  context?: string | undefined;
  thresholds?: { auto?: number | undefined; review?: number | undefined } | undefined;
  /**
   * Per-call policy options. Deliberately absent from the MCP tool's input
   * schema: a model asking for its own uncertain signals to be ignored is not
   * a request the server should honour.
   */
  policy?: GateActionPolicyOptions | undefined;
}

export interface GateActionCoreResult {
  decision: ActionDecision;
  reasons: string[];
  signals: GateActionSignals;
  signal_leans: Record<keyof GateActionSignals, Lean>;
  blast_radius: { score: number; legend?: Record<string, string>; confidence: number };
  thresholds: GateThresholds;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  latency_ms: number;
}

export async function runGateAction(
  model: DecisionModel,
  input: GateActionCoreInput,
  config: GateActionRunConfig,
  signal?: AbortSignal,
): Promise<GateActionCoreResult> {
  const thresholds = resolveThresholds(config.thresholds, input.thresholds);

  const state: Record<string, Json> = { action: input.action, user_request: input.user_request };
  if (input.context !== undefined) state.context = input.context;

  const request: EvaluateRequest = { state, questions: QUESTIONS };
  if (signal !== undefined) request.signal = signal;

  const result = await model.evaluate(request);
  const answers = result.answers as Record<string, NoulAnswer | ScoreAnswer | undefined>;

  const signals: GateActionSignals = {
    destructive: noul(answers.destructive),
    outward_facing: noul(answers.outward_facing),
    in_scope: noul(answers.in_scope),
    credential_exposure: noul(answers.credential_exposure),
  };

  const blast = answers.blast_radius as ScoreAnswer | undefined;
  const blastScore = typeof blast?.score === "number" ? blast.score : HIGH_BLAST_RADIUS;

  const policy = gateActionPolicy({
    signals,
    blast_radius: blastScore,
    thresholds,
    options: input.policy ?? config.gatePolicy,
  });

  const blastOut: GateActionCoreResult["blast_radius"] = {
    score: blastScore,
    confidence: typeof blast?.confidence === "number" ? blast.confidence : 0,
  };
  if (blast?.legend !== undefined) blastOut.legend = blast.legend;

  return {
    decision: policy.decision,
    reasons: policy.reasons,
    signals,
    signal_leans: policy.leans,
    blast_radius: blastOut,
    thresholds,
    model: result.model,
    usage: result.usage,
    latency_ms: result.latency_ms,
  };
}

/** A missing or non-noul answer reads as maximally uncertain, never as safe. */
function noul(answer: NoulAnswer | ScoreAnswer | undefined): number {
  return answer !== undefined && answer.type === "noul" && typeof answer.noul === "number" ? answer.noul : 0.5;
}

/** Names of the signals the policy reads, for callers that iterate them. */
export const GATE_ACTION_SIGNAL_NAMES = SIGNAL_NAMES;
export const GATE_ACTION_RISK_SIGNAL_NAMES = RISK_SIGNALS;
