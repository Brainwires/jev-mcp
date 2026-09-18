/**
 * Starting, replacing and stopping the daemon.
 *
 * This is the part that has to be right when everything else is wrong: a stale
 * pid file, a half-dead daemon from last week's version, another program that
 * happened to bind port 10522, two Claude Code sessions starting in the same
 * second. `ensureDaemon` is called from three places (SessionStart, the MCP
 * watchdog, `/jev:daemon`) and has to be safe to call from all of them at once.
 *
 * The decision is made from evidence, in this order:
 *
 *   probe answers, `jev: true`   → mine. Same protocol and not older than my
 *                                  bundle? `running`. Otherwise replace it,
 *                                  which is how a plugin update takes effect.
 *   probe answers, not mine      → `conflict`. Never kill it: it is somebody
 *                                  else's process. Say so loudly instead.
 *   connects but never answers   → mine if the state file names a live pid
 *                                  (a hung daemon: kill and replace). Unknown
 *                                  otherwise, which is a `conflict` too.
 *   refused                      → spawn, under a lock, after a second probe.
 *
 * What it never does is spawn from inside a Bash-tool process. Those are
 * sandboxed on some platforms, and a daemon inheriting that sandbox would be a
 * daemon that cannot read the data directory. `/jev:daemon restart` therefore
 * only stops; the watchdog or the next SessionStart starts the replacement.
 */

import { spawn } from "node:child_process";
import { closeSync } from "node:fs";
import { connect } from "node:net";
import { request } from "node:http";
import type { Env } from "../config.js";
import { LOCK_STALE_MS, PROBE_TIMEOUT_MS, PROTOCOL, WAIT_MS } from "./protocol.js";
import {
  bundleIdentity,
  daemonLogPath,
  markStopped,
  openLog,
  readDaemonState,
  releaseLock,
  tryAcquireLock,
  writeDaemonState,
  type DaemonCounters,
  type DaemonState,
} from "./state-file.js";
import { emptyCounters } from "./state-file.js";
import { HOOK_VERSION } from "../version.js";

export interface Health {
  jev: true;
  pid: number;
  port: number;
  version: string;
  protocol: number;
  bundle_path: string;
  bundle_mtime: number;
  started_at: number;
  uptime_ms: number;
  sessions: number;
  auth: string;
  counters?: DaemonCounters;
}

export type Probe =
  | { kind: "jev"; health: Health }
  /** Answered HTTP, but it is not us. */
  | { kind: "foreign" }
  /** The TCP connection opened and nothing came back in time. */
  | { kind: "silent" }
  /** Nothing is listening. */
  | { kind: "refused" };

export type EnsureResult = "running" | "started" | "replaced" | "conflict" | "failed";

export interface EnsureOptions {
  dataDir: string;
  port: number;
  /** The `hook.mjs` to run as the daemon. Usually `process.argv[1]`. */
  bundlePath: string;
  /** Environment the daemon inherits. The caller decides what is in it. */
  env: Env;
  /** Node to run it with. Defaults to the one making the call. */
  nodePath?: string;
  /**
   * How long to wait for a port to free, or for a new daemon to answer.
   *
   * Defaults to 2 s, which is what fits inside SessionStart's 5 s budget with
   * room for the probe and the session registration. Raised only by the tests,
   * which run this under a machine load no real session sees and would
   * otherwise be measuring the CPU rather than the code.
   */
  waitMs?: number;
}

/** Does a process with this pid exist? `kill(pid, 0)` answers without signalling. */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else, which still counts.
    return (error as { code?: string }).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * `GET /v1/health`, with a hard deadline.
 *
 * Deliberately not `fetch`: this runs inside a SessionStart hook, where every
 * millisecond is on the user's clock, and `node:http` with an explicit socket
 * timeout is both faster to start and easier to bound than undici's pool.
 */
