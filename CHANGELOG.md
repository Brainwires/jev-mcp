# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-09-17

### Changed
- `jev_rank` description now recommends `unit: "file"` for "where is X" questions. Live use showed
  a file's header comment outranking the code it describes, so file-level ranking is the reliable
  way to pick the file; read it afterwards.

## [0.2.0] - 2026-09-17

### Added

- `jev_rank` accepts `paths` or `glob` in place of `candidates` and reads the files itself: rows
  come back as `path:start_line-end_line` plus relevance, never the text that was scored. New
  `unit: "chunk" | "file"` (default `chunk`) controls whether a file source is scored per chunk or
  per file. New output fields `files_scanned`, `chunks_scored`, `skipped`, `est_cost_usd`.
- `jev_verify` accepts `evidence_path` (with optional `start_line`/`end_line`) in place of
  `evidence`. Evidence too large for one request is chunked and every claim is checked against
  every chunk, then merged: the chunk with the strongest verdict wins, and a claim that is firmly
  supported in one chunk and firmly contradicted in another comes back with a new `conflicting`
  verdict. Claims sourced from a file or from a chunked evidence blob carry a `where` line range.
- A shared file-access layer, `src/files/`, used by the MCP tools only. It resolves every path
  with `realpath` and refuses anything outside the project root (so a symlink cannot walk out),
  refuses the same sensitive paths the hook prefilter refuses, skips binaries, files over 512 KB,
  and generated output (`node_modules`, `.git`, `dist`, `build`, `.next`, `target`, `vendor`,
  lockfiles, `*.min.*`), and enforces a hard per-call cost ceiling of 3M estimated input tokens
  (about $0.13): over the ceiling, the call errors with the estimate and nothing is sent.
- A verification ledger. The async `PostToolUse`/`PostToolUseFailure` hooks now record, per
  session, whether the last test/build/type-check/lint command passed and how many edits have
  happened since. The `Stop` check gained a `claims_verified` signal and can now challenge a final
  message that claims checks pass when the last recorded run actually failed; a weaker case
  (claims pass, but nothing was recorded, or edits happened since) is logged as a new
  `unverified-claim` decision without blocking.
- `score_spread` on the `jev_rank` output for every source: top relevance minus median, to two
  decimals. It is the honest measure of whether a ranking discriminated at all — a run scoring
  everything between 0.84 and 0.87 has a spread near zero and an ordering that is noise, however
  confident the top number looks. Below 0.15 the tool description and the skill both say to narrow
  the glob or rephrase the query rather than trust the order. `any_relevant` is unchanged, but its
  schema now records that it is a maximum and therefore biased upward as the candidate set grows.
- `npm run bump -- <version>` keeps `package.json`, `plugin.json`, `marketplace.json`, the lockfile
  and `SERVER_VERSION` in agreement, backed by a test that asserts they never drift apart.
- CI on Node 20 and 22 (`.github/workflows/ci.yml`), `SECURITY.md`, and this changelog.

### Changed

- The Bash prefilter now recognizes a shell command that behaves like an `Edit` — an output
  redirect, `sed -i`, `tee`, or a `cat > file` heredoc whose targets all resolve inside the working
  directory and are not sensitive — and treats it the same way it treats an `Edit`. Ordinary
  in-project edits made through Bash no longer cost a prompt in standard mode.
- New `corroborateUncertain` gate policy option: on in standard mode, off in strict, off by default
  so `jev_gate_action`'s own defaults are unchanged. With it on, an uncertain risk signal
  (destructive, outward-facing, or credential exposure sitting in the uncertain band) only fires
  when something else corroborates it — a wide blast radius, a second risk signal, or a scope
  reading that leans out.
- `jev_rank` caps every request at 16 candidates (`MAX_CANDIDATES_PER_REQUEST`) instead of packing
  each one to the context budget; the budget still applies, whichever binds first. Packing to the
  budget alone put roughly 50 candidates in a call, and at that width the scores stopped
  discriminating: measured live against this repo with the query "where are retries and backoff
  implemented" over 159 file chunks, budget-exact packing (3 requests) scored everything between
  0.84 and 0.87 and left the actual retry implementation out of the top six, while batches of 16
  (10 requests) ranked it first. The payload is sent exactly once either way, so the fix cost 2.5%
  more input tokens and no additional wall-clock time. This applies to `candidates` as well as to
  `paths`/`glob` — that path had the same defect — so a large `candidates` call now reports a
  larger `chunks` count than it did in 0.1.x.

### Fixed

- A glob no longer walks into a directory that resolves outside the project root. It used to
  enumerate the whole linked tree and then refuse each file: a `src/etc -> /etc` symlink produced
  233 entries under it before reporting 233 refusals, and because the 1,000-file cap counts matches
  — and a path outside the root never becomes one — a symlink to `/` or `$HOME` would crawl the
  disk first. The directory is now pruned and counted once as `outside_root`. Two hard caps back it
  up: 20,000 directories and 200,000 entries per glob, each failing with a message that says to
  narrow the pattern.
