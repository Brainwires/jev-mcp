/**
 * The verification ledger: what the stop check knows that Jev cannot see.
 *
 * Jev reads the final message and nothing else, so it can tell you that a
 * message *claims* the tests pass. Whether they do is a fact about the session,
 * and facts about the session are bookkeeping — counted in code, compared in
 * code, and never asked of a classifier.
 *
 * Two numbers are all it takes: whether the last check passed, and how many
 * edits have happened since one ran. A message that says "all tests pass" after
 * a failing `npm test` with no passing run since is the one case where a stop
 * hook has evidence rather than an opinion.
 *
 * Everything here is pure except where it is handed a `Store`. No clock, no
 * model, no network.
 */

import { redactAndClamp } from "./redact.js";
import { prefilterBash, scanBash } from "./prefilter.js";
import type { HookInput } from "./types.js";

/** Longest command text kept in the ledger, redacted first. */
export const MAX_LEDGER_COMMAND_CHARS = 200;

export const VERIFICATION_KINDS = ["test", "build", "typecheck", "lint"] as const;
export type VerificationKind = (typeof VERIFICATION_KINDS)[number];

/**
 * npm-style script names, mapped to what running them establishes.
 *
 * `check`, `verify`, `validate` and `ci` are read as `test`: in practice they
 * run the whole suite, and `test` is the strongest of the four claims, so
 * reading them as anything weaker would let "all tests pass" off the hook.
 */
const SCRIPT_KINDS: [RegExp, VerificationKind][] = [
  [/^(type-?checks?|types|tsc)\b/, "typecheck"],
  [/^(lint|lints|eslint|format:check|fmt:check|style|stylelint)\b/, "lint"],
  [/^(build|compile|bundle|dist|prepack)\b/, "build"],
  [/^(tests?|unit|e2e|spec|specs|coverage|smoke|check|checks|verify|validate|ci|audit)\b/, "test"],
];

function fromScriptName(name: string | undefined): VerificationKind | undefined {
  if (name === undefined) return undefined;
  // `test:unit`, `lint-staged`, `type-check:ci` all key off the first word.
  const normalized = name.toLowerCase().replace(/^run:/, "");
  for (const [pattern, kind] of SCRIPT_KINDS) {
    if (pattern.test(normalized)) return kind;
  }
  return undefined;
}

/** Test runners invoked directly. */
const DIRECT: Record<string, VerificationKind> = {
  vitest: "test",
  jest: "test",
  mocha: "test",
  ava: "test",
  tap: "test",
  pytest: "test",
  phpunit: "test",
  rspec: "test",
  ctest: "test",
  tsc: "typecheck",
  mypy: "typecheck",
  pyright: "typecheck",
  flow: "typecheck",
  eslint: "lint",
  biome: "lint",
  rubocop: "lint",
  flake8: "lint",
  pylint: "lint",
  stylelint: "lint",
  shellcheck: "lint",
  "golangci-lint": "lint",
  tflint: "lint",
  prettier: "lint",
  ruff: "lint",
};

/** Package-manager style front ends whose first word is a subcommand. */
const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun", "npx", "pnpx", "deno", "bunx"]);

function firstWord(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("-"));
}

/** Classify one pipeline segment. */
function classifySegment(command: string, args: string[]): VerificationKind | undefined {
  if (RUNNERS.has(command)) {
    const sub = firstWord(args);
    if (sub === undefined) return undefined;
    if (sub === "run" || sub === "run-script") {
      const rest = args.slice(args.indexOf(sub) + 1);
      return fromScriptName(firstWord(rest));
    }
    if (sub === "exec" || sub === "x" || sub === "dlx") {
      const rest = args.slice(args.indexOf(sub) + 1);
      const inner = firstWord(rest);
      return inner === undefined ? undefined : classifySegment(inner.toLowerCase(), rest.slice(rest.indexOf(inner) + 1));
    }
    // `npm test`, `yarn lint`, `bun test`, `deno check`.
    return DIRECT[sub] ?? fromScriptName(sub);
  }

  if (command === "cargo") {
    const sub = firstWord(args);
    if (sub === "test" || sub === "nextest") return "test";
    if (sub === "check") return "typecheck";
    if (sub === "build" || sub === "b") return "build";
    if (sub === "clippy") return "lint";
    if (sub === "fmt" && args.includes("--check")) return "lint";
    return undefined;
  }

  if (command === "go") {
    const sub = firstWord(args);
    if (sub === "test") return "test";
    if (sub === "build" || sub === "install") return "build";
    if (sub === "vet") return "lint";
    return undefined;
  }

  if (command === "make" || command === "gmake" || command === "just") {
    // A bare `make` builds; a named target says what it is.
    const target = firstWord(args);
    return target === undefined ? "build" : (fromScriptName(target) ?? "build");
  }

  if (command === "mvn" || command === "gradle" || command === "gradlew" || command === "./gradlew") {
    const target = firstWord(args);
    if (target === undefined) return undefined;
    if (/^(test|check|verify)/.test(target)) return "test";
    if (/^(build|package|assemble|compile)/.test(target)) return "build";
    return undefined;
  }

  if (command === "dotnet") {
    const sub = firstWord(args);
    if (sub === "test") return "test";
    if (sub === "build") return "build";
    return undefined;
  }

  if (command === "python" || command === "python3") {
    // `python -m pytest`, `python -m mypy`.
    if (args[0] === "-m") return DIRECT[(args[1] ?? "").toLowerCase()];
    return undefined;
  }

  const direct = DIRECT[command];
  if (direct === undefined) return undefined;
  // `ruff check` lints; `ruff format` does not verify anything.
  if (command === "ruff") return firstWord(args) === "check" ? "lint" : undefined;
  if (command === "prettier") {
    return args.some((arg) => ["--check", "-c", "-l", "--list-different"].includes(arg)) ? "lint" : undefined;
  }
  if (command === "biome") return firstWord(args) === "check" || firstWord(args) === "lint" ? "lint" : undefined;
  return direct;
}

