# Jev capability discovery — what the model can do and what jev-mcp is not yet using

Research date: 2026-09-18 (jev-1.13.0; jev-mcp 0.3.0). Sources: TypeSafe docs (34 pages incl. every
cookbook), evals.typesafe.ai, typesafe-ai/skills, Aera's memory study, Vercel AI Gateway, jkudish/jev-mcp,
jev-rerank-bench, the HN launch thread, this repo, and the plugin's own decision log (395 records).

## A. Fundamental capabilities and limits

- **One endpoint, one operation.** `POST /v1/systemone` `{state, model, questions}` → one typed answer per
  question id (ids never reach the model). Noul → P(yes), no confidence; Choice → `choice`,
  `probabilities` (sum 1), `confidence`; Score → probability-weighted `score` over ordered levels, `legend`,
  `probabilities`, `confidence`. Confidence = distribution peakedness; probabilities are the primary signal.
- **Hard limits.** Choice ≤255 options (reliable to ~240); Score 2–10 levels (11 is a server error); 64k
  tokens state+questions, **32k for state + the single longest question**. **Text/JSON only** — no images,
  audio, files, URLs, embeddings. English primary.
- **Structure.** `instructions` AND `criteria` (Choice option descriptions, Score levels, Noul true/false)
  accept `string | object | array | null`. Docs idiom: `{question, focus, inspect|compare}` for
  instructions; `{what, not_for, examples}` for options; `{summary, signals}` for levels; backticked dot-paths
  into state. Examples in a Score's levels raised confidence 0.81→0.91 in the docs' own example.
- **Fan-out economics.** All questions in a request run in parallel over one ingested state; extra questions
  cost only their tokens. Measured: 13 batched vs 13 calls = 12.2× cheaper, 10.0× faster, identical answers.
  A second request is justified only when the first answer is needed to *build* the next state/options.
- **Cost / speed / limits.** $0.042/M input, output free; 250k tok/s, 1,200 rpm, "adjusting dynamically";
  no free tier. Our log: p50 547 ms, p95 3,657 ms, mean 1,666 input tokens per judged hook call (~$0.00007).
  Aliases move — pin `jev-1.13.0` once thresholds are tuned.
- **Calibration.** RLCD-trained; calibration is a group property, not a per-answer guarantee. Independent
  ECE (jev-rerank-bench): 0.097–0.098 for Noul configs vs 0.112 for DeepSeek P(yes); confidence bands held
  (conf <0.5 → 48% right, 0.5–0.9 → 75.5%, ≥0.9 → 94%). Self-consistency sd ≈ 0.01 over 15 repeats.
- **Jagged edges (jev-1.13, reviewed 2026-09-17):** literal reading; no counting/arithmetic; numeric
  representations (hex/RGB/px) underperform semantic ones; don't interpolate a Score into a number; dates
  read as text; indirection / double negatives / multi-hop; context rot with irrelevant state; adversarial
  state moves answers; contradictory instructions vs criteria; **no structural invariants** — the same
  question as a Noul gave 0.22 while as a yes/no Choice gave yes 0.01 / no 0.99; a Noul and its negation
  summed to 1.19. Choice is relative ("which"), Noul is absolute ("whether"): never carry thresholds across
  types. Weakest vendor eval is invoice processing (numeric/date-heavy): 61.8% vs 79.1% for a reasoning model.
- **Versus LLMs (vendor evals):** mean workflow accuracy Jev 67.8% / $0.0004 / 0.4 s per case vs Sonnet 5
  67.8% / $0.1174 / 78 s and Opus 5 73.1% / $0.1761 / 38 s. Reranking (independent, 8 BEIR sets): nDCG@10
  0.692 vs Cohere Rerank 4 Pro 0.691, top-1 +3.1 pp, $0.41 vs $2.51 per 1k queries — but reversing passage
  order flipped Jev's top pick on 24.7% of queries.

## B. Documented patterns and cookbooks

