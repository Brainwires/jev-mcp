/**
 * `ensureDaemon` against real processes.
 *
 * Everything here spawns something: the shipped bundle, a server that speaks
 * HTML, a server that never answers, a health responder claiming to be an older
 * version. Mocking these would be mocking the exact thing that goes wrong — the
 * whole reason this code exists is that ports and pids lie.
 *
 * Every test uses a port it asked the OS for and a temp data directory, and
 * `afterEach` kills every pid the run touched.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ensureDaemon,
  isAlive,
  probeHealth,
  stopDaemon,
  withLock,
  type EnsureOptions,
} from "../../src/hooks/daemon/control.js";
import { PROTOCOL } from "../../src/hooks/daemon/protocol.js";
import {
  daemonLockPath,
  readDaemonState,
  writeDaemonState,
  emptyCounters,
  type DaemonState,
} from "../../src/hooks/daemon/state-file.js";
import {
  cleanupDir,
  FOREIGN_SERVER,
  freePort,
  HOOK_BUNDLE,
  killTracked,
  onReady,
  SILENT_SERVER,
  spawnScript,
  STALE_DAEMON,
  tempDataDir,
  TEST_WAIT_MS,
  track,
  trackStateFilePid,
  waitUntil,
} from "./daemon-helpers.js";

let dir: string;
let port: number;

beforeEach(async () => {
  dir = tempDataDir("jev-ctl-");
  port = await freePort();
});

afterEach(async () => {
  trackStateFilePid(dir);
  await killTracked();
  cleanupDir(dir);
});

function options(overrides: Partial<EnsureOptions> = {}): EnsureOptions {
  return {
    dataDir: dir,
    port,
    bundlePath: HOOK_BUNDLE,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      CLAUDE_PLUGIN_DATA: dir,
      JEV_DAEMON_PORT: String(port),
      // No key: the daemon runs unauthenticated, which keeps the tests free of
      // a live credential and exercises the mode a keyless install gets.
      JEV_HOOKS_DISABLE: "",
    },
    waitMs: TEST_WAIT_MS,
    ...overrides,
  };
}

function stateFor(overrides: Partial<DaemonState> = {}): DaemonState {
  return {
    pid: process.pid,
    port,
    version: "0.4.0",
    protocol: PROTOCOL,
    bundle_path: HOOK_BUNDLE,
    bundle_mtime: Date.now(),
    data_dir: dir,
    started_at: Date.now(),
    updated_at: Date.now(),
    state: "running",
    counters: emptyCounters(),
    restarts: 0,
    ...overrides,
  };
}

describe("isAlive", () => {
  it("knows about this process and not about an impossible pid", () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-1)).toBe(false);
    expect(isAlive(2 ** 30)).toBe(false);
  });
});

describe("probeHealth", () => {
  it("says refused when nothing is listening", async () => {
    expect((await probeHealth(port, 200)).kind).toBe("refused");
  });

  it("says foreign when something answers that is not jev", async () => {
    const child = spawnScript(dir, "foreign.mjs", FOREIGN_SERVER, [String(port)]);
    await onReady(child);
    expect((await probeHealth(port, 500)).kind).toBe("foreign");
  });

  it("says silent when the connection opens and nothing comes back", async () => {
    const child = spawnScript(dir, "silent.mjs", SILENT_SERVER, [String(port)]);
    await onReady(child);
    expect((await probeHealth(port, 200)).kind).toBe("silent");
  });
});

describe("ensureDaemon", () => {
  it("spawns one when the port is refused, and finds it running on the next call", async () => {
    expect(await ensureDaemon(options())).toBe("started");
    const state = readDaemonState(dir);
    expect(state?.state).toBe("running");
    expect(state?.port).toBe(port);
    expect(state?.restarts).toBe(0);
    track(state?.pid);
    expect(isAlive(state?.pid as number)).toBe(true);

    const probe = await probeHealth(port, 1000);
    expect(probe.kind).toBe("jev");

    expect(await ensureDaemon(options())).toBe("running");
  }, 30_000);

  it("ignores a stale pid file rather than trusting it", async () => {
    // The port is the authority on whether a daemon is running. A file claiming
    // a long-dead pid must not stop a spawn, and must not get anything killed.
    writeDaemonState(dir, stateFor({ pid: 2 ** 30, state: "running" }));
    expect(await ensureDaemon(options())).toBe("started");
    const state = readDaemonState(dir);
    track(state?.pid);
    expect(state?.pid).not.toBe(2 ** 30);
    // The spawn read the old file, so the restart counter moved on.
    expect(state?.restarts).toBe(1);
  }, 30_000);

  it("kills a wedged daemon its own state file vouches for, and replaces it", async () => {
    const child = spawnScript(dir, "silent.mjs", SILENT_SERVER, [String(port)]);
    await onReady(child);
    const hung = child.pid as number;
    writeDaemonState(dir, stateFor({ pid: hung, state: "running" }));

    expect(await ensureDaemon(options())).toBe("replaced");
    await waitUntil(() => !isAlive(hung), "the wedged process to die");

    const state = readDaemonState(dir);
    track(state?.pid);
    expect(state?.state).toBe("running");
    expect(state?.pid).not.toBe(hung);
    expect((await probeHealth(port, 1000)).kind).toBe("jev");
  }, 30_000);

  it("does not kill a silent process it cannot account for", async () => {
    // Same wedged port, but no state file naming the pid. Sending SIGTERM to an
    // unidentified process is not something a plugin gets to do.
    const child = spawnScript(dir, "silent.mjs", SILENT_SERVER, [String(port)]);
    await onReady(child);
    const stranger = child.pid as number;

    expect(await ensureDaemon(options())).toBe("conflict");
    expect(isAlive(stranger)).toBe(true);
    expect(readDaemonState(dir)?.state).toBe("port-conflict");
  }, 30_000);

  it("reports a conflict when a foreign server answers, and leaves it alone", async () => {
    const child = spawnScript(dir, "foreign.mjs", FOREIGN_SERVER, [String(port)]);
    await onReady(child);
    const stranger = child.pid as number;

    expect(await ensureDaemon(options())).toBe("conflict");
    expect(isAlive(stranger)).toBe(true);
    const state = readDaemonState(dir);
    expect(state?.state).toBe("port-conflict");
    expect(state?.port).toBe(port);
  }, 30_000);

  it("replaces a daemon whose bundle is older than ours", async () => {
    // This is the plugin-update path: the running daemon is last version's code.
    const child = spawnScript(dir, "stale.mjs", STALE_DAEMON, [String(port), String(PROTOCOL)]);
    await onReady(child);
    const old = child.pid as number;
    expect((await probeHealth(port, 1000)).kind).toBe("jev");

    expect(await ensureDaemon(options())).toBe("replaced");
    await waitUntil(() => !isAlive(old), "the old daemon to exit");

    const state = readDaemonState(dir);
    track(state?.pid);
    expect(state?.pid).not.toBe(old);
    const probe = await probeHealth(port, 1000);
    expect(probe.kind).toBe("jev");
    if (probe.kind === "jev") expect(probe.health.version).not.toBe("0.0.1");
  }, 30_000);

  it("replaces a daemon speaking a different protocol", async () => {
    const child = spawnScript(dir, "stale.mjs", STALE_DAEMON, [String(port), String(PROTOCOL + 1)]);
    await onReady(child);
    const old = child.pid as number;

    expect(await ensureDaemon(options())).toBe("replaced");
    await waitUntil(() => !isAlive(old), "the other-protocol daemon to exit");
    const probe = await probeHealth(port, 1000);
    expect(probe.kind).toBe("jev");
    if (probe.kind === "jev") expect(probe.health.protocol).toBe(PROTOCOL);
  }, 30_000);

  it("spawns exactly one daemon when two callers race", async () => {
    const [a, b] = await Promise.all([ensureDaemon(options()), ensureDaemon(options())]);
    const state = readDaemonState(dir);
    track(state?.pid);

    // One of them spawned; the other found it, either under the lock or on the
    // re-probe after waiting for it.
    expect([a, b].filter((result) => result === "started")).toHaveLength(1);
    expect([a, b].every((result) => result === "started" || result === "running")).toBe(true);

    expect(state?.state).toBe("running");
    expect((await probeHealth(port, 1000)).kind).toBe("jev");
    // A second daemon would have failed to bind and written port-conflict.
    expect(state?.restarts).toBe(0);
  }, 40_000);

  it("fails rather than throws when the bundle does not exist", async () => {
    const result = await ensureDaemon(options({ bundlePath: join(dir, "not-a-file.mjs") }));
    expect(result).toBe("failed");
  }, 30_000);
});

/**
 * A jev-shaped health responder with a current protocol, a fresh-looking
 * bundle, and an optional `key_fingerprints` list.
 *
 * Built here rather than added to `daemon-helpers.ts` because it is the only
 * test that needs to answer health with fingerprints.
 */
