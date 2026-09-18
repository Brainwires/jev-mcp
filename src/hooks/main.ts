/**
 * The hook runtime. One process, one event, one JSON object on stdout — or
 * nothing at all, which is the common case.
 *
 * Three rules shape this file:
 *
 * 1. **Fail open, silently.** Every failure — no key, a timeout, a network
 *    error, malformed stdin, a bug in a handler — ends as exit 0 with empty
 *    stdout. The error goes to the decision log. A permission hook that breaks
 *    someone's session because an API was down is worse than no hook.
 * 2. **stdout is protocol.** Nothing else is ever written there.
 * 3. **Bounded time.** The handler races a hard wall-clock timer well inside
 *    the 5-second `timeout` declared in hooks.json, so Claude Code never has to
 *    kill us.
 *
 * It must also stay small: no MCP SDK, no zod. Everything it imports is either
 * a node builtin or part of the dependency-free decision core.
 */

import { JevDecisionModel } from "../jev/client.js";
import { loadHookConfig, type HookConfig } from "./config.js";
import { handleApproval, handlePostToolUse } from "./handlers/post-tool-use.js";
import { handlePreToolUse } from "./handlers/pre-tool-use.js";
import { handleSessionStart } from "./handlers/session-start.js";
import { handleStop } from "./handlers/stop.js";
import { handleUserPromptSubmit } from "./handlers/user-prompt-submit.js";
import { calibrateReport, statusReport, whyReport, type WhyFilter } from "./report.js";
import { Store } from "./store.js";
import type { Deps, Handler, HookInput, HookOutput } from "./types.js";

/** Hard ceiling for a handler, under the 5 s hooks.json timeout. */
export const WALL_CLOCK_MS = 3500;

const HANDLERS: Record<string, Handler> = {
  PreToolUse: handlePreToolUse,
  PostToolUse: handlePostToolUse,
  PostToolUseFailure: handlePostToolUse,
  /** Correlation bookkeeping only, wired up as an async hook. */
  Approval: handleApproval,
  UserPromptSubmit: handleUserPromptSubmit,
  Stop: handleStop,
  SubagentStop: handleStop,
  SessionStart: handleSessionStart,
};

export function buildDeps(config: HookConfig): Deps {
  const model =
    config.apiKey === null
      ? null
      : new JevDecisionModel({
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          model: config.model,
          timeoutMs: config.timeoutMs,
          maxRetries: config.maxRetries,
        });
  return { model, config, store: new Store(config.dataDir), now: () => Date.now() };
}

/** Resolve `undefined` rather than reject when the handler overruns. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
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

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY === true) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
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

/**
 * The `/jev:*` commands. A session id that Claude Code failed to substitute
 * arrives as the literal placeholder; treat it as absent and fall back to the
 * global flag, which is what `/jev:off` promises in that case.
 */
function sessionArgument(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.includes("${") || trimmed.toLowerCase() === "unknown") return null;
  return trimmed;
}

async function runCommand(command: string, args: string[], deps: Deps): Promise<string | undefined> {
  switch (command) {
    case "status":
      return statusReport(deps.config, deps.store, deps.now());
    case "why": {
      // `why`, `why 5`, `why trips`, `why 5 trips`: the count and the filter
      // are recognized by shape, so the order the user types them in does not
      // matter and a typo falls back to the default rather than to nothing.
      const numeric = args.map((arg) => Number(arg)).find((value) => Number.isFinite(value) && value > 0);
      const filter = args.map((arg) => arg.toLowerCase()).find((arg): arg is WhyFilter =>
        arg === "notes" || arg === "trips" || arg === "all",
      );
      return whyReport(deps.store, numeric === undefined ? 3 : Math.floor(numeric), filter ?? "all");
    }
    case "calibrate":
      return calibrateReport(deps.config, deps.store);
    case "disable":
    case "enable": {
      const disabled = command === "disable";
      const result = deps.store.setDisabled(sessionArgument(args[0]), disabled);
      const scope = result.scope === "session" ? "this session" : "all sessions (global flag)";
      return `jev hooks ${disabled ? "disabled" : "enabled"} for ${scope}.\n  ${result.path}`;
    }
    default:
      return undefined;
  }
}

const COMMANDS = new Set(["status", "why", "calibrate", "disable", "enable"]);

export async function main(argv: string[] = process.argv): Promise<void> {
  const event = argv[2] ?? "";
  const config = loadHookConfig();

  if (config.disabled) return;

  const deps = buildDeps(config);

  if (COMMANDS.has(event)) {
    // Reports are for a person, so they may write plain text and take their
    // time; they still must not throw.
    const text = await runCommand(event, argv.slice(3), deps);
    if (text !== undefined) process.stdout.write(`${text}\n`);
    return;
  }

  if (!(event in HANDLERS)) return;

  const output = await withDeadline(
    (async () => runEvent(event, await readStdin(), deps))(),
    WALL_CLOCK_MS,
  );

  if (output !== undefined) process.stdout.write(JSON.stringify(output));
}
