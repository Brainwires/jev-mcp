---
name: calibrate
description: Report how the jev gate has actually behaved — what Claude was told, what was suppressed, how every tripwire ended, and how many notes a different threshold would have produced.
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

# /jev:calibrate

Run exactly this command with the Bash tool and show its output verbatim:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs" calibrate
```

Then help the user read it, and be precise about what each section is:

- **1. What Claude was told** — notes emitted, and everything the table called for
  and then suppressed, by reason. The suppression counts are the interesting half:
  they are the notes the user did not have to read.
- **2. Tripwires** — every trip, and how it ended. A trip that was **not
  re-issued** is the strongest evidence available that the gate changed what
  happened. A trip re-issued with a marker is auditable: the marker text is printed
  at the end of the report. Three or more denies of the same call is reported as
  "stuck" rather than capped — a cap that went silent would be a bypass.
- **3. Marker hygiene** — `markers on calls that were never tripped` is the reflex
  metric. If it climbs, the agent is typing markers out of habit rather than
  answering a specific tripwire.
- **4. Signals, by what the gate did** — the distributions, split by outcome.
  `same_task_area` is logged and not consumed; the agreement line against
  `scope_step` is the evidence for promoting it to policy, or for dropping it.
- **5. The four replays** — `5a` gate, `5b` stop, `5c` screen, `5d` prompt kind.
  Each is exact, not an estimate: the log keeps every signal, every threshold and
  every policy option in force, so the report re-runs the same pure functions over
  the same records. Two honest gaps are printed with them — the gate replay counts
  before the per-session duplicate check and the five-note cap, and the stop replay
  covers the unfinished rule only, because what the last check command did is
  session state rather than log state. Records written by an older version replay
  on the rules they actually decided on.
- **6. How to read this** — the evidence hierarchy, printed in the report.

None of this measures whether a judgment was *correct*. Nobody was prompted, so
there is no human verdict to score against. If the user wants fewer notes, suggest
the smallest change the replay supports, and say what it costs.

One thing the replay cannot do is score a change to the *questions*: rewriting a
question moves every probability it produces, so replaying old records through new
thresholds compares two different measurements. That is measured with a pair of
captured fixtures instead — `npm run capture` before and after, then
`npm run capture -- --summary <fixture>` on each. Say so if the user asks whether a
question change helped.