/**
 * What running `command` would establish, or `undefined` for a command that
 * verifies nothing.
 *
 * A compound command counts if any segment matches: `npm run build && npm test`
 * is a test run, and the strongest claim in the chain is the one recorded.
 */
export function verificationKind(command: string): VerificationKind | undefined {
  const scan = scanBash(command);
  // Order of precedence when a chain does several things at once.
  const ranking: VerificationKind[] = ["test", "typecheck", "build", "lint"];
  let best: VerificationKind | undefined;
  for (const segment of scan.segments) {
    let index = 0;
    while (index < segment.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[index] as string)) index += 1;
    const raw = (segment[index] ?? "").split("/").pop() ?? "";
    const kind = classifySegment(raw.toLowerCase(), segment.slice(index + 1));
    if (kind === undefined) continue;
    if (best === undefined || ranking.indexOf(kind) < ranking.indexOf(best)) best = kind;
  }
  return best;
}

// ------------------------------------------------------------------ the outcome

/** `Exit code N` is the documented first line of a failed Bash `error`. */
const EXIT_CODE_LINE = /^\s*Exit code\s+(\d+)/i;

/**
 * Did this Bash tool call fail?
 *
 * `true` failed, `false` succeeded, `undefined` unknowable — which includes an
 * interrupt, because a cancelled test run is not evidence that anything is
 * broken.
 *
 * Claude Code documents a non-zero Bash exit as `PostToolUseFailure`, carrying
 * a top-level `error` string whose first line is `Exit code N`, plus an
 * optional `is_interrupt`. A successful `PostToolUse` carries a `tool_response`
 * of `{stdout, stderr, interrupted, isImage}` with no exit code at all. Both
 * are handled, and so are the structured fields the docs do not promise
 * (`exit_code`, `isError`, `success`), because a hook that reads one undocumented
 * field defensively costs nothing and a hook that trusts one shape breaks.
 *
 * `stdout` is deliberately never scanned for `Exit code N`: a test suite that
 * prints that string is not a failed command.
 */
