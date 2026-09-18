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

## Results

_(pending)_
