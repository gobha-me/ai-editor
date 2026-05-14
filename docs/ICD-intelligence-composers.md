# ICD — Intelligence-layer Composer seam

> **Status:** initial draft, RE-EVAL following 2.44.0. Second subsystem in the ICD-backfill program per [`ROADMAP.md`](ROADMAP.md) §"Per-subsystem ICD backfill program" target #2. Tracks the contract for both `js/intelligence/tools/composer.js` and `js/intelligence/retrieval/composer.js` as it stands at 2.44.0. The first ICD ([`ICD-chat-handlers.md`](ICD-chat-handlers.md), shipped 2.42.0) cross-referenced this seam under "Composer-vs-non-Composer path drift" — this doc covers the seam in isolation. Code-aware findings from authoring feed back to ROADMAP as `[strong]`-band rows in 2.46.0+; **one** surfaces this pass (see §"Code-aware findings").

## Purpose

The intelligence layer carries two modules named "composer" that operate on completely different domains but share a structural seam:

- **`js/intelligence/tools/composer.js`** — answers *"which tools should the model see this turn?"* Walks a profile's `tools.static` set, resolves through `Catalog`, applies authorization, packs against a token budget. Output: `ToolAdmissionResult` rendered into the OpenAI tool-array.
- **`js/intelligence/retrieval/composer.js`** — answers *"which code chunks should the model see for this query?"* Selects retrieval strategies, runs them in parallel, interleaves results against a per-strategy budget, optionally consults a task ledger for novelty-aware suppression. Output: `RetrievalResult` with attention-ordered context blocks.

**The seam they share** is the admissibility boundary between *what the registry / index could produce* and *what the model actually consumes*. Each Composer is a pure (no `State`, no DOM) algorithm that the caller wires to production via dependency injection — the caller supplies the registry (Tools) or the strategy list + chunk store (Retrieval), and the Composer returns a structured admission record plus a renderer for the API surface.

The 2.35.0 Composer-vs-non-Composer path drift ([`ICD-chat-handlers.md`](ICD-chat-handlers.md) §"The Composer-vs-non-Composer path drift") fired because the *Tools* Composer's admission decision can run on either branch and the system-prompt enumeration must agree with the API tools-array. This ICD's role is to keep the next instance from drifting — by naming the seam contract for both Composers as one document, so a maintainer wiring (or rewiring) either path reads what to preserve.

## The two modules at a glance

| | Tools Composer | Retrieval Composer |
|---|---|---|
| **File** | [`js/intelligence/tools/composer.js`](../js/intelligence/tools/composer.js) | [`js/intelligence/retrieval/composer.js`](../js/intelligence/retrieval/composer.js) |
| **Public exports** | `composeAdmission(request)`, `renderForLLM(result)`, `_testing` | `compose(req, deps, opts)` |
| **Shipped** | 1.3.14 (Phase 1 admission) + 1.3.17 (sticky) + 1.4.1 (lazy `short` form) + 1.4.8 (LRU eviction) | 1.4.17 (steps 1–8) + 1.4.18 (step 6.5 ledger consumer) + 1.5.12 (paraphraser opt) + 1.8.1 (expander opt) |
| **Signature shape** | Sync, single-arg request | Async, DI tuple `(req, deps, opts)` |
| **Purity** | Pure function — no `State`, no DOM, no logging side effects | Pure function — same, except ledger consumer (step 6.5) appends admission/exclusion records as a side effect on the supplied `task_ledger` |
| **Production wired** | ✅ Yes — `js/llm/api.js:67` imports it; `js/llm/api.js:990` calls `composeAdmission` inside `LLMTools._runComposer()`; `js/llm/api.js:1180` calls `renderForLLM` to produce the OpenAI tool-array | ✅ Yes — `js/intelligence/retrieval/manager.js:38` imports `compose`; the retrieval manager drives `find_relevant_files` and `findRelevantFiles()` through it (1.5.14 cutover replaced legacy `js/context-manager.js`) |
| **Kill-switch** | `?toolsCompose=off` URL flag → `isToolsComposeDisabled()` → legacy `Profiles.filterTools(defs, profileName)` path | None — Retrieval Composer is the only composition algorithm; legacy `context-manager.js` retired at 1.5.14 |
| **Activation predicate** | `profileName === 'coder.v1'` AND `CODER_V1.tools.static.length > 0` AND not kill-switched | Always active when retrieval manager runs |
| **Diagnostics seam** | Output `ToolAdmissionResult.diagnostics` → `LLMDebug.attachToolDiagnostics` for the upcoming exchange | Output `RetrievalResult.diagnostics` (`strategies_used`, `tokens_used`, `tokens_truncated`, `ledger_*`, `degraded_strategies`, `warnings`, `chunker_versions`, `paraphrase_count`, `expansion_count`) consumed by retrieval-tab UI + per-turn cost recorder |

