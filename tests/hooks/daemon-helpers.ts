/**
 * Rig for the tests that spawn real processes.
 *
 * Two rules, both non-negotiable:
 *
 * 1. **Never the real port.** Every test picks an ephemeral one. A test that
 *    bound 10522 would fight the developer's own running daemon, and one that
 *    killed it would change the behaviour of the session running the test.
 * 2. **Never leave a process behind.** Every pid this module hands out is
 *    tracked, and `killTracked` in an `afterEach` kills it. A leaked detached
 *    daemon holding a port is the most annoying possible test failure, because
 *    it fails the *next* run.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeHealth } from "../../src/hooks/daemon/control.js";
import { readDaemonState } from "../../src/hooks/daemon/state-file.js";

export const HOOK_BUNDLE = new URL("../../plugin/dist/hook.mjs", import.meta.url).pathname;

/**
 * How long a test lets `ensureDaemon` wait for a spawn.
 *
 * Production uses 2 s, which is what fits inside SessionStart's 5 s budget. The
 * full suite runs forty files in parallel and can take longer than that just to
 * start a Node process, so these tests would otherwise measure the machine.
 * Raised here rather than in the product: a real session should give up at 2 s
 * and fail open, which is the behaviour the e2e tests exercise through the real
 * bundle without this override.
 */
export const TEST_WAIT_MS = 10_000;

/**
 * An ephemeral port nobody is using.
 *
 * Bind-then-release, which is racy in principle. In practice the OS hands out
 * ports in sequence and a test suite is the only thing asking, so the window is
 * theoretical; the alternative — a fixed range — collides between the two
 * concurrent `daemon-e2e` runs CI does on purpose.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      usedPorts.add(port);
      server.close(() => resolve(port));
    });
  });
}

/** Every port a test in this file asked for, for the cleanup sweep. */
const usedPorts = new Set<number>();

const tracked = new Set<number>();
const children = new Set<ChildProcess>();

/**
 * Remember a pid to kill afterwards.
 *
 * Refuses this process and its parent, which is not paranoia: a `port-conflict`
 * state file records the pid of whatever *detected* the conflict, which is the
 * test worker, and an earlier version of this helper cheerfully SIGKILLed the
 * vitest worker running it. A test rig that can kill its own runner is a test
 * rig that reports "Channel closed" instead of a failure.
 */
export function track(pid: number | undefined): void {
  if (pid === undefined || pid <= 1) return;
  if (pid === process.pid || pid === process.ppid) return;
  tracked.add(pid);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill any jev daemon answering on a port this file asked for.
 *
 * The pid list is not enough on its own. `ensureDaemon` spawns a *detached*
 * process and gives up waiting after its budget, so a daemon that came up a
 * moment after the test finished was never recorded — and then it sits there
 * holding a port until its 30-minute idle timer, which is exactly the "left a
 * process behind" failure the suite must not have.
 *
 * The identification is deliberately strict: only a process that answers
 * `/v1/health` with `jev: true`, on a port this file chose, and names its own
 * pid. Nothing else is ever signalled.
 */
async function sweepPorts(): Promise<void> {
  for (const port of usedPorts) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const probe = await probeHealth(port, 300);
      if (probe.kind !== "jev") break;
      const pid = probe.health.pid;
      if (pid === process.pid || pid === process.ppid || pid <= 1) break;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  usedPorts.clear();
}

/** Kill everything this module started, and everything a test named. */
export async function killTracked(): Promise<void> {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
  children.clear();

  for (const pid of tracked) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline && [...tracked].some((pid) => alive(pid))) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  for (const pid of tracked) {
    if (alive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  tracked.clear();

  // Last resort: anything that still answers as a jev daemon on a port this
  // file picked is ours and was missed.
  await sweepPorts();
}

/**
 * Track the daemon `daemon.json` in this directory names, whoever started it.
 *
 * Only when the file says `running`: a `port-conflict` or `stopped` record's
 * pid is not a daemon of ours to kill.
 */
export function trackStateFilePid(dataDir: string): void {
  const state = readDaemonState(dataDir);
  if (state?.state === "running") track(state.pid);
}

export function tempDataDir(prefix = "jev-daemon-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Run a throwaway script as a detached child, tracked for cleanup.
 *
 * Written to a file rather than passed with `-e` so a failure shows a real
 * stack with a real path, and so the scripts below can be read as code.
 */
export function spawnScript(dir: string, name: string, source: string, args: string[] = []): ChildProcess {
  const path = join(dir, name);
  writeFileSync(path, source, "utf8");
  const child = spawn(process.execPath, [path, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  track(child.pid);
  return child;
}

/** Wait until `predicate` is true, or fail with a message that says what it wanted. */
export async function waitUntil(predicate: () => boolean | Promise<boolean>, what: string, budgetMs = 5000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${budgetMs} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** An HTTP server that answers everything with the given status and body. */
export const FOREIGN_SERVER = `
import { createServer } from "node:http";
const port = Number(process.argv[2]);
createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html><body>not a jev daemon</body></html>");
}).listen(port, "127.0.0.1", () => process.stdout.write("ready\\n"));
`;

/** A TCP server that accepts connections and never answers. A wedged daemon. */
export const SILENT_SERVER = `
import { createServer } from "node:net";
const port = Number(process.argv[2]);
createServer((socket) => {
  // Hold the connection open and say nothing at all.
  socket.on("error", () => {});
}).listen(port, "127.0.0.1", () => process.stdout.write("ready\\n"));
`;

/**
 * A jev-shaped health responder whose bundle looks older than ours.
 *
 * This is the plugin-update case: the daemon on the port is a previous version,
 * so `ensureDaemon` has to kill it rather than trust it. It reports its own pid
 * so the kill lands on this process and frees the port.
 */
export const STALE_DAEMON = `
import { createServer } from "node:http";
const port = Number(process.argv[2]);
const protocol = Number(process.argv[3] ?? "1");
const server = createServer((req, res) => {
  if (req.url === "/v1/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      jev: true,
      pid: process.pid,
      port,
      version: "0.0.1",
      protocol,
      bundle_path: "/nowhere/hook.mjs",
      bundle_mtime: 1,
      started_at: Date.now(),
      uptime_ms: 1,
      sessions: 0,
      auth: "none",
      counters: {},
    }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
process.on("SIGTERM", () => { server.close(); process.exit(0); });
server.listen(port, "127.0.0.1", () => process.stdout.write("ready\\n"));
`;

export function onReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("helper process never said ready")), 5000);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (String(chunk).includes("ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
