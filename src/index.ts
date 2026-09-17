#!/usr/bin/env node
/**
 * stdio entry point.
 *
 * stdout carries the MCP protocol and nothing else: every diagnostic goes to
 * stderr. A misconfiguration is reported per tool call rather than by exiting,
 * so the client can start the server and still tell the user what to fix.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { JevDecisionModel } from "./jev/client.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

function log(message: string): void {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

async function main(): Promise<void> {
  const config = loadConfig();

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

  if (model === null) {
    log("TYPESAFE_API_KEY is not set. Starting anyway; every tool call will explain what to set.");
  }

  const server = createServer(model, config);
  await server.connect(new StdioServerTransport());

  log(`v${SERVER_VERSION} ready on stdio (model ${config.model}, base ${config.baseUrl}).`);
}

main().catch((error: unknown) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