## The five classification axes

Each axis names a question both Composers must answer (or explicitly opt out of). The matrix is small — most cells differ between the two Composers, but the seam-contract question is the same.

| Axis | Question | Tools Composer | Retrieval Composer |
|---|---|---|---|
| **Source axis** | What is "static" admission vs "discovered" admission for this Composer? | `source: "static"` from `profile_static`; `source: "sticky"` from `task_ledger.tool_admissions`. Discovery (`source: "discovery"`) is reserved for a future PR (`diagnostics.discovery_admitted` slot exists; current value always `0`). | Strategies are the discovery mechanism. `priority_pins` is the "static" axis — pinned chunks are admitted first and never dropped by overflow (an OVERSIZED_PIN that exceeds budget throws caller-visible). `consult_ledger` (step 6.5) is the "sticky-skip" axis — re-admitted chunks below novelty threshold get replaced with ~20-token reference markers. |
| **Budget axis** | How is the token budget split + enforced? | Single budget (`request.budget_tokens`); declared-order static admits first, ledger-order sticky admits after; per-entry "pack if fits" gate followed by post-pass LRU eviction (1.4.8) when a budget shrink mid-task pushes `tokens_used > budget`. | Three-layer budget — total → reserves (system/output/history) → retrieval slice → per-strategy proportional shares from router applicability scores. Round-robin overflow drop within each strategy bucket, lowest-score-first inside the bucket. |
| **Authorization axis** | What gates a candidate before budget? | `metadata.authorization.required_groups` × caller `user_groups`. `'full'` bypass; `'all'` requirement always admits; empty `required_groups` → admit. Mirrors legacy `Roles.filterTools()` semantics. | None at this layer — authorization for retrieved content is upstream (ingest walker filters via `IgnoreManager` + size cap). The Retrieval Composer trusts that everything in the chunk store is admissible content. |
| **Overflow axis** | What happens when admitted ≠ budget? | Static set is privileged: if static alone > budget, leave it intact, surface `tokens_used > budget_tokens` (operator-visible "your static set is over budget — this is on you, not the runtime"). Sticky entries evict LRU first. | Round-robin across strategy buckets so no single strategy gets fully evicted before another loses a chunk; within a bucket, drop lowest-score chunks first. Pinned chunks never dropped. |
| **Diagnostics axis** | What does the Composer surface about its decision? | `ToolDiagnostics` — `static_admitted`, `sticky_admitted`, `discovery_admitted` (reserved), `suppressed`, `evicted_count`, `tokens_evicted`, `unresolved_static`. Attached to `LLMDebug` before the LLM stream opens. | `Diagnostics` — `strategies_used`, `strategies_skipped`, `chunks_returned_per_strategy`, `tokens_used`, `tokens_budget`, `tokens_truncated`, `ledger_consulted`, `ledger_suppressions`, `latency_per_strategy_ms`, `cache_hits`, `degraded_strategies`, `warnings[]`, `chunker_versions`, `paraphrase_count`, `expansion_count`. Surfaced via `retrieval:turn-stats` events into cost store + retrieval-tab UI. |

Three exports plus one composite type. The asymmetry between axis count (5) and export count (3) mirrors [`ICD-chat-handlers.md`](ICD-chat-handlers.md): each axis encodes a distinct *question*, but the two Composers carry their axis answers as fields on shared output records rather than as separate exports.

