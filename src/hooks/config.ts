/**
 * Hook configuration, read from the environment.
 *
 * Claude Code exports each plugin `userConfig` value to hook processes as
 * `CLAUDE_PLUGIN_OPTION_<KEY>`; a shell-form hook command cannot interpolate
 * `${user_config.*}` at all, so the environment is the only channel. Every
 * option also has a `JEV_*` fallback so the hooks work when the code is wired
 * up by hand rather than installed as a plugin.
 *
 * Nothing here throws. A hook that dies on a malformed option is a hook that
 * breaks someone's session over a typo, so every value falls back to its
 * default and the fact is recorded in `warnings`.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const GATE_MODES = ["off", "standard", "strict"] as const;
export type GateMode = (typeof GATE_MODES)[number];

export interface HookConfig {
  apiKey: string | null;
  baseUrl: string;
  model: string;
  /** Deadline for one Jev call inside a hook. Deliberately short. */
  timeoutMs: number;
  maxRetries: number;
  gateMode: GateMode;
  stopCheck: boolean;
  screenResults: boolean;
  routePrompts: boolean;
  autoThreshold: number;
  reviewThreshold: number;
  /** Directory for session files and the decision log. */
  dataDir: string;
  /** `JEV_HOOKS_DISABLE=1`: every hook becomes a no-op. */
  disabled: boolean;
  /** Malformed option values, for `/jev:status`. */
  warnings: string[];
}

export const HOOK_DEFAULTS = {
  baseUrl: "https://api.typesafe.ai",
  model: "jev-latest",
  timeoutMs: 1500,
  maxRetries: 0,
  gateMode: "standard" as GateMode,
  stopCheck: true,
  screenResults: true,
  routePrompts: false,
  autoThreshold: 0.85,
  reviewThreshold: 0.6,
} as const;

export type Env = Record<string, string | undefined>;

/** `CLAUDE_PLUGIN_OPTION_<KEY>` first, then the `JEV_*`/legacy names. */
function read(env: Env, option: string, ...fallbacks: string[]): string | undefined {
  for (const key of [`CLAUDE_PLUGIN_OPTION_${option.toUpperCase()}`, ...fallbacks]) {
    const raw = env[key];
    if (raw !== undefined && raw.trim() !== "") return raw.trim();
  }
  return undefined;
}

function readBool(env: Env, option: string, fallback: boolean, warnings: string[], ...aliases: string[]): boolean {
  const raw = read(env, option, ...aliases);
  if (raw === undefined) return fallback;
  const lowered = raw.toLowerCase();
  if (["true", "1", "yes", "on"].includes(lowered)) return true;
  if (["false", "0", "no", "off"].includes(lowered)) return false;
  warnings.push(`${option}=${JSON.stringify(raw)} is not a boolean; using ${fallback}.`);
  return fallback;
}

function readNumber(
  env: Env,
  option: string,
  fallback: number,
  min: number,
  max: number,
  warnings: string[],
  ...aliases: string[]
): number {
  const raw = read(env, option, ...aliases);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    warnings.push(`${option}=${JSON.stringify(raw)} is not a number in [${min}, ${max}]; using ${fallback}.`);
    return fallback;
  }
  return value;
}

/** Where session files and the decision log live. */
export function resolveDataDir(env: Env = process.env): string {
  const explicit = env.CLAUDE_PLUGIN_DATA?.trim();
  if (explicit !== undefined && explicit !== "") return explicit;
  const jev = env.JEV_HOOKS_DATA_DIR?.trim();
  if (jev !== undefined && jev !== "") return jev;
  return join(env.HOME?.trim() || homedir(), ".claude", "plugins", "data", "jev");
}

export function loadHookConfig(env: Env = process.env): HookConfig {
  const warnings: string[] = [];

  const gateRaw = read(env, "gate_mode", "JEV_GATE_MODE");
  let gateMode: GateMode = HOOK_DEFAULTS.gateMode;
  if (gateRaw !== undefined) {
    const lowered = gateRaw.toLowerCase();
    if ((GATE_MODES as readonly string[]).includes(lowered)) {
      gateMode = lowered as GateMode;
    } else {
      warnings.push(`gate_mode=${JSON.stringify(gateRaw)} is not one of ${GATE_MODES.join("|")}; using standard.`);
    }
  }

  const apiKey = read(env, "api_key", "TYPESAFE_API_KEY") ?? null;
  const auto = readNumber(env, "auto_threshold", HOOK_DEFAULTS.autoThreshold, 0, 1, warnings, "JEV_AUTO_THRESHOLD");
  const review = readNumber(
    env,
    "review_threshold",
    Math.min(HOOK_DEFAULTS.reviewThreshold, auto),
    0,
    1,
    warnings,
    "JEV_REVIEW_THRESHOLD",
  );

  return {
    apiKey,
    baseUrl: (read(env, "base_url", "TYPESAFE_BASE_URL") ?? HOOK_DEFAULTS.baseUrl).replace(/\/+$/, ""),
    model: read(env, "model", "JEV_MODEL") ?? HOOK_DEFAULTS.model,
    timeoutMs: readNumber(env, "timeout_ms", HOOK_DEFAULTS.timeoutMs, 100, 10_000, warnings, "JEV_HOOK_TIMEOUT_MS"),
    maxRetries: HOOK_DEFAULTS.maxRetries,
    gateMode,
    stopCheck: readBool(env, "stop_check", HOOK_DEFAULTS.stopCheck, warnings, "JEV_STOP_CHECK"),
    screenResults: readBool(env, "screen_results", HOOK_DEFAULTS.screenResults, warnings, "JEV_SCREEN_RESULTS"),
    routePrompts: readBool(env, "route_prompts", HOOK_DEFAULTS.routePrompts, warnings, "JEV_ROUTE_PROMPTS"),
    autoThreshold: auto,
    reviewThreshold: Math.min(review, auto),
    dataDir: resolveDataDir(env),
    disabled: readBool(env, "hooks_disable", false, warnings, "JEV_HOOKS_DISABLE"),
    warnings,
  };
}
