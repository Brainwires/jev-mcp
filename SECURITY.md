# Security

## What leaves the machine

When a hook decides Jev needs to judge something, or when an MCP tool is pointed at file content,
this plugin sends data to TypeSafe's API at `api.typesafe.ai`. Concretely:

- **Tool inputs and tool results.** The `PreToolUse` gate sends the tool name and a redacted,
  truncated excerpt of its arguments. The `PostToolUse` injection screen sends an excerpt of a
  `WebFetch`/`WebSearch`/MCP tool result (up to the first 12k and last 4k characters).
- **Your last few prompts.** Kept in the session file so the gate can judge whether an action is
  in scope, and sent as part of that judgment when a request is known.
- **Not the affirmation marker.** When Claude answers a tripwire with `# jev:intended <reason>`, the
  marker is stripped from the action *before* anything is sent, precisely so that text Claude wrote
  cannot move the `in_scope` signal. It is written to the local log and shown by `/jev:why`, and it
  never reaches the API.
- **Claude's final message.** Sent to the `Stop` check so it can tell whether Claude's own message
  claims the work, or verification of it, is finished.
- **File contents — only when you point an MCP tool at them.** `jev_rank` with `paths`/`glob` and
  `jev_verify` with `evidence_path` read files from disk on the caller's behalf and send their
  content (or line-ranged chunks of it) to be scored or checked. Nothing else in this plugin reads
  file content; the hooks only ever see the tool call itself, not the files a tool touches.

Everything sent is **redacted before logging and before sending**: values that look like secrets
(`sk-…`, `ghp_…`, `AKIA…`, `Bearer …`, `password=…`, PEM blocks, long hex or base64 following
`key`/`token`/`secret=`) are masked in both the outbound request and the local log entry. This is a
net, not a guarantee — it catches known shapes, not every secret. Everything sent is also
**size-clamped**: tool-input excerpts are capped at 4,000 characters, tool-result excerpts at 16k
characters (12k head + 4k tail), prompts at 2,000 characters each (last 3 kept), and the `Stop`
check's final message at 6,000 characters (tail). File reads for `jev_rank`/`jev_verify` are capped
by the file-access layer's own per-file (512 KB) and per-call (3M estimated input tokens, about
$0.13) limits — see below.

## What never leaves

- **Sensitive paths.** Anything matched by the sensitive-path predicate is refused outright, by
  both the hook prefilter and the file-access layer used by `jev_rank`/`jev_verify` — refused even
  when you name the path explicitly. That predicate lives in one place,
  `src/util/sensitive-path.ts`, precisely so the two callers can't drift apart; treat that file as
  the authoritative list. As of this writing it covers `.env*`, `id_rsa*` and other private-key
  basenames, `.npmrc`, `.netrc`, `.pypirc`, `.git-credentials`, `credentials`, `authorized_keys`,
  `known_hosts`, shell rc/profile files, `.gitconfig`, key/cert extensions (`.pem`, `.p12`, `.pfx`,
  `.key`, `.keystore`, `.jks`), the `.ssh/`, `.aws/`, `.gnupg/`, `.config/gcloud/`, `.kube/`, and
  `.docker/` directories, `**/.claude/settings*.json` and anything under `.claude/settings/` or
  `.claude/hooks/`, and `.git` internals.
- **Anything outside the project root.** The file-access layer resolves every path with `realpath`
  and refuses anything that resolves outside the project root, so a symlink cannot be used to walk
  a read out of the project.
- **The API key.** Never written to a settings file, never logged, never included in the decision
  log or the session file. `/jev:status` reports only whether a key is configured, never its value.

## Where the log lives, and how to delete it

State is written under `${CLAUDE_PLUGIN_DATA}`, which falls back to
`~/.claude/plugins/data/<plugin>@<marketplace>/` when that environment variable is not set. Two
kinds of file live there:

- `decisions.jsonl` — an append-only log, one line per hook invocation that reached a decision or
  an error. Rotated at 5 MB (renamed to `decisions.1.jsonl`, one generation kept). **Two fields are
  new in 0.3.0 and worth knowing about:** `emitted` is the exact text the hook handed Claude (up to
  300 characters, redacted), and `affirmation` is the reason Claude typed into an affirmation marker
  (up to 200 characters, redacted). Both are recorded deliberately — a tripwire that the agent can
  answer is only auditable if the answer is written down — and both are redacted with the same
  secret-shaped-value net as everything else, which means a secret with no recognizable shape typed
  into a marker would land in the log.
- `sessions/<session_id>.json` — per-session bookkeeping: your last few prompts, the verification
  ledger, the block count used to cap `Stop` blocks at one per prompt, open tripwires (each with its
  reason, its signals and any affirmation, expiring after 30 minutes), and the note counters used
  for the per-prompt cap and the duplicate check. Pruned opportunistically after about 7 days.

Deleting this directory is safe. It contains no configuration and nothing needed for the plugin to
keep working — the only thing you lose is calibration history (`/jev:calibrate`, `/jev:why`) and
the record of your last few prompts. Run `/jev:status` to print the resolved path before you delete
it, if you want to confirm where it lives on your machine.

## Advisory, not a boundary

jev can add a note, deny a call once, or block a stop — it can never emit
`permissionDecision: "allow"`. That makes it a layer that can make a bad tool call *less likely* to
go through unnoticed. It does not make one *impossible*, and 0.3.0 is explicit about the two reasons
why:

- **A note is post-hoc by construction.** Claude Code delivers a `PreToolUse` `additionalContext`
  next to the tool result — after the call has run — and drops it when the call is blocked. A note
  can only inform what happens next. Only a tripwire (the hard-coded catastrophic patterns and a
  model block-grade judgment) acts before execution.
- **A tripwire is answerable by the agent.** Claude may re-issue the identical call with
  `# jev:intended <reason>` on its last line and it passes the hook. That is the point — nothing
  here prompts you — but it means the plugin stops a mistake, not an adversary. A marker is honoured
  only against a trip this hook wrote for that exact action within 30 minutes, marker text never
  reaches the API, a marker on a call that was never tripped is stripped and counted, and every
  marker is logged and printed by `/jev:why`. Injected text that can persuade the agent to act can
  also persuade it to affirm; the affirmation text in the log is the audit trail, not a defence.

Every hook also fails open on any error (no API key, a timeout, a network error, malformed input, a
bug), because a gate that breaks your session when an API is unreachable is worse than no gate.

Jev is also not injection-hardened. It reads the tool input, tool result excerpt, or file content
you hand it as data, and text designed to argue for its own approval — whether typed by you, present
in a file, or embedded in a fetched page — can move its probabilities. Do not treat a `jev_gate_action`
`allow`, the absence of a note, or a tripwire that was answered, as a security decision.

Real enforcement — the thing that actually stops a tool call — belongs in Claude Code's own
permission rules, not in this plugin.

## Reporting a vulnerability

Please report security issues privately through GitHub's security advisory flow:
<https://github.com/Brainwires/jev-mcp/security/advisories/new>.

Do not open a public issue for anything exploitable. This is a small project maintained on a
best-effort basis, so there is no guaranteed response time — but reports are read, and a fix or an
acknowledgment is the goal for anything that turns out to be real.