## Per-export contract

### `composeAdmission(request)` ([tools/composer.js:154](../js/intelligence/tools/composer.js))

**Signature:** `(ToolRequest) → ToolAdmissionResult`. Sync. Pure.

**Request shape** (selected fields):
- `task: 'chat'` (literal today; reserved for `'search'` / `'discovery'` in future PRs)
- `profile_static: string[]` — tool names declared in the profile's `tools.static`
- `budget_tokens: number` — max admitted-tool-token spend; falls back to `Infinity`
- `user_groups: string[]` — derived from active profile's `tools.allowed_groups`; `['full']` bypasses authorization
- `task_ledger: TaskLedger|null` — for sticky re-admission of tools the model invoked on prior turns
- `discovery_call`, `expansion_mode` — reserved; ignored by current Phase 1 logic

**Result shape:** `{ admitted: AdmittedTool[], suppressed: SuppressionRecord[], diagnostics: ToolDiagnostics, tokens_used: number }`.

**Trigger points in production:**
- [`js/llm/api.js:955`](../js/llm/api.js) — `LLMTools._runComposer()` calls it once per `getToolsForRole()` invocation (i.e. once per LLM exchange). Output threaded to `_lastMetrics` for the `cost:updated` event and to `LLMDebug.attachToolDiagnostics` for the LLM-debug modal.
- [`js/llm/api.js:1221`](../js/llm/api.js) — `LLMTools.getAdmittedTools()` re-runs `_runComposer()` for the system-prompt path (same pure read; output goes to `buildSystemPrompt({admittedDefs, composerActive})`).
- [`js/chat/handlers.js:381`](../js/chat/handlers.js) — chat tool-loop calls `getAdmittedTools()` once per request to render the system prompt with the matching enumeration. **Both paths run the Composer twice per turn** (once for the API tool-array, once for the system-prompt enumeration). The 2.35.0 contract is that both runs are pure reads of the same registry + profile + ledger, so they cannot disagree — but they DO run twice. See "Code-aware findings" below.

**Invariants:**
- Output `admitted[]` is in declared order (static first, then ledger-order sticky); `renderForLLM(result)` preserves this order so the operator-visible "priority" in the profile static set survives to the API.
- `admitted[]` carries `tool_id` (Catalog ID) not name; downstream filters (`applyPlanModeFilter`, `applyPreviewToolFilter`, `applyScriptAutomationFilter`) look up by `.function.name` from the rendered shape, not by `tool_id`.
- `tokens_used > budget_tokens` is permitted (and surfaces in diagnostics) when the static set alone exceeds budget — operator-visible signal, not a hard error.
- Authorization changes mid-task drop previously-sticky tools (re-checked every call); a tool the operator removed from `allowed_groups` does not survive in the next exchange's admission.

### `renderForLLM(result)` ([tools/composer.js:408](../js/intelligence/tools/composer.js))

**Signature:** `(ToolAdmissionResult) → ToolDefinition[]`. Sync. Pure.

**Trigger point:** [`js/llm/api.js:1180`](../js/llm/api.js) — final step of `getToolsForRole()` before the result is filtered by `applyPlanModeFilter`, `applyScriptAutomationFilter`, `applyPreviewToolFilter` and returned as the OpenAI tool-array.

**Why re-resolution through `Catalog.getById()` matters:** The `AdmittedTool.rendered` field is a diagnostic record (what *was* sent), not the authoritative source. If the registry mutates between admit and render (a plugin registers / unregisters mid-call), `renderForLLM` emits the currently-registered shape. Removed tools drop silently. This protects against stale-state cache-served responses pointing at a tool the model can no longer call.

**Output order matches input order.** The caller controls priority via the profile's declared `tools.static` order; the Composer doesn't reorder.

### `_testing` ([tools/composer.js:420](../js/intelligence/tools/composer.js))

**Members:** `isAuthorized`, `toOpenAIShape`, `_orderNonStaticByLRU`, `_resolveCost`.

