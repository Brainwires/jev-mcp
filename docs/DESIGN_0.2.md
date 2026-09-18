# jev 0.2 — design changes

Grounded in the first day of real use (52 logged decisions): 10 of 23 gate escalations were
uncertain-only noise on ordinary in-project file edits made through Bash; the MCP tools made the
calling LLM pay output tokens to feed Jev; the stop check could not challenge a false "tests pass".

All invariants in `docs/PLUGIN_SPEC.md` still hold: escalate-only (never emit "allow"), fail open,
stdout is protocol, code before model, no install step (bundled `plugin/dist` is committed),
hook.mjs carries no MCP SDK / zod.

## A. Path-based MCP tools — Jev reads what the LLM has not

The point: the caller passes *references*, the server reads the content, and only
`path:start-end + score` comes back. The caller never emits or ingests rejected text.

Shared file access layer `src/files/` (used by MCP tools only, never by hooks):
- Root = `CLAUDE_PROJECT_DIR` if set, else `process.cwd()`. Every path is resolved with `realpath`
  and MUST stay inside root (symlink escapes rejected). Absolute paths inside root are fine.
- Refuse sensitive paths using the SAME predicate the hook prefilter uses (move `isSensitivePath`
  to a dependency-free shared module, e.g. `src/util/sensitive-path.ts`; both import it).
- Skip: binary files (NUL byte in first 8 KB), files > 512 KB, and by default anything under
  `node_modules`, `.git`, `dist`, `build`, `.next`, `target`, `vendor`, plus lockfiles and `*.min.*`.
- Glob: any small, bundle-friendly implementation (mcp.mjs is bundled; hook.mjs must not grow).
  Cap 1,000 matched files; clear error beyond that telling the caller to narrow the glob.
- Chunking: line-based, ~60 lines per chunk with 5-line overlap, never splitting mid-line; each
  chunk knows `path`, `start_line`, `end_line`. Chunks longer than ~6,000 chars are split further.
- Hard cost ceiling per call: estimated 3M input tokens (~$0.13). Over it -> error with the
  estimate and the number of files/chunks, nothing sent.
- Skipped files are reported by count and reason, never silently dropped. Six reasons as built, not
  the four first sketched here: `skipped: {binary, too_large, sensitive, outside_root, not_found,
  ignored}`. `not_found` is a named path that is not there, and `ignored` is generated output —
  both are drops the original four could not express. `outside_root` counts a *directory* that
  resolves out of the project once, rather than each file inside it: a `src/etc -> /etc` symlink
  otherwise enumerated 233 entries to report 233 refusals, and a link to `/` would crawl the disk,
  because the match cap counts matches and a path outside the root never becomes one.

`jev_rank` — exactly one of `candidates` | `paths` | `glob` (zod refine; clear error otherwise).
- New optional `unit: "chunk" | "file"` (default `chunk`) for paths/glob. `file` scores each file
  by its best chunk and returns one row per file with that chunk's line range.
- Output rows for file sources: `{path, start_line, end_line, relevance, rank}` (path relative to
  root). Still no text echoed. Add `files_scanned`, `chunks_scored`, `skipped`, `est_cost_usd`.
- Raise default fan-out concurrency for file sources to 8 (config `JEV_MAX_CONCURRENCY` still wins).
- **Cap candidates per request at 16** (`MAX_CANDIDATES_PER_REQUEST`), for every source, with the
  context budget still applying — whichever binds first. Packing to the budget alone put ~50
  candidates in a call and the scores stopped discriminating: measured live over 159 chunks of this
  repo, 53-per-request scored everything between 0.84 and 0.87 and missed the true answer entirely,
  16-per-request ranked it first. The payload is sent once either way, so the fix cost 2.5% more
  input tokens and no extra wall-clock time. This is the one place `candidates` output does change
  (`chunks` reports a larger number) — it had the same defect and it was worth fixing.
