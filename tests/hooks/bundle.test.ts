/**
 * What actually ships.
 *
 * A plugin install runs no build step, so `plugin/dist/*.mjs` is the artifact,
 * and its contents are a property worth testing. In particular the hook bundle
 * must not drag in the MCP SDK or zod: it runs on every tool call, and its
 * cold start is a tax on the whole session.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Kept in step with `scripts/build-plugin.ts`, which fails the build on these. */
const HOOK_FORBIDDEN = ["@modelcontextprotocol", "zod"];

const root = new URL("../../", import.meta.url).pathname;
const hook = `${root}plugin/dist/hook.mjs`;
const mcp = `${root}plugin/dist/mcp.mjs`;

describe("plugin/dist", () => {
  it("ships both bundles", () => {
    expect(existsSync(hook), "run `npm run build:plugin`").toBe(true);
    expect(existsSync(mcp), "run `npm run build:plugin`").toBe(true);
  });

  it("keeps the MCP SDK and zod out of the hook bundle", () => {
    const text = readFileSync(hook, "utf8");
    for (const name of HOOK_FORBIDDEN) {
      expect(text, `${name} must not be bundled into hook.mjs`).not.toContain(name);
    }
    expect(text).not.toContain("node_modules/zod");
  });

  it("keeps the hook bundle small enough to start fast", () => {
    // Generous headroom; the point is to notice a dependency creeping in.
    expect(statSync(hook).size).toBeLessThan(300 * 1024);
  });

  it("bundles the MCP SDK into the server", () => {
    expect(readFileSync(mcp, "utf8")).toContain("@modelcontextprotocol");
  });

  it("adds no shebang to the hook, which is invoked as `node <file>`", () => {
    expect(readFileSync(hook, "utf8").startsWith("#!")).toBe(false);
    // mcp.mjs inherits the one on src/index.ts, which is harmless: Node accepts
    // it, and it keeps the bundle runnable directly the way the npm bin is.
    expect(readFileSync(mcp, "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("is not gitignored", () => {
    const ignore = readFileSync(`${root}.gitignore`, "utf8");
    const patterns = ignore
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    // A bare `dist/` would match plugin/dist too. It must be anchored.
    expect(patterns).toContain("/dist/");
    expect(patterns).not.toContain("dist/");
    expect(patterns).not.toContain("plugin/dist/");
  });
});

describe("plugin manifest", () => {
  it("never maps the plugin option onto TYPESAFE_API_KEY, which would mask a shell-exported key when the option is empty", () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "plugin/.claude-plugin/plugin.json"), "utf8")) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    for (const server of Object.values(manifest.mcpServers)) {
      expect(Object.keys(server.env ?? {})).not.toContain("TYPESAFE_API_KEY");
    }
  });
});