export function probeHealth(port: number, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<Probe> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (probe: Probe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(probe);
    };

    const req = request(
      { host: "127.0.0.1", port, path: "/v1/health", method: "GET", timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          // A health body is a few hundred bytes. Anything enormous is not us,
          // and reading it all would be a gift to whatever is on the port.
          if (size > 64 * 1024) {
            res.destroy();
            finish({ kind: "foreign" });
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            finish({ kind: "foreign" });
            return;
          }
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
            if (
              typeof parsed === "object" &&
              parsed !== null &&
              (parsed as { jev?: unknown }).jev === true &&
              typeof (parsed as { pid?: unknown }).pid === "number"
            ) {
              finish({ kind: "jev", health: parsed as Health });
              return;
            }
          } catch {
            // Not JSON: somebody else's server.
          }
          finish({ kind: "foreign" });
        });
        res.on("error", () => finish({ kind: "foreign" }));
      },
    );

    // `timeout` on the request options only covers socket inactivity, so the
    // whole probe gets its own timer as well.
    const timer = setTimeout(() => {
      req.destroy();
      finish({ kind: "silent" });
    }, timeoutMs + 50);

    req.on("timeout", () => {
      req.destroy();
      finish({ kind: "silent" });
    });
    req.on("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ECONNREFUSED" || error.code === "ECONNRESET" ? { kind: "refused" } : { kind: "silent" });
    });
    req.end();
  });
}

/** Is anything accepting connections on this port? */
function portBusy(port: number, timeoutMs = 200): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (busy: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(timeoutMs, () => finish(true));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitForPortFree(port: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!(await portBusy(port, 100))) return true;
    await sleep(50);
  }
  return !(await portBusy(port, 100));
}

async function waitForHealth(port: number, budgetMs: number): Promise<Health | undefined> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const probe = await probeHealth(port, PROBE_TIMEOUT_MS);
    if (probe.kind === "jev") return probe.health;
    if (Date.now() >= deadline) return undefined;
    await sleep(50);
  }
}

/**
 * Run `fn` holding `daemon.lock`, or return `undefined` if someone else has it.
 *
 * The waiting matters as much as the locking: two sessions starting together
 * must not both spawn, and the loser must not simply give up — it waits for the
 * winner, then re-probes and finds a healthy daemon. `undefined` means "the
 * lock never came free", which the caller reports as a failure rather than
 * silently spawning anyway.
 */
export async function withLock<T>(dataDir: string, fn: () => Promise<T>, waitMs = WAIT_MS + 500): Promise<T | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (tryAcquireLock(dataDir, Date.now(), isAlive, LOCK_STALE_MS)) {
      try {
        return await fn();
      } finally {
        releaseLock(dataDir);
      }
    }
    if (Date.now() >= deadline) return undefined;
    await sleep(50);
  }
}

/**
 * Start the daemon detached and wait for it to answer.
 *
 * `detached` plus `unref` is what makes it outlive the hook that started it;
 * stdio goes to `daemon.log` because a detached child with an inherited stdout
 * would write into the hook's stdout, which is protocol.
 *
 * The state file is written by the daemon itself, from inside its own process —
 * it knows its pid, and with `--port 0` it is the only one that knows the port.
 * This function only waits for it.
 */
async function spawnDaemon(options: EnsureOptions): Promise<boolean> {
  const logFd = openLog(options.dataDir);
  try {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.env)) {
      if (value !== undefined) env[key] = value;
    }
    env.JEV_DAEMON_PORT = String(options.port);
    env.CLAUDE_PLUGIN_DATA = options.dataDir;

    const child = spawn(
      options.nodePath ?? process.execPath,
      [options.bundlePath, "daemon", "--port", String(options.port)],
      {
        detached: true,
        stdio: ["ignore", logFd === -1 ? "ignore" : logFd, logFd === -1 ? "ignore" : logFd],
        windowsHide: true,
        env,
      },
    );
    child.on("error", () => undefined);
    child.unref();
  } catch {
    return false;
  } finally {
    if (logFd !== -1) {
      try {
        closeSync(logFd);
      } catch {
        // The child has its own descriptor now.
      }
    }
  }

  const budget = options.waitMs ?? WAIT_MS;

  // With `--port 0` the port is not known until the daemon says so, so a
  // caller that asked for 0 has to read `daemon.json` rather than probe.
  if (options.port === 0) {
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
      const state = readDaemonState(options.dataDir);
      if (state?.state === "running" && state.port > 0) return true;
      await sleep(50);
    }
    return false;
  }

  return (await waitForHealth(options.port, budget)) !== undefined;
}