**Not a public surface.** Exists for unit tests in `tests/test-tool-composer.mjs` to assert internal helper behavior (authorization branches, LRU sort stability, cost choice for `short` vs `full` form). External consumers must not reach in; behavior is not invariant across patches.

### `compose(req, deps, opts)` ([retrieval/composer.js:435](../js/intelligence/retrieval/composer.js))

**Signature:** `(RetrievalRequest, {strategies, getChunkByID}, opts?) → Promise<RetrievalResult>`. Async. Pure (modulo step 6.5 ledger side-effect on `req.task_ledger`).

**Request shape** (selected fields):
- `task: string` — task description string (rendered into the final `task` block); used for diagnostic context
- `query: string` — primary retrieval query
- `query_variants?: string[]` — populated by the Composer when an optional paraphraser/expander runs (step 0); otherwise absent
- `priority_pins?: ChunkID[]` — pinned chunks admitted first
- `budget: {total_tokens, system_reserve, output_reserve, history_reserve}` — three-layer budget
- `history: HistoryTurn[]` — chat history packaged oldest→newest within `history_reserve`
- `task_ledger?: TaskLedger` — when supplied, step 6.5 fires (novelty-aware re-admission suppression)

**Deps shape:** `{ strategies: Strategy[], getChunkByID: (id) => Promise<ChunkRef|null> }`. The caller (production: `retrieval/manager.js`; tests: fixture factories) wires the strategies + chunk-store lookup; the Composer never embeds, never queries an index directly, never opens a DOM root.

**Opts shape:** `turnId?`, `queryEmbedding?`, `noveltyThreshold?`, `timeDecayMs?`, `queryParaphraser?`, `queryExpander?`. The two query-rewrite options are mutually exclusive — when both supplied, the expander wins (the back end is source of truth even if a UI bug leaks both modes set).

**Result shape:** `{ blocks: ContextBlock[], used_tokens: number, chunks_by_id: Object<ChunkID, ChunkRef>, diagnostics: Diagnostics }`. Blocks emit in attention-aware order (`task` at tail; `retrieved` + `history` body; `system_context` reserved). Caller stitches the prompt by `position` order.

**Trigger point:** [`js/intelligence/retrieval/manager.js:38`](../js/intelligence/retrieval/manager.js) — imported and called from `RetrievalManager.findRelevantFiles()`. Production cutover happened at 1.5.14 (replaced legacy `js/context-manager.js`).

**Invariants:**
- `priority_pins` admit before any strategy contribution; the OVERSIZED_PIN throw in step 5 guarantees no single pin exceeds total retrieval budget, so dropOverflow's "pinned never dropped" guarantee is sound.
- `strategies_used` and `strategies_skipped` are disjoint and together cover all input strategies; a degraded strategy (`STRATEGY_THREW` warning) appears in `strategies_used` with 0 chunks, not in `strategies_skipped`.
- `chunker_versions` snapshot is the runtime-resolved chunker version map — pinning the result to the chunker that produced it. A re-ingest with a different chunker version invalidates ledger entries whose `chunker_version` doesn't match (step 6.5 detail).
- `query_variants` MUST contain the original `req.query` as variant 0 when `queryParaphraser` produced results; when `queryExpander` produced results, `query_variants` contains ONLY expander output (baseline excluded — the "drop baseline from fusion" rule from the 2026-05-07 lever-B probe).

## Interaction matrix

The two Composers are *mostly* orthogonal — different domains, different signatures. Three contract surfaces where they intentionally agree:

### Shared seam contract

- **Pure functions of (request, registry-or-index, optional ledger).** Neither reads `State` directly. Both treat the caller as authoritative for what the registry / index contains. This is what makes both testable without an LLM, a vector store, or a DOM root.
- **Output records carry diagnostics inline.** `ToolAdmissionResult.diagnostics` and `RetrievalResult.diagnostics` are first-class returns, not side-channel logs. Consumers pin metrics to the exchange that produced them.
- **Caller wires the production rendering.** `renderForLLM` for tools is a separate export so the caller can apply downstream filters (Plan Mode, Script Automation, Preview gates) without the Composer being aware of them. The retrieval Composer emits `ContextBlock[]` with `position` hints; the caller stitches the system prompt and decides per-block formatting.