const FINGERPRINT_DAEMON = `
import { createServer } from "node:http";
const port = Number(process.argv[2]);
const protocol = Number(process.argv[3] ?? "1");
const mtime = Number(process.argv[4] ?? "1");
const fingerprints = process.argv[5] ?? "";
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
      bundle_mtime: mtime,
      started_at: Date.now(),
      uptime_ms: 1,
      sessions: 0,
      auth: "key",
      counters: {},
      ...(fingerprints === "" ? {} : { key_fingerprints: fingerprints.split(",") }),
    }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
process.on("SIGTERM", () => { server.close(); process.exit(0); });
server.listen(port, "127.0.0.1", () => process.stdout.write("ready\\n"));
`;

describe("key fingerprints in the staleness check", () => {
  it("replaces a daemon whose key_fingerprints do not include one of ours", async () => {
    // Current protocol, no older bundle: the fingerprints are the only reason
    // this daemon is stale.
    const child = spawnScript(
      dir,
      "fingerprint.mjs",
      FINGERPRINT_DAEMON,
      [String(port), String(PROTOCOL), String(Date.now()), "cafebabe"],
    );
    await onReady(child);
    const old = child.pid as number;

    expect(await ensureDaemon(options({ keyFingerprints: ["deadbeef"] }))).toBe("replaced");
    await waitUntil(() => !isAlive(old), "the daemon holding an unheld key to exit");
    const probe = await probeHealth(port, 1000);
    expect(probe.kind).toBe("jev");
  }, 30_000);

  it("does not replace a daemon whose health predates key_fingerprints", async () => {
    const child = spawnScript(
      dir,
      "fingerprint-plain.mjs",
      FINGERPRINT_DAEMON,
      [String(port), String(PROTOCOL), String(Date.now())],
    );
    await onReady(child);

    expect(await ensureDaemon(options({ keyFingerprints: ["deadbeef"] }))).toBe("running");
  }, 30_000);
});

