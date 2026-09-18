/**
 * The memo and the concurrency limit.
 *
 * The memo's job is to be honest as well as fast: a hit has to be reported as
 * `latency_ms: 0`, `input_tokens: 0` and `memo: true`, because otherwise
 * `/jev:status` would report a p50 that includes calls that never happened and
 * a token count that flatters the bill. Most of this file is about that, not
 * about whether the cache works.
 */

import { describe, expect, it } from "vitest";
import type { DecisionModel, EvaluateRequest, EvaluateResult, Question } from "../../src/decision/types.js";
import {
  canonicalJson,
  DEFAULT_CONCURRENCY,
  LimitedModel,
  MEMO_MAX_ENTRIES,
  MEMO_TTL_MS,
  MemoizedModel,
  memoKey,
} from "../../src/hooks/memo.js";
import { modelCost } from "../../src/hooks/store.js";

/** Counts calls and answers with the call number, so a hit is visible. */
class CountingModel implements DecisionModel {
  readonly name = "counting";
  calls = 0;

  constructor(private readonly fail?: () => Error) {}

  async evaluate<Q extends Record<string, Question>>(_request: EvaluateRequest<Q>): Promise<EvaluateResult<Q>> {
    this.calls += 1;
    const error = this.fail?.();
    if (error !== undefined) throw error;
    return {
      model: `counting-${this.calls}`,
      answers: {} as EvaluateResult<Q>["answers"],
      usage: { input_tokens: 100, output_tokens: 5 },
      latency_ms: 500,
    };
  }

  async choice(): Promise<never> {
    throw new Error("unused");
  }
  async score(): Promise<never> {
    throw new Error("unused");
  }
  async probability(): Promise<never> {
    throw new Error("unused");
  }
}

const QUESTIONS: Record<string, Question> = {
  destructive: { type: "noul", instructions: "Is it destructive?", criteria: { true: "yes", false: "no" } },
};

describe("canonicalJson", () => {
  it("does not depend on the order the properties were written in", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson({ a: { x: 1, y: 2 } })).toBe(canonicalJson({ a: { y: 2, x: 1 } }));
  });

  it("keeps array order, which is meaningful", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("distinguishes values that stringify alike", () => {
    expect(canonicalJson({ a: "1" })).not.toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(undefined)).toBe("null");
  });
});