export function bashFailed(input: HookInput): boolean | undefined {
  if (input.is_interrupt === true) return undefined;

  const response = (typeof input.tool_response === "object" && input.tool_response !== null
    ? (input.tool_response as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  if (response.interrupted === true) return undefined;

  const exit = response.exit_code ?? response.exitCode;
  if (typeof exit === "number") return exit !== 0;
  if (response.isError === true || response.is_error === true) return true;
  if (response.success === false) return true;

  const errorText = typeof input.error === "string" ? input.error : typeof response.error === "string" ? response.error : undefined;
  if (errorText !== undefined && errorText !== "") {
    const match = EXIT_CODE_LINE.exec(errorText);
    if (match !== null) return Number(match[1]) !== 0;
    // A failure message with no exit-code line: Claude Code could not even
    // start the shell. That is not the command reporting a verdict.
    return input.hook_event_name === "PostToolUseFailure" ? undefined : true;
  }

  if (input.hook_event_name === "PostToolUseFailure") return true;
  if (response.isError === false || response.success === true) return false;
  // A PostToolUse for a tool that ran: the documented success path.
  return false;
}

export interface VerificationRecord {
  kind: VerificationKind;
  ok: boolean;
  /** Epoch ms. */
  ts: number;
  /** Redacted, clamped. */
  command: string;
}

export interface VerificationLedger {
  last?: VerificationRecord;
  /** Edits since a verification command last ran. */
  edits_since: number;
}

export const EMPTY_LEDGER: VerificationLedger = { edits_since: 0 };

/** Tools whose success is an edit. */
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Update"]);

export interface LedgerEvent {
  /** A verification command that ran to a verdict. */
  verification?: VerificationRecord | undefined;
  /** This call edited a file in the project. */
  edited: boolean;
}

/**
 * Read one post-tool event as a ledger event. Pure.
 *
 * `cwd` is needed only to tell an in-project Bash write from any other one,
 * using the same prefilter the permission gate uses — so "a `sed -i` counts as
 * an edit" is true in exactly the cases where the gate stayed silent about it.
 */
export function ledgerEvent(input: HookInput, now: number): LedgerEvent {
  const toolName = input.tool_name ?? "";
  const failed = bashFailed(input);

  if (toolName === "Bash" || toolName === "PowerShell") {
    const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
    if (command.trim() === "") return { edited: false };

    const kind = verificationKind(command);
    if (kind !== undefined && failed !== undefined) {
      return {
        verification: {
          kind,
          ok: !failed,
          ts: now,
          command: redactAndClamp(command, MAX_LEDGER_COMMAND_CHARS),
        },
        edited: false,
      };
    }

    // Not a check. Did it edit the project? The prefilter already knows.
    if (failed === true) return { edited: false };
    const cwd = input.cwd;
    if (cwd === undefined || cwd === "") return { edited: false };
    const verdict = prefilterBash(command, { cwd, strict: false });
    // An `escalate` verdict never reports a write: it is a command the gate
    // stopped, not an edit that happened.
    return { edited: verdict.kind !== "escalate" && verdict.writesInProject === true };
  }

  if (EDIT_TOOLS.has(toolName)) return { edited: failed === false };
  return { edited: false };
}

/** Fold a ledger event into the ledger. Pure. */
export function applyLedgerEvent(ledger: VerificationLedger, event: LedgerEvent): VerificationLedger {
  if (event.verification !== undefined) {
    // A check ran, so "edits since a check ran" is zero again — whether it
    // passed or failed. What it established is in `last.ok`.
    return { last: event.verification, edits_since: 0 };
  }
  if (!event.edited) return ledger;
  const next: VerificationLedger = { edits_since: ledger.edits_since + 1 };
  if (ledger.last !== undefined) next.last = ledger.last;
  return next;
}

// ------------------------------------------------------------------ the policy

export interface VerificationPolicyResult {
  block: boolean;
  /** Set when the claim could not be corroborated either way: log, do not act. */
  logOnly: boolean;
  reason?: string;
  reasons: string[];
}

/**
 * Should a final message that claims the checks pass be challenged?
 *
 * Block only on evidence: the message says checks pass, a check is on record,
 * and that check failed. Everything else is calibration data. In particular,
 * "you claimed the tests pass and I have no record of you running them" is NOT
 * a block — the async hook can lose its race with Stop, a check may have run
 * before the plugin was installed, and accusing Claude of lying on the strength
 * of missing bookkeeping is exactly the kind of false positive that gets a stop
 * hook turned off.
 */
export function verificationPolicy(
  claimsVerified: number,
  ledger: VerificationLedger,
  auto: number,
  now: number,
): VerificationPolicyResult {
  const claims = claimsVerified >= auto;
  if (!claims) return { block: false, logOnly: false, reasons: [] };

  const last = ledger.last;
  if (last !== undefined && !last.ok) {
    const minutes = Math.max(0, Math.round((now - last.ts) / 60_000));
    const ago = minutes === 0 ? "less than a minute ago" : `${minutes} min ago`;
    return {
      block: true,
      logOnly: false,
      reason:
        `[jev] Your final message says checks pass (p=${claimsVerified.toFixed(2)}), but the last ${last.kind} ` +
        `command (\`${last.command}\`) failed ${ago} and nothing has passed since. Re-run it, or correct the claim.`,
      reasons: [
        `the final message claims checks pass (p=${claimsVerified.toFixed(2)})`,
        `the last ${last.kind} command failed ${ago}`,
      ],
    };
  }

  if (last === undefined) {
    return {
      block: false,
      logOnly: true,
      reasons: [`claims checks pass (p=${claimsVerified.toFixed(2)}) with no verification command on record`],
    };
  }

  if (ledger.edits_since > 0) {
    return {
      block: false,
      logOnly: true,
      reasons: [
        `claims checks pass (p=${claimsVerified.toFixed(2)}) but ${ledger.edits_since} edit${
          ledger.edits_since === 1 ? "" : "s"
        } happened after the last ${last.kind} run`,
      ],
    };
  }

  return { block: false, logOnly: false, reasons: [] };
}