### Disjoint surfaces

- **Tools' admission unit is the tool definition** (`ToolDef` — name, description, schema). Retrieval's admission unit is the chunk (`ChunkRef` — content, tokens, provenance). The two are never co-mingled.
- **Tools' "discovery" path is reserved for future PRs.** Retrieval's "discovery" path is the strategy router — already shipped. The two Composers will not converge on a shared discovery surface; the domain shapes are too different.
- **Tools' overflow protects the static set;** retrieval's overflow protects pinned chunks. Both have a "this is the operator's commitment, not the runtime's call" invariant, but they enforce it on different inputs.

### Open invariants (not asserted today)

- The two Composers' diagnostics field names overlap on a few keys (`tokens_used`, `suppressed`/`suppressions`) but are NOT type-compatible. Future code that ingests both (e.g. a unified intelligence-layer dashboard) must keep the two sources separate. No assertion enforces this today; if drift surfaces, an `intelligence/diagnostics-shape.test.mjs` would land it.

## The "Composer-vs-non-Composer" path drift (tools side)

[`ICD-chat-handlers.md`](ICD-chat-handlers.md) §"The Composer-vs-non-Composer path drift" covers the chat-side cross-reference. This ICD pins it in isolation:

### The contract

Two paths produce the same per-turn enumeration of admitted tools:

- **Composer active** ([`js/llm/api.js:1126-1141`](../js/llm/api.js)) — `composeAdmission` resolves a profile's `tools.static` against the registry, returns `result.admitted[]`, then `renderForLLM(result)` produces the OpenAI tool-array. The parallel system-prompt path calls `getAdmittedTools()` (same `_runComposer` call) and threads `{admittedDefs, composerActive: true}` into `buildSystemPrompt`.
- **Composer not active** ([`js/llm/api.js:1126-1141`](../js/llm/api.js) "Legacy path" branch) — `Profiles.filterTools(defs, profileName)` returns the registry's profile-filtered subset. The parallel system-prompt path derives enumeration from the SAME `Profiles.filterTools(...)` call.

