---
name: status
description: Show what the jev hooks are configured to do, and what they have done in the last 24 hours — notes, tripwires, re-issues, marker hygiene, latency, token spend, and the last error.
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

# /jev:status

Run exactly this command with the Bash tool and show the user its output verbatim:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs" status
```

Then, in one or two sentences, point out anything that needs attention: no API key
configured (the judgment hooks are inactive), a non-zero error count, a p95 latency
near the 1500 ms per-call timeout, or `hooks disabled by env`.

The `model` line is worth a glance. It is pinned to a version by default, which is
what keeps `/jev:calibrate`'s replay about one model's calibration; if it reads
`jev-latest`, say that thresholds tuned today can move under a release. If it names
a version and the error count is climbing, a retired pin is a candidate — the hooks
fail open, so that looks like silence rather than a failure, and `jev_list_models`
lists what the account can actually send.

Read the `option warnings` block out loud if it is there. A 0.2.x install still
carries `gate_mode`, which 0.3 reads and maps (`standard` → `gate: advisory`) while
saying so; `auto_mode` no longer does anything at all. The fix for both is one edit
in `/plugin` → jev.

Do not print or guess the API key. The report says only whether one is configured,
and that is all the user needs.
