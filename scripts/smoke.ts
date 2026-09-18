#!/usr/bin/env tsx
/**
 * Live smoke test: one tiny three-question request against the real API.
 *
 * Skips cleanly (exit 0) when TYPESAFE_API_KEY is unset, so it is safe to wire
 * into a pipeline that does not always have credentials. Costs a few hundred
 * input tokens, which at $0.042/Mtok is effectively free.
 *
 *   npm run smoke
 */

import { loadConfig } from "../src/config.js";
import { JevDecisionModel } from "../src/jev/client.js";
import { describeError } from "../src/jev/errors.js";
import * as rankTool from "../src/tools/rank.js";
import * as verifyTool from "../src/tools/verify.js";

async function main(): Promise<number> {
  const config = loadConfig();

  if (config.apiKey === null) {
    console.log("skipped: TYPESAFE_API_KEY is not set, so the live smoke test did not run.");
    return 0;
  }

  const model = new JevDecisionModel({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
  });

  console.log(`GET ${config.baseUrl}/v1/models`);
  const catalog = await model.listModels();
  for (const entry of catalog.models) {
    console.log(`  ${entry.name}  (${entry.release_date})  ${entry.description}`);
  }

  console.log(`\nPOST ${config.baseUrl}/v1/systemone  model=${config.model}`);
  const result = await model.evaluate({
    state: "Help! My payouts have been failing for 3 days.",
    questions: {
      is_urgent: {
        type: "noul",
        instructions: "Does this message convey urgency?",
        criteria: { true: "Explicitly time-sensitive", false: "No urgency expressed" },
      },
      department: {
        type: "choice",
        instructions: "Which team should handle this?",
        criteria: {
          billing: "Payments, invoicing, refunds",
          technical: "Bugs, outages, integrations",
          other: "None of the above",
        },
      },
      frustration: {
        type: "score",
        instructions: "How frustrated is the sender?",
        criteria: ["Calm, just stating facts", "Frustrated but civil", "Very angry"],
      },
    },
  });

  console.log(`  answered by: ${result.model}  in ${result.latency_ms}ms`);
  console.log(`  usage: ${result.usage.input_tokens} in / ${result.usage.output_tokens} out`);
  console.log(`  is_urgent   noul=${result.answers.is_urgent.noul}`);
  console.log(
    `  department  choice=${result.answers.department.choice} confidence=${result.answers.department.confidence}`,
  );
  console.log(
    `  frustration score=${result.answers.frustration.score} confidence=${result.answers.frustration.confidence}`,
  );

  // ---------------------------------------------------------------- jev_rank
  // The path-based half of 0.2: the server reads the repo, and only line
  // ranges come back. Costs a few tens of thousands of input tokens, which at
  // $0.042/Mtok is a fraction of a cent.
  const toolConfig = {
    model: config.model,
    thresholds: config.thresholds,
    maxConcurrency: config.maxConcurrency,
    maxConcurrencyExplicit: config.maxConcurrencyExplicit,
    files: { root: config.projectRoot },
  };

  console.log(`\njev_rank  glob="src/**/*.ts"  root=${config.projectRoot}`);
  const ranked = await rankTool.run(
    model,
    { query: "where are retries and backoff implemented", glob: "src/**/*.ts", unit: "file", top_k: 5 },
    toolConfig,
  );
  console.log(
    `  files_scanned=${ranked.files_scanned}  chunks_scored=${ranked.chunks_scored}  requests=${ranked.chunks}  ` +
      `latency=${ranked.latency_ms}ms`,
  );
  console.log(
    `  usage: ${ranked.usage.input_tokens} input tokens  est_cost=$${(ranked.est_cost_usd ?? 0).toFixed(5)}  ` +
      `actual=$${((ranked.usage.input_tokens / 1_000_000) * 0.042).toFixed(5)}`,
  );
  console.log(`  skipped: ${JSON.stringify(ranked.skipped)}`);
  console.log(
    `  any_relevant=${ranked.any_relevant}  score_spread=${ranked.score_spread}` +
      `  (${ranked.score_spread < 0.15 ? "NOT informative" : "informative"})`,
  );
  for (const row of ranked.ranked) {
    console.log(`  ${String(row.rank).padStart(2)}. ${row.relevance.toFixed(3)}  ${row.path}:${row.start_line}-${row.end_line}`);
  }

  // The `candidates` path at a size that used to fit one request. 40 short
  // candidates now split across ceil(40/16) = 3, which is what fixed it.
  const inline = [
    "retryWithBackoff() sleeps 2^n * 100ms between attempts and honours retry-after",
    "computeInvoiceTotal sums line items and applies tax",
    "The CLI parses argv[2] as the hook event name",
    "parseIsoDate returns null for a malformed string",
    "Exponential backoff is capped at 30 seconds",
    ...Array.from({ length: 35 }, (_, i) => `Unrelated helper number ${i}: formats a label for display`),
  ];
  console.log(`\njev_rank  ${inline.length} inline candidates`);
  const inlineRanked = await rankTool.run(
    model,
    {
      query: "where is retry and backoff logic described",
      candidates: inline.map((text, index) => ({ id: `c${index}`, text })),
      top_k: 3,
    },
    toolConfig,
  );
  console.log(
    `  requests=${inlineRanked.chunks}  total_candidates=${inlineRanked.total_candidates}  ` +
      `latency=${inlineRanked.latency_ms}ms  usage=${inlineRanked.usage.input_tokens} input tokens`,
  );
  console.log(
    `  any_relevant=${inlineRanked.any_relevant}  score_spread=${inlineRanked.score_spread}` +
      `  (${inlineRanked.score_spread < 0.15 ? "NOT informative" : "informative"})`,
  );
  for (const row of inlineRanked.ranked) {
    console.log(`  ${String(row.rank).padStart(2)}. ${row.relevance.toFixed(3)}  ${row.id}`);
  }

  // -------------------------------------------------------------- jev_verify
  console.log(`\njev_verify  evidence_path="CHANGELOG.md"`);
  const verified = await verifyTool.run(
    model,
    {
      claims: [
        "Version 0.2.0 adds a verification ledger.",
        "jev_rank accepts a glob and reads the files itself.",
        "The project is written in Rust.",
      ],
      evidence_path: "CHANGELOG.md",
    },
    toolConfig,
  );
  console.log(
    `  evidence_chunks=${verified.evidence_chunks}  latency=${verified.latency_ms}ms  ` +
      `usage=${verified.usage.input_tokens} input tokens  est_cost=$${(verified.est_cost_usd ?? 0).toFixed(5)}`,
  );
  console.log(`  summary: ${JSON.stringify(verified.summary)}  all_supported=${verified.all_supported}`);
  for (const claim of verified.claims) {
    const where = claim.where === undefined ? "" : `  lines ${claim.where.start_line}-${claim.where.end_line}`;
    console.log(
      `  ${claim.verdict.padEnd(14)} conf=${claim.confidence.toFixed(3)} gate=${claim.gate.padEnd(8)}${where}  "${claim.claim}"`,
    );
  }

  console.log("\nok");
  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(`smoke failed: ${describeError(error)}`);
    process.exit(1);
  });
