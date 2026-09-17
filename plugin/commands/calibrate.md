---
name: calibrate
description: Report how the jev gate has actually behaved — the distribution of each signal, how often each rule fired, and how many prompts a different threshold would have produced.
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

# /jev:calibrate

Run exactly this command with the Bash tool and show its output verbatim:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs" calibrate
```

Then help the user read it, and be precise about what it is:

- The threshold replay is exact, not an estimate. The log keeps every signal, the
  blast radius and the policy options for each decision, so the report re-runs the
  same pure policy function at other thresholds over the same data.
- The approval correlation is one-sided. Claude Code reports that an escalated tool
  call later ran, which means the user approved it. It never reports a denial:
  `PermissionDenied` fires only when auto mode's own classifier denies a call, not
  when a human answers a prompt. So an escalation with no matching run may have been
  denied, interrupted, or abandoned, and the "approved" share is a lower bound.
- None of this measures whether a judgment was *correct*. It measures how often the
  gate fires and how often the user overrode it.

If the user wants fewer prompts, suggest the smallest change the replay supports,
and say what it costs.