/** SIGTERM, then SIGKILL if the port is still held. */
async function terminate(pid: number, port: number, budgetMs: number = WAIT_MS): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  if (await waitForPortFree(port, budgetMs)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  await waitForPortFree(port, 500);
}

/**
 * Wait for a pid to actually disappear.
 *
 * Separate from `waitForPortFree` because the daemon frees the port first and
 * exits second: it closes the listener so a replacement can bind, then drains,
 * then writes `stopped`, then exits. A caller that checked `isAlive` the moment
 * the port came free would call a clean shutdown a failure.
 */
async function waitForExit(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
  return true;
}

function recordConflict(options: EnsureOptions, previous: DaemonState | undefined): void {
  const bundle = bundleIdentity(options.bundlePath);
  const now = Date.now();
  writeDaemonState(options.dataDir, {
    pid: previous?.pid ?? process.pid,
    port: options.port,
    version: HOOK_VERSION,
    protocol: PROTOCOL,
    bundle_path: bundle.path,
    bundle_mtime: bundle.mtime,
    data_dir: options.dataDir,
    started_at: previous?.started_at ?? now,
    updated_at: now,
    state: "port-conflict",
    counters: previous?.counters ?? emptyCounters(),
    restarts: previous?.restarts ?? 0,
  });
}

/**
 * Kill whatever jev daemon is on the port and start ours.
 *
 * Also the answer to a 401 from `/v1/session/start`: a daemon that rejects our
 * key is a daemon configured for a different key, which is a stale daemon, not
 * an authorization problem to report to the user.
 */
export async function replaceDaemon(options: EnsureOptions): Promise<EnsureResult> {
  const probe = await probeHealth(options.port, PROBE_TIMEOUT_MS);
  if (probe.kind === "foreign") {
    recordConflict(options, readDaemonState(options.dataDir));
    return "conflict";
  }
  const previous = readDaemonState(options.dataDir);
  const pid = probe.kind === "jev" ? probe.health.pid : previous?.pid;
  const budget = options.waitMs ?? WAIT_MS;
  if (pid !== undefined && pid !== process.pid && isAlive(pid)) {
    await terminate(pid, options.port, budget);
  }
  const result = await withLock(
    options.dataDir,
    async () => ((await spawnDaemon(options)) ? ("replaced" as EnsureResult) : ("failed" as EnsureResult)),
    budget + 500,
  );
  return result ?? "failed";
}

/**
 * Make sure a current daemon is listening on `options.port`.
 *
 * Never throws: every caller is either a hook that must exit 0 or a watchdog
 * that must not disturb the MCP loop.
 */