- A symlink to a directory is no longer reported as a file match. Its own directory entry says
  nothing about its target, and treating it as both meant the reader had to refuse it as "not a
  file"; the walker now stats the target once to classify it.

## [0.1.4] - 2026-09-17

### Fixed

- The plugin manifest mapped `TYPESAFE_API_KEY` to `${user_config.api_key}`. With the plugin
  setting left empty and the key exported in the shell instead, that entry overwrote the inherited
  variable with an empty string, so every MCP tool call failed with "TYPESAFE_API_KEY is not set"
  while the hooks, which read the environment directly, kept working. The manifest now passes the
  setting as `JEV_PLUGIN_API_KEY`, and the server takes the first non-empty value of
  `JEV_PLUGIN_API_KEY`, `CLAUDE_PLUGIN_OPTION_API_KEY`, `TYPESAFE_API_KEY`, in that order, so the
  plugin setting wins when both are present. The missing-key message now names both routes.

## [0.1.3] - 2026-09-17

### Fixed

- Short follow-up prompts ("go", "ship both") no longer evict the request they continue. Substantive
  and short prompts are now capped separately (3 and 2) and kept in order, so an authorization like
  "make it public" is still visible to the gate. Live, a requested push had scored `in_scope` 0.29
  because the recorded window held only "go" and "try it now".
- The request text is now assembled newest-first within its character budget. The previous
  join-then-clamp kept the head of the joined text, which cut off the newest prompt — the
  instruction the user had just given — whenever three long prompts did not all fit.
- `/jev:status` latency figures now count model calls only. Approval records had been carrying
  prompt-to-completion time (including the time the user spent thinking), which put p95 at 32
  seconds against a 1.5 second call timeout.

## [0.1.2] - 2026-09-17

### Added

- `auto_mode` setting (`advise` | `ask`, default `advise`). In auto mode, a confirm-grade judgment
  adds a `[jev]` note to Claude's context and emits no permission decision, leaving the call to
  Claude Code's own auto-mode classifier; block-grade judgments and the hard-coded patterns still
  ask. Abstaining is not approving — the hooks still never emit `allow`.
- `trustRequested` policy option: outward reach and blast radius stop being reasons to ask once
  `in_scope >= review` and neither `destructive` nor `credential_exposure` leans yes, so a push the
  user actually asked for no longer prompts.
- `lenientScope` policy option: an uncertain `in_scope` signal only fires when another risk signal
  or a wide blast radius corroborates it, since Jev reads scope literally and unnamed supporting
  work (installing a dependency) landed in the uncertain band on its own. A firm out-of-scope
  reading still confirms regardless.

Both options are hook-only — on in standard mode, off in strict — and the MCP tool's own defaults
are unchanged; the decision log records them so `/jev:calibrate` can replay the policy exactly.

### Fixed

- Live use showed the standard gate asking about ordinary, requested actions. Verified against the
  live API: a requested push and `npm install` go through silently; an out-of-scope refund, a
  recursive S3 delete, and a force push still ask.

## [0.1.1] - 2026-09-17

### Fixed

- `CLAUDE_PLUGIN_DATA` is exported to hook processes only. The `/jev:*` commands run through the
  Bash tool without it and fell back to `~/.claude/plugins/data/jev`, while the hooks logged to
  `~/.claude/plugins/data/<plugin>-<marketplace>`. `/jev:status`, `/jev:why`, and `/jev:calibrate`
  always showed an empty log, and `/jev:off`/`/jev:on` wrote flags the hooks never read. When the
  variable is unset, the install id is now derived from the script's own path under
  `plugins/cache/<marketplace>/<plugin>/<version>/`; an explicit `CLAUDE_PLUGIN_DATA` still wins,
  and paths outside the plugin cache keep the old default.

## [0.1.0] - 2026-09-17

### Added

- Initial release. Provider-agnostic `DecisionModel` contract (choice/score/probability plus
  batched `evaluate`), with a Jev implementation over TypeSafe's `/v1/systemone` API.
- MCP server with six tools: `jev_evaluate`, `jev_rank`, `jev_verify`, `jev_gate_action`,
  `jev_next_step`, `jev_list_models`. Gating policy lives in code, not in the model.
- A library entry point so a harness can embed the decision layer without going through MCP.
- Claude Code plugin: escalate-only, fail-open hooks — `PreToolUse` gate with a deterministic
  bash/file/MCP prefilter, `PostToolUse` injection screening, `Stop` stop-short check — plus
  `/jev:*` commands, a skill, and a committed, dependency-free `plugin/dist` bundle.

Not yet exercised against the live API at the time of this release.

[0.2.1]: https://github.com/Brainwires/jev-mcp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Brainwires/jev-mcp/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/Brainwires/jev-mcp/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Brainwires/jev-mcp/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Brainwires/jev-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Brainwires/jev-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Brainwires/jev-mcp/releases/tag/v0.1.0
