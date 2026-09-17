---
name: on
description: Turn the jev hooks back on after /jev:off, clearing both the session flag and the global one.
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

# /jev:on

Run exactly this command with the Bash tool:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs" enable "${CLAUDE_SESSION_ID}"
```

It clears this session's flag and the global flag file, so it undoes either form of
`/jev:off`. Confirm in one line, and mention that `JEV_HOOKS_DISABLE=1` in the
environment overrides this and has to be unset in the shell instead.
