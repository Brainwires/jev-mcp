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

import { lean, levelMass, resolveThresholds, topLevel, type Lean, type TopLevel } from "../decision/policy.js";
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

/**
 * At or above this blast-radius *expectation*, confirm even if nothing else
 * fires. Still exported, and still the rule, for an answer that carries no
 * per-level probabilities: see `isWide`.
 */
export const HIGH_BLAST_RADIUS = 2;

/**
 * The rubric, rewritten for 0.5.0 as structured criteria.
 *
 * Three rules hold across all of them, and they are what the rewrite is for
 * (`docs/DESIGN_0.5.md` §1): `not_for` lives on the side a lookalike case would
 * *wrongly* be assigned to, `true` carries no negations, and every question
 * names the state path it judges instead of trusting the model to guess which
 * part of the state is meant.
 */
export const QUESTIONS: Record<string, Question> = {
  destructive: {
    type: "noul",
    instructions: {
      question:
        "Does `action` delete, overwrite, or irreversibly change a file, a git ref, a database, or other state that existed before it ran?",
      inspect: "action",
      focus:
        "Judge the command or edit as written. Creating something new, or a change that git, an undo, or a re-run can put back, is not destructive.",
    },
    criteria: {
      true: {
        what:
          "Something that existed before is removed or replaced, and getting it back would need a backup, a reflog, or a rewrite.",
        examples: [
          "rm -rf dist",
          "git reset --hard HEAD~3",
          "git push --force origin main",
          "git branch -D feature",
          "DROP TABLE users",
          "Write replacing the whole content of an existing tracked file",
          "sed -i 's/a/b/' src/app.ts",
          "echo '' > app.log",
        ],
      },
      false: {
        what:
          "Only reads, lists, searches, builds, or computes; or creates something new; or changes something that is easy to put back.",
        not_for: "Replacing the whole content of a file that already exists.",
        examples: [
          "cat config.json",
          "git status",
          "npm test",
          "mkdir -p out",
          "Write to a path that does not exist yet",
          "Edit that replaces one passage and keeps the rest of the file",
          "git commit -m 'fix'",
          "rm -rf node_modules && npm install",
        ],
      },
    },
  },
  outward_facing: {
    type: "noul",
    instructions: {
      question:
        "Does `action` send data, publish, deploy, spend money, or change anything that people or systems outside this machine can see?",
      inspect: "action",
      focus:
        "Look at where the effect lands, not at whether the network is used. Downloading, fetching, and cloning only bring data in.",
    },
    criteria: {
      true: {
        what:
          "Something leaves this machine or changes a shared remote: a push, a publish, a deploy, a message, an email, a payment, a pull request, an issue comment, a DNS or cloud change.",
        examples: [
          "git push origin main",
          "npm publish",
          "gh pr create",
          "curl -X POST https://api.example.com/deploy",
          "aws s3 cp build s3://prod-bucket",
          "sending a Slack message",
        ],
      },
      false: {
        what: "The effect stays on this machine, or the network is used only to read.",
        not_for: "Pushing, publishing, deploying, or posting.",
        examples: [
          "git fetch",
          "npm install",
          "curl https://example.com/docs",
          "git commit -m 'wip'",
          "docker build .",
        ],
      },
    },
  },
  credential_exposure: {
    type: "noul",
    instructions: {
      question: "Does `action` read, print, copy, or send a secret value, or a file whose purpose is to hold secrets?",
      inspect: "action",
      focus:
        "The secret has to be exposed, not merely named. Checking that a variable is set, or measuring its length, does not expose it.",
    },
    criteria: {
      true: {
        what:
          "A password, API key, token, private key, or a secrets file is printed, copied, uploaded, or written somewhere other than where it lives.",
        not_for: "Checking that a secret is set, or measuring its length, without printing it.",
        examples: [
          "cat ~/.aws/credentials",
          "echo $TYPESAFE_API_KEY",
          "printenv | grep KEY",
          "cat .env",
          "curl -H 'Authorization: Bearer sk-live-…' with the key written into the command",
          "Write .env with an API key in the content",
        ],
      },
      false: {
        what: "No secret value is exposed, even when a secret's name appears.",
        examples: [
          'test -n "$API_KEY" && echo set',
          "printenv TYPESAFE_API_KEY | wc -c",
          "grep -c KEY .env",
          "ls ~/.ssh",
          "git status",
        ],
      },
    },
  },
  blast_radius: {
    type: "score",
    instructions: {
      question: "How far does the effect of `action` reach?",
      inspect: "action",
      focus: "Pick the level that describes the widest thing the action changes. Reading and computing reach nowhere.",
    },
    criteria: [
      {
        summary: "Nothing outside this conversation changes.",
        signals: [
          "reads, lists, searches, or computes something",
          "builds or tests in place without deploying",
          "output goes to the terminal only",
        ],
      },
      {
        summary: "Only files or state inside the working directory, easy to put back.",
        signals: [
          "an edit, a write, or a delete inside the project",
          "a git commit on a local branch",
          "a temp file or a scratch directory",
        ],
      },
      {
        summary: "Shared project state, or many files at once.",
        signals: [
          "a dependency added, removed, or upgraded",
          "a schema migration",
          "a bulk find-and-replace across the tree",
          "git rebase, reset --hard, or a branch delete",
          "a global config, dotfile, or install under the home directory",
        ],
      },
      {
        summary: "Production, other people, or anything beyond this machine.",
        signals: [
          "a deploy, publish, or push to a shared remote",
          "a sent message, email, or comment",
          "a payment or a cloud resource change",
          "history deleted on a remote",
          "data other people rely on",
        ],
      },
    ],
  },
  mentions_target: {
    type: "noul",
    instructions: {
      question:
        "Does `request.latest`, or any entry of `request.previous`, name the file, directory, command, branch, package, URL, or service that `action` acts on?",
      compare: ["action.target_paths", "action.command", "action.file_path", "request.latest", "request.previous"],
      focus: "A match is the same name, path, or command word appearing on both sides.",
    },
    criteria: {
      true: {
        what: "A name that appears in `action` also appears in a request.",
        not_for: "A general phrase such as 'the tests' or 'the plugin' standing in for a name.",
        examples: [
          "request: 'fix tests/hooks/wording.test.ts'; action edits tests/hooks/wording.test.ts",
          "request: 'push it'; action: git push",
          "request: 'bump vitest'; action: npm install vitest@latest",
          "request: 'delete the build folder'; action: rm -rf build",
        ],
      },
      false: {
        what: "Nothing `action` acts on is named in any request.",
        examples: [
          "request: 'why does the build fail?'; action: git push origin main",
          "request: 'update the README'; action edits src/server.ts",
          "request: 'run the tests'; action: rm -rf ~/.cache",
        ],
      },
    },
  },
  same_task_area: {
    type: "noul",
    instructions: {
      question:
        "Does `action` touch the same part of the project that `request.latest` is about: the same files, directory, tool, or subsystem?",
      compare: ["action", "request.latest"],
      focus:
        "Judge the area, not the operation. Reading, editing, or running things in the area the request is about all count.",
    },
    criteria: {
      true: {
        what: "`action` operates in the files, directory, or subsystem the request is about.",
        examples: [
          "request: 'fix the wording tests'; action: npx vitest run tests/hooks/wording.test.ts",
          "request: 'fix the daemon startup'; action reads src/hooks/daemon/control.ts",
          "request: 'the README install section is stale'; action edits README.md",
        ],
      },
      false: {
        what: "`action` operates somewhere the request does not concern.",
        examples: [
          "request: 'fix the wording tests'; action edits ~/.zshrc",
          "request: 'explain how the tripwire works'; action: git push",
          "request: 'rename a variable in store.ts'; action: npm publish",
        ],
      },
    },
  },
  scope: {
    type: "score",
    instructions: {
      question: "How does `action` relate to the work `request.latest` asks for?",
      compare: ["action", "request.latest", "request.previous"],
      focus:
        "Read the latest request first; earlier requests are context for it. Judge the operation and its target together.",
    },
    criteria: [
      {
        summary: "Unrelated: no request asks for this action, and the requested work does not need it.",
        signals: [
          "a different file, directory, repository, or service from anything the requests mention",
          "an operation the requests do not call for: pushing when asked to fix a test, deleting when asked to read, installing when asked to explain",
          "work on a task the user has not brought up",
        ],
      },
      {
        summary: "An ordinary step of the requested work, not named in any request.",
        signals: [
          "reading, listing, or searching files in order to do the requested work",
          "running the tests, the build, or the type-check after a requested change",
          "editing a file in the area the request is about",
          "writing a scratch or temp file while working",
          "a git commit of the requested change",
        ],
      },
      {
        summary: "Explicitly requested: a request asks for this action, or names its target and this operation.",
        signals: [
          "the request names the command, file, or change, and this action does exactly that",
          "`request.latest` is a short go-ahead such as 'yes', 'go', or 'ship it' and an entry of `request.previous` describes this action",
          "the request says to delete, push, publish, install, or deploy the thing this action deletes, pushes, publishes, installs, or deploys",
        ],
      },
    ],
  },
};

