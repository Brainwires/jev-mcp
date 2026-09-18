/**
 * On-disk state for the hooks: one small JSON file per session, plus an
 * append-only decision log.
 *
 * Everything here is best-effort. A hook that cannot write its bookkeeping
 * still has to let the session proceed, so every method swallows its own I/O
 * errors rather than propagating them into the handler.
 *
 * The session file exists because a hook fires with a tool call, not with the
 * user's request. `transcript_path` is documented as "conversation JSON" with
 * no schema and is written asynchronously, so parsing it would be guessing at a
 * private format; the UserPromptSubmit hook records the prompt instead and
 * every other handler reads it from here.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { VERIFICATION_KINDS, type VerificationLedger } from "./verification.js";

/** Maximum substantive prompts kept per session, oldest first. */
export const MAX_PROMPTS = 3;
export const MAX_PROMPT_CHARS = 2000;
/**
 * Below this a prompt is a continuation — "go", "ship both", "try it now". It
 * is kept, because "make it public" is an authorization the gate should see,
 * but it carries almost no scope and must not evict the request it continues.
 */
export const SHORT_PROMPT_CHARS = 40;
export const MAX_SHORT_PROMPTS = 2;

/** Append a prompt, trimming short and substantive prompts separately. Order is preserved. */
export function nextPrompts(existing: readonly string[], prompt: string): string[] {
  const text = prompt.trim();
  if (text === "") return [...existing];
  const all = [...existing, text];
  const isShort = (p: string): boolean => p.length < SHORT_PROMPT_CHARS;
  let short = all.filter(isShort).length;
  let long = all.length - short;
  return all.filter((p) => {
    if (isShort(p)) {
      if (short > MAX_SHORT_PROMPTS) {
        short -= 1;
        return false;
      }
      return true;
    }
    if (long > MAX_PROMPTS) {
      long -= 1;
      return false;
    }
    return true;
  });
}

/**
 * The user's request as one string within `max` characters. The budget is
 * filled from the newest prompt backwards, so what gets cut is the oldest
 * context and never the instruction the user just gave.
 */
export function requestText(prompts: readonly string[], max: number, separator = "\n---\n"): string {
  const kept: string[] = [];
  let used = 0;
  for (let i = prompts.length - 1; i >= 0; i -= 1) {
    const prompt = prompts[i] as string;
    const cost = prompt.length + (kept.length > 0 ? separator.length : 0);
    if (used + cost > max) {
      if (kept.length === 0) kept.unshift(prompt.slice(0, max));
      break;
    }
    kept.unshift(prompt);
    used += cost;
  }
  return kept.join(separator);
}
/** Rotate the decision log at this size. One generation is kept. */
export const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
/** Session files older than this are pruned. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Pending `ask` correlations kept per session. */
const MAX_PENDING = 20;

export interface PendingAsk {
  tool_use_id: string;
  ts: number;
  tool_name: string;
}

export interface SessionState {
  /** Last few user prompts, oldest first, each truncated. */
  prompts: string[];
  /** Stop blocks issued since the last user prompt. */
  stop_blocks: number;
  /** `/jev:off` for this session. */
  disabled?: boolean;
  /** Tool calls this plugin escalated to `ask`, awaiting a PostToolUse. */
  pending_asks?: PendingAsk[];
  /** SessionStart already told the user the key is missing. */
  key_warned?: boolean;
  /**
   * What the last test/build/type-check/lint run established, and how many
   * edits have happened since. Deliberately NOT reset by a new user prompt:
   * a failing test suite is still failing after the user types something.
   */
  verification?: VerificationLedger;
  /** Epoch ms of the last write, for pruning. */
  updated?: number;
}

export const EMPTY_SESSION: SessionState = { prompts: [], stop_blocks: 0 };

