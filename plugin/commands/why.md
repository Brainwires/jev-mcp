---
name: why
description: Explain the last few escalations the jev hooks raised — which signals fired, with what probabilities, and which policy rule turned them into a prompt.
disable-model-invocation: true
argument-hint: "[count]"
allowed-tools: Bash(node:*)
---

# /jev:why

Run exactly this command with the Bash tool, substituting the count the user asked
for (default 3) for `$ARGUMENTS`, and show the output verbatim:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs" why $ARGUMENTS
```

Each entry lists the tool, the redacted subject, the prefilter verdict, the raw
probabilities, and the reasons the policy gave. If an entry looks wrong to the
user, the fix is usually one of: raise `auto_threshold` (fewer prompts, see
`/jev:calibrate` first), switch `gate_mode` from `strict` to `standard`, or turn
the gate off for this session with `/jev:off`.

Note when a decision came from a code pattern rather than the model: those entries
have a `prefilter` line and no signals, and no threshold change will affect them.
