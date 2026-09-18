/**
 * The verification ledger: two numbers, and the one case they justify blocking.
 *
 * Jev reads the final message, so it can say that a message *claims* the checks
 * pass. Whether they do is bookkeeping: did the last verification command pass,
 * and how many edits landed since one ran. Everything in this file is pure —
 * no store, no clock, no model — so the tests are a truth table and nothing else.
 *
 * The block rule is deliberately narrow, and the tests below pin that narrowness
 * down rather than leaving it to the reader. Blocking requires evidence: the
 * message claims the checks pass, a check is on record, and that check failed.
 * A *missing* record is never an accusation — the async post-tool hook can lose
 * its race with Stop, a check may have run before the plugin was installed, and
 * "I have no record of you running the tests" is exactly the false positive that
 * gets a stop hook switched off. That case is `logOnly`: calibration data, not a
 * verdict. Same for edits after a passing run, which is suspicion, not proof.
 */

import { describe, expect, it } from "vitest";
import {
  applyLedgerEvent,
  bashFailed,
  EMPTY_LEDGER,
  ledgerEvent,
  MAX_LEDGER_COMMAND_CHARS,
  verificationKind,
  verificationPolicy,
  type VerificationKind,
  type VerificationLedger,
} from "../../src/hooks/verification.js";
import type { HookInput } from "../../src/hooks/types.js";

const NOW = 1_700_000_000_000;
const AUTO = 0.85;
const PROJECT = "/home/dev/project";

/** The documented success shape of a Bash `tool_response`. */
const OK_RESPONSE = { stdout: "ok\n", stderr: "", interrupted: false, isImage: false };

function post(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: "s1",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_response: OK_RESPONSE,
    ...overrides,
  };
}

function failed(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: "s1",
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    ...overrides,
  };
}

/** A Bash post-tool event for `command`, succeeding unless told otherwise. */
function bash(command: string, overrides: Partial<HookInput> = {}): HookInput {
  return post({ tool_input: { command }, ...overrides });
}

describe("verificationKind", () => {
  // command -> what running it establishes
  const cases: [string, VerificationKind | undefined][] = [
    // test
    ["npm test", "test"],
    ["npm run test", "test"],
    ["npm run test:unit", "test"],
    ["pnpm test", "test"],
    ["yarn test", "test"],
    ["bun test", "test"],
    ["npx vitest run", "test"],
    ["vitest", "test"],
    ["jest --ci", "test"],
    ["pytest -q", "test"],
    ["python3 -m pytest", "test"],
    ["cargo test", "test"],
    ["go test ./...", "test"],
    ["dotnet test", "test"],
    ["mvn test", "test"],
    // `ci` and `verify` run the whole suite in practice, and `test` is the
    // strongest of the four claims: reading them weaker lets the claim off.
    ["npm run ci", "test"],
    ["npm run verify", "test"],
    ["make test", "test"],

    // typecheck
    ["tsc --noEmit", "typecheck"],
    ["npm run type-check", "typecheck"],
    ["npm run typecheck", "typecheck"],
    ["npm run types", "typecheck"],
    ["mypy src", "typecheck"],
    ["pyright", "typecheck"],
    ["cargo check", "typecheck"],
    // `npx tsc` is the compiler invoked directly, whatever the project flag says.
    ["npx tsc --project tsconfig.build.json", "typecheck"],

    // build
    ["npm run build", "build"],
    ["cargo build", "build"],
    ["go build ./...", "build"],
    ["make", "build"],
    ["make dist", "build"],

    // lint
    ["eslint .", "lint"],
    ["npm run lint", "lint"],
    ["ruff check .", "lint"],
    ["cargo clippy", "lint"],
    ["go vet ./...", "lint"],
    ["prettier --check .", "lint"],
    ["golangci-lint run", "lint"],

    // verifies nothing
    ["ls -la", undefined],
    ["git status", undefined],
    ["echo hi", undefined],
    ["cat package.json", undefined],
    ["rm -rf build", undefined],
    // A formatter rewrites files; it does not establish that anything works.
    ["ruff format .", undefined],
    ["prettier --write .", undefined],
    ["cargo fmt", undefined],
    ["npm install", undefined],
    ['git commit -m "x"', undefined],
    ["", undefined],
  ];

  for (const [command, expected] of cases) {
    it(`${expected ?? "nothing"}: ${command === "" ? "(empty)" : command}`, () => {
      expect(verificationKind(command)).toBe(expected);
    });
  }

  it("takes the strongest claim in a chain", () => {
    expect(verificationKind("npm run build && npm test")).toBe("test");
    expect(verificationKind("npm test && npm run build")).toBe("test");
    expect(verificationKind("npm run build && npm run lint")).toBe("build");
    expect(verificationKind("git status && npm run lint")).toBe("lint");
  });

  it("ignores a segment that verifies nothing", () => {
    expect(verificationKind("ls | wc -l")).toBeUndefined();
  });

  it("looks past a leading environment assignment", () => {
    expect(verificationKind("CI=1 npm test")).toBe("test");
  });
});

