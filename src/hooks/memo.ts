/**
 * Two `DecisionModel` wrappers the daemon puts in front of the Jev client.
 *
 * Neither changes an answer. `MemoizedModel` returns an answer the daemon
 * already paid for when the identical question comes back inside a few minutes;
 * `LimitedModel` stops a burst of hooks from opening twenty sockets at once.
 *
 * Both exist because the daemon is long-lived and the command path was not: a
 * process that dies after one hook cannot cache anything, so this is new
 * behaviour that arrives with 0.4 and has to be honest about it. A memo hit is
 * reported as `latency_ms: 0`, `input_tokens: 0` and `memo: true` so the log
 * never charges the user for a call that did not happen, and `/jev:status`'s
 * latency percentiles are over calls that really went out.
 *
 * What is *not* cached: failures. A timeout or a 500 is cached for exactly no
 * time at all — the next hook tries again. Caching an error would turn one bad
 * second into five bad minutes.
 */

import { createHash } from "node:crypto";
import type {
  ChoiceAnswer,
  ChoiceQuestion,
  DecisionModel,
  EvaluateRequest,
  EvaluateResult,
  NoulQuestion,
  Question,
  ScoreAnswer,
  ScoreQuestion,
  State,
} from "../decision/types.js";

/** Distinct question sets kept. Each entry is a few hundred bytes. */
export const MEMO_MAX_ENTRIES = 256;
/** How long an answer stays usable. Short: the world moves. */
export const MEMO_TTL_MS = 5 * 60 * 1000;
/** Jev calls in flight at once, across every session the daemon serves. */
export const DEFAULT_CONCURRENCY = 4;

/**
 * JSON with object keys in sorted order, all the way down.
 *
 * The cache key has to be stable across two hooks that built the same request
 * with their properties in a different order, and `JSON.stringify` preserves
 * insertion order, so it cannot be the key on its own.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/** The cache key: sha256 over the model, the state and the questions. */
export function memoKey(model: string | undefined, state: State, questions: Record<string, Question>): string {
  return createHash("sha256")
    .update(canonicalJson({ model: model ?? null, state, questions }))
    .digest("hex");
}

interface MemoEntry {
  key: string;
  ts: number;
  result: EvaluateResult;
}

export interface MemoOptions {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

export interface MemoStats {
  hits: number;
  /** Calls that went out to the provider. */
  misses: number;
  /** Of those, the ones that threw. */
  errors: number;
  /** Of those errors, the ones that were a deadline rather than a refusal. */
  timeouts: number;
  entries: number;
}

/**
 * Is this error a deadline?
 *
 * Counted separately because the two say different things: a timeout is "Jev
 * was slow and the hook gave up", which is a latency problem, and everything
 * else is "the call failed", which is an availability problem. Matched by name
 * rather than by class so this module does not have to import the Jev client.
 */
function isTimeout(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" && (name.includes("Timeout") || name === "AbortError");
}

/**
 * A tiny LRU over `evaluate`.
 *
 * `Map` preserves insertion order, so "least recently used" is "the first key
 * the iterator yields" once every read re-inserts its entry. 256 entries of a
 * few hundred bytes is small enough that eviction is about bounding the memory
 * of a process that lives for hours, not about cache pressure.
 */
export class MemoizedModel implements DecisionModel {
  readonly name: string;

  private readonly inner: DecisionModel;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, MemoEntry>();
  private hits = 0;
  private misses = 0;
  private errors = 0;
  private timeouts = 0;

  constructor(inner: DecisionModel, options: MemoOptions = {}) {
    this.inner = inner;
    this.name = inner.name;
    this.maxEntries = options.maxEntries ?? MEMO_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? MEMO_TTL_MS;
    this.now = options.now ?? ((): number => Date.now());
  }

  stats(): MemoStats {
    return {
      hits: this.hits,
      misses: this.misses,
      errors: this.errors,
      timeouts: this.timeouts,
      entries: this.entries.size,
    };
  }

  async evaluate<Q extends Record<string, Question>>(request: EvaluateRequest<Q>): Promise<EvaluateResult<Q>> {
    const key = memoKey(request.model, request.state, request.questions as Record<string, Question>);
    const now = this.now();
    const hit = this.entries.get(key);
    if (hit !== undefined) {
      if (now - hit.ts <= this.ttlMs) {
        // Re-insert so this key is now the most recently used one.
        this.entries.delete(key);
        this.entries.set(key, { ...hit, ts: hit.ts });
        this.hits += 1;
        return {
          ...(hit.result as EvaluateResult<Q>),
          latency_ms: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
          memo: true,
        };
      }
      this.entries.delete(key);
    }

    this.misses += 1;
    // The catch counts and rethrows; it never caches. A timeout or a 500 cached
    // for five minutes would turn one bad second into five bad minutes.
    let result: EvaluateResult<Q>;
    try {
      result = await this.inner.evaluate(request);
    } catch (error) {
      this.errors += 1;
      if (isTimeout(error)) this.timeouts += 1;
      throw error;
    }
    this.entries.set(key, { key, ts: this.now(), result: result as EvaluateResult });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    return result;
  }

  async choice(state: State, question: Omit<ChoiceQuestion, "type">): Promise<ChoiceAnswer> {
    const result = await this.evaluate({ state, questions: { q: { type: "choice", ...question } } });
    return result.answers.q;
  }

  async score(state: State, question: Omit<ScoreQuestion, "type">): Promise<ScoreAnswer> {
    const result = await this.evaluate({ state, questions: { q: { type: "score", ...question } } });
    return result.answers.q;
  }

  async probability(state: State, question: Omit<NoulQuestion, "type">): Promise<number> {
    const result = await this.evaluate({ state, questions: { q: { type: "noul", ...question } } });
    return result.answers.q.noul;
  }
}

/**
 * A counting semaphore in front of `evaluate`.
 *
 * The per-call deadline still belongs to the caller: a request that waits here
 * and then times out is a request that was going to time out anyway, and the
 * alternative — unbounded fan-out from a session that ran twenty tool calls in
 * a second — is worse for every one of them.
 */
export class LimitedModel implements DecisionModel {
  readonly name: string;

  private readonly inner: DecisionModel;
  private readonly limit: number;
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(inner: DecisionModel, limit: number = DEFAULT_CONCURRENCY) {
    this.inner = inner;
    this.name = inner.name;
    this.limit = Math.max(1, Math.floor(limit));
  }

  /** In-flight calls right now, for the tests and the counters. */
  get inFlight(): number {
    return this.active;
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next !== undefined) next();
  }

  async evaluate<Q extends Record<string, Question>>(request: EvaluateRequest<Q>): Promise<EvaluateResult<Q>> {
    await this.acquire();
    try {
      return await this.inner.evaluate(request);
    } finally {
      this.release();
    }
  }

  async choice(state: State, question: Omit<ChoiceQuestion, "type">): Promise<ChoiceAnswer> {
    const result = await this.evaluate({ state, questions: { q: { type: "choice", ...question } } });
    return result.answers.q;
  }

  async score(state: State, question: Omit<ScoreQuestion, "type">): Promise<ScoreAnswer> {
    const result = await this.evaluate({ state, questions: { q: { type: "score", ...question } } });
    return result.answers.q;
  }

  async probability(state: State, question: Omit<NoulQuestion, "type">): Promise<number> {
    const result = await this.evaluate({ state, questions: { q: { type: "noul", ...question } } });
    return result.answers.q.noul;
  }
}