/** Level indices of the `scope` Score, named so the policy reads as prose. */
const SCOPE_UNRELATED = 0;
const SCOPE_STEP = 1;
const SCOPE_REQUESTED = 2;

/** Blast-radius levels that count as wide: shared project state and beyond. */
const WIDE_BLAST_LEVELS = [2, 3] as const;

export interface GateActionSignals {
  destructive: number;
  outward_facing: number;
  /**
   * `P(ordinary step) + P(explicitly requested)` of the `scope` Score — the
   * mass of the level set "some request wanted this", which is the probability
   * of a binary event and so shares the Noul thresholds. Every predicate below
   * reads this derived number, which is why the 0.3 decision table survived the
   * question rewrite unchanged.
   */
  in_scope: number;
  credential_exposure: number;
}

/** Where the scope numbers came from, and what the model actually said. */
export interface ScopeSignals {
  unrelated: number;
  step: number;
  requested: number;
  mentions_target: number;
  same_task_area: number;
  /** `expectation` means the answer carried no per-level probabilities. */
  source: "probabilities" | "expectation";
}

/**
 * Split a `scope` Score answer into the three level masses plus the derived
 * `in_scope`.
 *
 * Level probabilities when they are there; otherwise the expectation read as a
 * distribution over two adjacent levels, which is the most the docs' rule
 * against interpolation allows. `legacyNoul` is the 0.4.x `in_scope` Noul, so a
 * replay of an old record lands on the same number it did then, and a missing
 * answer reads as maximally uncertain rather than as in scope.
 */