- Add `score_spread` (top relevance minus median, 2 dp) to the output for every source: the honest
  diagnostic for whether a ranking discriminated at all. Below 0.15 the ordering is not informative.
  `any_relevant` stays a maximum and is documented as biased upward on large sets, since more
  candidates means more requests and each contributes a sample.
- Existing `candidates` behaviour and output are otherwise unchanged.

`jev_verify` — exactly one of `evidence` | `evidence_path` (+ optional `start_line`/`end_line`).
- If the evidence exceeds the per-request budget, chunk it and verify every claim against every
  chunk. Merge per claim: take the chunk whose max(supported, contradicted) is highest; the claim
  is `not_addressed` only if it is `not_addressed` in every chunk. If one chunk firmly supports and
  another firmly contradicts (both >= auto), verdict `conflicting`, gate `escalate`.
- Add `where: {start_line, end_line}` to each claim when evidence came from a file or was chunked.

Tool descriptions must lead with the economics: "pass paths/globs for anything you have not
already read — do not read files in order to pass their text". Keep each under 1,200 chars.
Update `plugin/skills/jev-decisions` to teach this (rank a glob BEFORE reading; verify a draft
against `evidence_path`).

## B. Verification ledger — evidence for the stop check

Bookkeeping in code, judgment by Jev, decision by policy.

- In the async `Approval` hook path (this repo's own argv label, not a Claude Code event; it is
  registered under the real PostToolUse / PostToolUseFailure events with `async: true`, already for
  Bash|Write|Edit|MultiEdit|NotebookEdit): maintain in the session file
  `verification: { last?: {kind, ok, ts, command(<=200, redacted)}, edits_since: number }`.
  - A Bash command is a verification command when a pure classifier says so
    (`verificationKind(command) -> "test"|"build"|"typecheck"|"lint"|undefined`): test runners,
    `npm|pnpm|yarn|bun (run)? test|build|lint|type-check|typecheck|check`, `tsc`, `cargo test|check|
    build|clippy`, `go test|build|vet`, `pytest`, `vitest`, `jest`, `ruff check`, `mypy`, `eslint`, ...
    Compound commands count if any segment matches.
  - `ok`: settled from the docs. A non-zero Bash exit arrives as **PostToolUseFailure, which fires
    instead of PostToolUse**, and carries top-level `error` (first line `Exit code N`),
    `is_interrupt?` and `duration_ms?` — there is no `tool_response`, and no documented `exit_code`
    or `isError` field. A successful Bash PostToolUse carries `{stdout, stderr, interrupted,
    isImage}`. Both are handled, plus the undocumented `exit_code`/`isError`/`success` shapes
    defensively. `stdout` is never scanned for `Exit code N` — a test suite printing that string is
    not a failed command. `is_interrupt`/`interrupted` records nothing at all: an aborted run is not
    evidence about the code.
  - Write/Edit/MultiEdit/NotebookEdit success, and Bash in-project writes recognised by the
    prefilter (section C), increment `edits_since`; a verification command resets it to 0.
  - UserPromptSubmit does NOT reset the ledger (verification state outlives a prompt).
- Stop handler: add Noul `claims_verified` — "`final_message` states that tests, a build, a
  type-check or a lint run passed or succeeded" (true/false criteria; literal).
- Policy (pure, truth-table tested). Existing stop-short rule unchanged. New rule:
  block iff `claims_verified >= auto` AND `verification.last` exists AND `last.ok === false`.
  Reason to Claude: "[jev] Your final message says checks pass (p=0.xx), but the last {kind}
  command (`{command}`) failed {n} min ago and nothing has passed since. Re-run it, or correct the
  claim." (minutes computed in code.)
  NOT a block, log-only with decision `unverified-claim`: claims_verified >= auto AND
  (no verification on record OR edits_since > 0). That is calibration data, not an accusation.
