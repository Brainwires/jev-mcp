/**
 * The three files the daemon leaves in the data directory.
 *
 * `daemon.json`  — what is running, rewritten every 15 s and once on exit.
 * `daemon.lock`  — an `O_EXCL` file so two SessionStarts cannot both spawn.
 * `daemon.log`   — the daemon's stderr, truncated when it starts.
 *
 * Disk stays the source of truth, deliberately. `/jev:status` runs through the
 * Bash tool, which on some setups cannot open a loopback socket at all, and a
 * report that says "down" because *it* could not reach the port would be
 * lying. So everything a person might want to know is on disk, and the live
 * probe is a second opinion the report labels as such.
 *
 * Every function here swallows its own I/O errors. A daemon that cannot write
 * its heartbeat still has hooks to serve.
 */

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { statSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL } from "./protocol.js";

export type DaemonRunState = "running" | "stopped" | "port-conflict";

/**
 * What the daemon has done since it started.
 *
 * Counted rather than derived from the decision log because most of these
 * never reach the log: a 401, an unknown event, a request that arrived while
 * the gate was off. "How many hooks did this thing actually serve" is the first
 * question anyone asks of a daemon, and it should not require a log parse.
 */
export interface DaemonCounters {
  /** Requests served, by event name. */
  hooks: Record<string, number>;
  sessions_started: number;
  sessions_ended: number;
  jev_calls: number;
  jev_timeouts: number;
  jev_errors: number;
  memo_hits: number;
  unauthorized: number;
  protocol_mismatch: number;
  unknown_event: number;
  bad_request: number;
  oversize: number;
  /** Handlers that hit the wall clock and answered `{}` instead. */
  deadline_overruns: number;
  /** Exceptions the request handler caught and answered 500 for. */
  errors: number;
}

export function emptyCounters(): DaemonCounters {
  return {
    hooks: {},
    sessions_started: 0,
    sessions_ended: 0,
    jev_calls: 0,
    jev_timeouts: 0,
    jev_errors: 0,
    memo_hits: 0,
    unauthorized: 0,
    protocol_mismatch: 0,
    unknown_event: 0,
    bad_request: 0,
    oversize: 0,
    deadline_overruns: 0,
    errors: 0,
  };
}

export interface DaemonState {
  pid: number;
  port: number;
  version: string;
  protocol: number;
  /** The bundle this daemon is running, and its mtime at startup. */
  bundle_path: string;
  bundle_mtime: number;
  data_dir: string;
  started_at: number;
  updated_at: number;
  state: DaemonRunState;
  counters: DaemonCounters;
  /**
   * How many times a daemon has been started in this data directory. 0 is the
   * first ever; a respawn after a kill reads the old file and adds one, which
   * is what makes "restarts" in `/jev:status` mean something.
   */
  restarts: number;
}

export function daemonStatePath(dataDir: string): string {
  return join(dataDir, "daemon.json");
}

export function daemonLockPath(dataDir: string): string {
  return join(dataDir, "daemon.lock");
}

export function daemonLogPath(dataDir: string): string {
  return join(dataDir, "daemon.log");
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function readCounters(raw: unknown): DaemonCounters {
  const base = emptyCounters();
  if (typeof raw !== "object" || raw === null) return base;
  const value = raw as Record<string, unknown>;
  const hooks: Record<string, number> = {};
  if (typeof value.hooks === "object" && value.hooks !== null) {
    for (const [event, count] of Object.entries(value.hooks as Record<string, unknown>)) {
      if (typeof count === "number" && Number.isFinite(count) && count >= 0) hooks[event] = Math.floor(count);
    }
  }
  const counters: DaemonCounters = { ...base, hooks };
  for (const key of Object.keys(base) as (keyof DaemonCounters)[]) {
    if (key === "hooks") continue;
    const count = value[key];
    if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
      counters[key] = Math.floor(count) as never;
    }
  }
  return counters;
}

/**
 * Read `daemon.json`, validating every field.
 *
 * The pid in this file is passed to `kill`, so it is checked hard: a
 * non-integer, a zero, or a negative number (which on POSIX would signal a
 * *process group*) is not repaired, it makes the whole file unusable.
 */