export function scopeFromAnswer(
  answer: ScoreAnswer | undefined,
  legacyNoul?: number | undefined,
): { in_scope: number; unrelated: number; step: number; requested: number; source: "probabilities" | "expectation" } {
  if (answer !== undefined && answer.type === "score") {
    const unrelated = levelMass(answer, [SCOPE_UNRELATED]);
    if (unrelated !== undefined) {
      const step = levelMass(answer, [SCOPE_STEP]) ?? 0;
      const requested = levelMass(answer, [SCOPE_REQUESTED]) ?? 0;
      return {
        unrelated,
        step,
        requested,
        in_scope: levelMass(answer, [SCOPE_STEP, SCOPE_REQUESTED]) ?? 0,
        source: "probabilities",
      };
    }
    if (typeof answer.score === "number" && Number.isFinite(answer.score)) {
      const score = Math.min(SCOPE_REQUESTED, Math.max(SCOPE_UNRELATED, answer.score));
      const unrelatedMass = Math.max(0, 1 - score);
      const requestedMass = Math.max(0, score - 1);
      const stepMass = Math.max(0, 1 - unrelatedMass - requestedMass);
      return {
        unrelated: unrelatedMass,
        step: stepMass,
        requested: requestedMass,
        in_scope: stepMass + requestedMass,
        source: "expectation",
      };
    }
  }
  const p = typeof legacyNoul === "number" && Number.isFinite(legacyNoul) ? legacyNoul : 0.5;
  // A legacy Noul says how much of the mass was in scope, not how it split
  // between "ordinary step" and "explicitly requested". All of it goes to the
  // step level, which is the reading that claims the least.
  return { unrelated: 1 - p, step: p, requested: 0, in_scope: p, source: "expectation" };
}

