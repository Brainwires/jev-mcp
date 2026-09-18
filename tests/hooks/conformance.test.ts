/**
 * The command path and the daemon path must produce the same bytes.
 *
 * This is the release's load-bearing test. 0.4.0's whole claim is "same plugin,
 * different transport": if the http hooks and the command hooks could disagree,
 * a user's behaviour would depend on whether a daemon happened to be up, which
 * is exactly the kind of bug nobody reports because it looks like the model
 * being inconsistent.
 *
 * So every case runs twice — `runEvent` in a fresh data directory, and a POST
 * to a real `startDaemon({port: 0})` in another fresh one — and the reply body
 * has to equal `JSON.stringify(output ?? {})`. `{}` for `undefined` is the wire
 * saying nothing, which is what an empty stdout means on the command side.
 *
 * Both sides get the same injected `now`, so nothing in the comparison depends
 * on how long the test took.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runEvent } from "../../src/hooks/main.js";
import { startDaemon, type DaemonHandle } from "../../src/hooks/daemon/server.js";
import { SessionRegistry } from "../../src/hooks/daemon/registry.js";
import { Store } from "../../src/hooks/store.js";
import type { Deps } from "../../src/hooks/types.js";
import { CASES } from "./cases.js";
import { cleanup, makeDeps, tempDir } from "./helpers.js";

const NOW = 1_700_000_000_000;

let commandDir: string;
let daemonDir: string;
const handles: DaemonHandle[] = [];

beforeEach(() => {
  commandDir = tempDir();
  daemonDir = tempDir();
});

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop();
    if (handle !== undefined) await handle.close();
  }
  cleanup(commandDir);
  cleanup(daemonDir);
});

/** A daemon whose `Deps` are built exactly as the in-process driver builds them. */
async function daemonFor(deps: Deps): Promise<DaemonHandle> {
  const handle = await startDaemon({
    port: 0,
    expectedKeys: [],
    depsFor: () => deps,
    registry: new SessionRegistry(() => NOW),
    onExitRequested: () => undefined,
    idleMs: 0,
    lastSessionGraceMs: 0,
  });
  handles.push(handle);
  return handle;
}

async function post(port: number, path: string, body: string): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return { status: response.status, text: await response.text() };
}

describe("the command path and the daemon path agree byte for byte", () => {
  for (const hookCase of CASES) {
    it(hookCase.name, async () => {
      const raw = JSON.stringify(hookCase.input);

      const commandDeps = makeDeps(commandDir, {
        ...(hookCase.model !== undefined ? { model: hookCase.model() } : {}),
        ...(hookCase.config !== undefined ? { config: hookCase.config } : {}),
        now: NOW,
      });
      hookCase.prepare?.(commandDeps.store);
      const expected = JSON.stringify((await runEvent(hookCase.event, raw, commandDeps)) ?? {});

      const daemonDeps = makeDeps(daemonDir, {
        ...(hookCase.model !== undefined ? { model: hookCase.model() } : {}),
        ...(hookCase.config !== undefined ? { config: hookCase.config } : {}),
        now: NOW,
      });
      hookCase.prepare?.(daemonDeps.store);
      const handle = await daemonFor(daemonDeps);
      const reply = await post(handle.port, `/v1/hook/${hookCase.event}`, raw);

      expect(reply.status).toBe(200);
      expect(reply.text).toBe(expected);
      if (hookCase.expect !== undefined) expect(reply.text).toBe(hookCase.expect);
      for (const needle of hookCase.contains ?? []) expect(reply.text).toContain(needle);
    });
  }
});

describe("the daemon's side effects match the command path's", () => {
  it("writes the same decision log line for a tripped call", async () => {
    const input = JSON.stringify({
      session_id: "shared",
      cwd: "/home/dev/project",
      permission_mode: "default",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf ~/" },
    });

    const commandDeps = makeDeps(commandDir, { now: NOW });
    await runEvent("PreToolUse", input, commandDeps);

    const daemonDeps = makeDeps(daemonDir, { now: NOW });
    const handle = await daemonFor(daemonDeps);
    await post(handle.port, "/v1/hook/PreToolUse", input);

    const fromCommand = new Store(commandDeps.config.dataDir).readLog();
    const fromDaemon = new Store(daemonDeps.config.dataDir).readLog();
    expect(fromDaemon).toEqual(fromCommand);
  });

  it("answers `{}` rather than an empty body, so the reply is always valid JSON", async () => {
    // Claude Code treats a 2xx with a non-JSON body as a non-blocking error and
    // logs it. Silence has to be `{}`, not nothing at all.
    const handle = await daemonFor(makeDeps(daemonDir, { now: NOW }));
    const reply = await post(
      handle.port,
      "/v1/hook/PreToolUse",
      JSON.stringify({ session_id: "shared", tool_name: "Bash", tool_input: { command: "ls -la" } }),
    );
    expect(reply.text).toBe("{}");
    expect(JSON.parse(reply.text)).toEqual({});
  });
});
