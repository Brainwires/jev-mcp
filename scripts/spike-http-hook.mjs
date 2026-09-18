#!/usr/bin/env node
// Phase-2 spike: a throwaway loopback listener that records what Claude Code
// sends to a `type: "http"` hook, so the daemon design rests on observed
// behaviour rather than on the docs alone. Not part of the plugin.
//
// Usage:
//   node scripts/spike-http-hook.mjs [port] [mode]
//     mode = empty | json | text | status500   (what to answer; default json = `{}`)
// Then add the throwaway hook entry from docs/SPIKE_HTTP_HOOK.md to a
// settings file, start a session, run two or three tool calls, and read
// /tmp/jev-spike.log. Delete the hook entry afterwards.

import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 10523);
const mode = process.argv[3] ?? "json";
const log = process.env.JEV_SPIKE_LOG ?? "/tmp/jev-spike.log";

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    let event = "?";
    let session = "?";
    try {
      const parsed = JSON.parse(body);
      event = parsed.hook_event_name ?? "?";
      session = parsed.session_id ?? "?";
    } catch {
      /* keep "?" */
    }
    const line = {
      ts: new Date().toISOString(),
      method: req.method,
      url: req.url,
      event,
      session,
      // Which headers arrived, and whether env interpolation happened. Values
      // are reported by length only: this file is a log, not a key store.
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, typeof v === "string" ? `${v.length} chars${v.includes("$") ? " (contains $ — not interpolated)" : ""}` : v]),
      ),
      body_bytes: body.length,
      answered: mode,
    };
    appendFileSync(log, `${JSON.stringify(line)}\n`);

    switch (mode) {
      case "empty":
        res.writeHead(200).end();
        break;
      case "text":
        res.writeHead(200, { "content-type": "text/plain" }).end("not json");
        break;
      case "status500":
        res.writeHead(500).end();
        break;
      default:
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stderr.write(`spike listener on http://127.0.0.1:${port} answering "${mode}", logging to ${log}\n`);
});
