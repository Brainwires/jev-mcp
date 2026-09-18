/**
 * The MCP server's watchdog.
 *
 * Its job is narrow — call `ensureDaemon` every ten seconds — so most of what
 * matters is what it refuses to do: start when it was not asked to, keep the
 * MCP process alive, overlap its own runs, or let an error escape into a tool
 * call.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeHealth } from "../../src/hooks/daemon/control.js";
import { readDaemonState } from "../../src/hooks/daemon/state-file.js";
import { resolveBundlePath, startDaemonWatchdog, WATCHDOG_INTERVAL_MS } from "../../src/daemon-watchdog.js";
import {
  cleanupDir,
  freePort,
  killTracked,
  tempDataDir,
  TEST_WAIT_MS,
  track,
  trackStateFilePid,
  waitUntil,
} from "./daemon-helpers.js";

const pluginRoot = new URL("../../plugin/", import.meta.url).pathname;

let dir: string;
let port: number;
const handles: { stop(): void }[] = [];

beforeEach(async () => {
  dir = tempDataDir("jev-watchdog-");
  port = await freePort();
});

afterEach(async () => {
  for (const handle of handles) handle.stop();
  handles.length = 0;
  trackStateFilePid(dir);
  await killTracked();
  cleanupDir(dir);
});

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    JEV_PLUGIN_DAEMON: "1",
    JEV_PLUGIN_ROOT: pluginRoot,
    CLAUDE_PLUGIN_DATA: dir,
    JEV_DAEMON_PORT: String(port),
    ...extra,
  };
}

describe("resolveBundlePath", () => {
  it("finds the bundle under the plugin root", () => {
    expect(resolveBundlePath({ JEV_PLUGIN_ROOT: pluginRoot })).toContain("plugin/dist/hook.mjs");
    expect(resolveBundlePath({ CLAUDE_PLUGIN_ROOT: pluginRoot })).toContain("plugin/dist/hook.mjs");
  });

  it("ignores an unsubstituted placeholder rather than building a path from it", () => {
    // The manifest passes `${CLAUDE_PLUGIN_ROOT}`; a Claude Code that did not
    // substitute it would hand us the literal string.
    expect(resolveBundlePath({ JEV_PLUGIN_ROOT: "${CLAUDE_PLUGIN_ROOT}" })).toBeUndefined();
  });

  it("returns nothing when there is no plugin root, or no bundle under it", () => {
    expect(resolveBundlePath({})).toBeUndefined();
    expect(resolveBundlePath({ JEV_PLUGIN_ROOT: "/nowhere/at/all" })).toBeUndefined();
    expect(resolveBundlePath({ JEV_PLUGIN_ROOT: "   " })).toBeUndefined();
  });
});

describe("startDaemonWatchdog", () => {
  it("does nothing at all unless the manifest asked for it", () => {
    expect(startDaemonWatchdog(env({ JEV_PLUGIN_DAEMON: "0" }))).toBeUndefined();
    expect(startDaemonWatchdog(env({ JEV_PLUGIN_DAEMON: "" }))).toBeUndefined();
    const { JEV_PLUGIN_DAEMON: _omitted, ...without } = env();
    expect(startDaemonWatchdog(without)).toBeUndefined();
  });

  it("does nothing when it cannot find a bundle to run", () => {
    expect(startDaemonWatchdog(env({ JEV_PLUGIN_ROOT: "/nowhere" }))).toBeUndefined();
  });

  it("starts the daemon on its first pass, without waiting for the interval", async () => {
    const handle = startDaemonWatchdog(env(), 60_000, TEST_WAIT_MS);
    expect(handle).toBeDefined();
    handles.push(handle!);

    // The daemon writes its state file before `ensureDaemon` has finished
    // waiting for health, so wait for the pass itself rather than the file.
    await waitUntil(() => handle!.stats().last !== undefined, "the watchdog's first pass", 15_000);
    track(readDaemonState(dir)?.pid);
    expect(readDaemonState(dir)?.state).toBe("running");
    expect((await probeHealth(port, 2000)).kind).toBe("jev");
    expect(handle!.stats().last).toBe("started");
  }, 30_000);

  it("finds it running on the next pass rather than starting a second one", async () => {
    const handle = startDaemonWatchdog(env(), 60_000, TEST_WAIT_MS);
    handles.push(handle!);
    await waitUntil(() => handle!.stats().last === "started", "the first pass to start a daemon", 15_000);
    const pid = readDaemonState(dir)?.pid as number;
    track(pid);

    await handle!.tick();
    expect(handle!.stats().last).toBe("running");
    expect(readDaemonState(dir)?.pid).toBe(pid);
    expect(handle!.stats().failures).toBe(0);
  }, 30_000);

  it("counts a failure without throwing", async () => {
    // A port held by something that answers HTML: `ensureDaemon` reports a
    // conflict, and the watchdog records it and carries on.
    const { createServer } = await import("node:http");
    const squatter = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>no</html>");
    });
    await new Promise<void>((resolve) => squatter.listen(port, "127.0.0.1", () => resolve()));
    try {
      const handle = startDaemonWatchdog(env(), 60_000, TEST_WAIT_MS);
      handles.push(handle!);
      await waitUntil(() => handle!.stats().runs > 0 && handle!.stats().last !== undefined, "one pass", 15_000);
      expect(handle!.stats().last).toBe("conflict");
      expect(handle!.stats().failures).toBe(1);
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  }, 30_000);

  it("never runs two passes at once", async () => {
    const handle = startDaemonWatchdog(env(), 60_000, TEST_WAIT_MS);
    handles.push(handle!);
    // The first pass is already in flight from the constructor; three more
    // requested at once must collapse into it rather than spawn three daemons.
    await Promise.all([handle!.tick(), handle!.tick(), handle!.tick()]);
    await waitUntil(() => handle!.stats().last !== undefined, "the one real pass", 15_000);
    track(readDaemonState(dir)?.pid);
    expect(readDaemonState(dir)?.state).toBe("running");
    // A second spawn would have read the first one's state file and counted a
    // restart, or failed to bind and written port-conflict.
    expect(readDaemonState(dir)?.restarts).toBe(0);
    expect(handle!.stats().runs).toBe(1);
  }, 30_000);

  it("stops cleanly and does nothing afterwards", async () => {
    const handle = startDaemonWatchdog(env(), 60_000, TEST_WAIT_MS);
    handles.push(handle!);
    await waitUntil(() => handle!.stats().last !== undefined, "the first pass", 15_000);
    track(readDaemonState(dir)?.pid);

    const before = handle!.stats().runs;
    handle!.stop();
    await handle!.tick();
    expect(handle!.stats().runs).toBe(before);
  }, 30_000);

  it("watches every ten seconds", () => {
    expect(WATCHDOG_INTERVAL_MS).toBe(10_000);
  });
});