export interface DecisionRecord {
  ts: string;
  session_id: string;
  event: string;
  tool_name?: string;
  tool_use_id?: string;
  /** Redacted, <= 300 chars. */
  subject?: string;
  prefilter?: string;
  signals?: Record<string, number>;
  /** Policy options in force, so `/jev:calibrate` can replay the decision. */
  policy?: {
    ignore_scope: boolean;
    uncertain: string;
    lenient_scope?: boolean;
    trust_requested?: boolean;
    corroborate_uncertain?: boolean;
  };
  decision: string;
  reasons?: string[];
  model?: string;
  latency_ms?: number;
  input_tokens?: number;
  error?: string;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Validate a ledger read back off disk.
 *
 * The session file is state this plugin wrote, but it is still a file on disk
 * that anything could have edited, and `last.kind` reaches a user-visible
 * message. Anything unrecognized is dropped rather than repaired.
 */
function readLedger(raw: unknown): VerificationLedger | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Partial<VerificationLedger>;
  const ledger: VerificationLedger = {
    edits_since: typeof value.edits_since === "number" && value.edits_since >= 0 ? Math.floor(value.edits_since) : 0,
  };
  const last = value.last;
  if (
    typeof last === "object" &&
    last !== null &&
    (VERIFICATION_KINDS as readonly string[]).includes(last.kind) &&
    typeof last.ok === "boolean" &&
    typeof last.ts === "number" &&
    typeof last.command === "string"
  ) {
    ledger.last = { kind: last.kind, ok: last.ok, ts: last.ts, command: last.command };
  }
  return ledger;
}

/** Session ids arrive from the harness; never let one escape the data dir. */
export function safeSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 120);
  return cleaned === "" ? "unknown" : cleaned;
}

export class Store {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private ensureDir(sub?: string): string {
    const target = sub === undefined ? this.dir : join(this.dir, sub);
    safe(() => mkdirSync(target, { recursive: true }), undefined);
    return target;
  }

  private sessionPath(sessionId: string): string {
    return join(this.dir, "sessions", `${safeSessionId(sessionId)}.json`);
  }

  get logPath(): string {
    return join(this.dir, "decisions.jsonl");
  }

  /** The `/jev:off` fallback when a command cannot learn the session id. */
  get globalDisablePath(): string {
    return join(this.dir, "disabled");
  }

  readSession(sessionId: string): SessionState {
    return safe(() => {
      const raw = readFileSync(this.sessionPath(sessionId), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null) return { ...EMPTY_SESSION };
      const state = parsed as Partial<SessionState>;
      const session: SessionState = {
        prompts: Array.isArray(state.prompts) ? state.prompts.filter((p) => typeof p === "string") : [],
        stop_blocks: typeof state.stop_blocks === "number" ? state.stop_blocks : 0,
      };
      if (state.disabled === true) session.disabled = true;
      if (state.key_warned === true) session.key_warned = true;
      if (Array.isArray(state.pending_asks)) {
        session.pending_asks = state.pending_asks.filter(
          (p): p is PendingAsk => typeof p === "object" && p !== null && typeof p.tool_use_id === "string",
        );
      }
      if (typeof state.updated === "number") session.updated = state.updated;
      const ledger = readLedger(state.verification);
      if (ledger !== undefined) session.verification = ledger;
      return session;
    }, { ...EMPTY_SESSION });
  }

  writeSession(sessionId: string, state: SessionState, now: number = Date.now()): void {
    this.ensureDir("sessions");
    safe(() => {
      writeFileSync(this.sessionPath(sessionId), `${JSON.stringify({ ...state, updated: now })}\n`, "utf8");
    }, undefined);
  }

  updateSession(sessionId: string, mutate: (state: SessionState) => SessionState, now: number = Date.now()): SessionState {
    const next = mutate(this.readSession(sessionId));
    this.writeSession(sessionId, next, now);
    return next;
  }