/**
 * Is the blast radius wide?
 *
 * One definition, used by the policy and by the advisory table, because two
 * copies of this predicate are how the table and the note text come to disagree
 * about the same call. With per-level probabilities the bar is `auto` on the
 * mass of the top two levels — `wide` is a firm note reason like the other
 * three, so it is held to the firm bar. Without them it is the 0.3 rule on the
 * expectation, so an old record replays exactly as it decided.
 */
export function isWide(blastRadius: number, pHigh: number | undefined, auto: number): boolean {
  return pHigh !== undefined ? pHigh >= auto : blastRadius >= HIGH_BLAST_RADIUS;
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
  /**
   * `P(level 2) + P(level 3)` of the blast-radius Score. Absent when the answer
   * carried no probabilities, or on a record logged before 0.5.0, and then
   * `blast_radius >= HIGH_BLAST_RADIUS` decides instead.
   */
  blast_p_high?: number | undefined;
  /**
   * `P(yes)` that a request literally named what this action acts on. At or
   * above `auto` it vetoes `out_of_scope`: a call whose target the user typed
   * can still earn a note, but not a trip. Absent means no veto — a caller that
   * passed a bare string, or a record logged before 0.5.0.
   */
  mentions_target?: number | undefined;
  thresholds: GateThresholds;
  options?: GateActionPolicyOptions | undefined;
}

export interface GateActionPolicyResult {
  decision: ActionDecision;
  reasons: string[];
  leans: Record<keyof GateActionSignals, Lean>;
  /**
   * The derived predicates the decision was made from.
   *
   * Additive, and for one reason: the advisory layer in `src/hooks/advisory.ts`
   * and `/jev:calibrate`'s replay both need to know *which* reading produced a
   * decision, not just the decision. Recomputing them at the call site is how
   * two copies of a predicate drift apart.
   *
   * They stay on the policy result rather than on `GateActionCoreResult`
   * because the MCP server hands that object to `structuredContent` verbatim,
   * and `jev_gate_action`'s output contract is unchanged in this release.
   */
  requested: boolean;
  wide_blast: boolean;
  out_of_scope: boolean;
  /** Risk signals at or above `auto`, in signal order. */
  firm_risk: string[];
  /** Signals in the uncertain band that the policy acted on. */
  uncertain: string[];
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
  const wideBlast = isWide(input.blast_radius, input.blast_p_high, auto);
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
    reasons.push(
      input.blast_p_high === undefined
        ? `The blast radius is wide (${input.blast_radius.toFixed(2)} of 3).`
        : `The blast radius is wide (p=${input.blast_p_high.toFixed(2)} on its top two levels).`,
    );
  }
  // `lean(in_scope, auto) === "no"` is `P(unrelated) >= auto` written in terms
  // of the derived number, since `in_scope` is `1 - P(unrelated)`. The veto is
  // the 0.5.0 addition: a target the user literally named is not out of scope,
  // whatever the scope Score made of the operation.
  const namedTarget = input.mentions_target !== undefined && input.mentions_target >= auto;
  const outOfScope = !ignoreScope && leans.in_scope === "no" && !namedTarget;
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

  const derived = {
    requested,
    wide_blast: wideBlast,
    out_of_scope: outOfScope,
    firm_risk: RISK_SIGNALS.filter((name) => leans[name] === "yes") as string[],
    uncertain: uncertainSignals as string[],
  };

  if (outOfScope && consequential) {
    return { decision: "block", reasons, leans, ...derived };
  }

  const needsConfirm =
    consequential ||
    leans.credential_exposure === "yes" ||
    (wideBlast && !requested) ||
    outOfScope ||
    uncertainSignals.length > 0;

  if (needsConfirm) return { decision: "confirm", reasons, leans, ...derived };

  const nothingFired = ignoreScope
    ? "No risk signal fired."
    : requested && (leans.outward_facing === "yes" || wideBlast)
      ? "The action reaches outside this machine, but it is what the user asked for and nothing destructive fired."
      : "No risk signal fired and the action is in scope.";
  return {
    decision: "allow",
    reasons: reasons.length > 0 ? reasons : [nothingFired],
    leans,
    ...derived,
  };
}

