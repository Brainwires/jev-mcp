/**
 * Error taxonomy for the Jev HTTP client.
 *
 * Every error thrown by `JevDecisionModel` is a `JevError`, so callers can
 * branch on `instanceof` for the class and read `status` / `body` for detail.
 * `body` is the parsed (or raw text) response body and never contains the API
 * key — the client never echoes request headers into an error.
 */

export interface JevErrorOptions {
  status?: number;
  body?: unknown;
  cause?: unknown;
}

export class JevError extends Error {
  readonly status?: number;
  readonly body?: unknown;

  constructor(message: string, options: JevErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    if (options.status !== undefined) this.status = options.status;
    if (options.body !== undefined) this.body = options.body;
  }
}

/** 401: missing or invalid API key. Never retried. */
export class JevAuthError extends JevError {}

/** 422: the request body failed validation. Never retried. */
export class JevValidationError extends JevError {}

/** 429: rate limited. Retried with backoff, honoring `retry-after`. */
export class JevRateLimitError extends JevError {}

/** 529 (and 5xx): TypeSafe is overloaded. Retried with backoff. */
export class JevOverloadedError extends JevError {}

/** The request exceeded `timeoutMs`, or the caller's signal aborted it. */
export class JevTimeoutError extends JevError {}

/** The request never reached the API (DNS, TLS, socket). Retried. */
export class JevConnectionError extends JevError {}

/**
 * The API answered, but not in the documented shape: unparseable JSON, a
 * missing answer for a requested question id, or an answer whose `type` does
 * not match the question that asked for it.
 */
export class JevProtocolError extends JevError {}

/** Best-effort one-line summary for a tool result. Never includes a stack. */
export function describeError(error: unknown): string {
  if (error instanceof JevError) {
    const detail = formatBody(error.body);
    const status = error.status === undefined ? "" : ` (HTTP ${error.status})`;
    return detail ? `${error.message}${status}: ${detail}` : `${error.message}${status}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function formatBody(body: unknown): string {
  if (body === undefined || body === null) return "";
  const text = typeof body === "string" ? body : safeStringify(body);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
