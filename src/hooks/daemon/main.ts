/**
 * `node hook.mjs daemon` — the long-lived half of the plugin.
 *
 * Same bundle as the hooks, a different argv. That is not a saving on build
 * time, it is the guarantee the whole release rests on: there is exactly one
 * copy of every handler, so the daemon path and the command path cannot drift.
 *
 * What this file owns is everything the handlers do not: one Jev client for the
 * life of the process (so TLS and the connection pool are paid for once), the
 * memo and the concurrency limit in front of it, the session registry, the
 * heartbeat, and a shutdown that frees the port before it drains.
 *
 * Nothing here writes to stdout. The daemon's stdio is redirected into
 * `daemon.log` by whoever spawned it, and a stray `console.log` in a detached
 * process is how you end up with a 400 MB log file.
 */

import { JevDecisionModel } from "../../jev/client.js";
import type { DecisionModel } from "../../decision/types.js";
import { loadHookConfig, type Env, type HookConfig } from "../config.js";
import { expectedKeysFrom } from "./auth.js";
import { LimitedModel, MemoizedModel } from "../memo.js";
import { Store } from "../store.js";
import type { Deps } from "../types.js";
import { HOOK_VERSION } from "../version.js";
import { HEARTBEAT_MS, PROTOCOL } from "./protocol.js";
import { hookConfigFrom, readSessionConfig, sessionConfigOf, SessionRegistry } from "./registry.js";
import { startDaemon, type DaemonHandle } from "./server.js";
import {
  bundleIdentity,
  emptyCounters,
  readDaemonState,
  writeDaemonState,
  type DaemonCounters,
  type DaemonState,
} from "./state-file.js";

/** How long the daemon gives in-flight work after the listener closes. */
const DRAIN_MS = 3500;

/** `--port <n>`, if it is there and usable. */
export function parsePort(argv: readonly string[]): number | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const inline = /^--port=(.*)$/.exec(arg);
    const raw = inline !== null ? inline[1] : arg === "--port" ? argv[i + 1] : undefined;
    if (raw === undefined) continue;
    const value = Number(raw);
    if (Number.isInteger(value) && value >= 0 && value <= 65_535) return value;
  }
  return undefined;
}

/**
 * The model stack.
 *
 * Memo outside the limiter on purpose: a hit must not queue behind four real
 * calls to return a result that is already in memory.
 */
export function buildDaemonModel(config: HookConfig): {
  model: DecisionModel | null;
  memo: MemoizedModel | undefined;
} {
  if (config.apiKey === null) return { model: null, memo: undefined };
  const client = new JevDecisionModel({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
  });
  const memo = new MemoizedModel(new LimitedModel(client));
  return { model: memo, memo };
}

/**
 * Build the `Deps` for one session.
 *
 * Three sources, in order: the registry (this session said hello), the session
 * file on disk (it said hello to a daemon that has since been replaced), and
 * this daemon's own environment (a session that never said anything, which is
 * what a bare `curl` looks like).
 *
 * The middle case is the one worth having. A plugin update replaces the daemon
 * mid-session, and without it every session in flight would be judged with
 * whatever settings the *new* daemon's environment happened to hold.
 */
export function makeDepsFor(
  config: HookConfig,
  model: DecisionModel | null,
  registry: SessionRegistry,
): (sessionId: string) => Deps {
  const own = sessionConfigOf(config);
  const stores = new Map<string, Store>();
  const storeFor = (dir: string): Store => {
    const existing = stores.get(dir);
    if (existing !== undefined) return existing;
    const store = new Store(dir);
    stores.set(dir, store);
    return store;
  };

  return (sessionId: string): Deps => {
    const entry = registry.get(sessionId);
    if (entry !== undefined) {
      return {
        model,
        config: hookConfigFrom(entry.config, config.apiKey, entry.dataDir),
        store: storeFor(entry.dataDir),
        now: () => Date.now(),
      };
    }

    // Unknown session: try the snapshot the session file kept, then give up and
    // use our own. Reading it also re-registers the session, so the next hook
    // on it does not pay for the file read.
    const store = storeFor(config.dataDir);
    const persisted = readSessionConfig(store.readSession(sessionId).config, own);
    if (persisted !== undefined) {
      registry.start(sessionId, config.dataDir, persisted);
      return {
        model,
        config: hookConfigFrom(persisted, config.apiKey, config.dataDir),
        store,
        now: () => Date.now(),
      };
    }

    return { model, config, store, now: () => Date.now() };
  };
}

function stateFrom(
  config: HookConfig,
  handle: DaemonHandle,
  counters: DaemonCounters,
  restarts: number,
  run: DaemonState["state"],
): DaemonState {
  const bundle = bundleIdentity();
  return {
    pid: process.pid,
    port: handle.port,
    version: HOOK_VERSION,
    protocol: PROTOCOL,
    bundle_path: bundle.path,
    bundle_mtime: bundle.mtime,
    data_dir: config.dataDir,
    started_at: handle.startedAt,
    updated_at: Date.now(),
    state: run,
    counters,
    restarts,
  };
}