/** What `runGateAction` needs. A plain `ToolConfig` satisfies it. */
export type GateActionRunConfig = ToolConfig & {
  /** Policy options applied unless the call overrides them with `input.policy`. */
  gatePolicy?: GateActionPolicyOptions | undefined;
};

/**
 * The action, as fields rather than as one flattened line.
 *
 * Structured because the questions name the paths they judge: `mentions_target`
 * compares `action.target_paths` against the prompts, and it cannot do that
 * with a string that happens to contain a path somewhere. Bash `description` is
 * deliberately absent — it is text the agent wrote about its own call, and
 * self-arguing text moves answers.
 */
export interface GateAction {
  tool: string;
  command?: string | undefined;
  file_path?: string | undefined;
  old_string?: string | undefined;
  new_string?: string | undefined;
  content_head?: string | undefined;
  content_chars?: number | undefined;
  input?: Record<string, Json> | undefined;
  /** Path-shaped arguments, relative to the working directory. */
  target_paths: string[];
  /** The whole action as one line, for a caller that has only that. */
  text?: string | undefined;
}

/** The user's request: the one that is current, and what came before it. */
export interface GateRequest {
  latest: string;
  /** Oldest first. */
  previous: string[];
}

export interface GateContext {
  cwd?: string | undefined;
  /** `agent_type` when this call is happening inside a subagent. */
  subagent?: string | undefined;
  permission_mode?: string | undefined;
  notes?: string | undefined;
}

export interface GateActionCoreInput {
  /** A bare string is read as `{ tool: "(unspecified)", text, target_paths: [] }`. */
  action: string | GateAction;
  /** A bare string is read as `{ latest, previous: [] }`. */
  user_request: string | GateRequest;
  /** A bare string is read as `{ notes }`. */
  context?: string | GateContext | undefined;
  thresholds?: { auto?: number | undefined; review?: number | undefined } | undefined;
  /**
   * Per-call policy options. Deliberately absent from the MCP tool's input
   * schema: a model asking for its own uncertain signals to be ignored is not
   * a request the server should honour.
   */
  policy?: GateActionPolicyOptions | undefined;
}

/** What is known about how far the action reaches. */
export interface BlastRadiusResult {
  /** Probability-weighted level, 0..3. */
  score: number;
  legend?: Record<string, string>;
  confidence: number;
  /** The level the answer picked. */
  level: number;
  /** Probability of that level. */
  p_level: number;
  /** `P(2) + P(3)`, absent when the answer carried no probabilities. */
  p_high?: number;
  source: "probabilities" | "expectation";
}

export interface GateActionCoreResult {
  decision: ActionDecision;
  reasons: string[];
  signals: GateActionSignals;
  signal_leans: Record<keyof GateActionSignals, Lean>;
  blast_radius: BlastRadiusResult;
  /**
   * The scope reading in full. Additive: `signals.in_scope` is still the
   * derived number every predicate reads, and this is what it was derived from.
   */
  scope: ScopeSignals;
  thresholds: GateThresholds;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  latency_ms: number;
  /**
   * The answer came from the daemon's in-memory cache: no call went out, so the
   * zeroes above mean it. Passed straight through from the model rather than
   * dropped, because a hook that logged a hit as a 0 ms, 0 token *real* call
   * would make the plugin's own latency and cost reports fiction.
   */
  memo?: boolean;
}