describe("bashFailed", () => {
  // label -> input -> true failed, false succeeded, undefined unknowable
  const cases: [string, HookInput, boolean | undefined][] = [
    [
      "a documented non-zero exit",
      failed({ error: "Exit code 1\nError: Cannot find module 'express'", is_interrupt: false }),
      true,
    ],
    [
      "the same failure arriving as an abort",
      failed({ error: "Exit code 1\nError: Cannot find module 'express'", is_interrupt: true }),
      undefined,
    ],
    // Claude Code could not start the shell: nothing reported a verdict.
    ["a failure with no exit-code line", failed({ error: "Failed to start shell" }), undefined],
    ["the documented success shape", post(), false],
    ["an interrupted tool_response", post({ tool_response: { ...OK_RESPONSE, interrupted: true } }), undefined],
    ["an explicit exit 0", failed({ error: "Exit code 0\nnothing to do" }), false],
    // Undocumented fields, read defensively: one shape breaking should not
    // silently turn every check into "unknowable".
    ["an undocumented exit_code 2", post({ tool_response: { exit_code: 2 } }), true],
    ["an undocumented exit_code 0", post({ tool_response: { exit_code: 0 } }), false],
    ["an undocumented isError", post({ tool_response: { isError: true } }), true],
    ["an undocumented success:false", post({ tool_response: { success: false } }), true],
    ["an undocumented is_error", post({ tool_response: { is_error: true } }), true],
  ];

  for (const [label, input, expected] of cases) {
    it(`${expected === undefined ? "cannot tell" : expected ? "failed" : "succeeded"}: ${label}`, () => {
      expect(bashFailed(input)).toBe(expected);
    });
  }

  it("never reads an exit code out of stdout", () => {
    // A test suite that prints "Exit code 1" in its own output is not a failed
    // command. Scanning stdout would make every such suite look broken, and a
    // hook that cries wolf on a passing run is worse than no hook.
    const input = post({
      tool_response: { ...OK_RESPONSE, stdout: "PASS  should report Exit code 1 on failure\n1 passed\n" },
    });
    expect(bashFailed(input)).toBe(false);
  });
});

describe("ledgerEvent", () => {
  /**
   * The ledger has to strip the affirmation marker for the same reason the gate
   * does: `npm test # jev:intended …` is a test run, and the marker's words are
   * not arguments. Without stripping, a re-issued check would stop counting as
   * a check and the stop hook would go blind exactly when a trip was answered.
   */
  it("reads a re-issued command as the command it is, marker and all", () => {
    const event = ledgerEvent(bash('npm test # jev:intended the request says "get the suite green"'), NOW);
    expect(event.verification?.kind).toBe("test");
  });

  it("records a passing check and resets the edit count", () => {
    const event = ledgerEvent(bash("npm test"), NOW);
    expect(event.edited).toBe(false);
    expect(event.verification).toEqual({ kind: "test", ok: true, ts: NOW, command: "npm test" });

    const next = applyLedgerEvent({ edits_since: 5 }, event);
    expect(next.edits_since).toBe(0);
    expect(next.last).toEqual(event.verification);
  });

  it("records a failing check and still resets the edit count", () => {
    // A check ran, so "edits since a check ran" is zero again whether it passed
    // or failed. What it established lives in `last.ok`, not in the counter.
    const event = ledgerEvent(
      failed({ tool_input: { command: "npm test" }, error: "Exit code 1\n1 failed" }),
      NOW,
    );
    expect(event.verification?.ok).toBe(false);
    expect(event.verification?.kind).toBe("test");

    const next = applyLedgerEvent({ edits_since: 4 }, event);
    expect(next.edits_since).toBe(0);
    expect(next.last?.ok).toBe(false);
  });

  it("records nothing for an interrupted check", () => {
    const event = ledgerEvent(
      failed({ tool_input: { command: "npm test" }, error: "Exit code 130\n", is_interrupt: true }),
      NOW,
    );
    expect(event.verification).toBeUndefined();
    expect(event.edited).toBe(false);

    const ledger: VerificationLedger = { last: { kind: "test", ok: true, ts: NOW - 1000, command: "npm test" }, edits_since: 2 };
    expect(applyLedgerEvent(ledger, event)).toBe(ledger);
  });

  it("counts a successful Write as an edit", () => {
    const event = ledgerEvent(post({ tool_name: "Write", tool_response: { filePath: "/p/x.ts" } }), NOW);
    expect(event.edited).toBe(true);
    expect(event.verification).toBeUndefined();

    const last = { kind: "test" as const, ok: true, ts: NOW - 60_000, command: "npm test" };
    const next = applyLedgerEvent({ last, edits_since: 1 }, event);
    expect(next.edits_since).toBe(2);
    expect(next.last).toEqual(last);
  });

  it("does not count a failed Write as an edit", () => {
    const event = ledgerEvent(
      failed({ tool_name: "Write", error: "File has not been read yet. Read it first." }),
      NOW,
    );
    expect(event.edited).toBe(false);
  });

  // Bash edits, recognized by the same prefilter the permission gate uses, so
  // "a `sed -i` counts as an edit" holds in exactly the cases the gate stayed
  // silent about.
  const bashEdits: [string, boolean][] = [
    ["sed -i 's/a/b/' src/x.ts", true],
    ["echo x > /etc/passwd", false],
    ["ls -la", false],
  ];

  for (const [command, expected] of bashEdits) {
    it(`${expected ? "counts" : "ignores"} \`${command}\``, () => {
      expect(ledgerEvent(bash(command, { cwd: PROJECT }), NOW).edited).toBe(expected);
    });
  }

  it("cannot judge a Bash edit without a cwd", () => {
    expect(ledgerEvent(bash("sed -i 's/a/b/' src/x.ts"), NOW).edited).toBe(false);
  });

  it("clamps a long command", () => {
    const long = `npm test -- ${"--grep pattern ".repeat(20)}`;
    expect(long.length).toBeGreaterThan(MAX_LEDGER_COMMAND_CHARS);

    const record = ledgerEvent(bash(long), NOW).verification;
    expect(record?.kind).toBe("test");
    expect(record?.command.length).toBeLessThanOrEqual(MAX_LEDGER_COMMAND_CHARS);
    expect(record?.command.startsWith("npm test --")).toBe(true);
    expect(record?.command.endsWith("… [truncated]")).toBe(true);
  });

  it("redacts a secret out of the command", () => {
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const record = ledgerEvent(bash(`npm test --token=${secret}`), NOW).verification;
    expect(record?.kind).toBe("test");
    expect(record?.command).not.toContain(secret);
    expect(record?.command).not.toContain("sk-ant-api03");
    expect(record?.command).toBe("npm test --token=[REDACTED]");
  });
});