export function readDaemonState(dataDir: string): DaemonState | undefined {
  return safe(() => {
    const parsed = JSON.parse(readFileSync(daemonStatePath(dataDir), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const value = parsed as Record<string, unknown>;
    const pid = value.pid;
    const port = value.port;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return undefined;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65_535) return undefined;
    const runState = value.state;
    return {
      pid,
      port,
      version: typeof value.version === "string" ? value.version : "unknown",
      protocol: typeof value.protocol === "number" ? value.protocol : PROTOCOL,
      bundle_path: typeof value.bundle_path === "string" ? value.bundle_path : "",
      bundle_mtime: typeof value.bundle_mtime === "number" ? value.bundle_mtime : 0,
      data_dir: typeof value.data_dir === "string" ? value.data_dir : dataDir,
      started_at: typeof value.started_at === "number" ? value.started_at : 0,
      updated_at: typeof value.updated_at === "number" ? value.updated_at : 0,
      state:
        runState === "running" || runState === "stopped" || runState === "port-conflict"
          ? runState
          : "stopped",
      counters: readCounters(value.counters),
      restarts: typeof value.restarts === "number" && value.restarts >= 0 ? Math.floor(value.restarts) : 0,
    } satisfies DaemonState;
  }, undefined);
}

/**
 * Write `daemon.json` atomically.
 *
 * Rename rather than truncate-and-write: `/jev:status` and `ensureDaemon` both
 * read this file at arbitrary moments, and a half-written heartbeat would read
 * as a corrupt file and be discarded — which, for `ensureDaemon`, means
 * spawning a second daemon.
 */
export function writeDaemonState(dataDir: string, state: DaemonState): void {
  safe(() => mkdirSync(dataDir, { recursive: true }), undefined);
  safe(() => {
    const temp = `${daemonStatePath(dataDir)}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state)}\n`, "utf8");
    renameSync(temp, daemonStatePath(dataDir));
  }, undefined);
}

/** Mark whatever the state file describes as no longer running. */
export function markStopped(dataDir: string, runState: DaemonRunState = "stopped", now = Date.now()): void {
  const state = readDaemonState(dataDir);
  if (state === undefined) return;
  writeDaemonState(dataDir, { ...state, state: runState, updated_at: now });
}

/** The bundle this process was started from, and its mtime. */
export function bundleIdentity(scriptPath: string | undefined = process.argv[1]): {
  path: string;
  mtime: number;
} {
  const path = scriptPath ?? "";
  return { path, mtime: safe(() => Math.floor(statSync(path).mtimeMs), 0) };
}

/**
 * Take `daemon.lock`, or say who has it.
 *
 * `O_EXCL` is the whole mechanism: it either creates the file or fails, with no
 * window between the check and the create. The contents are `<pid> <ms>` so a
 * lock left behind by a process that was killed mid-spawn can be recognized as
 * stale — by a dead pid, or by age — instead of blocking every future session.
 */
export function tryAcquireLock(dataDir: string, now: number, isAlive: (pid: number) => boolean, staleMs: number): boolean {
  safe(() => mkdirSync(dataDir, { recursive: true }), undefined);
  const path = daemonLockPath(dataDir);
  try {
    const fd = openSync(path, "wx");
    try {
      writeFileSync(fd, `${process.pid} ${now}\n`, "utf8");
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    // Held. Work out whether the holder is still alive.
    const raw = safe(() => readFileSync(path, "utf8"), "");
    const [pidText, tsText] = raw.trim().split(/\s+/);
    const pid = Number(pidText);
    const ts = Number(tsText);
    const dead = !Number.isInteger(pid) || pid <= 1 || !isAlive(pid);
    const old = !Number.isFinite(ts) || now - ts > staleMs;
    if (dead || old) {
      safe(() => unlinkSync(path), undefined);
      return safe(() => {
        const fd = openSync(path, "wx");
        try {
          writeFileSync(fd, `${process.pid} ${now}\n`, "utf8");
        } finally {
          closeSync(fd);
        }
        return true;
      }, false);
    }
    return false;
  }
}

export function releaseLock(dataDir: string): void {
  safe(() => unlinkSync(daemonLockPath(dataDir)), undefined);
}

/** Open `daemon.log` for writing, truncating it. Returns -1 if it cannot. */
export function openLog(dataDir: string): number {
  safe(() => mkdirSync(dataDir, { recursive: true }), undefined);
  return safe(() => openSync(daemonLogPath(dataDir), "w"), -1);
}