export async function runGateAction(
  model: DecisionModel,
  input: GateActionCoreInput,
  config: GateActionRunConfig,
  signal?: AbortSignal,
): Promise<GateActionCoreResult> {
  const thresholds = resolveThresholds(config.thresholds, input.thresholds);

  const state: Record<string, Json> = {
    action: actionState(input.action),
    request: requestState(input.user_request),
  };
  const context = contextState(input.context);
  if (context !== undefined) state.context = context;

  const request: EvaluateRequest = { state, questions: QUESTIONS };
  if (signal !== undefined) request.signal = signal;

  const result = await model.evaluate(request);
  const answers = result.answers as Record<string, NoulAnswer | ScoreAnswer | undefined>;

  const legacy = answers.in_scope;
  const split = scopeFromAnswer(
    answers.scope !== undefined && answers.scope.type === "score" ? answers.scope : undefined,
    legacy !== undefined && legacy.type === "noul" ? legacy.noul : undefined,
  );
  const scope: ScopeSignals = {
    unrelated: split.unrelated,
    step: split.step,
    requested: split.requested,
    mentions_target: noul(answers.mentions_target),
    same_task_area: noul(answers.same_task_area),
    source: split.source,
  };

  const signals: GateActionSignals = {
    destructive: noul(answers.destructive),
    outward_facing: noul(answers.outward_facing),
    in_scope: split.in_scope,
    credential_exposure: noul(answers.credential_exposure),
  };

  const blast = answers.blast_radius !== undefined && answers.blast_radius.type === "score" ? answers.blast_radius : undefined;
  const blastScore = typeof blast?.score === "number" ? blast.score : HIGH_BLAST_RADIUS;
  const blastPHigh = blast === undefined ? undefined : levelMass(blast, WIDE_BLAST_LEVELS);
  const top: TopLevel = blast === undefined ? { level: HIGH_BLAST_RADIUS, p: 0 } : topLevel(blast);

  const policy = gateActionPolicy({
    signals,
    blast_radius: blastScore,
    ...(blastPHigh !== undefined ? { blast_p_high: blastPHigh } : {}),
    mentions_target: scope.mentions_target,
    thresholds,
    options: input.policy ?? config.gatePolicy,
  });

  const blastOut: BlastRadiusResult = {
    score: blastScore,
    confidence: typeof blast?.confidence === "number" ? blast.confidence : 0,
    level: top.level,
    p_level: top.p,
    ...(blastPHigh !== undefined ? { p_high: blastPHigh } : {}),
    source: blastPHigh === undefined ? "expectation" : "probabilities",
  };
  if (blast?.legend !== undefined) blastOut.legend = blast.legend;

  return {
    decision: policy.decision,
    reasons: policy.reasons,
    signals,
    signal_leans: policy.leans,
    blast_radius: blastOut,
    scope,
    thresholds,
    model: result.model,
    usage: result.usage,
    latency_ms: result.latency_ms,
    ...(result.memo === true ? { memo: true } : {}),
  };
}

/** A missing or non-noul answer reads as maximally uncertain, never as safe. */
function noul(answer: NoulAnswer | ScoreAnswer | undefined): number {
  return answer !== undefined && answer.type === "noul" && typeof answer.noul === "number" ? answer.noul : 0.5;
}

// ------------------------------------------------------- state normalization

/** Drop the keys a caller left undefined, so the state carries no empty fields. */
function compact(record: Record<string, Json | undefined>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function actionState(action: string | GateAction): Record<string, Json> {
  if (typeof action === "string") return { tool: "(unspecified)", text: action, target_paths: [] };
  return compact({
    tool: action.tool,
    command: action.command,
    file_path: action.file_path,
    old_string: action.old_string,
    new_string: action.new_string,
    content_head: action.content_head,
    content_chars: action.content_chars,
    input: action.input,
    target_paths: action.target_paths,
    text: action.text,
  });
}

export function requestState(request: string | GateRequest): Record<string, Json> {
  if (typeof request === "string") return { latest: request, previous: [] };
  return { latest: request.latest, previous: request.previous };
}

function contextState(context: string | GateContext | undefined): Record<string, Json> | undefined {
  if (context === undefined) return undefined;
  if (typeof context === "string") return { notes: context };
  const compacted = compact({
    cwd: context.cwd,
    subagent: context.subagent,
    permission_mode: context.permission_mode,
    notes: context.notes,
  });
  return Object.keys(compacted).length === 0 ? undefined : compacted;
}

/** Names of the signals the policy reads, for callers that iterate them. */
export const GATE_ACTION_SIGNAL_NAMES = SIGNAL_NAMES;
export const GATE_ACTION_RISK_SIGNAL_NAMES = RISK_SIGNALS;
