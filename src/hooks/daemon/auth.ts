/**
 * Who may post a hook payload to the daemon.
 *
 * The daemon binds to loopback, so the threat is not the network: it is another
 * process on the same machine — a different local user, or anything that can
 * make an HTTP request — feeding the plugin tool calls it never saw, or reading
 * them back. The shared secret is the TypeSafe API key, because it is the one
 * value both ends already have: `hooks.json` interpolates it into the request
 * headers and `loadHookConfig` reads it in the daemon.
 *
 * Two headers, either of which is accepted:
 *
 *   Authorization: Bearer $CLAUDE_PLUGIN_OPTION_API_KEY
 *   X-Jev-Env-Key: $TYPESAFE_API_KEY
 *
 * Both are sent on every hook, and exactly one of them usually has a value: the
 * spike showed `CLAUDE_PLUGIN_OPTION_API_KEY` interpolating to the empty string
 * when the plugin option is unset (leaving a bare `Bearer `), while a key
 * exported in the user's shell arrives in the second. An empty credential is
 * therefore *absent*, not wrong — treating it as wrong would lock out every
 * install that sets the key in only one of the two places.
 *
 * The daemon holds every key present in its environment — the plugin option,
 * `JEV_PLUGIN_API_KEY` and `TYPESAFE_API_KEY` — and accepts a credential
 * matching any of them. The option and the shell can legitimately hold
 * different keys, and the hooks interpolate one of each, so an install that
 * rotated one half and not the other still has a daemon that knows both.
 *
 * With no key configured anywhere the daemon runs unauthenticated. That is not
 * a hole being waved through: with no key there is nothing to spend and no
 * judgment to make, so the daemon has no secret to leak and nothing to do. It
 * says so in `/v1/health` as `auth: "none"` rather than implying otherwise.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** Header bag as `node:http` hands it over. */
export type Headers = Record<string, string | string[] | undefined>;

export type AuthMode = "key" | "none";

export function authMode(expectedKeys: readonly string[]): AuthMode {
  return expectedKeys.length === 0 ? "none" : "key";
}

function header(headers: Headers, name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? value : undefined;
}

/**
 * Every credential the request offered, empties dropped.
 *
 * Exported because "an empty `Bearer ` counts as no credential at all" is the
 * subtle half of this module and deserves its own test.
 */
export function credentials(headers: Headers): string[] {
  const found: string[] = [];

  const authorization = header(headers, "authorization")?.trim();
  if (authorization !== undefined) {
    const match = /^Bearer\s*(.*)$/i.exec(authorization);
    const token = (match?.[1] ?? "").trim();
    if (token !== "") found.push(token);
  }

  const envKey = header(headers, "x-jev-env-key")?.trim();
  if (envKey !== undefined && envKey !== "") found.push(envKey);

  return found;
}

/** Constant-time comparison of two secrets of any length. */
function sameSecret(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

/**
 * The keys the daemon's environment holds, trimmed, empty ones dropped,
 * duplicates collapsed (first occurrence wins), in a fixed order.
 *
 * The plugin option, `JEV_PLUGIN_API_KEY` and the shell's `TYPESAFE_API_KEY`
 * are three places the same install can put a key, and the hooks interpolate
 * one of each into the two headers, so the daemon serves them all rather than
 * only the one `loadHookConfig` happened to pick.
 */
export function expectedKeysFrom(env: Record<string, string | undefined>): string[] {
  const keys: string[] = [];
  for (const raw of [env.CLAUDE_PLUGIN_OPTION_API_KEY, env.JEV_PLUGIN_API_KEY, env.TYPESAFE_API_KEY]) {
    const value = (raw ?? "").trim();
    if (value !== "" && !keys.includes(value)) keys.push(value);
  }
  return keys;
}

/**
 * The first 8 lowercase hex characters of `sha256(key)`.
 *
 * It identifies a key in a status line without revealing it: 32 bits of a hash
 * of a 100+ character secret is not a recovery path.
 */
export function keyFingerprint(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 8);
}

/**
 * True when the request may be served.
 *
 * No key held is unauthenticated mode and accepts everything; with keys held,
 * at least one non-empty credential has to match one of them.
 */
export function authorize(headers: Headers, expectedKeys: readonly string[]): boolean {
  if (expectedKeys.length === 0) return true;
  for (const candidate of credentials(headers)) {
    for (const key of expectedKeys) {
      if (sameSecret(candidate, key)) return true;
    }
  }
  return false;
}