- Same one-block-per-prompt cap, `stop_hook_active`, background-task and question skips as today.
- The async hook can lose a race with Stop; that only ever makes the check more lenient. Document it.

## C. Noise

1. Prefilter: Bash writes that are equivalent to an Edit are treated like one.
   `prefilterBash(command, {cwd, strict})`: when every segment is allowlisted-read-only EXCEPT for
   (a) output redirects `>`/`>>` whose targets, and (b) `sed -i`/`--in-place` whose file operands,
   (c) `tee [-a] file`, (d) `cat > file <<'EOF'` heredoc writes — all resolve inside `cwd`, are not
   sensitive, and the command has no substitution/expansion/grouping — return the same verdict
   `prefilterFileWrite` would (skip in standard, judge in strict). Anything else about redirects
   stays `judge`. Interpreter heredocs (`python3 - <<EOF`) stay `judge` — opaque is opaque.
   Hard patterns still run first. Expose `writesInProject: boolean` on the verdict for the ledger.
2. Policy option `corroborateUncertain?: boolean` on `gateActionPolicy` (hook-only, on in standard,
   off in strict, default off so the MCP tool is unchanged): an uncertain *risk* signal
   (destructive/outward_facing/credential_exposure in the uncertain band) fires only when
   corroborated by blast_radius >= HIGH_BLAST_RADIUS, or a second risk signal >= 0.5, or
   in_scope leaning no. Log it in `record.policy` and replay it in `/jev:calibrate`.
3. ACCEPTANCE TEST against real data: `tests/fixtures/day1-decisions.jsonl` (I will provide it —
   signals and policy only, subjects stripped). Replaying every judged PreToolUse record through
   the new standard-mode policy must (a) still escalate every record that has a firm signal
   (any risk signal >= 0.85, in_scope <= 0.15, or blast >= 2 without `requested`), and
   (b) escalate at most 2 of the uncertain-only records. Print the before/after counts in the test name
   or a snapshot so the number is visible.

## D. Production readiness

- `tests/versions.test.ts`: package.json, plugin.json, marketplace.json, `SERVER_VERSION` agree.
  Add `npm run bump -- <version>` (scripts/bump.ts) that sets all four and the lockfile.
- CI `.github/workflows/ci.yml`: Node 20 + 22 matrix; `npm ci`, type-check, test, build, then
  `git diff --exit-code plugin/dist` so a stale committed bundle fails the build. (Confirm the
  esbuild output is deterministic across the two Node versions; if not, check freshness on one.)
- `CHANGELOG.md` (Keep a Changelog style) reconstructing 0.1.0–0.1.4 from `git log` and adding 0.2.0.
- `SECURITY.md`: what leaves the machine (redacted excerpts of tool inputs/results and the last few
  prompts go to api.typesafe.ai; file contents go only when an MCP tool is pointed at them), what
  never does (sensitive-path files, anything outside the project root), where the log lives and how
  to delete it, the advisory-not-a-boundary statement, and how to report a vulnerability
  (GitHub private advisory on Brainwires/jev-mcp).
- README: restructure for a first-time reader — what it is in 5 lines; install (plugin first, then
  bare MCP, then library); a "what you will see" section with real `[jev]` lines and a real prompt
  screenshot description; settings table (incl. `auto_mode`, both API-key routes); the tools with
  the path-based examples first; commands; guarantees; limits & honest caveats (slower per judged
  call ~0.5 s; advisory; Jev's known failure modes; calibration is yours to measure); cost; FAQ
  (hooks silent? -> /jev:status; too many prompts? -> /jev:calibrate, gate_mode; key not picked up?
  -> /reload-plugins). State plainly that it has been exercised against the live API, with the date.
- `package.json`: `engines`, `repository`, `bugs`, `homepage`, `keywords`; `npm pack --dry-run`
  must contain dist/, plugin/, .claude-plugin/, README, LICENSE, CHANGELOG and nothing from tests/.
- Version 0.2.0.
