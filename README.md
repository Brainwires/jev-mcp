# jev-mcp

An MCP server — and an embeddable TypeScript library — for **Jev**, TypeSafe AI's
[System One](https://docs.typesafe.ai/concepts/system-one) model. Jev does not generate text: you give
it a `state` and a map of typed questions (yes/no, pick-one, rate-on-a-rubric) and it returns a
calibrated probability distribution over the answer space *you* defined, for every question in
parallel. That makes it a cheap, fast judgment primitive you can put inside an `if` — classification,
relevance, claim checking, and the go/no-go decisions an agent loop keeps guessing at.

This package turns that primitive into six MCP tools, a Claude Code plugin whose hooks put those
judgments at the harness boundaries, and a library that keeps all the decision logic in pure
functions you can import directly. Docs: [docs.typesafe.ai](https://docs.typesafe.ai).

## Install and configure

You need a TypeSafe API key (`TYPESAFE_API_KEY`). The server starts without one, but every tool call
will answer with an error telling you to set it.

### Claude Code

```bash
claude mcp add jev -e TYPESAFE_API_KEY=sk-... -- npx -y jev-mcp
```

Or from a local checkout:

```bash
npm install && npm run build
claude mcp add jev -e TYPESAFE_API_KEY=sk-... -- node /abs/path/to/jev-mcp/dist/index.js
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "jev": {
      "command": "npx",
      "args": ["-y", "jev-mcp"],
      "env": { "TYPESAFE_API_KEY": "sk-..." }
    }
  }
}
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.jev]
command = "npx"
args = ["-y", "jev-mcp"]
env = { TYPESAFE_API_KEY = "sk-..." }
```

### Environment variables

| Variable                | Default                    | Meaning                                                                 |
| ----------------------- | -------------------------- | ----------------------------------------------------------------------- |
| `TYPESAFE_API_KEY`      | *(required)*               | Bearer token. Missing: the server starts, tools return a clear error.    |
| `TYPESAFE_BASE_URL`     | `https://api.typesafe.ai`  | API base. Point at a proxy or a mock.                                    |
| `JEV_MODEL`             | `jev-latest`               | Model or alias. Pin `jev-1.13.0` if you have tuned thresholds.           |
| `JEV_TIMEOUT_MS`        | `30000`                    | Deadline for one logical call, retries included.                         |
| `JEV_MAX_RETRIES`       | `3`                        | Retries after the first attempt, on 429 / 529 / 5xx / network errors.    |
| `JEV_AUTO_THRESHOLD`    | `0.85`                     | At or above this certainty, `gate` is `auto`.                            |
| `JEV_REVIEW_THRESHOLD`  | `0.6`                      | At or above this (below `auto`), `gate` is `review`; below it, `escalate`. |
| `JEV_MAX_CONCURRENCY`   | `4`                        | Parallel requests when `jev_rank` has to chunk.                          |

Every tool result carries `model` (the versioned id that answered), `usage`, and `latency_ms`.
`jev_evaluate`, `jev_verify`, `jev_gate_action` and `jev_next_step` also accept
`thresholds: { auto, review }` to override the configured gating for one call.

## Tools

### `jev_evaluate`

The generic primitive: one state, many questions, one round trip. Everything else here is a
special case of it.

```jsonc
// input
{
  "state": { "ticket": "My payouts have been failing for 3 days." },
  "questions": {
    "urgent": { "type": "noul", "instructions": "Does `ticket` convey urgency?" },
    "team": {
      "type": "choice",
      "instructions": "Which team should handle `ticket`?",
      "criteria": { "billing": "Payments, refunds", "technical": "Bugs, outages", "other": "None of the above" }
    }
  }
}
// output (abridged)
{
  "answers": {
    "urgent": { "type": "noul", "noul": 0.93, "certainty": 0.93, "verdict": "yes", "gate": "auto" },
    "team":   { "type": "choice", "choice": "billing", "probabilities": {...}, "confidence": 0.88, "gate": "auto" }
  },
  "thresholds": { "auto": 0.85, "review": 0.6 },
  "model": "jev-1.13.0", "usage": { "input_tokens": 312, "output_tokens": 48 }, "latency_ms": 240
}
```

`gate` is computed in code, never by the model. Choice and Score gate on `confidence`. A Noul has no
confidence, so it gates two-sided on `max(p, 1 - p)` and reports `verdict` — a confident *no* is
`0.02`, which must not read as low certainty.

### `jev_rank`

Relevance-rank up to 500 candidates against a query: one Noul per candidate, plus an `any_relevant`
Noul that tells you whether the whole set is a dead end. Oversized sets are auto-chunked to fit the
context budget and run with bounded concurrency.

```jsonc
// input
{ "query": "How do I handle rate limits?",
  "candidates": [{ "id": "doc:a", "text": "..." }, { "id": "doc:b", "text": "..." }],
  "top_k": 5, "min_relevance": 0.5 }
// output
{ "ranked": [{ "id": "doc:b", "relevance": 0.95, "rank": 1 }],
  "any_relevant": 0.95, "chunks": 1, "total_candidates": 2, "model": "...", "usage": {...}, "latency_ms": 310 }
```

Candidate ids never reach the model: candidates go in as an index-keyed array and the indices are
mapped back in code. Candidate text is not echoed back — keep your own id → text map.

### `jev_verify`

Check up to 100 claims against one block of evidence, closed-world.

```jsonc
// input
{ "claims": ["Payouts settle in 2 days.", "Refunds are automatic."], "evidence": "Payouts settle in 5 business days." }
// output
{ "claims": [
    { "claim": "Payouts settle in 2 days.", "verdict": "contradicted", "probabilities": {...}, "confidence": 0.91, "gate": "auto" },
    { "claim": "Refunds are automatic.",    "verdict": "not_addressed", "probabilities": {...}, "confidence": 0.87, "gate": "auto" }],
  "summary": { "supported": 0, "contradicted": 1, "not_addressed": 1, "needs_review": 0 },
  "all_supported": false, "model": "...", "usage": {...}, "latency_ms": 280 }
```

A claim that is true in the world but absent from the evidence comes back `not_addressed` — which is
the answer you want when you are hunting unsupported assertions. `all_supported` is true only if
every claim is `supported` **and** every gate is `auto`.

### `jev_gate_action`

Advisory pre-flight check on an action an agent is about to take. Five judgments in one request
(`destructive`, `outward_facing`, `in_scope`, `credential_exposure`, and a 4-level `blast_radius`
score), then a deterministic policy in code.

```jsonc
// input
{ "action": "Bash(git push --force origin main)", "user_request": "run the unit tests" }
// output
{ "decision": "block",
  "reasons": ["The action destroys or overwrites existing data.",
              "The action affects people or systems outside this machine.",
              "The action does not look like something the user asked for."],
  "signals": { "destructive": 0.97, "outward_facing": 0.95, "in_scope": 0.03, "credential_exposure": 0.01 },
  "signal_leans": { "destructive": "yes", "outward_facing": "yes", "in_scope": "no", "credential_exposure": "no" },
  "blast_radius": { "score": 2.7, "legend": {...}, "confidence": 0.9 },
  "model": "...", "usage": {...}, "latency_ms": 260 }
```

The policy: **block** when the action leans out of scope *and* is destructive or outward-facing;
**confirm** when any risk signal leans yes, the blast radius is ≥ 2, the action leans out of scope, or
any signal sits in the uncertain band (neither ≥ `auto` nor ≤ `1 - auto`); **allow** otherwise. It is
a pure function (`gateActionPolicy`) with a truth-table test.

Two options narrow it for callers who are not an agent asking about its own next step — the plugin's
hooks use both. `ignoreScope` drops `in_scope` from every rule and from the reasons, for when the
user's request is genuinely unknown. `uncertain: "risky-lean"` confirms on an uncertain signal only
when it leans the unsafe way (`p ≥ 0.5` for a risk signal, `p < 0.5` for `in_scope`), because prompt
fatigue is the main failure mode of an automatic gate. Neither is part of the MCP input schema: they
are passed in-process through `run`'s `input.policy` or `config.gatePolicy`, since a model asking for
its own uncertainty to be ignored is not a request to honour.

**This is not a security boundary.** See *Limits & caveats*.

### `jev_next_step`

Agent control flow: `continue` / `retry` / `change_approach` / `ask_user` / `done`, plus the signals
behind it. Code overrides the model where it must not have the last word.

```jsonc
// input
{ "goal": "make the test suite pass", "last_step": "ran npm test",
  "result": "1 passed, 4 failing", "attempts": 1 }
// output
{ "next": "continue",
  "reasons": ["Model suggested `done` (confidence 0.91).",
              "Downgraded `done` to `continue`: goal_complete is 0.40, which does not clear the auto threshold (0.85) as a yes."],
  "signals": { "step_succeeded": 0.2, "error_is_transient": 0.05, "goal_complete": 0.4, "result_relevant": 0.9 },
  "choice_probabilities": {...}, "confidence": 0.91, "model": "...", "usage": {...}, "latency_ms": 250 }
```

`done` is downgraded to `continue` unless `goal_complete` gates a confident yes; `retry` becomes
`change_approach` once the error stops looking transient or `attempts` reaches 3. `attempts` is
compared **in code** and is never sent to the model — Jev does not compare numbers reliably.

### `jev_list_models`

No input. Passthrough of `GET /v1/models`: the names and aliases your account can send in `model`,
with descriptions and release dates. Costs no tokens.

## Embedding in a harness

```ts
import { JevDecisionModel, runGateAction, runVerify, runNextStep } from "jev-mcp";

const jev = new JevDecisionModel({ apiKey: process.env.TYPESAFE_API_KEY!, model: "jev-1.13.0" });
const config = { model: "jev-1.13.0", thresholds: { auto: 0.85, review: 0.6 }, maxConcurrency: 4 };

// Before a destructive tool call:
const check = await runGateAction(jev, { action: toolCallDescription, user_request: userTurn }, config);
if (check.decision === "block") throw new Error(check.reasons.join(" "));
if (check.decision === "confirm") await askTheHuman(check);
```

**Mandatory checks belong in the harness, not in the MCP surface.** A check an agent can decline to
call is not a check. Put these at the boundaries your loop actually crosses:

- **before a destructive or outward-facing tool runs** → `runGateAction`, and honour `block`.
- **after a search or retrieval step** → `runRank`, and if `any_relevant` is low, change the query
  instead of reading the top hit anyway.
- **before declaring the task done** → `runNextStep` (which will not return `done` on a weak
  completion signal), or `runVerify` over the claims in your final message.

Every `run*` function takes a `DecisionModel` (the interface in `src/decision/types.ts`) rather than
the concrete client, so you can pass a fake in tests or swap in a structured-output LLM adapter. The
policy layer — `gate`, `gateNoul`, `lean`, `gateActionPolicy`, `nextStepPolicy`, `allSupported` — is
pure and testable on its own. MCP exposure is for interop with tools you do not control.

## Claude Code plugin

The same core also ships as a Claude Code plugin. The MCP tools above are things Claude can choose to
call; the plugin's **hooks** are things that happen whether or not Claude wants them to, at the
points where the harness hands control to a tool, to a fetched page, or back to the user.

```bash
/plugin marketplace add Brainwires/jev-mcp     # or a local path to this repo
/plugin install jev@brainwires-jev
```

Then set the API key: `/plugin` → jev → **TypeSafe API key**. Without a key the judgment hooks stay
inactive — the deterministic pattern checks still run — and the plugin says so once per session.

The plugin installs with no build step: `plugin/dist/hook.mjs` and `plugin/dist/mcp.mjs` are
committed, dependency-free, esbuild-bundled single files. Node >= 20.

### What each hook does

| Boundary | What it judges | What it can do |
|---|---|---|
| `PreToolUse` on Bash, Write, Edit, MultiEdit, NotebookEdit, MCP tools | Is this action destructive, outward-facing, touching credentials, wide in blast radius, or outside what you asked for? | Raise a permission prompt (`ask`), or `deny` in `dontAsk`/`bypassPermissions` where no prompt would be shown |
| `PostToolUse` on WebFetch, WebSearch, MCP tools | Does this result contain instructions addressed to an AI agent? | Add one line of context telling Claude to treat the result as data. Never blocks, never rewrites the result |
| `PostToolUse` / `PostToolUseFailure` on gated tools (async) | — | Nothing. Records that an escalated call went ahead, for `/jev:calibrate` |
| `Stop` | Does Claude's own final message say part of the requested work is unfinished, while not waiting on you? | Ask Claude to continue, at most once per prompt |
| `UserPromptSubmit` | (bookkeeping, always) records your last few prompts so the other hooks know what you asked for. Optionally classifies the task kind | Add one advisory line |
| `SessionStart` | Is the plugin configured? | Say once when it is not |

A deterministic prefilter decides whether Jev is consulted at all, so reading files, running tests,
`git status`, and ordinary edits inside the project cost one process start and no API call. A small
set of catastrophic shapes — `rm -rf ~`, `git push --force` to main, `git reset --hard`, `DROP TABLE`,
`mkfs`, `dd of=/dev/…`, `chmod -R 777`, a fork bomb — skip the model entirely and go straight to a
prompt, because a regex is more reliable than a classifier for those.

### Two guarantees

**Escalate-only.** A hook can emit nothing, `ask`, `deny`, added context, or a Stop block. It can
**never** emit `permissionDecision: "allow"`. Jev is not injection-hardened, so a tool input written
to argue for its own approval must not be able to produce an approval. The type that carries the
decision has no `allow` member, and the test suite asserts that no code path and no shipped bundle
contains one.

**Fail open, silently.** No API key, a timeout, a network or API error, malformed stdin, a bug — all
of them end as exit 0 with empty stdout, with the error recorded in the decision log. A gate that
breaks your session because an API was down is worse than no gate. Per-call timeout is 1500 ms with
no retries, under a 3500 ms hard wall clock, under the 5 s hook timeout.

### Privacy

When a hook consults Jev, it sends TypeSafe's API: the tool name and its arguments (or an excerpt of
a tool result, or your last few prompts, or Claude's final message), each redacted best-effort for
things that look like secrets — `sk-…`, `ghp_…`, `AKIA…`, `Bearer …`, `password=…`, PEM blocks, long
hex blobs — and truncated. Redaction is a net, not a guarantee.

Everything is local otherwise. State lives in `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/jev-…`):
`sessions/<id>.json` with your last three prompts, pruned after 7 days, and `decisions.jsonl`, an
append-only log rotated at 5 MB. Nothing is sent anywhere else, and the API key is never written to
either.

To send less:

- `gate_mode: off` — no tool-call judgments at all.
- `screen_results: false` — never send tool results.
- `route_prompts: false` (the default) — never send prompt text for classification.
- `stop_check: false` — never send Claude's final message.
- `/jev:off` — everything off for this session; `JEV_HOOKS_DISABLE=1` — everything off, always.

### Commands

- `/jev:status` — configuration, 24-hour counts by event and decision, p50/p95 latency, token spend
  and estimated cost, error count and the last error. Never prints the key.
- `/jev:why [n]` — the last n escalations with their signals and the rules that fired.
- `/jev:calibrate` — signal distributions, firing rates, and an exact replay of your own log at other
  thresholds, plus the approval correlation (see below).
- `/jev:off`, `/jev:on` — per session.

### Configuration

| Option | Default | Effect |
|---|---|---|
| `api_key` | — | TypeSafe API key. Stored in your keychain, never in a settings file |
| `gate_mode` | `standard` | `off`, `standard`, or `strict`. `strict` also judges ordinary in-project edits and treats every uncertain signal as a reason to ask |
| `auto_mode` | `advise` | What a confirm-grade judgment does while the session is in auto mode. `advise` adds a `[jev]` note to Claude's context and abstains, so Claude Code's auto-mode classifier decides and you are not prompted. `ask` prompts anyway. Out-of-scope actions that are destructive or outward-facing, and the hard-coded patterns, prompt either way |
| `stop_check` | `true` | The `Stop` hook |
| `screen_results` | `true` | The `PostToolUse` screen |
| `route_prompts` | `false` | Prompt classification |
| `auto_threshold` | `0.85` | Probability at or above which a signal counts as established |

Hooks read these from `CLAUDE_PLUGIN_OPTION_<KEY>`, falling back to `TYPESAFE_API_KEY` and `JEV_*`.

### Costs

A judged tool call is one request of roughly 500–2000 input tokens, so on the order of $0.00002–
$0.00008 each at $0.042/Mtok. The prefilter is what keeps that number small: in ordinary work most
tool calls never reach the model. `/jev:status` reports your actual spend.

### Limitations

- **Advisory, not a security boundary.** Jev is not hardened against adversarial text. Real
  enforcement is the permission system's job. Treat this as a layer that catches plausible mistakes.
- **`ask` has no audience in `dontAsk` and `bypassPermissions`.** There is no prompt to show, so a
  block-grade judgment becomes a `deny` addressed to Claude instead. In those modes the plugin is the
  only thing in the way, which is exactly when you should not be relying on it alone.
- **The gate does not see your request unless you typed one this session.** After a `/clear`, or on
  the first tool call of a resumed session, the scope signal is ignored rather than guessed at.
- **The Stop check only sees the final message.** It cannot tell a finished task from an unfinished
  one; it only catches Claude saying that work remains.
- **No denial signal.** Claude Code reports that an escalated tool call later ran, but never that you
  denied a prompt, so `/jev:calibrate` is a firing-rate report with a one-sided approval correlation,
  not an accuracy measurement.
- **`SubagentStop` is not wired up.** The event carries the subagent's final message but no
  documented access to the task it was given, and judging a subagent's report against the parent
  session's prompt would frame the question wrongly.

## Limits & caveats

- **Schema-safe is not the same as correct.** Jev cannot invent an option outside your `criteria`, so
  you never have to parse prose. It can absolutely pick the wrong one. Gate on the returned
  certainty; do not treat a well-formed answer as a verified one.
- **It reads literally.** It answers the question you wrote, not the one you meant. Scoping words,
  negations and implied conditions are taken at face value. Put boundary cases in `criteria`.
- **No maths, no dates.** It does not count reliably, cannot do arithmetic, and reads dates as text
  rather than as ordered quantities. Extract with a Choice over enumerated options, then compare in
  code. Do not interpolate a Score between levels to recover a number.
- **Context rot.** Accuracy falls as the state fills with detail unrelated to the question. Filter
  first and send only what the question needs.
- **Not injection-hardened.** State is data, and Jev does not treat it as hostile. Text written to
  steer the model — an injected instruction, a misleading framing, text arguing for its own
  classification — can move an answer. `jev_gate_action` is therefore an advisory judgment layer, not
  a security boundary: never rely on it to contain untrusted input, and never let `allow` stand in
  for a real permission check.
- **Budget.** ~64k tokens for the state plus all questions, ~32k for the state plus the single
  longest question. This server estimates conservatively (3.5 chars/token) and fails locally with a
  message naming the limit rather than spending a round trip on a 422.
- **One judgment per question; batch aggressively.** Questions in one request are independent and run
  in parallel, so extra questions cost only their own tokens. Speculative questions you may not need
  are close to free.
- **Pin the version if you tune thresholds.** `jev-latest` is an alias that moves; set
  `JEV_MODEL=jev-1.13.0` (or pass `model` to `jev_evaluate`) so a release does not shift calibration
  underneath your gates.
- **Pricing.** $0.042 per million input tokens as of 2026-09; output tokens are free. Rate limits are
  adjusting dynamically — the client retries 429/529 with jittered exponential backoff and honours
  `retry-after`.

## Development

```bash
npm install
npm run type-check
npm run build         # tsc build, then the two esbuild plugin bundles
npm run build:plugin  # plugin/dist/hook.mjs + mcp.mjs only
npm run test:run
npm run smoke         # live, one tiny request; skips when TYPESAFE_API_KEY is unset
npm run dev           # tsx watch, stdio
```

`plugin/dist/` is committed on purpose — a plugin install runs no build step — so rebuild it in the
same commit as any change under `src/hooks/`. The build fails if the MCP SDK or zod ever reach the
hook bundle.

`src/decision/types.ts` is the provider-agnostic contract. `src/decision/` holds pure logic (policy,
budget, validation), `src/jev/` the HTTP client, `src/tools/` one file per tool with a pure `run`,
and `src/server.ts` the MCP wiring. `src/hooks/` holds the plugin: pure prefilters and policies, one
handler per event, each written as `(input, deps) => Promise<HookOutput | undefined>` so tests inject
a fake `DecisionModel` and a temp data directory. Tests use an injected fake `fetch` or a fake
`DecisionModel`; nothing in the suite touches the network. `claude plugin validate ./plugin` and
`claude plugin validate .` check the manifests.

## License

MIT © Brainwires