/**
 * What the model wrappers know that the server cannot.
 *
 * The server never makes a Jev call — a handler does — so it has no way to
 * count them. The memo does, because every call goes through it: a miss is a
 * call that went out, a hit is one that did not, and an error it saw on the way
 * back is an error. Handed to `startDaemon` so `/v1/health` and the state file
 * report the same numbers rather than two different halves of the truth.
 */
function modelStatsOf(memo: MemoizedModel | undefined): (() => Partial<DaemonCounters>) | undefined {
  if (memo === undefined) return undefined;
  return (): Partial<DaemonCounters> => {
    const stats = memo.stats();
    return {
      jev_calls: stats.misses,
      memo_hits: stats.hits,
      jev_timeouts: stats.timeouts,
      jev_errors: stats.errors,
    };
  };
}

export async function runDaemon(argv: readonly string[], env: Env): Promise<void> {
  const config = loadHookConfig(env);
  const port = parsePort(argv) ?? config.daemonPort;
  const previous = readDaemonState(config.dataDir);
  const restarts = previous === undefined ? 0 : previous.restarts + 1;

  const { model, memo } = buildDaemonModel(config);
  const modelStats = modelStatsOf(memo);
  const registry = new SessionRegistry();
  const depsFor = makeDepsFor(config, model, registry);

  let stopping = false;
  let handle: DaemonHandle | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const shutdown = (reason: string): void => {
    if (stopping) return;
    stopping = true;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    void (async (): Promise<void> => {
      if (handle !== undefined) {
        // `close()` stops the listener first, so a replacement can bind the
        // port while this one is still finishing what it started.
        await Promise.race([handle.close(), new Promise((resolve) => setTimeout(resolve, DRAIN_MS))]);
        writeDaemonState(config.dataDir, stateFrom(config, handle, handle.stats(), restarts, "stopped"));
      }
      process.stderr.write(`[jev-daemon] stopped (${reason})\n`);
      process.exit(0);
    })();
  };

  // Every key the environment holds, not only the one `loadHookConfig` picked:
  // the hooks interpolate both the plugin option and the shell's key.
  const keys = expectedKeysFrom(env);
  try {
    handle = await startDaemon({
      port,
      expectedKeys: keys,
      depsFor,
      registry,
      idleMs: config.daemonIdleMs,
      onExitRequested: () => shutdown("idle"),
      ...(modelStats !== undefined ? { modelStats } : {}),
    });
  } catch (error) {
    // The usual cause is something else on the port. Record it so
    // `/jev:status` can say so, and leave: a daemon that cannot listen has
    // nothing to offer, and the hooks fail open without it.
    const code = (error as { code?: string }).code;
    const bundle = bundleIdentity();
    writeDaemonState(config.dataDir, {
      pid: process.pid,
      port,
      version: HOOK_VERSION,
      protocol: PROTOCOL,
      bundle_path: bundle.path,
      bundle_mtime: bundle.mtime,
      data_dir: config.dataDir,
      started_at: Date.now(),
      updated_at: Date.now(),
      state: code === "EADDRINUSE" ? "port-conflict" : "stopped",
      counters: emptyCounters(),
      restarts,
    });
    process.stderr.write(`[jev-daemon] cannot listen on 127.0.0.1:${port}: ${String(code ?? error)}\n`);
    process.exit(0);
  }

  const live = handle;
  writeDaemonState(config.dataDir, stateFrom(config, live, live.stats(), restarts, "running"));

  heartbeat = setInterval(() => {
    writeDaemonState(config.dataDir, stateFrom(config, live, live.stats(), restarts, "running"));
  }, HEARTBEAT_MS);
  // Do not hold the loop open on the heartbeat alone: the listener is what
  // keeps this process alive, and it should be the only thing that does.
  heartbeat.unref();

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  // A crash in a detached process with nobody watching is still better spent
  // writing `stopped` than leaving a state file that claims to be running.
  process.on("uncaughtException", (error) => {
    process.stderr.write(`[jev-daemon] uncaught: ${String(error)}\n`);
    shutdown("uncaught");
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`[jev-daemon] unhandled rejection: ${String(reason)}\n`);
  });

  process.stderr.write(
    `[jev-daemon] v${HOOK_VERSION} protocol ${PROTOCOL} listening on 127.0.0.1:${live.port}, ` +
      `data ${config.dataDir}, auth ${keys.length === 0 ? "none" : `${keys.length} key${keys.length === 1 ? "" : "s"}`}, ` +
      `restarts ${restarts}\n`,
  );
}