export async function ensureDaemon(options: EnsureOptions): Promise<EnsureResult> {
  try {
    const budget = options.waitMs ?? WAIT_MS;
    const mine = bundleIdentity(options.bundlePath);
    const probe = await probeHealth(options.port, PROBE_TIMEOUT_MS);

    if (probe.kind === "jev") {
      const stale =
        probe.health.protocol !== PROTOCOL ||
        (mine.mtime > 0 && probe.health.bundle_mtime > 0 && probe.health.bundle_mtime < mine.mtime);
      if (!stale) return "running";
      return await replaceDaemon(options);
    }

    if (probe.kind === "foreign") {
      recordConflict(options, readDaemonState(options.dataDir));
      return "conflict";
    }

    const previous = readDaemonState(options.dataDir);

    if (probe.kind === "silent") {
      // Something holds the port and will not speak HTTP. If our own state file
      // names a live process, that is a hung daemon and killing it is right.
      // If it does not, we have no idea whose process it is, and guessing would
      // mean sending SIGTERM to a stranger.
      const pid = previous?.pid;
      if (
        previous !== undefined &&
        previous.state === "running" &&
        previous.port === options.port &&
        pid !== undefined &&
        pid !== process.pid &&
        isAlive(pid)
      ) {
        // One longer look before killing: a daemon under load can miss a 300 ms
        // probe, and 1 s more is cheap next to killing a working process.
        if ((await probeHealth(options.port, 1000)).kind === "jev") return "running";
        await terminate(pid, options.port, budget);
        const result = await withLock(
          options.dataDir,
          async () => ((await spawnDaemon(options)) ? ("replaced" as EnsureResult) : ("failed" as EnsureResult)),
          budget + 500,
        );
        return result ?? "failed";
      }
      recordConflict(options, previous);
      return "conflict";
    }

    // Refused: nothing there. A stale pid file is simply ignored — the port is
    // the authority on whether a daemon is running, not a file.
    const result = await withLock(
      options.dataDir,
      async () => {
        // Re-probe under the lock: while we waited for it, the process that
        // held it may have started the very daemon we were about to duplicate.
        const second = await probeHealth(options.port, PROBE_TIMEOUT_MS);
        if (second.kind === "jev") {
          const stale =
            second.health.protocol !== PROTOCOL ||
            (mine.mtime > 0 && second.health.bundle_mtime > 0 && second.health.bundle_mtime < mine.mtime);
          return stale ? undefined : ("running" as EnsureResult);
        }
        if (second.kind === "foreign") {
          recordConflict(options, previous);
          return "conflict" as EnsureResult;
        }
        return (await spawnDaemon(options)) ? ("started" as EnsureResult) : ("failed" as EnsureResult);
      },
      budget + 500,
    );

    if (result === undefined) {
      // Either the lock never came free, or the daemon under it was stale.
      const third = await probeHealth(options.port, PROBE_TIMEOUT_MS);
      if (third.kind === "jev") {
        const stale =
          third.health.protocol !== PROTOCOL ||
          (mine.mtime > 0 && third.health.bundle_mtime > 0 && third.health.bundle_mtime < mine.mtime);
        return stale ? await replaceDaemon(options) : "running";
      }
      return "failed";
    }
    return result;
  } catch {
    return "failed";
  }
}

export type StopResult = "stopped" | "not-running" | "failed";

/**
 * Stop the daemon on this port, if it is ours.
 *
 * Signals only: there is no shutdown endpoint, deliberately. An HTTP route that
 * kills the process is a route worth attacking, and a signal already requires
 * being the same user.
 */
export async function stopDaemon(dataDir: string, port: number, waitMs: number = WAIT_MS): Promise<StopResult> {
  const probe = await probeHealth(port, PROBE_TIMEOUT_MS);
  const state = readDaemonState(dataDir);
  const pid = probe.kind === "jev" ? probe.health.pid : state?.state === "running" ? state.pid : undefined;

  if (probe.kind === "foreign") return "not-running";
  if (pid === undefined || pid === process.pid || !isAlive(pid)) {
    if (state !== undefined && state.state === "running") markStopped(dataDir);
    return "not-running";
  }

  await terminate(pid, port, waitMs);
  if (!(await waitForExit(pid, waitMs))) return "failed";
  // The daemon writes `stopped` from its own SIGTERM handler; if it was killed
  // hard, say so here rather than leave the file claiming it is running.
  const after = readDaemonState(dataDir);
  if (after !== undefined && after.state === "running") markStopped(dataDir);
  return "stopped";
}

/** Where the daemon's stderr goes, for `/jev:daemon status`. */
export function logPathFor(dataDir: string): string {
  return daemonLogPath(dataDir);
}
