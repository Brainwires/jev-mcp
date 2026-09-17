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
