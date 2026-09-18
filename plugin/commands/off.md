---
name: off
description: Turn the jev hooks off for this session — no notes, no tripwires, no result screening, no stop check — until /jev:on.
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

# /jev:off

Run exactly this command with the Bash tool:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs" disable "${CLAUDE_SESSION_ID}"
```

Report which scope it reported back:

- **this session** — the flag went into this session's state file. Other sessions
  keep their hooks. `/jev:on` clears it, and the file expires after 7 days.
- **all sessions (global flag)** — `${CLAUDE_SESSION_ID}` was not substituted, so
  the command could not tell which session it was in and fell back to a global flag
  file. Tell the user plainly that the hooks are now off for *every* session until
  `/jev:on`, and that `JEV_HOOKS_DISABLE=1` in the environment does the same thing
  without a file.

Turning the hooks off does not change the MCP tools: `jev_gate_action` and the rest
stay available for a deliberate check. It also clears nothing that was already
said: a note Claude has read is in the context either way, and an open tripwire
stops mattering only because nothing is checking it any more.

For the tool gate alone, without turning off result screening and the stop check,
the setting is `gate: off` in `/plugin` → jev.
