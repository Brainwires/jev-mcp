# Security

## What leaves the machine

When a hook decides Jev needs to judge something, or when an MCP tool is pointed at file content,
this plugin sends data to TypeSafe's API at `api.typesafe.ai`. Concretely:

- **Tool inputs and tool results.** The `PreToolUse` gate sends the tool name and a redacted,
  truncated excerpt of its arguments. The `PostToolUse` injection screen sends an excerpt of a
  `WebFetch`/`WebSearch`/MCP tool result (up to the first 12k and last 4k characters).
- **Your last few prompts.** Kept in the session file so the gate can judge whether an action is
  in scope, and sent as part of that judgment when a request is known.
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
  an error. Rotated at 5 MB (renamed to `decisions.1.jsonl`, one generation kept).
- `sessions/<session_id>.json` — per-session bookkeeping: your last few prompts, the verification
  ledger, and the escalation count used to cap `Stop` blocks at one per prompt. Pruned
  opportunistically after about 7 days.

Deleting this directory is safe. It contains no configuration and nothing needed for the plugin to
keep working — the only thing you lose is calibration history (`/jev:calibrate`, `/jev:why`) and
the record of your last few prompts. Run `/jev:status` to print the resolved path before you delete
it, if you want to confirm where it lives on your machine.

## Advisory, not a boundary

jev is escalate-only: a hook can add context, raise a permission prompt (`ask`), or deny — it can
never emit `permissionDecision: "allow"`. That makes it a layer that can make a bad tool call *less
likely* to go through unnoticed. It does not make one *impossible*: every hook fails open on any
error (no API key, a timeout, a network error, malformed input, a bug), because a gate that breaks
your session when an API is unreachable is worse than no gate.

Jev is also not injection-hardened. It reads the tool input, tool result excerpt, or file content
you hand it as data, and text designed to argue for its own approval — whether typed by you, present
in a file, or embedded in a fetched page — can move its probabilities. Do not treat a `jev_gate_action`
`allow`, or the absence of a hook prompt, as a security decision.

Real enforcement — the thing that actually stops a tool call — belongs in Claude Code's own
permission rules, not in this plugin.

## Reporting a vulnerability

Please report security issues privately through GitHub's security advisory flow:
<https://github.com/Brainwires/jev-mcp/security/advisories/new>.

Do not open a public issue for anything exploitable. This is a small project maintained on a
best-effort basis, so there is no guaranteed response time — but reports are read, and a fix or an
acknowledgment is the goal for anything that turns out to be real.