describe("withLock", () => {
  it("runs the body and releases the lock", async () => {
    let ran = 0;
    const result = await withLock(dir, async () => {
      ran += 1;
      return "done";
    });
    expect(result).toBe("done");
    expect(ran).toBe(1);
    // Released: a second caller gets straight in.
    expect(await withLock(dir, async () => "again")).toBe("again");
  });

  it("releases the lock when the body throws", async () => {
    await expect(
      withLock(dir, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await withLock(dir, async () => "after")).toBe("after");
  });

  it("gives up rather than barging in when a live holder keeps it", async () => {
    // A lock held by this very process, which is certainly alive and certainly
    // not stale, so the waiter must time out instead of stealing it.
    writeFileSync(daemonLockPath(dir), `${process.pid} ${Date.now()}\n`, "utf8");
    const started = Date.now();
    expect(await withLock(dir, async () => "stolen", 120)).toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it("breaks a lock left behind by a dead process", async () => {
    writeFileSync(daemonLockPath(dir), `${2 ** 30} ${Date.now()}\n`, "utf8");
    expect(await withLock(dir, async () => "taken", 200)).toBe("taken");
  });

  it("breaks a lock that is simply too old", async () => {
    writeFileSync(daemonLockPath(dir), `${process.pid} ${Date.now() - 60_000}\n`, "utf8");
    expect(await withLock(dir, async () => "taken", 200)).toBe("taken");
  });

  it("breaks a lock whose contents are garbage", async () => {
    writeFileSync(daemonLockPath(dir), "not a pid at all\n", "utf8");
    expect(await withLock(dir, async () => "taken", 200)).toBe("taken");
  });
});

describe("stopDaemon", () => {
  it("stops a daemon it started and records it as stopped", async () => {
    expect(await ensureDaemon(options())).toBe("started");
    const pid = readDaemonState(dir)?.pid as number;
    track(pid);

    expect(await stopDaemon(dir, port)).toBe("stopped");
    await waitUntil(() => !isAlive(pid), "the daemon to exit");
    expect(readDaemonState(dir)?.state).toBe("stopped");
    expect((await probeHealth(port, 300)).kind).toBe("refused");
  }, 30_000);

  it("says not-running when there is nothing there", async () => {
    expect(await stopDaemon(dir, port)).toBe("not-running");
  });

  it("corrects a state file that claims a dead daemon is running", async () => {
    writeDaemonState(dir, stateFor({ pid: 2 ** 30, state: "running" }));
    expect(await stopDaemon(dir, port)).toBe("not-running");
    expect(readDaemonState(dir)?.state).toBe("stopped");
  });

  it("refuses to kill a foreign process on the port", async () => {
    const child = spawnScript(dir, "foreign.mjs", FOREIGN_SERVER, [String(port)]);
    await onReady(child);
    const stranger = child.pid as number;
    expect(await stopDaemon(dir, port)).toBe("not-running");
    expect(isAlive(stranger)).toBe(true);
  }, 30_000);
});

describe("restarts", () => {
  it("counts a respawn after a kill", async () => {
    expect(await ensureDaemon(options())).toBe("started");
    const first = readDaemonState(dir);
    track(first?.pid);
    expect(first?.restarts).toBe(0);

    expect(await stopDaemon(dir, port)).toBe("stopped");
    await waitUntil(() => !isAlive(first?.pid as number), "the first daemon to exit");

    expect(await ensureDaemon(options())).toBe("started");
    const second = readDaemonState(dir);
    track(second?.pid);
    expect(second?.restarts).toBe(1);
    expect(second?.pid).not.toBe(first?.pid);
  }, 40_000);
});