  /** Session-scoped or global `/jev:off`. */
  isDisabled(sessionId: string): boolean {
    if (safe(() => existsSync(this.globalDisablePath), false)) return true;
    return this.readSession(sessionId).disabled === true;
  }

  setDisabled(sessionId: string | null, disabled: boolean): { scope: "session" | "global"; path: string } {
    if (sessionId === null) {
      this.ensureDir();
      if (disabled) {
        safe(() => writeFileSync(this.globalDisablePath, `${new Date().toISOString()}\n`, "utf8"), undefined);
      } else {
        safe(() => unlinkSync(this.globalDisablePath), undefined);
      }
      return { scope: "global", path: this.globalDisablePath };
    }
    this.updateSession(sessionId, (state) => {
      const next: SessionState = { ...state };
      if (disabled) next.disabled = true;
      else delete next.disabled;
      return next;
    });
    // An enable must also clear a global flag, or it silently does nothing.
    if (!disabled) safe(() => unlinkSync(this.globalDisablePath), undefined);
    return { scope: "session", path: this.sessionPath(sessionId) };
  }

  /** Record that this tool call was escalated, so PostToolUse can see it ran. */
  rememberAsk(sessionId: string, pending: PendingAsk): void {
    this.updateSession(sessionId, (state) => ({
      ...state,
      pending_asks: [...(state.pending_asks ?? []), pending].slice(-MAX_PENDING),
    }));
  }

  /** Consume a pending ask. Returns it when this tool call was one of ours. */
  takeAsk(sessionId: string, toolUseId: string): PendingAsk | undefined {
    const state = this.readSession(sessionId);
    const pending = state.pending_asks ?? [];
    const found = pending.find((p) => p.tool_use_id === toolUseId);
    if (found === undefined) return undefined;
    this.writeSession(sessionId, {
      ...state,
      pending_asks: pending.filter((p) => p.tool_use_id !== toolUseId),
    });
    return found;
  }

  /** One `appendFileSync` call, so concurrent hooks cannot interleave a line. */
  append(record: DecisionRecord): void {
    this.ensureDir();
    safe(() => {
      const size = safe(() => statSync(this.logPath).size, 0);
      if (size >= LOG_ROTATE_BYTES) {
        safe(() => renameSync(this.logPath, join(this.dir, "decisions.1.jsonl")), undefined);
      }
      appendFileSync(this.logPath, `${JSON.stringify(record)}\n`, "utf8");
    }, undefined);
  }

  /** Read the log back, newest last. Malformed lines are skipped. */
  readLog(): DecisionRecord[] {
    const files = [join(this.dir, "decisions.1.jsonl"), this.logPath];
    const out: DecisionRecord[] = [];
    for (const file of files) {
      const raw = safe(() => readFileSync(file, "utf8"), "");
      for (const line of raw.split("\n")) {
        if (line.trim() === "") continue;
        const parsed = safe<DecisionRecord | null>(() => JSON.parse(line) as DecisionRecord, null);
        if (parsed !== null && typeof parsed === "object") out.push(parsed);
      }
    }
    return out;
  }

  /**
   * Drop session files older than the TTL, at most once a day. Called from
   * UserPromptSubmit, which is the one hook with time to spare.
   */
  pruneSessions(now: number = Date.now()): number {
    const marker = join(this.dir, "last-prune");
    const last = safe(() => Number(readFileSync(marker, "utf8").trim()), 0);
    if (Number.isFinite(last) && now - last < PRUNE_INTERVAL_MS) return 0;
    this.ensureDir();
    safe(() => writeFileSync(marker, String(now), "utf8"), undefined);

    const dir = join(this.dir, "sessions");
    const names = safe(() => readdirSync(dir), [] as string[]);
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      const mtime = safe(() => statSync(path).mtimeMs, now);
      if (now - mtime > SESSION_TTL_MS) {
        safe(() => unlinkSync(path), undefined);
        removed += 1;
      }
    }
    return removed;
  }
}
