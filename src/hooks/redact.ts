/**
 * Best-effort secret masking.
 *
 * Applied twice: before anything is written to the decision log, and before
 * anything is sent to the Jev API. It is a net, not a guarantee — a secret with
 * no recognizable shape gets through — which is why the README says plainly
 * that tool inputs are sent to a third-party API and how to turn each hook off.
 */

const PATTERNS: [RegExp, string][] = [
  // PEM blocks: drop the body, keep the shape.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  // Provider-shaped keys.
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{12,}/g, "[REDACTED]"],
  [/\bASIA[0-9A-Z]{12,}/g, "[REDACTED]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[REDACTED]"],
  [/\bAIza[A-Za-z0-9_-]{20,}/g, "[REDACTED]"],
  // JWTs.
  [/\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  // `Authorization: Bearer …`, `Basic …`.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [REDACTED]"],
  // key=value / key: value where the key names a secret.
  [
    /\b((?:api[_-]?key|apikey|secret|password|passwd|pwd|token|access[_-]?key|private[_-]?key|auth|credential)s?)\s*[:=]\s*("[^"]{4,}"|'[^']{4,}'|[^\s,;&"']{4,})/gi,
    "$1=[REDACTED]",
  ],
  // Long hex or base64 blobs are almost never something a judgment needs.
  [/\b[0-9a-f]{40,}\b/gi, "[REDACTED HEX]"],
];

/** Mask values that look like secrets. Idempotent enough to apply twice. */
export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Redact, then hard-truncate with a marker so token budgets stay predictable. */
export function redactAndClamp(text: string, max: number): string {
  const masked = redact(text);
  if (masked.length <= max) return masked;
  return `${masked.slice(0, Math.max(0, max - 20))}… [truncated]`;
}

/** Stringify a tool input compactly for judging and logging. */
export function compactJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