describe("verificationPolicy", () => {
  const failing = { kind: "test" as const, ok: false, ts: NOW - 7 * 60_000, command: "npm test" };
  const passing = { kind: "test" as const, ok: true, ts: NOW - 7 * 60_000, command: "npm test" };

  it("says nothing when the message never claimed anything", () => {
    const result = verificationPolicy(0.5, { last: failing, edits_since: 0 }, AUTO, NOW);
    expect(result.block).toBe(false);
    expect(result.logOnly).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("blocks a claim contradicted by a failed check", () => {
    const result = verificationPolicy(0.95, { last: failing, edits_since: 0 }, AUTO, NOW);
    expect(result.block).toBe(true);
    expect(result.logOnly).toBe(false);
    for (const fragment of [
      "[jev]",
      "says checks pass (p=0.95)",
      "test",
      "npm test",
      "7 min ago",
      "Re-run it, or correct the claim.",
    ]) {
      expect(result.reason, fragment).toContain(fragment);
    }
    expect(result.reason).toBe(
      "[jev] Your final message says checks pass (p=0.95), but the last test command (`npm test`) " +
        "failed 7 min ago and nothing has passed since. Re-run it, or correct the claim.",
    );
  });

  it("rounds a sub-minute failure to words rather than to zero", () => {
    const result = verificationPolicy(0.95, { last: { ...failing, ts: NOW - 20_000 }, edits_since: 0 }, AUTO, NOW);
    expect(result.block).toBe(true);
    expect(result.reason).toContain("failed less than a minute ago");
    expect(result.reason).not.toContain("0 min ago");
  });

  it("says nothing when the claim is corroborated", () => {
    const result = verificationPolicy(0.95, { last: passing, edits_since: 0 }, AUTO, NOW);
    expect(result.block).toBe(false);
    expect(result.logOnly).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it("logs rather than accuses when nothing is on record", () => {
    // The async post-tool hook can lose its race with Stop, so a missing record
    // is missing bookkeeping — never evidence that the claim was false.
    const result = verificationPolicy(0.95, EMPTY_LEDGER, AUTO, NOW);
    expect(result.block).toBe(false);
    expect(result.logOnly).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.reasons.join(" ")).toContain("no verification command on record");
  });

  it("logs edits landing after the last passing run", () => {
    const result = verificationPolicy(0.95, { last: passing, edits_since: 3 }, AUTO, NOW);
    expect(result.block).toBe(false);
    expect(result.logOnly).toBe(true);
    expect(result.reasons.join(" ")).toContain("3 edits happened after the last test run");
  });

  it("treats the threshold as inclusive", () => {
    expect(verificationPolicy(0.85, { last: failing, edits_since: 0 }, AUTO, NOW).block).toBe(true);
    expect(verificationPolicy(0.84, { last: failing, edits_since: 0 }, AUTO, NOW).block).toBe(false);
  });
});
