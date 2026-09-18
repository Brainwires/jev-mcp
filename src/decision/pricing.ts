/**
 * What a judgment costs.
 *
 * TypeSafe bills input tokens only, so one number is the whole price list. It
 * lives on its own because two unrelated callers quote it — the MCP file tools,
 * which refuse a request that would cost too much, and `/jev:status`, which
 * reports what the last day actually cost — and a price that disagrees with
 * itself is worse than no price at all.
 */

/** USD per million input tokens. */
export const USD_PER_MTOK = 0.042;

export function estimateCostUsd(inputTokens: number): number {
  return (inputTokens / 1_000_000) * USD_PER_MTOK;
}