**Invariant:** Both paths read `Profiles.filterTools(defs, profileName)` (Composer path inside Composer's authorization gate; legacy path directly). The system-prompt enumeration and the API tools-array are guaranteed to agree because they share the upstream filter.

### Why the drift bit at 2.35.0

Pre-2.35.0, the legacy system-prompt path read a hardcoded `LEGACY_TOOL_ENUMERATION` constant in `js/prompts.js` that had to be edited every time a tool was added or removed. Three tool additions (Tier 3a preview at 2.10.0, CI tools at 1.4.5, LLM-authored automation at 1.16.0) silently failed to update that constant; the model's system prompt told it tools existed that the API didn't admit, OR didn't tell it about tools the API did admit. The 2.35.0 deletion of `LEGACY_TOOL_ENUMERATION` + same-projection derivation made the contract self-enforcing — both paths read from the registry through the same filter.

### What the ICD freezes

The contract that "Composer active → admittedDefs from `_runComposer().result.admitted` mapped to ToolDefs; Composer not active → `Profiles.filterTools(defs, profileName)`" is now load-bearing. Adding a third source (e.g. a discovery-aware enumeration that the Composer admits but the legacy path doesn't know about) would re-introduce the drift class.

Anti-regression test: [`tests/test-system-prompt-admission.mjs`](../tests/test-system-prompt-admission.mjs) asserts both paths produce the same set of tool names for a fixed profile + registry state.

## Code-aware findings (feed back to ROADMAP as 2.46.0+ rows)

Authoring this ICD surfaced **one** drift item worth promoting to `[strong]` in the next code minor:

### 1. Retrieval Composer docstring claims "not yet wired"

[`js/intelligence/retrieval/composer.js:31-34`](../js/intelligence/retrieval/composer.js) opens with:

> `**No runtime wire-up:** the Composer is exported but not yet called by find_relevant_files or js/context-manager.js; production wiring lands with the migration PR (1.5.2 per ROADMAP). Removability holds (Decision §7) — with composer.js deleted nothing in production degrades.`

This is **stale**. Production wiring landed at 1.5.14 (the cutover that retired legacy `js/context-manager.js` entirely). [`js/intelligence/retrieval/manager.js:38`](../js/intelligence/retrieval/manager.js) imports `compose` and drives `findRelevantFiles()` through it. The Removability claim is also now inverted — with `composer.js` deleted, `retrieval/manager.js` fails to import and `find_relevant_files` breaks at module-load time.

**Suggested fix shape (2.46.0+):** A docstring update — single-file, no behavior change. The "No runtime wire-up" paragraph deletes; replace with a "Production wiring" paragraph naming `retrieval/manager.js` as the caller and dating the cutover (1.5.14). This is a `[strong] [S]` row that folds into the next in-track patch. Audit the rest of the file's docstrings for similarly stale 1.4.x-era claims at the same time.

### Nothing surfaced for the tools Composer

The Tools Composer docstring is current and accurate; the production wire-up at `js/llm/api.js:67/990/1180` matches what the module header claims. No drift found.

### Other observations (not promoted)

- **Both Composers re-run twice per chat turn** — once for the API tool-array (via `getToolsForRole()`), once for the system-prompt enumeration (via `getAdmittedTools()`). Both are pure reads of the same registry+profile+ledger so they cannot disagree, but the doubled cost matters for very large `profile_static` sets (the Composer's `Catalog.getByName` + authorization-check inner loop is O(n) per call). Today this is fine — `coder.v1` has ~50 static tools — but a future profile with hundreds of tools would feel it. Memoization within a single tick is the natural fix; not load-bearing today. Park as a `[fuzzy]` note in the deferred bucket, not a `[strong]` row.

## Why these two Composers resist consolidation

A natural-looking refactor is "extract a `BaseComposer` class with abstract `admit()` / `render()` hooks." That has been considered and deferred for three reasons:

1. **Different domains, different shapes.** Tool admission is per-name (a string set); chunk admission is per-content-hash (a content set). Tool authorization is per-required-group; chunk authorization is upstream-only (ingest walker). Tool budget is single-tier; retrieval budget is three-tier with strategy proportional shares. A shared base class would force every consumer to read through abstractions that don't simplify either path.

2. **Different lifecycle profiles.** The Tools Composer runs synchronously twice per LLM exchange. The Retrieval Composer runs asynchronously once per `find_relevant_files` tool call or `findRelevantFiles()` plugin call (a much rarer event). Folding both into a shared async surface would add unnecessary async overhead to the chat-loop hot path.

3. **The seam contract is the abstraction.** What both Composers share is *the seam* — pure function, DI deps, structured diagnostics, separate render export. That's documented here; consolidating the *implementations* would obscure rather than expose the contract.

The collapse remains a future option if a third Composer surfaces and the per-Composer divergence becomes pure ceremony; today the two-per-seam pattern is the contract.

## Forward-evolution rules

### When adding a new Composer in the intelligence layer (e.g. memory, compression)

1. **Make it pure.** No `State` reads, no DOM, no logging side effects. The caller wires production; the Composer is testable without it.
2. **DI for collaborators.** Strategies / catalog / chunk-store lookups arrive as deps, not as imports. The Tools Composer's `Catalog` import is borderline — the catalog is a singleton today, but a multi-profile world might want per-call catalog views; the import would become a constraint.
3. **Structured diagnostics on the result.** Don't log to console for diagnostic flow control; emit a record the caller can pin to its exchange.
4. **Separate render export.** Keep the rendering for the production API out of the Composer itself so the caller can apply filters / formatting / framing.
5. **Document the wiring location at the top of the file** — and **keep it current.** The stale docstring finding above is what motivates this rule.

### When changing the Tools Composer's static-vs-sticky-vs-discovery shape

1. **The `source` enum is load-bearing.** Code branches downstream (cost dashboard, sticky-ledger reconciliation) discriminate on `source`. Adding a new value (e.g. `source: 'discovery'` for PR 5) requires a coordinated update to every consumer; `_lastMetrics` and `LLMDebug` consumers iterate on the field today.
2. **Authorization stays uniform across sources.** Static, sticky, and (future) discovery entries all pass through `isAuthorized` with the same `user_groups`. An authorization carve-out per source class would re-introduce the kind of carve-out the 2.0 profile flip eliminated.
3. **LRU eviction touches only non-static entries.** Static is privileged; the static set is the operator's commitment.

### When changing the Retrieval Composer's step ordering

1. **Pinned-first is load-bearing.** Step 5 admits pinned chunks before any strategy contribution. Reordering would lose the "user explicitly said this matters" guarantee.
2. **Step 6.5 (ledger) sits between interleave (step 6) and overflow (step 7).** Moving it would change novelty-suppression semantics; the design's principle is "decide what's novel before deciding what to drop."
3. **Strategy parallelism is `Promise.allSettled`-style.** One strategy's throw cannot tank the call. The `STRATEGY_THREW` warning is the operator-visible signal; the strategy lands in `degraded_strategies`.

## References

- Source: [`js/intelligence/tools/composer.js`](../js/intelligence/tools/composer.js), [`js/intelligence/tools/index.js`](../js/intelligence/tools/index.js) (barrel re-export), [`js/intelligence/tools/catalog.js`](../js/intelligence/tools/catalog.js), [`js/intelligence/retrieval/composer.js`](../js/intelligence/retrieval/composer.js), [`js/intelligence/retrieval/router.js`](../js/intelligence/retrieval/router.js), [`js/intelligence/retrieval/ledger-consumer.js`](../js/intelligence/retrieval/ledger-consumer.js), [`js/intelligence/retrieval/manager.js`](../js/intelligence/retrieval/manager.js) (production consumer).
- Production wiring: [`js/llm/api.js`](../js/llm/api.js) (tools: lines 67 / 955 / 990 / 1180 / 1221 — `_runComposer`, `getToolsForRole`, `getAdmittedTools`); [`js/chat/handlers.js:381`](../js/chat/handlers.js) (system-prompt parallel); [`js/prompts.js`](../js/prompts.js) (`buildSystemPrompt({admittedDefs, composerActive})`).
- Design contracts: [`docs/DESIGN-tools.md`](DESIGN-tools.md) §"Static is privileged" + §"Eviction is LRU-by-task-use"; [`docs/DESIGN-retrieval.md`](DESIGN-retrieval.md) §"Composition Algorithm" lines 395–471; [`docs/DESIGN-intelligence.md`](DESIGN-intelligence.md) cross-subsystem narrative.
- Tests: [`tests/test-tools-composer.mjs`](../tests/test-tools-composer.mjs) (Tools Composer admission + authorization + budget + LRU); [`tests/test-retrieval-composer.mjs`](../tests/test-retrieval-composer.mjs) (Retrieval Composer steps 1–8 + ledger); [`tests/test-system-prompt-admission.mjs`](../tests/test-system-prompt-admission.mjs) (Composer-vs-non-Composer projection invariant).
- Cross-ICD: [`ICD-chat-handlers.md`](ICD-chat-handlers.md) §"The Composer-vs-non-Composer path drift" — chat-side consumer cross-reference.
- Methodology: [`ROADMAP.md`](ROADMAP.md) §"Per-subsystem ICD backfill program" (this ICD is target #2; target #3 is the Tool registry admission contract at `RE-EVAL following 2.47.0`).
- History anchors: 1.3.14 (Composer Phase 1); 1.3.17 (sticky admission via TaskLedger); 1.4.1 (lazy `short` form for discovery); 1.4.8 (LRU eviction); 1.4.17 (Retrieval Composer steps 1–8); 1.4.18 (step 6.5 ledger consumer); 1.5.12 (paraphraser opt); 1.5.14 (Retrieval Manager cutover — legacy `context-manager.js` retired); 1.8.1 (expander opt, lever-B production wiring); 2.0.0 (profile contract flip; `'*'` → `['full']` bypass); 2.35.0 (`LEGACY_TOOL_ENUMERATION` deletion; Composer-vs-non-Composer same-projection derivation).