Patterns: **speculative fan-out** (ask every branch's questions, code discards); **confidence-gated
routing** (0.6 floor, per-action thresholds scale with stakes); **composite scoring** (one Score per
dimension, weights in code); **intent routing** (Choice intent + Score complexity → code / specialist LLM /
human). The "how to build" page's canonical harness example is **verifying a tool-call trace** decomposed
into 9 Nouls (tool relevant to request, args conform to schema, result id matches call, units match)
instead of one "is the trace correct?".

| Cookbook | Mechanism | Reported result |
|---|---|---|
| rerank | BM25 top-30 → 1 Noul per (query, passage), sort by p | top-1 5%→18%, top-10 38%→62%; $0.0645 for 1,200 calls |
| semantic_find | doc as `L052\| …` tagged lines; **Choice over 218 line ids** + `exists` Noul | exists 0.98 on real answers; exists 0.14 while top line still 0.86 when absent — the Noul says "not here" |
| autoformat | pass 1: Nouls "does line N continue mid-sentence"; pass 2: 62 questions over 17 blocks incl. speculative companions | 0.8 s, 10k tokens; wording ablation: "same paragraph" collapsed lists, "mid-sentence" did not |
| function_calling | 54 questions per command: Choice over functions + Choice per Literal arg + `stated?` Noul per arg; confidence = min over parts | 14/14; low confidence surfaced as "weakest argument" |
| skill_suggestion | req 1: Choice over 182 skills + 3 gate Nouls; req 2: Choice over top-3 with bodies + absolute `fits` Noul each; inject one hedged line | wrong loads 16.8%→7.3%, needless 9.8%→4.0%; 0.16–0.31 s per pass |
| entity_alignment | **3-level Score whose levels are the outcomes** (unlink / curator / merge); decision = round(score); no thresholds | 450 pairs → 8.9% merge, 11.1% curator |
| classifying_rag_passages | per passage: relevant, evidence, **contradicts_premise**, injection Nouls; ordered cascade in code, injection first | injection 0.99 on a passage embeddings ranked #1; false-premise query → honest answer |
| citation_check | stage 1 in code: substring match (miss → `fabricated`, no call); stage 2 Choice supports/contradicts/says_nothing; auto ≥0.8 | 4/4 accurate verified ≥0.93; 4/4 planted failures caught |
| llm_guardrails | 4 hazard Nouls + shared severity Score, both directions; named policy dicts | jailbreaks 0.74–0.98; policy swap costs 0 calls |
| parallel_questions | 13 mixed questions over a 54k-char article | 12.2× cheaper, 10.0× faster, no answer shift |
| sde_cascade | cheap extractor → per-field "is this bad" Noul battery → `max` gate 0.7 → escalate | Pareto frontier above every single model |
| date_extraction | 7 speculative Choices (month/day/year/…) with `none`; calendar math in code; confidence = min of parts | 6/6; never-stated date scored 0.46 → review |
| pre_parsed_value_extraction | regex over-finds spans; **Choice whose keys are the spans** + `none`; code copies verbatim | 0.90–1.00; value cannot be invented |
| hierarchical_classification | Choice per tree node over children, beam K=3, geometric-mean path score (incl. a codebase file-tree walk) | beam 4/4 vs greedy 2/4 |
| classification_using_confidence | one Choice over 75 groups; confidence <0.9 → report the parent level | confident half 90% right; unsure half 40%→70% one level up |
| consistency (noul/choice) | rubrics ×15 repeats; uncertain band 0.30–0.70 → human | 111 ms, $0.00004 per 14-question rubric; ~100× faster, ~800× cheaper than reasoning models |

Independent builds: **Aera** — one Noul per memory candidate in one request: precision 79%→85% at 147 ms vs
463 ms; failure modes: blind to on-screen content, re-reads with longer excerpts collapsed strong candidates,
template prompts give flat distributions. **jkudish/jev-mcp** — verify / screen / find (Choice over ≤250
ids + exists Noul); a subset of ours but with Choice-based ranking. **Vercel AI Gateway** exposes Jev via AI
SDK `evaluate`. **HN thread**: main critique "schema-valid ≠ correct", conceded by the CEO.

## C. Gap analysis

### (a) Agent decision-making
1. **Scope is a multi-hop question** ("does the request ask for this action, or plainly require it as a
   step?") — jaggedness §Indirection. Log: across 211 allowed actions median `in_scope` = 0.33; the research
   agent's own scratchpad rewrite tripped (destructive 0.95 — literally true; in_scope 0.05 — judged against
   the *top-level user's* prompts, not the subagent's task). **Fix:** `ignoreScope` when `agent_type` is
   set; structured state `{action: {tool, command|file_path, target_paths[]}, request: {latest, previous[]}}`;
   literal fan-out (`mentions_target`, `same_task_area`) plus a **3-level Score whose levels are the
   outcomes**: explicitly requested / an ordinary step of the requested work / unrelated. Round it; no
   threshold. Effort S.
2. **State is a flattened string** (`"Bash {json}"`, 4,000 chars of concatenated prompts) — the docs'
   "named fields, point by path, send only what the question needs". Effort S.
3. **Structured criteria unsupported** (`criteria` is string-only in `src/decision/types.ts` and
   `src/tools/shared.ts`). Widen to the docs' `EntryType`; rewrite gate/stop/injection criteria with
   `what / not_for / examples` (e.g. `destructive.false.not_for: "rewriting a file the agent itself created
   this session"`). Effort S; measure `silent-uncertain` share before/after.
4. **Prompt routing is unused.** `route_prompts` classifies but nothing consumes it. skill_suggestion is a
   drop-in: rank installed skills/commands/subagent types, re-read top 3 bodies, inject one hedged line;
   feed kind + ambiguity to fable-lite delegation. Effort M.
5. **PostToolUse screen is partial** — only head+tail of the text; add `contradicts_premise` and chunk the
   full text with `max` in code. Effort S.
6. **Stop check sees no evidence but the ledger.** Add claim extraction in code (file:line references,
   quoted identifiers) → deterministic existence check (citation_check stage 1, no call) → `runVerify` of
   the remainder against `git diff` / the named files. Effort M.
7. **No subagent report verification** (sde_cascade over a subagent's report vs its transcript) — blocked
   on the harness exposing the task text; feasible as a library call in a custom harness.
8. **Score magnitudes.** Notes print `blast radius 2.43 of 3` and policy thresholds on the expectation;
   docs say threshold on level probabilities, never interpolate. Use `p[2]+p[3]`. Effort S.

### (b) Code development
1. **Semantic code lint** (use-case map "semantic code linting"): on Edit/Write, one request over
   `{file_path, old_string, new_string, conventions: <CLAUDE.md excerpt>}` with a Noul battery — removes a
   test/assertion; swallows an exception; hardcodes a secret/URL/absolute path; adds `any`/`@ts-ignore`/
   `eslint-disable`; changes a public signature; leaves TODO/placeholder; violates a named convention (one
   Noul per convention line). Plus the docs' own `pr_scope` Score on the staged diff before commit. ~$0.00006
   per edit. Effort M.
2. **`jev_pick`: choose from enumerated candidates instead of guessing** (pre_parsed_value_extraction):
   grep hits, symbols, failing test names, files → Choice whose keys are the ids + `none`, plus an absolute
   `fits` Noul each. Effort S (reuses `rank.ts`).
3. **Ranking should be relative, not absolute.** `jev_rank` asks an absolute Noul per candidate; the flat
   0.84–0.87 scores and the 0.02 top-3 gap are the predicted symptom. semantic_find/skill_suggestion use a
   **Choice over ids** (forces discrimination, 218 options in one request) and keep a Noul only for "is
   anything relevant". Add the Choice in the same request (free), order by it, raise the per-request cap
   toward 100–200 chunks → ~10× fewer requests. Keep "trust top 1–3" (order-reversal flips 24.7%). Effort M.
4. **Tree walk for large repos** (hierarchical_classification): Choice over directory children, beam K=3.
   Effort M; after 3.
5. **Failure diagnosis routing**: add `failure_kind` Choice to `jev_next_step` so code can pick a fix
   recipe. Effort S.

### (c) Frontend / design
Hard boundary: **Jev never sees pixels.** A screenshot must first be described (VLM, DOM, axe-core, computed
styles) and Jev judges the description. Numeric visual properties (contrast ratio, px, hex) are unreliable
in state — compute in code, pass **named buckets** ("largest text on the page", "contrast fails AA"), keep
Jev for the judgment ("does this colour read as a warning?" is the docs' own example).

Bounded judgments it can make well from source text or structured descriptions:
- **Semantic HTML / a11y rubric** (Nouls per component): interactive element without an accessible name;
  clickable `div` where a button belongs; image without meaningful alt; form control without a label;
  heading used for styling; focus state removed; colour as the only status cue; hover-only affordance.
  Counting-type checks (heading order, tab order) stay in code/axe-core.
- **Design-system conformance** (Choice over the *exported* token/component list + `none`): which token a
  raw value stands for; which library component this hand-rolled markup should be — after code has
  regex-found the raw values. Prevents hallucinated token names.
- **Copy tone and content** (Scores): formality, jargon density, terminology consistency vs a glossary,
  reading level, error-message helpfulness (says what happened / what to do / neither).
- **Structured visual hierarchy** (Scores over a JSON description: role, text, size-bucket,
  prominence-bucket, position-bucket): is the primary action the most prominent interactive element; more
  than one competing primary action; a single clear title.
- **Component/pattern selection** (skill_suggestion two-stage) against a component catalogue.
- **Spec conformance** (citation_check): each design claim vs the spec section.
- **Publish guardrails** (llm_guardrails battery): impersonation, fabricated records, credential forms.

Proposal: `jev_review_ui { paths|glob, tokens_path?, glossary_path?, rubric?: a11y|tokens|copy|hierarchy }`
that reads source, extracts raw values/strings in code, builds per-component state, returns per-check
probabilities with `where` line ranges; hooked as an advisory PostToolUse note on `*.tsx|*.vue|*.html|*.css`
writes and as a pre-publish step. ~$0.00013 per 300-line component. Effort M. Measure: agreement with
axe-core on its checkable subset; human labels on 50 tone/hierarchy judgments; zero raw-value false
positives on a token-clean repo.

## D. Things we do that the docs advise against

1. `in_scope` is multi-hop plan inference, judged against the wrong prompts inside subagents (C.a.1–2).
   The single biggest source of noise.
2. Stringified, oversized state instead of named fields and paths.
3. String-only criteria.
4. `jev_rank` packs 16 × ≤6,000-char chunks as distractor-heavy state for absolute Nouls — the "large
   state full of irrelevant detail" mode; the flat scores are the predicted symptom.
5. Score expectations used as magnitudes (`2.43 of 3`); threshold on summed level probabilities instead.
6. PostToolUse screens head+tail only — a mid-page injection is not in the state at all.
7. Compound/negated Stop question (`admits_unfinished` bundles four conditions and a negation) — split into
   literal Nouls and OR in code.
8. Hook latency vs timeout: p95 3,657 ms against a 1,500 ms abort; fail-open hides it (the 0.4 daemon
   removes process start + cold TLS).
9. One `auto` threshold shared by two-sided Noul gating and Choice `confidence` — different quantities per
   the invariants note; make thresholds per-type and replay them separately.

## E. Top 10 (ranked by value ÷ effort)

| # | What | Why | Effort | Measure |
|---|---|---|---|---|
| 1 | Rewrite scope: structured state, literal fan-out, outcome-level Score; ignore scope in subagents | §Indirection; log median in_scope 0.33 on allowed actions; false-positive trip in a subagent | S | replay: allowed-action in_scope median >0.7; instrumental trips → 0; the real trips kept |
| 2 | Structured criteria end-to-end; `what/not_for/examples` in every hook question | primitives/advanced; 0.81→0.91 in the docs' example | S | `silent-uncertain` share falls |
| 3 | `jev_rank`: Choice over chunk ids in the same request for order; Nouls for `any_relevant`; higher cap | semantic_find; rerank-bench top-1 +3.1 pp | M | README benchmark: `client.ts` rank 1; requests 11→≤3; `score_spread` ↑ |
| 4 | Skill/subagent/model routing on UserPromptSubmit wired to fable-lite | 2.3× fewer wrong skill loads in the cookbook | M | 50 labelled prompts; delegation cost per task |
| 5 | Semantic code-lint battery on Edit/Write + `pr_scope` before commit | use-case map; $0.00004 per rubric | M | precision/recall on 100 labelled edits; notes/prompt ≤5 |
| 6 | Stop-time claim verification: code reference check → `runVerify` against the diff | citation_check 4/4 planted failures | M | ≥90% planted false claims caught, ≤1 false block per 50 stops |
| 7 | `jev_pick` (Choice over enumerated candidates + `none` + `fits`) | pre_parsed_value_extraction; "Choice settles which, Nouls settle whether" | S | top-1 on 30 "which grep hit" tasks |
| 8 | `jev_review_ui` + advisory note on UI files | text-only model but exactly this shape of judgment | M | axe-core agreement ≥95%; tone agreement ≥80% |
| 9 | Full-text chunked screening + `contradicts_premise` note | classifying_rag (0.99 / 0.92) | S | planted mid-page injection ≥0.9; one note not five |
| 10 | Pin `jev-1.13.0` by default; threshold Scores by level probabilities; per-type thresholds in calibrate | models.md alias warning; invariants note | S | replay unchanged across an alias move |

Deferred: tree-walk file location (L), subagent report verification (needs harness data),
autoresearch-style rubric discovery for the lint battery (needs labelled outcomes first).
