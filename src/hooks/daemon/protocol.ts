/**
 * Constants the daemon, its control plane and the hook config all need.
 *
 * They live in their own module for one boring reason: `config.ts` needs the
 * default port, and `server.ts` needs `Deps`, which comes from `types.ts`,
 * which comes from `config.ts`. Declaring the port in `server.ts` and importing
 * it into `config.ts` would close that loop, and a `const` read across an ESM
 * cycle can be in its temporal dead zone at the wrong moment. `server.ts`
 * re-exports `DEFAULT_PORT` and `PROTOCOL` so callers can keep importing them
 * from where the design says they live.
 */

/**
 * Loopback port. Fixed rather than configurable in practice: `hooks.json` can
 * interpolate environment variables into *headers* only, so the URL's port is a
 * literal in the manifest and `JEV_DAEMON_PORT` exists for tests and for a
 * hand-wired install.
 */
export const DEFAULT_PORT = 10522;

/**
 * Wire version. Bumped when the request or response shape changes in a way an
 * older daemon would get wrong; `ensureDaemon` replaces a daemon whose health
 * reports a different number, which is how a plugin update takes effect without
 * the user restarting anything.
 */
export const PROTOCOL = 1;

/** Largest hook payload accepted. A tool result can be big; 4 MB is not. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** No request for this long and the daemon exits rather than sit resident. */
export const DEFAULT_IDLE_MS = 30 * 60 * 1000;

/** After the last session ends, wait this long before exiting. */
export const LAST_SESSION_GRACE_MS = 60 * 1000;

/** How often the daemon rewrites `daemon.json`. */
export const HEARTBEAT_MS = 15 * 1000;

/** A `daemon.lock` older than this, or held by a dead pid, is stale. */
export const LOCK_STALE_MS = 30 * 1000;

/** Health probe budget. Short: this runs inside a SessionStart hook. */
export const PROBE_TIMEOUT_MS = 300;

/** How long `ensureDaemon` waits for a port to free, or for a new daemon. */
export const WAIT_MS = 2000;
