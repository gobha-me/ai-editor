# AI Editor — Roadmap

> Last updated: 2026-05-05 · Current released (tagged) version: **1.6.5** · `main` HEAD: 1.6.8 (untagged — sits in main alongside the also-untagged 1.6.6 cost-export, 1.6.7 cost-store race-safety, 1.6.8 cost-dashboard retrieval-extension, buffer-aware read tools, and long-running tool timeout patches).

## How to read this doc

Roadmap = where we're going. Shipped work and per-PR rationale live in [CHANGELOG.md](../CHANGELOG.md) — don't duplicate it here.

- **Now / Next / Later** — where we are at a glance.
- **Active track** — in-flight work, sized to PRs.
- **Later** — committed tracks queued behind the active one.
- **Deferred / unscheduled** — work that was planned, designed, or partially started but isn't currently scheduled. Triage owed.

## Now / Next / Later

| Phase | Track |
|---|---|
| **Now** | **1.6.0 — Chat Stability.** Six-PR series sized in [`docs/design/long-chat-stability/findings.md`](design/long-chat-stability/findings.md). Status: 1.6.0–1.6.5 all shipped to main and individually tagged (`v1.6.0` through `v1.6.5`); the bundled-release framing in older revisions of this doc was abandoned in favor of per-patch tags. |
| **Next** | **1.6.6** Cost-dashboard export *(✅ shipped)* · **1.6.7** Cost-store race-safety / `KeyMutex` (gitea#188) *(✅ shipped)* · **1.6.8** Cost-dashboard retrieval extension *(✅ shipped)* · **1.6.9** Query / structural expansion cache · **1.6.10 (gated)** AST-based code chunker, only if regex heuristic shows measurable gaps on the benchmark. |
| **Later** | **2.0 Profiles.** Designed; not started. |
| **Deferred** | Foundations (was 1.1.x), Compression (was 1.2.x), various UI items — see *Deferred / unscheduled*. |

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

## Active track: 1.6.0 — Chat Stability

**Why this is a minor, not a 1.5.x patch.** Five+ PRs of coherent work; treating it as a track keeps the in-track-patches rule honest and signals to anyone reading the changelog that chat stability is a coherent track, not an interleaved bug-fix bundle.

**Why the next release tag is `v1.6.0` and not `v1.5.14`.** The editor's primary surface is chat. A long session today silently truncates messages mid-loop, drops the original task framing, and occasionally 400s the LLM provider with orphaned tool messages. Internally-correct retrieval improvements ship with no user-visible benefit while this is broken. The 1.5.14 retrieval cutover (PR #266) merges to main as 1.5.14 in `version.js` but is **not tagged on its own** — its release event is the `v1.6.0` tag, which deploys both the chat-stability bundle and the retrieval cutover together.

### Sequenced PRs

| PR | Status | Scope | Closes (per findings.md) |
|---|---|---|---|
| 1.6.0 | ✅ shipped (#268) | Truncation marker in [`getContextMessages()`](../js/chat/summarizer.js) + pin first user turn (task framing). | Hypothesis #0 (silent windowing) |
| 1.6.1 | ✅ shipped (#269) | Boundary-aware prune in [`ChatSummarizer._pruneHistory()`](../js/chat/summarizer.js). | Hypothesis #1 (pruning algorithm cuts mid-pair) |
| 1.6.2 | ✅ shipped (#271) | Request-shape validator before [`LLM.chat`](../js/chat/handlers.js): asserts every `tool` message has a matching preceding `assistant.tool_calls[].id`; drops orphans with a warning rather than 400-ing the request. | defense-in-depth |
| 1.6.3 | pending | `function.name` overwrite-if-empty at [`js/llm/api.js`](../js/llm/api.js). One-line fix + regression test. Latent. | Hypothesis #2 |
| 1.6.4 | ✅ shipped | Token-based summarization trigger + map-reduce multi-pass at [`js/chat/summarizer.js`](../js/chat/summarizer.js). Replaces the message-count `SUMMARY_THRESHOLD` with a real-prompt-size gate keyed on `State.lastExchangeTokens.prompt`; bundled multi-pass safely chunks the summarization input itself when the utility model's window is small (1M prod ↔ 4–256K utility). | Hypothesis #7 |
| 1.6.5 | ✅ shipped (#275) | localStorage quota-recovery cleanup at [`js/core.js`](../js/core.js). Remove the chat-history-prune branch — IDB is authoritative; localStorage is best-effort; the destructive-sounding `[Storage] Quota exceeded — pruned chat history` warning is misleading because the in-memory `_cache` and IDB still hold the full history. Surfaced during the 1.6.0 PR 0 dogfood. | Hypothesis #8 |

**Verification artifacts to capture** (per findings.md). Before any PR lands, drive one long session on the prior HEAD to confirm the symptom is unchanged. Set `localStorage.setItem('debug.dump.summarizerSnapshots', '1')` so each rebuild's `RECENT_COUNT`, `startIndex`, `info?.summary` presence, and dropped count are logged.

**Exit criterion.** A 10-turn dogfooding session in this repo (the release-readiness gate) passes: no silent truncation; no orphaned-tool 400s; the model stays anchored on the original task framing across pruning events; no misleading `[Storage] Quota exceeded` warnings. With the gate cleared, the **`v1.6.0`** tag is pushed — that release deploys the six chat-stability fixes (1.6.0–1.6.5) **and** the 1.5.14 retrieval cutover as a single user-visible release event.

**Removability.** Each of the six PRs reverts independently; the chat loop returns to its pre-1.6.x state.

### Post-tag dogfood battery

Once `v1.6.0` is tagged, the open GitHub issues below run as ai-editor sessions against `main` — real work that doubles as the chat-stability dogfood. **Goal: not just a passing PR, but a captured trace showing *how* ai-editor got there.** Each session is its own discrete test.

| Order | Issue | What it exercises | Pass criteria |
|---|---|---|---|
| 1 | ~~**github#20**~~ — `git_log` tool missing *(✅ shipped PR #278)* | Tool registry, doc updates, **memory recall** (does ai-editor find the parked git-tool-wrappers wishlist and propose a bundle, or ship `git_log` alone in violation of it?) | Reached the "bundle with the wishlist" conclusion. `git_log` ships bundled. Trace showed memory hit. |
| 2 | ~~**github#15**~~ — Conflicting timeouts (test-driven loop) *(✅ shipped PR #282)* | Tool execution path in [`js/chat/handlers.js`](../js/chat/handlers.js) + settings; bounded two-file fix with three solution options on the issue | `LONG_RUNNING_TOOLS` set routes `wait_for_ci` to `longRunningToolTimeout` (300 s). Standard tools keep their 30 s default. |
| 3 | **github#23** — MCP plugin disable doesn't purge tools | Cross-layer: MCP bridge + plugin layer + chat handlers + tool registry; multi-file edit + system-message injection into chat | All acceptance criteria from the issue body pass. |
| 4 | **github#21** — MCP role-based tool access | MCP bridge + role system + Settings → MCP Servers UI; new UI plus core change | Three-part proposed solution lands; backward-compatible default (no roles set ⇒ `'all'`). |

**What to capture per session.**

- `localStorage.setItem('debug.dump.summarizerSnapshots', '1')` set before starting. Each context rebuild logs `RECENT_COUNT`, `startIndex`, `info?.summary` presence, dropped count.
- Full LLM-debug-modal export at session end: chat trace, tool calls, latency, `prompt_tokens`, `cached_tokens`.
- **Chat-stability invariants:**
  - Did the **truncation marker** (1.6.0) appear when context was windowed?
  - Did the **request-shape validator** (1.6.2) drop any orphans? *(it firing once is fine; firing repeatedly means an upstream regression.)*
  - Did the **token-based summarization** (1.6.4) trigger when load warranted, and not before?
- Retrieval hit-set per `find_relevant_files` call (which files came back, were they the right ones?).
- Cost-dashboard reading at session end (eyeballed in [`js/settings/cost-tab.js`](../js/settings/cost-tab.js) until the export item lands).

**Grading.** Each session passes if *both*:
1. **Output quality** — the produced PR meets the issue's acceptance criteria, builds clean, and existing tests pass.
2. **Trace quality** — no regressions in the chat-stability invariants. Failure of (2) but passing (1) means the chat surface is fragile under that workload — file as a follow-up issue and continue the battery.

**Out of scope for the battery:** github#18 (cross-device settings sync via QR/P2P) — unbounded scope; tests product-design instincts more than repo-fluency. Reconsider once the four-issue battery completes and we have a baseline.

---

## Later (sequenced)

### 1.6.6–1.6.10 — Storage / retrieval follow-ups

Bumped past the chat-stability minor.

- **1.6.6 ✅ shipped:** Cost-dashboard export — JSON-download from [`js/settings/cost-tab.js`](../js/settings/cost-tab.js) (`buildCostExport()` + Export button). Unblocks the compression-track measurement loop and the 1.6.8 retrieval extension. See [CHANGELOG.md](../CHANGELOG.md) §1.6.6.
- **1.6.7 ✅ shipped:** Cost-store race-safety — `KeyMutex` around `recordTurn`'s read-modify-write paths in [`js/intelligence/cost/cost-store.js`](../js/intelligence/cost/cost-store.js). Closes gitea#188 (cost-daily graph data lost after refresh). Same disposition as the memory subsystem's `KeyMutex` adoption. See [CHANGELOG.md](../CHANGELOG.md) §1.6.7.
- **1.6.8 ✅ shipped:** Cost-dashboard retrieval extension — `ConvCost.byStrategy: { [name]: { hits, tokens } }` added to [`js/intelligence/cost/cost-store.js`](../js/intelligence/cost/cost-store.js); `retrieval:turn-stats` event emitted from [`js/intelligence/retrieval/manager.js`](../js/intelligence/retrieval/manager.js) after each `compose()`; cost-recorder buffers per-conv stats and merges into the next `cost:updated` write so `requests` is not double-counted; new "Retrieval (per strategy)" table in [`js/settings/cost-tab.js`](../js/settings/cost-tab.js) shows Strategy / Chunks (Σ) / Avg/turn / Tokens (paraphrase chatFn captured via `State.sessionCost` delta — embedding-token attribution deferred). See [CHANGELOG.md](../CHANGELOG.md) §1.6.8.
- **1.6.9:** Query cache, structural expansion cache.
- **1.6.10 (gated):** AST-based code chunker (tree-sitter) only if the regex heuristic shows measurable quality gaps on the benchmark.

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
| Provider rate-limit respect | (none) | Read `x-ratelimit-*` headers; pace requests; back off on 429. Needs to ship before any *non-self-hosted* embedder is viable for repo-scale ingest. |

### Other deferred

- **`ChatHistoryStore` encapsulation** — `State.chatHistory` is mutated directly by 14 call sites across 5 files (`messages.js`, `handlers.js`, `summarizer.js`, `index.js`, `conversations.js`), and each one is independently responsible for calling `Storage.set('chatHistory', …)` afterward. Three issue #16 patches in a row had to walk every site to change persistence policy; missing one keeps the bug alive (1.5.9 #16 missed it; 1.6.5 had to revisit). Scope: introduce a single module exposing `append(msg)`, `splice(from)`, `replace(arr)`, `clear()`, route every consumer through it, drop `Storage.set('chatHistory', …)` from everywhere else. Unblocks the quota-aware eviction strategy Jeff described (embeddings-first → old chats → never active). **Structural risk, not lo-pri** — the current code works until the next persistence-policy change pays the same 5-file walk and one site gets missed again. Slot before the next change that touches chat persistence.
- **Chat panel facelift** — three Touch 2 variants (Polish, Restructure, Reskin); direction not locked. Will get a slot once a direction is picked or roll into 2.0 with the profile picker.
- **Persona memory scope** — deferred indefinitely. Workspace + user scopes cover the demand seen so far.
- **Plugin SlotManager** — designed but not built; on PLAN.md.
- **In-app help renderer** — sidebar pane instead of modal; would make `read_docs`-driven content far more useful.
- **Mobile secondary pane rework** — current ≤768px layout treats secondary pane as a fullscreen overlay; could be a slide-over.
- **Issue/PR tab visual hierarchy** — long tabs feel busy; lo-pri.
- **Plugin marketplace** — defer to 2.x once the architecture stabilizes.

### Known open issues — not yet scheduled

User-facing gaps tracked as filed issues but not yet slotted into a track. Listed here so a roadmap reader can see them without diff'ing against the issue tracker. **Issue trackers split by audience:** internal/dogfood-only on Gitea (`git.gobha.me/xcaliber/ai-editor`); public-facing on the GitHub mirror (`github.com/gobha-me/ai-editor`).

- ~~**gitea#188 — `[storage] cost-daily graph data lost after refresh`**~~ *(✅ closed at 1.6.7)*. `KeyMutex` adoption in [`js/intelligence/cost/cost-store.js`](../js/intelligence/cost/cost-store.js) — `recordTurn` now serializes its read-modify-write per storage key. See [CHANGELOG.md](../CHANGELOG.md) §1.6.7.
- **github#23 — `Bug: Disabling an MCP plugin should remove its tools from listings and notify the LLM`** *(open)*. When an MCP server is disabled (Settings → MCP Servers toggle), tools may still surface in `list_tools_by_category` / `find_tool` discovery, and the LLM gets a generic "server not enabled" error after attempting a call rather than a proactive "server disabled, N tools removed" state message. Touches `js/mcp/bridge.js`, `plugins/mcp-bridge.js`, `js/chat/handlers.js`, `js/tools/registry.js`. Has full proposed solution + acceptance criteria on the issue. Not in 1.6.x scope (chat-stability bundle).
- ~~**github#20 — `Feature: Add git log tool`**~~ *(✅ closed — shipped PR #278)*. `git_log` bundled with the git-tool-wrappers wishlist items.
- ~~**github#30 — `[storage] cost-daily graph data lost after refresh`**~~ *(✅ closed — fixed in 1.6.7 / PR #280)*. Same `KeyMutex` cure as gitea#188.
- ~~**github#31 — `Duplicate tool definitions in role settings`**~~ *(✅ closed — shipped 1.6.8)*. `register()` now splices the old entry before pushing; dedup mirrors `unregister()`.
- ~~**github#32 — `Should git_log be available to all roles?`**~~ *(✅ closed — shipped 1.6.8)*. Changed to `roles: 'all'`; read-only, no side effects.
- **github#29 — `Retrieval discoverability + edit_file fragility (post-mortem of PR #278)`** *(open)*. Post-mortem of the qwen-3-6-plus dogfood session on github#20 surfaced two compounding levers that explain the partial-implementation pattern (only `gitea.js` patched; `github.js` / `gitlab.js` / `local.js` / `base.js` left untouched): (1) `find_relevant_files` was never invoked AND the indexer reported `indexed: 6` of ~505 files — the tool would have returned thin results silently; (2) line-range `edit_file` ate a closing brace on a replace, the recovery edit stitched the surrounding lines but left the truncated body in place, producing the duplicate `getCommitStatus` that broke `.statuses` on the success path. Three sized levers on the issue: indexer-readiness gate on `find_relevant_files`, `edit_file` post-edit context echo, and a CLAUDE.md provider-symmetry note. Couples to the §1.5.x retrieval track when the §1.5.0 baseline conversation reopens.

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
10. **claude.ai/design engages on a two-touch model.** Touch 1 (Memory UX, 2026-04-29) → 1.3.0 Memory flows; deliverable at `docs/design/touch-1-memory-ux/`. Touch 2 (whole-app facelift, 2026-04-30) → top-bar Restructure + Settings sidebar + Connections / Debug / Help panels; deliverable at `docs/design/touch-2-facelift/`.
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
