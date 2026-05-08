# AI Editor — Roadmap

> Last updated: 2026-05-08 · Current released (tagged) version: **1.9.1** · `main` HEAD: **1.13.0**. `1.6.6`–`1.6.14`, `1.7.0`–`1.7.2`, and `1.8.0`–`1.9.1` are tagged on the release line; **1.10.0 (Plan Mode, github#25) and 1.11.0 (ChatHistoryStore + per-conversation scratchpad) sit in main untagged**, awaiting the next release-readiness gate. The 1.8.3 → 1.9.1 stretch closed AST Phase 2 (lever B shipped 1.8.1) and shipped structured user-interaction in two halves: 1.9.0 added the `ask_user` tool, 1.9.1 added the queued-user-input drain — both halves of [github#33](https://github.com/gobha-me/ai-editor/issues/33), now functionally complete. 1.8.5 sits between them as a cost-reporting accuracy fix (`extractUsage()` provider parsing). 1.10.0 ([github#25](https://github.com/gobha-me/ai-editor/issues/25)) layered Plan Mode on top of the `pendingUserResponse` seam introduced for `ask_user`; 1.11.0 paid off two structural risks — `ChatHistoryStore` encapsulation (one owner of `State.chatHistory` mutations + persistence; closes the recurring "missed Storage.set site" pattern from issue #16) and per-conversation scratchpad persistence (rides in the `conv-{id}` payload alongside todos, survives refresh, dies with the chat).

## How to read this doc

Roadmap = where we're going. Shipped work and per-PR rationale live in [CHANGELOG.md](../CHANGELOG.md) — don't duplicate it here.

- **Now / Next / Later** — where we are at a glance.
- **Active track** — in-flight work, sized to PRs.
- **Later** — committed tracks queued behind the active one.
- **Deferred / unscheduled** — work that was planned, designed, or partially started but isn't currently scheduled. Triage owed.

## Now / Next / Later

| Phase | Track |
|---|---|
| **Just shipped** | **1.6.0–1.6.14 + 1.7.0–1.7.2 + 1.8.0–1.8.5 + 1.9.0–1.9.1 + 1.10.0 + 1.11.0 — Chat Stability → retrieval caches → MCP polish → tool-ergonomics post-mortem → security/conventions/export-fix trio → AST-aware C-family chunker (Phase 1) → cross-request cache invalidation on mutation → AST Phase 2 lever-C measurement → TodoRead/TodoWrite tools → AST Phase 2 lever-B production (cross-file query expansion) → tool-aware refusal-envelope hint → `edit_file` overlap detection + Debug slide-out Clear button → scratchpad visibility panel (closes github#34) → accurate provider usage parsing for cost reporting → `ask_user` structured-question tool (github#33 Phase 1) → queued user input during long runs (github#33 Phase 2) → Plan Mode (github#25) → `ChatHistoryStore` encapsulation + per-conversation scratchpad.** Twenty-eight in-track changes in main, tagged through `v1.9.1`; `1.10.0` and `1.11.0` sit in main untagged pending the next gate. **1.10.0** layered Plan Mode on the `pendingUserResponse` seam from 1.9.0: read-only tool catalog filter via `ToolDefinition.readOnly` + `ToolRegistry.filterReadOnly`, `submit_plan_for_approval` tool, plan-approval card mirroring the ask-user-card lifecycle, Plan Mode chip + system-prompt addendum, optional auto-engage on issue start. **1.11.0** introduced [`js/chat/history-store.js`](../js/chat/history-store.js) as the single owner of `State.chatHistory` mutations + persistence (closes the recurring "missed `Storage.set` site" pattern from issue #16; sixteen sites consolidated to one) and pinned the scratchpad to the conversation: it now rides in the `conv-{id}` payload alongside todos, survives refresh, gets cleared on new chat, and dies when the conversation it belongs to is deleted. **1.8.2** added `getRefusalHint(toolName)` to concatenate a behavioral next-action hint into REFUSED envelopes so cheap-tier models break out of identical-args loops without escalating tier (HTML-Games dogfood, Grok-4-3 looping on `get_ci_status`). **1.8.3** rewrote `EditTracker.checkStale` RULE 3 to be overlap-aware — pre-1.8.3 used `e.startLine < targetStartLine` and missed both same-startLine re-edits and target-overlaps-edit-from-above, allowing the destructive `replaceRange` to silently mutate lines whose content had already been replaced (the HTML head/wrapper damage cluster in PRs #115–#127 of html-games); same release added the missing Clear button to the Debug slide-out, closing the breakout #124 UX gap (clear-log-button regression + sticky `#btnDebugMenu` red badge). **1.8.5** centralized provider-usage extraction into `extractUsage()` so Anthropic / OpenAI / Venice / OpenRouter all report `cacheReadTokens` + `cacheCreationTokens` consistently on `ConvCost`. **1.9.0** shipped the `ask_user` tool: an inline question card pauses the tool loop, supports single-select / multi-select / free-text answer types, and lands user replies via a new `pendingUserResponse` chat-state seam. **1.9.1** closed the github#33 gap where Enter-presses during a chat run were silently swallowed: a module-level `pendingMessageQueue` (FIFO, `MAX_QUEUE = 5`, oldest-dropped on overflow) drains inside `chat/handlers.js` *before* the forward-progress check, the queued-input panel mirrors the scratchpad-panel lifecycle, and the textarea is no longer disabled while generating. Cancellation preserves the queue. |
| **Now** | **Slot reopened.** Plan Mode (1.10.0), ChatHistoryStore + per-conversation scratchpad (1.11.0), Plan Mode session-locality reframe (1.11.1), the **branch-switcher upgrade** (1.12.0 — Touch 3 extraction A), and the **inline ▶ Start button on issue rows** (1.13.0 — Touch 3 extraction B) all sit in main untagged. 2.0 Profiles is queued; remaining open issues (#37 Phase 2, #27, #24, #18) are slotted below. |
| **Next** | **2.0 Profiles** — Designed in [`docs/DESIGN-profiles.md`](DESIGN-profiles.md); not started. Slot opens with Phase 2 closed; ready to schedule. |
| **Later** | Open issues #37 (Phase 2), #27, #24, #18 (see *Known open issues* below) — none currently on the active track. |
| **Deferred** | Foundations (was 1.1.x), Compression (was 1.2.x), various UI items — see *Deferred / unscheduled* below. |

---

## TL;DR — architectural commitments

The four DESIGN subsystems (`docs/DESIGN-*.md`) describe an intelligence layer rebuild — retrieval, memory, compression, tools — coordinated by per-surface profiles. Three load-bearing commitments:

1. **Admissibility, not accumulation** — every byte the model sees has earned its place.
2. **Git-native memory** — memory and conversation state can opt into living in `.aieditor/*` files committed with the repo. No backend; notes follow the code across machines and forks.
3. **Measurement before scale** — the cost dashboard ships with the first eviction subsystem, not at the end of the arc. Each subsequent track lands against measured baselines.

A 2.0 ships when profiles become the load-bearing configuration surface.

---

## Cadence and versioning

**SemVer with intent.**

| Bump | Triggered by |
|---|---|
| Patch (`1.x.y → 1.x.y+1`) | Bug fixes, doc updates, security, small UI polish, single-rule additions inside an active track |
| Minor (`1.x → 1.(x+1)`) | New subsystem track lands Phase 1, or a self-contained feature spans multiple files |
| Major (`1.x → 2.0`) | The profile contract becomes the load-bearing configuration surface |

**Branching.** Main is protected. Every change goes through a PR from a topic branch. Gitea CI runs security lint + Docker build on every PR; tag push deploys to production. PR title convention: `feat(track):`, `fix(area):`, `chore(release):`, `docs(...)`. Squash + delete on merge. No "preview" or "beta" channels in 1.x — `:dev` Docker tag for PRs and `:test` for `main` provide preview environments.

**Release-readiness gate (added 2026-05-04, retroactive from `v1.6.0`).** Gates **release tag pushes**, not merges to main. Code can land in main behind a version bump (e.g. 1.5.14, 1.6.0, 1.6.1, 1.6.2 sit in main untagged) without triggering this gate; the gate fires when the next `vX.Y.0` tag is about to be pushed. **Pass criteria for tagging a minor:** drive a real chat session of ~10 turns with tool calls, run `find_relevant_files` against a query, make a code edit + commit, all in this repo. No silent history truncation; no broken-history 400s; no stale-state regressions in surfaces touched since the previous tag. **Patch tags** are exempt unless they touch the chat loop or the LLM request shape — though in practice patches inside an active track stay untagged until the next minor closes the bundle. **Why this exists:** between 1.5.5 and 1.5.13 the retrieval track shipped seven internally-correct minor versions while the chat surface had a known summarizer regression that made the editor unusable for long sessions. Shipping internally-correct code on top of an unusable surface is a release-criterion bug, not a roadmap-ordering bug. The gate is honor-system today (no automation); the dogfood result is recorded on the release tag annotation alongside the bundled-PR list.

---

## Track context: post-1.6.x dogfood + measurement

The 1.6.0 chat-stability minor (six PRs sized in [`docs/design/long-chat-stability/findings.md`](design/long-chat-stability/findings.md)) shipped 1.6.0–1.6.5 individually tagged through `v1.6.5`. Follow-on patches 1.6.6–1.6.14 plus the 1.7.x–1.9.x stretch are now all tagged on the release line through `v1.9.1`. **Per-PR rationale and shipped detail live in [CHANGELOG.md](../CHANGELOG.md)** — not duplicated here.

This section is the home for ongoing **dogfood + measurement** work chained off the chat-stability minor. It's not a "track" in the active-PR sense anymore, but the dogfood-battery framing was authored here and stays here for context continuity.

### Post-tag dogfood battery

**Original framing (historical).** The four-issue ai-editor self-test battery (github#20, #15, #23, #21) shipped through 1.6.0–1.6.11. github#21's substance landed in 1.6.11 (untagged on main); the *trace* portion exposed three concrete tool-ergonomics pathologies fixed in PRs [#289](https://github.com/gobha-me/ai-editor/pull/289)/[#293](https://github.com/gobha-me/ai-editor/pull/293): retrieval cold-start silence (`indexer_not_ready` envelope), stateful-read cache collisions (`STATEFUL_READ_TOOLS` bypass), and `edit_file` STALE LINE NUMBERS without surrounding context (`_getStaleWindow` + 5/5 success echo).

**Why we pivoted (2026-05-06).** The 1.6.11 post-mortem made the load-bearing pattern visible: ai-editor's tool loop runs nested inside the same indexing/caching/state system the test was meant to probe, so self-targeting amplifies fragility *into* the test rather than isolating it. Driving the battery against ai-editor itself stopped paying — the noise-to-signal ratio fell below useful, and partial fixes / fix-branches against the editor itself aren't acceptable as test outcomes.

**The north star is still the self-licking ice cream cone.** ai-editor *should* be the editor we use to maintain ai-editor — that's the whole point. HTML-Games is the bridge: a clean external substrate where we can isolate logic faults from runtime fragility, fix them with confidence, and *then* reattempt self-targeting once the fragility budget is paid down. It's also more fun, which matters for sustaining the work.

**New substrate: [HTML-Games](https://git.gobha.me/xcaliber/HTML-Games).** Private xcaliber repo, six standalone games (5 vanilla JS, 1 Cogfall on TS/Vite/Pixi). Modular, well-documented, varied complexity (Snake ~2.2K LOC → Cogfall ~10K LOC). External codebase whose state never feeds back into ai-editor's caches — clean isolation between target and runtime.

**Test-issue archetypes.**

| Archetype | Example | What it measures |
|---|---|---|
| Add feature to existing game | "Add pause to Space-Invaders" | Retrieval (find main.js + game.js + renderer.js), multi-file edit, stale-line behavior under sequential edits |
| Create new minimal game | "Build a Pong (paddle/ball/score) in vanilla JS matching repo conventions" | Planning, file creation, convention recall, zero-corpus retrieval behavior |
| Cross-game refactor | "Unify high-score `localStorage` between Snake and Forge-Defense" | Cross-file retrieval breadth, refactor proposal quality, compression preserving multi-file context |
| Bug fix in deeper code | "Fix multiplayer collision in Snake" | Root-cause diagnosis, sequential read pattern, tool-call ordering |

Cogfall is the step-up rung when needed: build-step, type errors, framework-shaped retrieval, an existing vitest suite.

**What we measure (logic, not the LLM).** Re-running the same task across a cheap model (Haiku) and a strong one (Opus) is the crux: faults reproducing on **both** are logic faults; faults only on weaker models are LLM faults. Capture per session:

- **Retrieval quality** — for each `find_relevant_files` call: query, returned set, hand-graded "right files?" yes/no. Track whether the indexer-readiness gate fired.
- **Tool-call quality** — did stale-line errors fire? How many recovery turns? Did `edit_file`'s 5/5 success echo carry enough surrounding context? Did `read_*` cache misbehave?
- **Compression behavior** — `localStorage.setItem('debug.dump.summarizerSnapshots', '1')` before starting. Per rebuild: `RECENT_COUNT`, `startIndex`, `info?.summary` presence, dropped count. Did the 1.6.0 truncation marker appear when warranted? 1.6.2 request-shape validator drop orphans (firing once is fine; repeatedly means upstream regression)? 1.6.4 token-based summarization fire when load warranted and not before?
- **Planning quality** — eyeball: did the model plan the work or hack? Sane edit order?
- **Cost-quality tradeoff** — `prompt_tokens` and `cached_tokens` per turn vs. the observed quality of the four axes above. The grading axis the others gate against. Two failure modes: **under-spend** (token cheap but compression / retrieval dropped what the model needed — output is wrong) and **over-spend** (tokens expensive but quality flat above some level — money for context the model never used). Cost-dashboard export via `buildCostExport()` ([`js/settings/cost-tab.js`](../js/settings/cost-tab.js)) at session end; per-strategy retrieval cost via [`cost-store.js`](../js/intelligence/cost/cost-store.js). See the **operational constraints** below for how we probe model-vs-logic faults given the editor's branch lifecycle and Jeff's testing budget.

#### Test design under operational constraints

Two real constraints shape how the battery actually runs.

**1. Branch lifecycle.** ai-editor auto-creates a branch when a session "starts" on an issue, with a guard against multi-start on the same issue. So we **cannot rerun the same task** against a different model the way the original cross-model probe assumed. The replacement is **sibling tasks**: pick an archetype, design 2-3 same-shape tasks against different games/features, assign a different model to each. Faults reproducing across all siblings are logic faults; faults visible on a single sibling are model-specific.

| Archetype | Sibling 1 | Sibling 2 | Sibling 3 |
|---|---|---|---|
| Add feature | "Add pause to Snake" | "Add pause to Space-Invaders" | "Add pause to Forge-Defense" |
| Cross-game refactor | "Unify highscore Snake↔Forge" | "Unify audio Snake↔SpaceInv" | (skip unless 1+2 disagree) |

Variation across game adds noise vs. the lab-clean rerun, but it's also a *better* probe — a logic fault that survives codebase variation is a stronger finding.

**2. Budget — $11/day.** The cross-model probe lives in the **cheap tier**. Opus and Sonnet stay out of the daily lineup; reserve Sonnet 4.6 for one anchor probe per week on the smallest archetype.

| Tier | Models | $/M in | $/M out | Per-session est. | Role |
|---|---|---|---|---|---|
| Cheap (default) | DeepSeek V4 Flash, Mistral Small 4, Grok 4.1 Fast | $0.17–$0.23 | $0.35–$0.75 | ~$0.40 | Default rotation across siblings |
| Code-aware | Qwen 3 Coder 480B Turbo | $0.35 | $1.50 | ~$0.60 | When the cheap tier flubs and we want a code-specialist comparison |
| Mid (escalation) | GLM 5, Kimi K2.6 | $0.85–$1.00 | $3.20–$4.66 | ~$1.20 | When cheap+code-aware both fail and we want to confirm logic-vs-LLM before declaring a fault |
| Strong-anchor (rare) | Sonnet 4.6 | $3.60 | $18.00 | ~$5.00 | One probe per week on the smallest archetype, to confirm the upper bound |
| Skip for daily | Opus 4.x, GPT-5.x Codex, Grok 4.20 | — | — | — | Budget killers; only on explicit need |

**Reading the matrix:** if a logic fault shows up on Cheap-tier-A but not Cheap-tier-B against sibling tasks of equivalent shape, that's noise / model-specific. If it shows up on **both** cheap-tier siblings AND survives the code-aware run, escalate one tier and confirm. If it survives mid-tier too, file as a logic fault with high confidence and hold the strong-anchor probe in reserve for next week's verification.

End-of-session deliverable: per-session markdown trace at [`docs/dogfood-battery/`](dogfood-battery/) — filename `YYYY-MM-DD-<short-task-slug>.md`. First trace establishes the template; do not pre-design it. These are the artifact, not throwaway notes.

**Grading.** Pass = trace is legible cold AND surfaces at least one logic-vs-LLM distinction AND the cost-quality tradeoff lands on the right side of the knee (under-spend with quality loss or over-spend with no quality gain both fail, even if every logic axis is clean). Output PR quality (does the editor produce mergeable code) is secondary — it's a lagging proxy.

**Preserved from the old plan: the release-readiness gate (§"Cadence and versioning").** Before any `vX.Y.0` tag push, drive a 10-turn ai-editor session **in this repo** with one `find_relevant_files`, one edit, one commit. Honor-system smoke test that the editor still functions on its own corpus. Unchanged.

**Out of scope for the new battery:** github#18 (cross-device settings sync via QR/P2P) — unbounded; tests product-design instincts more than logic. Automation/runners — first ~3-5 sessions are manual; abstract only when a pattern repeats.

---

## Later (sequenced)

### Decision: AST-based code chunker Phase 1 — shipped 1.7.0 (2026-05-06)

The polyglot benchmark ([PR #290](https://github.com/gobha-me/ai-editor/pull/290) `chore(retrieval): polyglot benchmark — fires AST chunker gate`, merged 2026-05-05) fired the gate. The 1.7.0 brace-depth-aware C-family lexer is the response. Per-PR rationale and chunker shape live in [CHANGELOG §1.7.0](../CHANGELOG.md) — the table below records the decision context, not the implementation.

**Pre-1.7.0 (the gate firing).**

| Repo | Files | Chunks | meanHit@5 | meanRecall@5 |
|---|---:|---:|---:|---:|
| armature (Go) | 746 | 1752 | 1.000 | 0.883 |
| **plinth (C++)** | **404** | **776** | **0.600** | **0.267** |

**Post-1.7.0 (Phase 1 shipped).**

| Repo | Files | Chunks | meanHit@5 | meanRecall@5 |
|---|---:|---:|---:|---:|
| armature (Go) | 746 | 1752 | 1.000 | 0.883 |
| **plinth (C++)** | **404** | **4400** | **0.800** | **0.300** |

Hit@5 lift is real: two previously-zero fixtures (`realtime-pubsub-broker`, `audit-logging-write`) now hit. Two stay zero (`capability-registry-api`, `rbac-enforcement-filter`) — those are scoring-side failures, not chunker-side: the integration-test files out-score the source files when both contain the query keywords. Phase 2 trigger.

Reproducible benchmark: re-run `tests/run-polyglot-benchmark.mjs` against the same `tests/fixtures/polyglot-corpus.js`. Future Phase 2 lever (vendored tree-sitter for parent-class-signature propagation, cross-file query expansion, or test/source weighting) must move the needle on **recall@5** specifically — Hit@5 is approaching ceiling now.

### Decision: AST Phase 2 lever C (test/source path weighting) — measured 1.7.2; insufficient alone

Cheapest of the three Phase 2 levers — the existing `applyScoreWeights` ([js/intelligence/retrieval/strategies/semantic.js:300](../js/intelligence/retrieval/strategies/semantic.js)) already supports prefix-keyed multipliers post-rank. 1.7.2 added a multi-config sweep to the polyglot benchmark and ran with `tests/` prefix penalties 0.5 and 0.3.

| Scope | baseline | tests-prefix-0.5 | tests-prefix-0.3 |
|---|---:|---:|---:|
| Armature meanRecall@5 | 0.883 | 0.883 | 0.883 |
| **Plinth meanRecall@5** | **0.300** | **0.400** | **0.400** |

Lift is real (+33% relative on Plinth, no Armature regression) but does not reach the 0.55 floor and does not move the two stuck-zero fixtures off zero. Why: demoting `tests/` only helps when the *correct* `src/` file is already in the top-5 candidate pool to be re-ranked. For `plinth-capability-registry-api` and `plinth-rbac-enforcement-filter` the right files (`registration.cpp/.hpp`, `enforcement.cpp/.hpp`) never enter the candidate pool — query keywords don't BM25-match the file content directly.

**Next lever has to widen the pool, not re-rank within it.** Lever C becomes a useful re-ranker layered on top of whichever of A/B ships, but on its own it doesn't carry past the floor. Production change held; no `defaultCodeScoreWeights` ships in 1.7.2.

### Decision: AST Phase 2 lever B (cross-file query expansion) — shipped 1.8.1 (2026-05-08)

The 2026-05-07 feasibility probe (PR #305) and the 2026-05-08 production wiring shipped together at 1.8.1; full per-PR rationale and result tables in [CHANGELOG §1.8.1](../CHANGELOG.md). The decision context — preserved here for roadmap continuity:

| Scope | baseline | lever C (tests-prefix-0.5) | lever B (best-of) | lever B (rrf-fused) | **lever B (rrf-alts-only)** |
|---|---:|---:|---:|---:|---:|
| Plinth meanHit@5 | 0.800 | 0.800 | 1.000 | 0.900 | **1.000** |
| Plinth meanRecall@5 | 0.300 | 0.400 | 0.467 | 0.367 | **0.467** |

The `lever-B-rrf-alts-only` sweep added in 1.8.1 closed the option-1 measurement gap: RRF over the alt rankings alone (baseline excluded from fusion) matches best-of at the aggregate and lifts both stuck-zero Plinth fixtures off zero, with no Armature regression. Production ships option 1 — simpler than confidence-weighted fusion, no oracle needed, degenerates cleanly when the rewriter emits one alt.

**Lever A stays parked.** The gap closed cleanly under a smarter query — it's rewriteable, not structural. Web-tree-sitter's parent-class-signature propagation isn't justified by current measurement; it stays a candidate only if a future fixture surfaces a chunk-content gap that no rewrite can paper over.

**Lever C** (test/source path weighting) remains opt-in via `MetadataFilter.score_weights` — the post-fusion re-ranker layered on top of lever B. Useful when the alts surface integration tests alongside source files; not the production default for the same reason 1.7.2 didn't ship a `defaultCodeScoreWeights` (insufficient lift on its own without lever B widening the candidate pool first).

### LLM reranker (scoped, not committed)

A candidate next-lever class for retrieval quality. Different in kind from every lever the §1.5.0 track shipped: every prior lever (T1–T5, BM25, paraphrase, Thematic) operated on the *candidate pool*. A reranker re-orders within the already-correct top-K — and `meanHitAt5 = 1.000` post-1.5.11 says the top-K is already correct for every fixture in this corpus.

**Sketch.** New `js/intelligence/retrieval/strategies/reranker.js` exporting `createReranker({ chatFn, modelId, prompt?, parser?, cache? })` and `buildRerankerFromSettings(settings, ...)`, mirroring [`createQueryParaphraser`](../js/intelligence/retrieval/query-paraphraser.js) (pure DI; production wires `chatFn = LLM.chat`; failure modes pass-through). Wiring seam: post-Composer, pre-block-assembly. Settings → Retrieval gains a section mirroring paraphrase (mode picker, `rerankModelId`, top-K).

**Locked default prompt skeleton (corpus-agnostic; subject to T9 measurement before commit).**

> *"You are a relevance-ranking assistant. Given a search query and a numbered list of code-snippet candidates, score each candidate 0–10 for how relevant it is to the query. Output one score per line in the form `N: <score>` matching the candidate index. No commentary. No invented scores."*

**Why deferred.** Cost-vs-lift sanity check before code is written: candidate-set N=20 chunks × ~50 tokens + prompt ~200 + N output scores ~100 = ~55k tokens per measurement pass. The budget impact on the live `find_relevant_files` path is the limiting factor. Decision to ship is Jeff's call against measured numbers.

### 2.0.0 — Profiles ascend [target: ~3 weeks after 1.6.x closes]

**What ships:**
- **Profile contract goes live.** `Profile { name, version, base, budget, retrieval, memory, compression, tools, task_ledger }` is the configuration surface.
- **Canonical profiles registered:** `chat.v1` (base), `coder.v1`, `kb.v1`. (`chat_multi.v1` and `rp.v1` shipped as stubs for plugin authors.)
- **Roles → profile presets.** The existing 5 roles become UI-friendly toggles over the profile's tool catalog. `role` setting persists for UX continuity; subsystems read from the resolved profile.
- **Task ledger** with novelty-based re-admission.
- **Settings migration script.** One-shot on first 2.0 load; `settings.role` translates to `settings.profile.preset`. Audit-logged.
- **Profile picker UI.** New top-bar selector — sits next to or replaces the role selector after dogfooding.

**Be ready to discover the profile contract is lighter than designed.** `DESIGN-profiles.md` describes profiles as the abstraction across five surfaces; ai-editor has one. If by 1.6.x the "profile" reduces to `coder.v1` plus a settings struct plus three knobs, that's a finding to celebrate — 2.0 ships a contract sized to what the editor actually needs.

**Exit criteria:**
- Settings export from 1.6.x imports cleanly into 2.0 with the migration applied.
- A user who never touches the profile picker sees no behavior difference.
- Profile-aware diagnostics: every subsystem's diagnostics surface includes the active profile name + version.
- **Removability check:** With the profile layer collapsed back to roles, what user-visible behavior degrades?

**Size:** ~6-10 PRs over 3 weeks. Migration is the risk; everything else is plumbing.

### 3.0 / Post-2.0 candidates [unscoped]

- **Uniform UI consolidation** — by 2.0 we'll have shipped Preact + `htm` on a handful of new surfaces (Memory, `@memory` chip, active-tools chip row, profile picker). 3.0 evaluates whether to migrate select existing surfaces (Settings sidebar, secondary pane, conversation drawer), introduce a Plugin Component primitive, and rework mobile.
- **Sub-agents** — bounded child conversations with their own context/tool catalog/budget. Tractable post-2.0 because profiles make "child profile" a real abstraction. Commit only if real tasks are measurably bottlenecked on context exhaustion that decomposition would solve.
- **Browser-in-browser preview** — Service Worker intercepting iframe `fetch` to serve in-memory files; multi-file static web apps render correctly. StackBlitz-classic / CodeSandbox-v1 pattern. Commit if real users hit the multi-file wall often enough.

All three get scoped post-2.0 against measured signal, not speculation.

---

## Deferred / unscheduled (needs triage)

> **Why this section exists.** Foundations (1.1.x) and Compression (1.2.x) were sequenced before Memory + Tools jumped ahead. Some items are gated on metrics from the cost dashboard (which has shipped — but its export affordance has not; see the Compression bucket). Some may be obsolete now that Tools shipped its own equivalents (e.g. the `TaskLedger` landed in 1.3.17). Sorting paused-vs-abandoned is owed.
>
> **Triage policy (2026-05-05).** Each item below gets one of two scheduled actions: a **code audit** (read the relevant module + branch, decide whether the work is still needed in light of what shipped since) or a **formal test** (when an audit can't determine relevance — e.g. compression Rules 1+2 effectiveness only shows up under measured load). Items determined to be **OBE** ("Overcome By Events" — superseded by later work) get removed from this doc; items determined to be still needed get re-slotted with a track. Audits/tests run as their own small PRs; the disposition note lands in this section's row before removal or re-slotting.

### Foundations (was 1.1.x)

| Item | Branch | Rationale |
|---|---|---|
| Turn metadata enrichment | `feat/1.1.0-turn-enrichment` | Needed by compression Rules 1–3 (`file_ops`, `tool_result_for`). Read-path-only; new turns enriched, old ones absent. |
| Migration coverage probe | `feat/1.1.0-metadata-coverage-probe` | Read-only consistency check; `?debug=metadata` flips it on. Distinguishes "no rule applied" from "rule skipped because metadata absent." |
| Profile scaffolding (data only) | `feat/1.1.0-profile-scaffolding` | `js/profiles/coder.v1` mirroring current behavior, no behavior change. |
| CI `node --test` step | `feat/1.1.0-ci-node-test` | Port `*.mjs` suites to `node:test`. Likely abandoned; we're well past 1.1.0. |
| Pre-merge version coherence check | (none) | Lint comparing `js/version.js` to latest `## [X.Y.Z]` heading in `CHANGELOG.md`. Two release-sync drifts is enough; one evening to fix forever. |
| Embedder hardening | `feat/1.1.2-embedder-provider-decoupling` | Provider decoupling, filetype filters, 500-file ceiling, in-browser embedder validation, Settings → Embeddings tab. |
| Vim keybindings | `feat/1.1.3-vim-keybindings` | `@replit/codemirror-vim`; toggle in Settings → Appearance. Self-contained. |
| Glassworm / Trojan-Source protection | (none) | Invisible-Unicode lint in CI; editor decoration; plugin install warning band; `docs/SECURITY.md`. |

### Compression (was 1.2.x)

> **The whole track is gated on cost-dashboard export.** The dashboard itself shipped at 1.2.1 ([`js/settings/cost-tab.js`](../js/settings/cost-tab.js)) — cross-provider, per-conversation, per-tool, 30-day chart, budget tracking. It is currently *read-only*: the data lives in [`js/intelligence/cost/cost-store.js`](../js/intelligence/cost/cost-store.js) but cannot leave the browser. Without an export affordance (Copy / JSON / CSV), the question "did Rules 1+2 actually save the projected 40%?" can be eyeballed in the chart but not analyzed offline. Each compression follow-up gates on the previous one's measured value showing up in the dashboard *and* being capturable for comparison.

| Item | Branch | Rationale |
|---|---|---|
| Rules 1+2 (Subsumption, Invalidation) | `feat/1.2.0-compression-phase-1`, `feat/1.2.x-compression-off-flag`, `feat/1.2.x-synthetic-savings` | New `js/intelligence/compression/` module tree. `preserve_recent` invariant. Diagnostics in LLM debug modal. Existing `chat/summarizer.js` stays as Rule 5 fallback. |
| Cost dashboard *(shipped 1.2.1)* | (n/a) | Cross-provider, per-conversation, per-tool token + cost breakdown lives at [`js/settings/cost-tab.js`](../js/settings/cost-tab.js); store at [`js/intelligence/cost/cost-store.js`](../js/intelligence/cost/cost-store.js). Venice + OpenRouter remote dashboards in `plugins/`. **Status:** ✅ shipped; the listed-here legacy line said "(none)" — that was stale. |
| **Cost-dashboard export** *(✅ shipped 1.6.6)* | (n/a) | JSON-download from [`js/settings/cost-tab.js`](../js/settings/cost-tab.js) via `buildCostExport()` + Export button. Lives at [CHANGELOG.md](../CHANGELOG.md) §1.6.6. Unblocks the compression-track measurement loop and the 1.6.7 retrieval extension. |
| Rule 3 (Consumption) | (none) | Gated on export + ≥95% `tool_result_for` coverage on production sessions. |
| Rule 4 (Resolution) | (none) | Templated marker generation for "debugging spans that ended successfully." Gated on Rule 3 numbers matching the design. |
| Rule 5 tuning | (none) | Plug existing summarizer into the pipeline cleanly; measure compression latency and summarizer call rate. |
| Settings → Compression panel refresh | (none) | Replaces Settings → Chat Summarizer. Establishes the **preset / advanced toggle pattern** (Decision §11) that subsequent panels inherit. Gated on Rules 1–5 live. |
| Provider rate-limit respect | (none) | Read `x-ratelimit-*` headers; pace requests; back off on 429. Needs to ship before any *non-self-hosted* embedder is viable for repo-scale ingest, **AND** before Touch 3 Window v2 / Sessions concurrent-agents work — multiple sessions running in one window saturate per-provider caps faster than any single chat ever did. Reference implementation in [`evals/pacing.js`](../evals/pacing.js): `RateLimiter` class + per-model `RateLimiterPool` + 10% token-budget headroom + per-call delay + null-cap handling. Production wiring path: `js/providers/venice.js` (and equivalents for OpenAI / OpenRouter / Anthropic) ingests `x-ratelimit-*` from each response, exposes `msUntilNextSend()` to the chat / agent loop. |

### Touch 3 deliverables (received 2026-05-07; dominantly post-2.0)

> **Bundle:** [`docs/design/touch-3-left-pane-and-window/`](design/touch-3-left-pane-and-window/) — README + 2 chat transcripts (`chat1.md` is the historical Touch 1+2 thread; **`chat2.md` is the Touch 3 work**, started 2026-05-01) + `Facelift.html` design canvas + JSX/CSS deliverables. Repo dumps and design-canvas sidecar state pruned. Read `chat2.md` and `pushback.jsx` before implementing anything from this touch.
>
> **Why post-2.0.** The user explicitly tied this to 2.X profiles in the design conversation (`chat2.md` line 141: *"claude code and I are wrapping up 1.X and are about to cut 2.X profiles, this is intelligence layer stuff"*). The Window v2 architecture is **load-bearing on the profile contract** — a "session" is naturally a profile instance, so building Sessions before profiles ship doubles the rework risk. PR Review and Merge Conflict are surface-sized minors that could ship pre-2.0 if a slot opens, but they're independent of the Sessions work.

| Item | Bundle file(s) | Scope shape | Notes |
|---|---|---|---|
| **Window v2 / Sessions / chat-as-spine** | `window-v2.jsx`, `window-v2.css`, `Facelift.html#window-v2` section | Architectural rework | Middle pane becomes a **stage** that swaps mode (welcome / file / diff / PR review / conflict / task timeline). Chat earns the center-right column full-height (gets a focus mode with rail collapsed). **Sessions tabs** in the top bar — each tab = self-contained branch + task + chat + open files; multi-branch / multi-project concurrent in one window. **Hard prerequisite:** production rate-limit pacer (see Compression bucket §"Provider rate-limit respect") — multiple concurrent agents in one window saturate per-provider caps faster than the single-chat case. Reference: [`evals/pacing.js`](../evals/pacing.js). |
| **PR Review surface** | `pr-review.jsx`, `Facelift.html#prreview` section | New surface, minor-sized | Full editor takeover. File tree of changes / side-by-side diff / inline comment threads anchored to lines / AI review summary banner / sticky review dock (Comment / Request changes / Approve / Submit). Tabs: Conversation · Files · Commits · Checks. Closes the "leave for repo BE to actually review" gap (was the user's #1 cited pain point in `chat2.md`). Independent of Sessions; could ship pre-2.0 if a slot opens. |
| **Merge Conflict Resolver** | `merge-conflict.jsx`, `Facelift.html#merge` section | New surface, minor-sized | Three-pane (Theirs / Resolved / Ours), per-hunk Accept Theirs / Both / Ours, "AI resolve" per hunk, conflict minimap. Designer confirmed feasible in pure browser. Independent of Sessions. |
| **Left-pane Rail v2 (full conversion)** | `left-pane-v2.jsx`, `Facelift.html#leftpane-v2` section | Full pane rework | Activity-rail (B) + view switcher; new verbs **Tasks** (in-flight agents w/ progress + tokens), **Releases** (AI notes pinned), **▶ Start** on issues, real branch switcher with ↑/↓ counts + cut-release inline, Files w/ hover-actions + "Now strip". Bundle with Window v2 to avoid double-disrupting the same surface. |
| **Zip Up / Zip Down — three scopes, three homes** *(2026-05-08 follow-on bundle)* | `zip-flow.jsx`, `zip-flow.css`, `Facelift.html#zip-flow` section | UX rework of an existing feature | **Project zip** lives in the Project switcher menu next to the brand (Clone from URL · Import .zip · Export project · Export branch). **Branch zip** lives in the Branches rail next to Cut release, plus a window-wide drop zone (drops always become *new* branches). **Session zip** lives on session-tab right-click — a snapshot = `branch + chat history + notes` so a teammate can reopen mid-flow. Upload modal gains a `main / new branch / new session` segmented control up front. Atomic-batch-commit semantics persist. Closes the [`docs/design/OPEN-QUESTIONS.md`](design/OPEN-QUESTIONS.md) zip-flow entry filed 2026-05-07. Naturally bundles with Window v2 / Sessions because the session-snapshot surface depends on session tabs existing. |

**1.x extraction candidates (small, feasible without the full rework — not committed; pick when a slot wants UX polish):**

| Candidate | Scope | Source | Why it's tractable now |
|---|---|---|---|
| ~~**A. Branch switcher upgrade**~~ *(✅ shipped 1.12.0)* | Replaced the `<select id="branchSelect">` dropdown with a row-list panel: ↑/↓ ahead/behind counts (single GitHub call, two-call default for Gitea/GitLab, null for Local), inline Switch / Cut release / Delete with confirm. New `Git.getBranchAheadBehind` provider method; `State.branchMetadata` populated lazily with concurrency cap of 4. CHANGELOG §1.12.0. | `left-pane-v2.jsx` "branches" view | Out — shipped. |
| ~~**B. ▶ Start prominence on issues**~~ *(✅ shipped 1.13.0)* | Inline ▶ Start / 🔀 Switch & Start / ✅ Active button on each issue row in the left-pane Issues panel; `event.stopPropagation` keeps the row click → `openIssueTab` flow intact. New pure helper `computeIssueBranchState(issue, ctx)` in [`js/issue-detail.js`](../js/issue-detail.js) is the single source of truth for the multi-start guard semantics; new pure renderer [`js/ui/issue-list.js`](../js/ui/issue-list.js) mirrors the 1.12.0 branch-panel pattern (HTML in, HTML out, no DOM). CHANGELOG §1.13.0. | `left-pane-v2.jsx` "issues" view | Out — shipped. |
| **C. Files "Now strip"** | Tiny indicator above the file tree showing changes count + active agent activity | `left-pane-v2.jsx` "files" view | Surfaces existing scratchpad / TodoWrite / queued-input data (all shipped). Read-only; no new state. ~1 small patch. |

### Other deferred

- ~~**`ChatHistoryStore` encapsulation**~~ *(✅ shipped 1.11.0)* — Single owner at [`js/chat/history-store.js`](../js/chat/history-store.js) exposes `append / splice / setLength / replace / clear`; sixteen direct mutations + persistence calls across `messages.js`, `handlers.js`, `summarizer.js`, `index.js`, `conversations.js`, `storage-metrics.js` consolidated to one. All methods mutate `State.chatHistory` in place to preserve any captured array reference. Tests in [`tests/test-history-store.mjs`](../tests/test-history-store.mjs). The quota-aware eviction strategy this unblocks (embeddings-first → old chats → never active) stays a separate slot.
- **Chat panel facelift** — three Touch 2 variants (Polish, Restructure, Reskin); direction not locked. Will get a slot once a direction is picked or roll into 2.0 with the profile picker.
- **Persona memory scope** — deferred indefinitely. Workspace + user scopes cover the demand seen so far.
- **Plugin SlotManager** — designed but not built. Contract locked in [`docs/DESIGN-git-providers-and-ui-extensions.md`](DESIGN-git-providers-and-ui-extensions.md) §4 (slot catalog, error semantics, security boundary, priority rule, `version` field). `git-providers/registry.js#getAllContributions` already collects manifests; the patch ships `js/slot-manager.js` against the locked contract. Today plugins inject UI only via `registerButton` and `registerModal`.
- **In-app help renderer** — sidebar pane instead of modal; would make `read_docs`-driven content far more useful. (`js/help/` exists today — modal-based; the deferred work is the sidebar variant.)
- **Mobile secondary pane rework** — current ≤768px layout treats secondary pane as a fullscreen overlay; could be a slide-over.
- **Issue/PR tab visual hierarchy** — long tabs feel busy; lo-pri.
- **Plugin marketplace** — defer to 2.x once the architecture stabilizes.
- **LLM-authored ad-hoc automation (parked, design first; gates required)** — Surfaced 2026-05-08 from a session where the model needed to find dead CSS and correctly asked permission to *write a one-off script* rather than grind a `read_file` loop. **Load-bearing motivation (Jeff, 2026-05-08):** if a large analytical task costs `X^N` tokens worth of tool calls (each read pulls more refs that pull more reads — the combinatorial fan-out we already see in cross-file refactors and unused-symbol sweeps) but a one-off script collapses it to linear, the discussion is worth having. The cost-vs-context-quality steering frame (`project_cost_quality_tradeoff.md`) lands on the side of having the surface, *with gates*. Today there's no "execute an arbitrary script and read the output" tool — intentionally; the role-gating model treats the catalog as the trust boundary, and arbitrary execution inverts that. **Open design questions before this gets a version slot:** (a) trust-surface seam — Jeff explicitly: "there will need to be gates"; the 1.10.0 `submit_plan_for_approval` propose-then-approve mechanism is the obvious template (propose script → human reviews source → approve → run → return output); (b) script scope — read-only fs-walk only? deps allowed? network allowed? each step expands risk; (c) sandbox — browser context has no fs / no shell, so this needs a backend bridge (back to the MCP / dev-server seam); (d) "throwaway vs tool" threshold — some recurring asks (dead CSS, unused exports, import graph) probably want to graduate into named tools instead, so the surface should *measure* repeat scripts and surface "you've run this shape 3+ times — propose a tool?". **Not slotted.** Design pass owed before a version assignment; the gates question is the gating question. Captured in memory `project_wishlist_llm_authored_automation.md`.

**Migrated from retired `docs/PLAN.md` (2026-05-06; triage owed):**

- **Dynamic provider registration in settings UI** — Plugins that call `Providers.register()` or `GitProviderRegistry.register()` don't appear in settings dropdowns. The dropdown should read from the live registry.
- **Plugin settings panel tab** — Allow plugins to register a dedicated tab in the Settings modal for richer configuration UI beyond auto-generated `configSchema` fields.
- **CodeMirror extension bridge** — Expose the CodeMirror `EditorView` to plugins for keybindings, decorations, and custom syntax highlighting.
- **Tools settings page** — Dedicated tab showing all registered tools with name, description, role assignments, and enable/disable toggles.
- **Custom role creation UI** — Create new roles with name, icon, description, and checkbox list of tools. `Roles.register()` exists but has no UI.
- **Cross-project tools** — `peek_scan_file` (cross-repo function/class outline; requires extracting scan parsing into a shared module), `peek_search_in_files` (cross-repo grep; needs tree iteration or provider search API), `peek_read_function` (combines `peek_scan_file` + `peek_read_lines`).
- **More languages in `scan_file`** — Today only JS/TS and Python parse into a structured outline. Add Go, Rust, Java, C/C++ patterns so `scan_file` is useful in polyglot repos.
- **Expand `.mjs` test coverage** — The `node --test` CI step (1.0.6) runs only the ported subset (`test-smoke`, `test-retry`, `test-edit-tracker`, `test-summarizer`, `test-blame-normalize`, `test-metadata-coverage`, `test-turn-enrich`). The browser-only `.js` suites still run only under `tests/index.html`. Port them so CI exercises the full surface.
- **Generic / custom git provider** — A "custom" option where users map endpoint URLs to the base interface for any Git API.
- **Offline / PWA support** — Service Worker for offline editing with sync-on-reconnect.
- **Untrusted issue/PR content delimiter wrapping (security-track patch)** — Wrap external issue/PR/comment text in `<UNTRUSTED_*>` markers in `js/prompts.js`; add a system-prompt instruction that imperatives inside markers are data not commands; extend `js/security/invisible-unicode.js` to scan tool returns. Audited 2026-05-06; see `docs/SECURITY.md` §"Untrusted issue / PR / comment content" and memory `project_untrusted_issue_content_gap.md`.

### Known open issues — not yet scheduled

User-facing gaps tracked as filed issues but not yet slotted into a track. Listed here so a roadmap reader can see them without diff'ing against the issue tracker. **Issue trackers split by audience:** internal/dogfood-only on Gitea (`git.gobha.me/xcaliber/ai-editor`); public-facing on the GitHub mirror (`github.com/gobha-me/ai-editor`).

**Open — slotted but not on the active track:**

- **github#37 Phase 2** — Re-scope the eight deferred design questions (listed inline under the closed Phase-1 entry below) once dogfood surfaces real friction around conventions. No active work; not gated. Phase 1 may turn out to be the whole answer.
- **github#27 — `MCP Server Discovery & Easy Configuration`** — Discoverability + config UX for MCP servers in Settings. The discovery contract pattern is already sketched in [`docs/DESIGN-tools.md`](DESIGN-tools.md); the open work is the settings-UI half. Medium effort, can land any time the slot is free.
- **github#24 — `Sub-agent architecture for delegated task execution`** — Bounded child conversations with their own context / tool catalog / budget. Per §"3.0 / Post-2.0 candidates" below, this is post-2.0: profiles make "child profile" a real abstraction. Commit only if real tasks are measurably bottlenecked on context exhaustion that decomposition would solve.
- **github#18 — `Cross-device settings sync via QR codes / P2P`** — Designed in [`docs/DESIGN-cross-device-sync.md`](DESIGN-cross-device-sync.md) (draft). Roadmap §"What's out of scope for the 1.x → 2.0 arc" lists "cross-process / distributed state" as out of scope; this issue is the design-on-paper edge of that line. Stay parked through 2.0; revisit post-profile-contract.

**Closed:**

- ~~**github#25 — `Plan Mode — read-only planning phase with approval gate`**~~ *(✅ closed — shipped 1.10.0 / [PR #316](https://github.com/gobha-me/ai-editor/pull/316))*. Read-only planning phase layered on top of the `pendingUserResponse` seam introduced for `ask_user` (1.9.0): tool catalog filter via `ToolDefinition.readOnly` + `ToolRegistry.filterReadOnly`, a `submit_plan_for_approval` tool that pauses the loop, an inline plan-approval card mirroring the ask-user-card lifecycle, a Plan Mode chip + system-prompt addendum that drops out automatically on approval. Optional `autoPlanOnIssueStart` setting wires Plan Mode on at session start. See [CHANGELOG.md](../CHANGELOG.md) §1.10.0.
- ~~**gitea#188 — `[storage] cost-daily graph data lost after refresh`**~~ *(✅ closed at 1.6.7)*. `KeyMutex` adoption in [`js/intelligence/cost/cost-store.js`](../js/intelligence/cost/cost-store.js) — `recordTurn` now serializes its read-modify-write per storage key. See [CHANGELOG.md](../CHANGELOG.md) §1.6.7.
- ~~**github#23 — `Bug: Disabling an MCP plugin should remove its tools from listings and notify the LLM`**~~ *(✅ closed — shipped 1.6.10)*. Diff-based state messages, `tools:unregistered` event for embeddings cache eviction, actionable error string. See [CHANGELOG.md](../CHANGELOG.md) §1.6.10. Investigation found most of the issue's stated concerns were already structurally correct (registry cleanup is complete, system prompt rebuilds per-turn) — the real gaps were the silent toggle, the embeddings cache leak, and the unhelpful error.
- ~~**github#20 — `Feature: Add git log tool`**~~ *(✅ closed — shipped PR #278)*. `git_log` bundled with the git-tool-wrappers wishlist items.
- ~~**github#30 — `[storage] cost-daily graph data lost after refresh`**~~ *(✅ closed — fixed in 1.6.7 / PR #280)*. Same `KeyMutex` cure as gitea#188.
- ~~**github#31 — `Duplicate tool definitions in role settings`**~~ *(✅ closed — shipped 1.6.8)*. `register()` now splices the old entry before pushing; dedup mirrors `unregister()`.
- ~~**github#32 — `Should git_log be available to all roles?`**~~ *(✅ closed — shipped 1.6.8)*. Changed to `roles: 'all'`; read-only, no side effects.
- ~~**github#29 — `Retrieval discoverability + edit_file fragility (post-mortem of PR #278)`**~~ *(✅ closed — shipped 1.6.11 / PR #293)*. The three sized levers landed: `find_relevant_files` indexer-readiness gate (`indexer_not_ready` envelope + soft budget), `edit_file` post-edit context widened from 3/3 to 5/5 with a `_getStaleWindow` on STALE LINE NUMBERS errors, and `MUTATING_TOOLS` cache-hit messaging. See [CHANGELOG.md](../CHANGELOG.md) §1.6.11 and [PR #293](https://github.com/gobha-me/ai-editor/pull/293).
- ~~**github#21 — `MCP role-based tool access`**~~ *(✅ closed — shipped via PR #289)*. Three-part proposed solution landed: per-server roles in MCP settings; backward-compatible default of `'all'` when no roles set; integration through the role-based access path. Bundled into 1.6.11.
- ~~**github#37 Phase 1 — `Design: project-conventions file (CLAUDE.md analogue)`**~~ *(✅ Phase 1 closed — shipped 1.6.13)*. Repo-root `CLAUDE.md` autoloads on `git:projectLoaded` into `State.projectConventions` and renders as a `<PROJECT_CONVENTIONS>` block in the editor system prompt — committed by the project maintainer and therefore trusted (NOT wrapped in `<UNTRUSTED_*>`). See [CHANGELOG.md](../CHANGELOG.md) §1.6.13. **Phase 2 still open** — re-scoped from real dogfood signal, not speculation. The eight deferred design questions: (a) location (repo-root vs `.aieditor/conventions.md` vs `docs/CONVENTIONS.md`), (b) loading lifecycle (session-start vs every-turn vs lazy), (c) role interaction (per-role sections vs undifferentiated), (d) memory-subsystem boundary (project-memory vs user-memory line), (e) project-switch behavior (active-project vs branch-scoped), (f) versioning (active branch vs local checkout; mid-session branch switch), (g) length cap / compression integration, (h) system-prompt enumeration parity (per `feedback_prompts_js_parallel_enumeration.md`), (i) empty-state UX. Trigger: dogfood signal — do conventions stay short and uncontroversial (Phase 1 is the whole answer), or does friction surface around any of these knobs?
- ~~**github#26 — `Feature: TodoRead/TodoWrite tools for persistent task tracking`**~~ *(✅ closed — shipped 1.8.0)*. Structured per-conversation task list re-injected into the system prompt every turn (same survival mechanism as scratchpad); shape mirrors Claude Code's TodoWrite. Conversation-scoped persistence via the existing `conv-{id}` payload — no new storage keys. UI panel from the issue's open-questions block stays deferred (read-only first cut against the system prompt is enough to learn whether the structured-anchor hypothesis holds). See [CHANGELOG.md](../CHANGELOG.md) §1.8.0.
- ~~**gitea#301 — `[chat] edit_file ↔ read-cache cross-request deadlock`**~~ *(✅ closed — shipped 1.7.1 / PR #302)*. Cross-request dup cache (`State.toolActionLog`) now invalidates on file mutation, breaking the `STALE LINE NUMBERS` ↔ `_cached: true` deadlock. Logic refactored into `js/chat/cache-invalidation.js` for testability. See [CHANGELOG.md](../CHANGELOG.md) §1.7.1.
- ~~**github#34 — `Feature: Scratchpad visibility panel — real-time user view of LLM notes`**~~ *(✅ closed — shipped 1.8.4)*. New `EventBus('scratchpad:changed')` channel emitted from [`js/tools/scratchpad-tools.js`](../js/tools/scratchpad-tools.js); collapsed-by-default Notes tray inside `.chat-input-area` reads `State.scratchpad` reactively. Read-only scope; editing deferred (issue's "user-editable?" question stays open — conflict resolution unsolved). Lifecycle wrapper [`js/chat/scratchpad-panel.js`](../js/chat/scratchpad-panel.js) mirrors the Memory-tab precedent. See [CHANGELOG.md](../CHANGELOG.md) §1.8.4.
- ~~**github#33 — `Feature: Structured question tool (ask_user) + queued user input during long runs`**~~ *(✅ closed — Phase 1 shipped 1.9.0 / [PR #312](https://github.com/gobha-me/ai-editor/pull/312); Phase 2 shipped 1.9.1 / [PR #313](https://github.com/gobha-me/ai-editor/pull/313))*. **Phase 1** added the `ask_user` tool: an inline question card pauses the tool loop and supports single-select / multi-select / free-text answer types, landing replies via a new `pendingUserResponse` chat-state seam in [`js/chat/state.js`](../js/chat/state.js). **Phase 2** added a module-level `pendingMessageQueue` (FIFO, `MAX_QUEUE = 5`, oldest-dropped on overflow) drained inside [`js/chat/handlers.js`](../js/chat/handlers.js) *before* the forward-progress check (so a stalling model can't be killed before it sees the queued user input); the queued-input panel ([`js/chat/queued-input-panel.js`](../js/chat/queued-input-panel.js)) mirrors the scratchpad-panel lifecycle and joins the Decision §9 Preact + htm allow-list; the textarea is no longer disabled during generation; cancellation preserves the queue. Validated by [`docs/dogfood-battery/2026-05-07-queued-input-qwen-html-games.md`](dogfood-battery/2026-05-07-queued-input-qwen-html-games.md). See [CHANGELOG.md](../CHANGELOG.md) §1.9.0 and §1.9.1.

---

## Decisions

Resolved from discussion. Load-bearing — implementations honor them.

1. **Memory storage is two-tier.** Browser cache default (per-tab); repo-committed `.aieditor/memory/*.md` opt-in per workspace. Toggle in Settings → Memory.
2. **Roles get replaced by the profile picker at 2.0.** No dual-surface; one selector. Migration script translates stored `role` to a profile preset.
3. **Compression diagnostics surface as a public status-bar pill** (e.g., "📉 60% kept"), not just debug-mode. Full eviction trace stays in the LLM debug modal for power users.
4. **Memory files auto-stage on commit when repo mode is opt-in AND the current branch isn't protected.** On protected branches, the memory diff surfaces in the commit modal as an unstageable warning.
5. **Tool budget defaults to 5000 tokens** (per design), exposed as a tunable in Settings → Tools.
6. **Branching: per-PR feature branches off `main`. Squash + delete on merge.** No long-lived track branches.
7. **Removability is an explicit checkpoint, not a vibe.** Every Phase-1 milestone carries a Removability check in its exit criteria. If "subsystem removed → no user-visible degradation," the next minor is gated on closing that gap.
8. **Measurement before scale.** Cost dashboard shipped at 1.2.1 with cross-provider, per-conversation, and per-tool breakdowns ([`js/settings/cost-tab.js`](../js/settings/cost-tab.js)); the export affordance to make it useful for offline analysis is the open gap (see Compression bucket).
9. **Preact + `htm` allowed for new state-heavy surfaces from 1.3.0; vanilla everywhere else through 2.0.** Existing tabs / sidebar / file tree / editor frame / chat stay vanilla forever; no migration. Bigger uniform-UI consolidation is a 2.0 → 3.0 arc.
10. **claude.ai/design engages on a three-touch model (was two; Touch 3 received 2026-05-07).** Touch 1 (Memory UX, 2026-04-29) → 1.3.0 Memory flows; deliverable at `docs/design/touch-1-memory-ux/`. Touch 2 (whole-app facelift, 2026-04-30) → top-bar Restructure + Settings sidebar + Connections / Debug / Help panels; deliverable at `docs/design/touch-2-facelift/`; shipped 1.3.5–1.3.13. Touch 3 (left pane + window architecture, 2026-05-07) → Rail v2, PR Review surface, Merge Conflict Resolver, Window v2 / Sessions; deliverable at `docs/design/touch-3-left-pane-and-window/`; **dominantly post-2.0** per the design transcript and the Sessions ↔ profile-contract dependency. Code-session ↔ design-session backfeed runs through [`docs/design/OPEN-QUESTIONS.md`](design/OPEN-QUESTIONS.md): implementers append open questions, Jeff routes them to claude.ai/design with screenshots, answers land as addendum / new chat transcripts in the relevant touch directory.
11. **Two-view configuration for every settings panel.** Preset view (intent) + advanced view (parameters), reachable via the same toggle name and position in every panel. Editing in advanced flips the preset selector to "Custom"; switching back to a named preset snaps every knob to that preset's defaults. **No separate "Developer mode" sections.** Full contract in `docs/DESIGN-profiles.md` §"Two-View Configuration."
12. **Release-readiness gate (2026-05-04).** Release tag pushes (not merges to main) require a passing 10-turn dogfood in this repo. Patches inside an active track stay untagged until the next minor closes the bundle. See §"Cadence and versioning" for full criteria.

---

## What's out of scope for the 1.x → 2.0 arc

- **Multi-modal context.** Image/audio chunks. Vision models work for images today (paste-to-chat); structured handling is a 3.x topic.
- **Cross-process / distributed state.** Stays single-process. No sync server, no multi-tab live coordination beyond the existing tab-isolation model.
- **Real-time collaborative editing.** Two users editing the same file simultaneously. Not a context problem; not in scope.
- **Plugin marketplace.** Defer to 2.x after the profile contract stabilizes.
- **Markdown-as-source AST chunking.** Phase 1 code chunker is regex-based; tree-sitter-grade is gated on measured need.
- **Custom embedding model fine-tuning.** Use the user's chosen provider.
- **Cross-project task ledger.** Task ledgers stay session-scoped. Continuity goes through memory with consent.

---

## What this roadmap commits to

- **Now / Next / Later** at the top — the doc's first job is to answer *what's being worked on, what's queued, what's not*.
- **Admissibility, not accumulation** as the architectural principle every PR is reviewed against.
- **Git-native memory and session state** as the externally-tellable story.
- **Measurement before scale.** Cost dashboard is gating infrastructure; tracks that nominally depend on it stay deferred until it ships.
- **Removability discipline.** Every Phase-1 milestone exit criteria asks: with this subsystem removed, what user-visible behavior degrades?
- **No major version bumps** until profiles become the load-bearing configuration surface — *and* the contract is sized to what ai-editor actually uses.
- **The DESIGN docs are the contract.** When implementation diverges from a DESIGN doc, the doc updates first, then the code.
- **Honest deferrals.** Multi-modal, collaboration, marketplace are not on this roadmap.
- **Shipped work goes in [CHANGELOG.md](../CHANGELOG.md), not here.** This doc describes where we're going. The changelog is the authoritative running history.

Push back on any of this. The roadmap is a hypothesis. The first track that drifts more than two weeks past its target gets the next milestone re-scoped, not the deadline pushed.