describe("memoKey", () => {
  it("is stable for the same question asked twice", () => {
    expect(memoKey("jev-latest", { a: "x" }, QUESTIONS)).toBe(memoKey("jev-latest", { a: "x" }, QUESTIONS));
  });

  it("changes with the model, the state and the questions", () => {
    const base = memoKey("jev-latest", { a: "x" }, QUESTIONS);
    expect(memoKey("jev-1.13", { a: "x" }, QUESTIONS)).not.toBe(base);
    expect(memoKey("jev-latest", { a: "y" }, QUESTIONS)).not.toBe(base);
    expect(
      memoKey("jev-latest", { a: "x" }, { ...QUESTIONS, extra: QUESTIONS.destructive as Question }),
    ).not.toBe(base);
  });

  it("is a sha256 digest, so no payload text reaches the key", () => {
    expect(memoKey(undefined, "secret-value", QUESTIONS)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("MemoizedModel", () => {
  it("answers the second identical request without calling through", async () => {
    const inner = new CountingModel();
    const memo = new MemoizedModel(inner);
    const first = await memo.evaluate({ state: { a: "x" }, questions: QUESTIONS });
    const second = await memo.evaluate({ state: { a: "x" }, questions: QUESTIONS });
    expect(inner.calls).toBe(1);
    expect(second.model).toBe(first.model);
    expect(memo.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it("reports a hit as free, and flags it", async () => {
    const memo = new MemoizedModel(new CountingModel());
    const first = await memo.evaluate({ state: { a: "x" }, questions: QUESTIONS });
    expect(first.latency_ms).toBe(500);
    expect(first.usage.input_tokens).toBe(100);
    expect(first.memo).toBeUndefined();

    const hit = await memo.evaluate({ state: { a: "x" }, questions: QUESTIONS });
    expect(hit.memo).toBe(true);
    expect(hit.latency_ms).toBe(0);
    expect(hit.usage.input_tokens).toBe(0);
    expect(hit.usage.output_tokens).toBe(0);
  });

  it("records a hit as memo in the decision log's cost fields", () => {
    // The end of the chain that matters: a hit must never look like a 0 ms call.
    expect(
      modelCost({ model: "jev-1.13", latency_ms: 0, usage: { input_tokens: 0 }, memo: true }),
    ).toEqual({ model: "jev-1.13", latency_ms: 0, input_tokens: 0, memo: true });
    expect(modelCost({ model: "jev-1.13", latency_ms: 480, usage: { input_tokens: 900 } })).toEqual({
      model: "jev-1.13",
      latency_ms: 480,
      input_tokens: 900,
    });
  });

  it("misses a different question", async () => {
    const inner = new CountingModel();
    const memo = new MemoizedModel(inner);
    await memo.evaluate({ state: { a: "x" }, questions: QUESTIONS });
    await memo.evaluate({ state: { a: "y" }, questions: QUESTIONS });
    expect(inner.calls).toBe(2);
  });

  it("expires an entry after the TTL", async () => {
    const inner = new CountingModel();
    let now = 1000;
    const memo = new MemoizedModel(inner, { ttlMs: 100, now: () => now });
    await memo.evaluate({ state: { a: "x" }, questions: QUESTIONS });
    now = 1050;
    await memo.evaluate({ state: { a: "x" }, questions: QUESTIONS });
    expect(inner.calls).toBe(1);
    now = 1200;
    await memo.evaluate({ state: { a: "x" }, questions: QUESTIONS });
    expect(inner.calls).toBe(2);
  });

  it("evicts the least recently used entry past the cap", async () => {
    const inner = new CountingModel();
    const memo = new MemoizedModel(inner, { maxEntries: 2 });
    await memo.evaluate({ state: { a: "1" }, questions: QUESTIONS });
    await memo.evaluate({ state: { a: "2" }, questions: QUESTIONS });
    // Touch 1 so 2 becomes the oldest.
    await memo.evaluate({ state: { a: "1" }, questions: QUESTIONS });
    await memo.evaluate({ state: { a: "3" }, questions: QUESTIONS });
    expect(memo.stats().entries).toBe(2);

    await memo.evaluate({ state: { a: "1" }, questions: QUESTIONS });
    const callsAfterOne = inner.calls;
    await memo.evaluate({ state: { a: "2" }, questions: QUESTIONS });
    expect(inner.calls).toBe(callsAfterOne + 1);
  });

  it("does not cache a failure, and counts it", async () => {
    // A cached timeout would turn one bad second into five bad minutes.
    let fail = true;
    const inner = new CountingModel(() => {
      if (!fail) return undefined as unknown as Error;
      const error = new Error("too slow");
      error.name = "JevTimeoutError";
      return error;
    });
    const memo = new MemoizedModel(inner);
    await expect(memo.evaluate({ state: { a: "x" }, questions: QUESTIONS })).rejects.toThrow("too slow");
    expect(memo.stats()).toMatchObject({ errors: 1, timeouts: 1 });

    fail = false;
    const ok = await memo.evaluate({ state: { a: "x" }, questions: QUESTIONS });
    expect(ok.memo).toBeUndefined();
    expect(inner.calls).toBe(2);
  });

  it("counts a non-timeout failure separately", async () => {
    const inner = new CountingModel(() => {
      const error = new Error("503");
      error.name = "JevOverloadedError";
      return error;
    });
    const memo = new MemoizedModel(inner);
    await expect(memo.evaluate({ state: { a: "x" }, questions: QUESTIONS })).rejects.toThrow("503");
    expect(memo.stats()).toMatchObject({ errors: 1, timeouts: 0 });
  });

  it("keeps the inner model's name, so the log still says which model answered", () => {
    expect(new MemoizedModel(new CountingModel()).name).toBe("counting");
  });

  it("defaults to 256 entries and five minutes", () => {
    expect(MEMO_MAX_ENTRIES).toBe(256);
    expect(MEMO_TTL_MS).toBe(5 * 60 * 1000);
  });
});

describe("LimitedModel", () => {
  it("runs no more than the limit at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const inner: DecisionModel = {
      name: "slow",
      evaluate: async <Q extends Record<string, Question>>(): Promise<EvaluateResult<Q>> => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => release.push(resolve));
        inFlight -= 1;
        return {
          model: "slow",
          answers: {} as EvaluateResult<Q>["answers"],
          usage: { input_tokens: 1, output_tokens: 1 },
          latency_ms: 1,
        };
      },
      choice: async () => {
        throw new Error("unused");
      },
      score: async () => {
        throw new Error("unused");
      },
      probability: async () => {
        throw new Error("unused");
      },
    };

    const limited = new LimitedModel(inner, 4);
    const all = Array.from({ length: 12 }, (_, i) =>
      limited.evaluate({ state: { i }, questions: QUESTIONS }),
    );

    // Let the first batch enter.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(limited.inFlight).toBe(4);
    expect(peak).toBe(4);

    while (release.length > 0 || inFlight > 0) {
      const next = release.shift();
      if (next === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      next();
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    await Promise.all(all);
    expect(peak).toBe(4);
    expect(limited.inFlight).toBe(0);
  });

  it("releases its slot when the inner call throws", async () => {
    const inner: DecisionModel = {
      name: "bad",
      evaluate: async () => {
        throw new Error("nope");
      },
      choice: async () => {
        throw new Error("nope");
      },
      score: async () => {
        throw new Error("nope");
      },
      probability: async () => {
        throw new Error("nope");
      },
    };
    const limited = new LimitedModel(inner, 1);
    for (let i = 0; i < 3; i += 1) {
      await expect(limited.evaluate({ state: { i }, questions: QUESTIONS })).rejects.toThrow("nope");
    }
    expect(limited.inFlight).toBe(0);
  });

  it("defaults to four, matching the MCP server's own fan-out", () => {
    expect(DEFAULT_CONCURRENCY).toBe(4);
  });
});

describe("the daemon's stack", () => {
  it("puts the memo outside the limiter, so a hit never queues", async () => {
    let entered = 0;
    const release: (() => void)[] = [];
    const inner: DecisionModel = {
      name: "slow",
      evaluate: async <Q extends Record<string, Question>>(): Promise<EvaluateResult<Q>> => {
        entered += 1;
        await new Promise<void>((resolve) => release.push(resolve));
        return {
          model: "slow",
          answers: {} as EvaluateResult<Q>["answers"],
          usage: { input_tokens: 1, output_tokens: 1 },
          latency_ms: 1,
        };
      },
      choice: async () => {
        throw new Error("unused");
      },
      score: async () => {
        throw new Error("unused");
      },
      probability: async () => {
        throw new Error("unused");
      },
    };

    const stack = new MemoizedModel(new LimitedModel(inner, 1));
    const first = stack.evaluate({ state: { a: "x" }, questions: QUESTIONS });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(entered).toBe(1);
    release.shift()?.();
    await first;

    // The slot is busy with a second real call; the memo hit must still be
    // instant rather than waiting behind it.
    const blocking = stack.evaluate({ state: { a: "y" }, questions: QUESTIONS });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const hit = await stack.evaluate({ state: { a: "x" }, questions: QUESTIONS });
    expect(hit.memo).toBe(true);

    release.shift()?.();
    await blocking;
  });
});
