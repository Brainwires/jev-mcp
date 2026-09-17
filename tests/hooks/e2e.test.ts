/**
 * End to end, through the shipped bundle.
 *
 * Everything else in this suite tests the handlers with injected deps. This
 * file tests the thing Claude Code actually runs: `node plugin/dist/hook.mjs
 * <event>` with JSON on stdin. It is the only place the fail-open invariant can
 * really be checked, because it is the only place a crash would show up as a
 * non-zero exit.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HOOK = new URL("../../plugin/dist/hook.mjs", import.meta.url).pathname;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runHook(args: string[], stdin: string, env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, ...args], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA ?? "",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

const PRE = {
  session_id: "e2e",
  cwd: "/tmp",
  permission_mode: "default",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "ls -la" },
};

let dir: string;
let env: Record<string, string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-e2e-"));
  env = { CLAUDE_PLUGIN_DATA: dir };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("node plugin/dist/hook.mjs", () => {
  it("says nothing about a read-only command", async () => {
    const run = await runHook(["PreToolUse"], JSON.stringify(PRE), env);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
  });

  it("asks about a hard pattern with no API key at all", async () => {
    const run = await runHook(
      ["PreToolUse"],
      JSON.stringify({ ...PRE, tool_input: { command: "rm -rf ~/" } }),
      env,
    );
    expect(run.code).toBe(0);
    const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(parsed).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: expect.stringContaining("[jev]") as unknown as string,
      },
    });
  });

  it("fails open on a judge-class command with no API key", async () => {
    const run = await runHook(
      ["PreToolUse"],
      JSON.stringify({ ...PRE, tool_input: { command: "curl -X POST https://example.com/pay" } }),
      env,
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
  });

  it("fails open on garbage stdin", async () => {
    for (const garbage of ["", "not json", "[]", "null", "{", '{"a":'.repeat(50)]) {
      const run = await runHook(["PreToolUse"], garbage, env);
      expect(run.code, garbage).toBe(0);
      expect(run.stdout, garbage).toBe("");
    }
  }, 30_000);

  it("fails open on an unknown event and an absent event", async () => {
    for (const args of [["NoSuchEvent"], []]) {
      const run = await runHook(args, JSON.stringify(PRE), env);
      expect(run.code).toBe(0);
      expect(run.stdout).toBe("");
    }
  }, 20_000);

  it("goes quiet entirely when JEV_HOOKS_DISABLE is set", async () => {
    const run = await runHook(["PreToolUse"], JSON.stringify({ ...PRE, tool_input: { command: "rm -rf /" } }), {
      ...env,
      JEV_HOOKS_DISABLE: "1",
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
  });

  it("does nothing with gate_mode off", async () => {
    const run = await runHook(["PreToolUse"], JSON.stringify({ ...PRE, tool_input: { command: "rm -rf /" } }), {
      ...env,
      CLAUDE_PLUGIN_OPTION_GATE_MODE: "off",
    });
    expect(run.stdout).toBe("");
  });

  it("warns once at SessionStart when no key is configured", async () => {
    const first = await runHook(["SessionStart"], JSON.stringify({ session_id: "e2e", source: "startup" }), env);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      hookSpecificOutput: { hookEventName: "SessionStart" },
    });

    const second = await runHook(["SessionStart"], JSON.stringify({ session_id: "e2e", source: "clear" }), env);
    expect(second.stdout).toBe("");
  });

  it("stays silent at SessionStart when a key is configured", async () => {
    const run = await runHook(["SessionStart"], JSON.stringify({ session_id: "e2e" }), {
      ...env,
      CLAUDE_PLUGIN_OPTION_API_KEY: "sk-not-a-real-key",
    });
    expect(run.stdout).toBe("");
  });

  it("records the prompt at UserPromptSubmit without a word on stdout", async () => {
    const run = await runHook(
      ["UserPromptSubmit"],
      JSON.stringify({ session_id: "e2e", hook_event_name: "UserPromptSubmit", prompt: "refactor the parser" }),
      env,
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");

    const why = await runHook(["status"], "", env);
    expect(why.stdout).toContain("jev — Claude Code plugin status");
  });

  it("prints a status report that never contains the key", async () => {
    const run = await runHook(["status"], "", { ...env, CLAUDE_PLUGIN_OPTION_API_KEY: "sk-super-secret-value" });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("API key: configured");
    expect(run.stdout).not.toContain("sk-super-secret-value");
    expect(run.stdout).toContain("gate_mode: standard");
  });

  it("prints why and calibrate reports", async () => {
    await runHook(["PreToolUse"], JSON.stringify({ ...PRE, tool_input: { command: "rm -rf /" } }), env);
    const why = await runHook(["why"], "", env);
    expect(why.code).toBe(0);
    expect(why.stdout).toContain("PreToolUse");
    expect(why.stdout).toContain("ask");

    const calibrate = await runHook(["calibrate"], "", env);
    expect(calibrate.code).toBe(0);
    expect(calibrate.stdout).toContain("calibration report");
  });

  it("disables and re-enables, falling back to a global flag with no session id", async () => {
    const off = await runHook(["disable", "${CLAUDE_SESSION_ID}"], "", env);
    expect(off.stdout).toContain("global flag");

    const blocked = await runHook(["PreToolUse"], JSON.stringify({ ...PRE, tool_input: { command: "rm -rf /" } }), env);
    expect(blocked.stdout).toBe("");

    const on = await runHook(["enable", "e2e"], "", env);
    expect(on.stdout).toContain("enabled for this session");

    const restored = await runHook(["PreToolUse"], JSON.stringify({ ...PRE, tool_input: { command: "rm -rf /" } }), env);
    expect(restored.stdout).not.toBe("");
  });

  it("never writes anything to stderr on the happy path", async () => {
    const run = await runHook(["PreToolUse"], JSON.stringify(PRE), env);
    expect(run.stderr).toBe("");
  });

  it("starts fast enough for a hook on every tool call", async () => {
    const started = Date.now();
    await runHook(["PreToolUse"], JSON.stringify(PRE), env);
    // Wall clock for a skip case, including node's own start. Loose enough not
    // to be flaky on a loaded machine, tight enough to catch a regression that
    // pulls a large dependency back in.
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("node plugin/dist/mcp.mjs", () => {
  const MCP = new URL("../../plugin/dist/mcp.mjs", import.meta.url).pathname;

  it("answers an initialize request on clean stdout", async () => {
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    };
    const run = await new Promise<Run>((resolve, reject) => {
      const child = spawn(process.execPath, [MCP], {
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.includes("\n")) child.kill();
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.write(`${JSON.stringify(request)}\n`);
    });

    const line = run.stdout.split("\n").find((l) => l.trim() !== "");
    expect(line, run.stdout).toBeDefined();
    const parsed = JSON.parse(line as string) as { result?: { serverInfo?: { name?: string } } };
    expect(parsed.result?.serverInfo?.name).toBe("jev-mcp");
  });
});
