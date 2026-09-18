# Spike: what Claude Code actually does with a `type: "http"` hook

Run before any daemon code (plan Phase 2). Each question below has a "what we do if no" so the
result changes the design rather than just confirming it.

## Setup (10 minutes, one throwaway session)

1. `node scripts/spike-http-hook.mjs 10523 json` in a spare terminal (leave it running).
2. Add this to `.claude/settings.local.json` **in this repo** (project-local; remove it afterwards):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:10523/v1/hook/PreToolUse",
            "timeout": 5,
            "statusMessage": "spike: http hook",
            "headers": {
              "Authorization": "Bearer $CLAUDE_PLUGIN_OPTION_API_KEY",
              "X-Env-Key": "${TYPESAFE_API_KEY}",
              "X-Static": "static-value"
            },
            "allowedEnvVars": ["CLAUDE_PLUGIN_OPTION_API_KEY", "TYPESAFE_API_KEY"]
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "http", "url": "http://127.0.0.1:10523/v1/hook/PostToolUse", "timeout": 5, "async": true }
        ]
      }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "http", "url": "http://127.0.0.1:10523/v1/hook/UserPromptSubmit", "timeout": 5 } ] }
    ]
  }
}
```

3. Start a new Claude Code session in this repo, type a prompt, have it run `ls` twice, then stop.
4. Read `/tmp/jev-spike.log`. Then repeat step 3 once with the listener **stopped** (connection
   refused) and once with `node scripts/spike-http-hook.mjs 10523 text`.

## Questions and what each answer changes

| # | Question | Read from | If yes | If no |
|---|---|---|---|---|
| 1 | Are `$VAR` and `${VAR}` both interpolated in `headers` when listed in `allowedEnvVars`? Do `CLAUDE_PLUGIN_OPTION_*` vars resolve inside a plugin's hooks? (Here in settings they may be absent — the length/"contains $" note in the log says which.) | `headers` in the log | use the API key as the bearer | add a `daemon_secret` userConfig and pass it via the MCP manifest instead |
| 2 | Is a `2xx {}` reply completely silent in the transcript? | the session UI | ship pure http hooks | answer with an empty 2xx body instead (also test) |
| 3 | With the listener stopped, is anything shown to the user or Claude for the refused connection? | the session UI, the transcript | fail-open is quiet: no fallback needed on the hot path | keep the command fallback on `UserPromptSubmit`, and consider it on `PreToolUse` |
| 4 | With a `text/plain` reply, is anything shown? | the session UI | — | never answer non-JSON |
| 5 | Is `async: true` honoured on an http hook (PostToolUse returns before the listener answers — add a 2 s delay in the listener to see)? | wall clock | keep `Approval` async | daemon answers `{}` first and does bookkeeping after (already the design) |
| 6 | Does `UserPromptSubmit` reach the listener before the first `PreToolUse` of the same turn, and does `SessionStart` (a command hook in the real plugin) complete first? | order of lines in the log | first prompt is safe | keep the command fallback on `UserPromptSubmit` |
| 7 | Is `statusMessage` shown for an http hook? | the session UI | cosmetic | cosmetic |

Record the answers in this file under "Results" with the Claude Code version (`claude --version`).

## Results (Claude Code 2.1.275, 2026-09-18, headless `claude -p … --settings <file>` sessions)

| # | Answer | Evidence |
|---|---|---|
| 1 | **Yes.** `$VAR` and `${VAR}` both interpolate when listed in `allowedEnvVars`; an unlisted `$HOME` became an empty string; a static value passed through. `CLAUDE_PLUGIN_OPTION_API_KEY` was empty in a *settings* hook (that variable exists only in a plugin's hook environment) — `TYPESAFE_API_KEY` from the shell resolved to its full 108-char value. | listener log: `Authorization` = 6 chars ("Bearer " + empty), `X-Env-Key` = 108 chars, `X-Static` = 12 chars, `X-Unlisted` = 0 chars |
| 2 | **Yes.** A `2xx {}` reply is silent: the stream-json transcript shows no hook event for the http hooks at all (only the plugins' command `SessionStart` hooks appear), and the session completed normally. | run "up": `result success done`, hook mentions identical to a session without the http hooks |
| 3 | **Quiet.** With the listener stopped, the session ran identically: same transcript shape, no warning, the Bash call ran. Fail-open needs no fallback on the hot path. | run "down": identical line count and hook-event count to run "up" |
| 4 | **Quiet.** A `text/plain` reply produced nothing visible either. | run "text": identical |
| 5 | Fired: the `async: true` PostToolUse entry reached the listener 1–3 s after each PreToolUse. Whether it blocked the turn was not measurable headless (no delay was added). The daemon design answers `{}` first and does bookkeeping after, so it does not depend on this. | listener log ordering |
| 6 | **Yes.** `UserPromptSubmit` reached the listener before the first `PreToolUse` of the turn in all three runs. Plugin command `SessionStart` hooks ran before the prompt (they appear first in the transcript). | listener log ordering; transcript |
| 7 | Not measurable headless. Cosmetic. | — |
| 8 | **A non-2xx reply is NOT silent** (the one question the headless spike could not see and a real session answered the hard way): Claude Code shows it to the user as a hook error. Since 0.5.1 the daemon answers every hook-route refusal `200 {}` and counts it; only the `/v1/session/*` routes keep their real 4xx statuses, because `/v1/session/start` uses a 401 to recognise a stale daemon. | daemon.test.ts asserts 200 `{}` on hook-route refusals and 401 on the session route |
| 9 | `$CLAUDE_PLUGIN_OPTION_API_KEY` is **not** interpolated into a plugin's http hook headers either (observed on 0.5.1: a daemon holding only the option key counted every hook post `unauthorized`). Only variables in Claude Code's own process environment interpolate. Since 0.5.2 a hook post is authorized by the `session_id` in its body, which `SessionStart` — a command hook, which does see the option — registered with the daemon. | 0.5.2 counter `session_auth`; daemon.test.ts |

Design consequences: pure `type: "http"` hooks on the hot path; a command hook only on `SessionStart`
(to start/replace the daemon); keep a command fallback on `UserPromptSubmit` only (once per prompt,
protects the first prompt when the daemon is cold — cheap insurance even though question 6 passed).
Auth: the shell key interpolates; inside the plugin `CLAUDE_PLUGIN_OPTION_API_KEY` does **not**
interpolate into http hook headers (only into command-hook processes). Since 0.5.2 the daemon
authorizes a `POST /v1/hook/*` by the `session_id` in its body when that session is known, because
`SessionStart` is a command hook and registers the session over an authenticated `/v1/session/start`.
The `/v1/session/*` routes still require a held key, and the daemon still accepts `X-Jev-Env-Key` or
a non-empty `Authorization: Bearer`. A refusal the daemon can only count, never answer with a status:
an http hook route has exactly one user-visible outcome, so anything it wants to say has to fit in a
counter.
