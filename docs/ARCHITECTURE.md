# AI Editor — Architecture

> Module dependency map, layer boundaries, and key data flows.
> Last sync: **2.60.0** (2026-05-16, sixth RE-EVAL slot — `RE-EVAL following 2.55.0`, overdue by 5 minors; doc-only — no version bump, accumulates in [Unreleased]; 8-minor catch-up from the 2.52.0 sync covering: 2.53.0 `resolveTaskLedgerConfig` resolver (ICD #5 finding (a)), **2.54.0 tool-admission inversion** — `roles:` retired; profiles enumerate explicit names in `tools.admit`; `'*'` sentinel + `'<prefix>__*'` glob + `admit_add`/`admit_remove` operators (gitea#438), 2.55.0 `findAdmittingProfiles` boot-warn (gitea#439), 2.56.0 hand-curated admit lists for chat.v1/coder.v1/kb.v1 (gitea#440), 2.57.0 user-visible Roles→Profiles rename (gitea#441) + 2.57.0.1 PROFILES_AND_TOOLS.md rewrite + 2.57.0.2 TOOLS.md rewrite + 2.57.0.3 this doc's tools/registry paragraph fix, **2.58.0 `plugin.enabled` capability-overlay flag** (gitea#442), 2.59.0 `ChunkStore` typedef widening (ICD #5 finding (b1)), and 2.60.0 demote dead `resolveReviewThread` (ICD #4 finding #3). Plus the [Unreleased] sub-agents Phase 2 spec (doc-only expansion of DESIGN-sub-agents.md). Per-subsystem detail lives in [`docs/DESIGN-*.md`](.) and [`docs/ICD-*.md`](.) — sixth ICD authored this slot at [`docs/ICD-mcp-bridge.md`](ICD-mcp-bridge.md); this doc tracks structural shape only.

> **Commitment bands.** Per the methodology adopted 2026-05-12 (see [`VERSIONING.md`](VERSIONING.md) and [`ROADMAP.md`](ROADMAP.md) §"How to read the bands"), unlabeled sections in this document are implicit `[strong]`-band commitments — load-bearing for the next ~3 milestones. The Intelligence Layer carries `[medium]` for Phase 2 picker promotion (`kb.v1` shipped 2.8.0; `chat_multi.v1` / `rp.v1` deprioritized for ai-editor) and `[fuzzy]` for Phase 3 operational maturity and Phase 4 extensibility.

## Design Constraints

- **No build step.** Every `.js` file is a native ES module (`<script type="module">`).
- **Vanilla JS for existing code; Preact + `htm` allowed for new state-heavy surfaces from 1.3.0 onward** (per `docs/ROADMAP.md` Decision §9). Existing tabs / sidebar / file tree / editor frame / chat stay vanilla and don't get migrated. New surfaces with non-trivial state — Memory tab (1.3.0), inline `@memory` chip, active-tools chip row (1.4.0), profile picker (2.0) — may use Preact + `htm/preact` loaded via the vendor bundle (no JSX, ~5KB gzipped). `useState` is for ephemeral UI state only; app-level state stays in `State` + `EventBus` and components subscribe via a thin store hook.
- **No package.json.** Vendor scripts are fetched from CDN with SRI hashes.
- **Single global state.** `State` in `core.js` is the truth; `EventBus` decouples consumers.

## Layer Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                          app.js (entry)                          │
│      Boots modules, wires EventBus, loads UI partials/HTML       │
├──────────────┬─────────────────┬─────────────────┬───────────────┤
│   UI Layer   │   Editor Layer  │    Chat Layer   │  Help Layer   │
│              │                 │                 │               │
│ settings/    │ editor/         │ chat/           │ help/         │
│   llm-tab    │   instance      │   index         │   pages/      │
│   connections│   setup         │   handlers      │   hotkey-     │
│   persistence│   ghost-text    │   messages      │   registry    │
│   plugins-tab│ tab-manager     │   summarizer    │ (in-app)      │
│   models-tab │ file-tree       │   conversations │               │
│   memory-tab/│ resize-manager  │   replay (debug)│               │
│   cost-tab   │ secondary-pane  │   tool-classif. │               │
│   profile-   │ diff-viewer     │   cache-invalid.│               │
│     picker   │ search-panel    │   refusal-hints │               │
│ ui/          │ quick-open      │   task-state    │               │
│  rail v2     │                 │   turn-enrich   │               │
│  modal-      │ pr-review/      │   consent-card/ │               │
│   registry   │ merge-conflict/ │   memory-chip/  │               │
│  hotkey-     │ preview/        │   plan-mode-    │               │
│   bindings   │  (Tier 1/2/3a)  │     chip/       │               │
│  icons       │                 │   plan-approval-│               │
│  branch-     │                 │     card/       │               │
│   panel      │                 │   script-       │               │
│  pr-list /   │                 │     approval-   │               │
│   issue-list │                 │     card/       │               │
│  now-strip   │                 │   ask-user-card/│               │
│ onboarding   │                 │   queued-input- │               │
│ mobile       │                 │     panel/      │               │
│ projects/    │                 │   scratchpad-   │               │
│  switcher-   │                 │     panel/      │               │
│   menu       │                 │   export        │               │
│ zip-upload   │                 │                 │               │
│ zip-export   │                 │                 │               │
├──────────────┴────┬────────────┴─────────────────┴───────────────┤
│   Slot/Event Reg. │   Tool Layer (~60 native + MCP-bridged)      │
│                   │                                              │
│ slot-manager      │ tools/registry        tools/file-tools       │
│  ('rail-views' +  │ tools/edit-tools      tools/multifile-tools  │
│   5 flat slots)   │ tools/cursor-tools    tools/scan-tools       │
│ events/public-    │ tools/search-tools    tools/project-tools    │
│  channels (1)     │ tools/xref-tools      tools/issue-tools      │
│ ui/modal-registry │ tools/pr-tools        tools/commit-tools     │
│ ui/hotkey-        │ tools/scratchpad-tools tools/context-tools   │
│  bindings         │ tools/plugin-tools    tools/doc-tools        │
│ security/         │ tools/eval-tools      tools/git-log-tools    │
│  untrusted-wrap   │ tools/preview-tools   tools/edit-tracker     │
│  invisible-       │ ── MCP bridge (js/mcp/, plugins/mcp-bridge)──│
│   unicode         │                                              │
├──────────────────┬┴──────────────────────────────────────────────┤
│  Profiles (load-bearing as of 2.0) — js/profiles/                │
│                                                                  │
│  Picker-promoted: chat.v1 · coder.v1 · kb.v1                     │
│  Synthetic (lookup-only): chat_multi.v1 · rp.v1 · subagent.v1 ·  │
│    full.v1 · plugin-dev.v1 · pm.v1 · reviewer.v1                 │
│  tools.admit: name enumeration + '<prefix>__*' glob + '*' bypass │
│  admit_add / admit_remove (inheritance operators) — since 2.54.0 │
│  Overlay seams: plugin.enabled · preview.enabled ·               │
│    scriptAutomation.enabled (capability flags layer onto active) │
│  registry · resolve · migration · inheritance · diff             │
│  profile-contract (the typed shape) · task-ledger                │
├──────────────────────────────────────────────────────────────────┤
│         Intelligence Layer (js/intelligence/)                    │
│  retrieval/  manager + strategies (paraphrase, BM25, structural, │
│              thematic, composer, semantic);                      │
│              chunkers/code-chunker (AST Phase 1 + 2);            │
│              contracts.js;                                       │
│              7-day IDB paraphrase cache                          │
│  memory/     file-layer (.aieditor/memory/* git-tracked notes)   │
│  cost/       cost-store (per-conv, per-tool, per-strategy;       │
│              KeyMutex; byStrategy)                               │
│  compression/  tracker; Rules 1+2 staged                         │
│  tools/      embeddings (semantic tool admission via Catalog)    │
│  test-loop/  subsystem self-test harness                         │
│  workspace-settings/  per-workspace overrides                    │
├──────────────────────────────────────────────────────────────────┤
│                          LLM Layer                               │
│  llm.js (barrel)   llm/api  (streaming SSE, tool-call asm,       │
│                              Composer-aware getAdmittedTools)    │
│  llm/debug   llm/utils                                           │
│  prompts.js  (system prompt builder; Composer-vs-non-Composer    │
│               enumeration derives from Profiles.filterTools()    │
│               on both paths since 2.35.0; untrusted markers      │
│               render from UNTRUSTED_KINDS since 2.37.0)          │
│  embeddings-client                                               │
├──────────────────────────────────────────────────────────────────┤
│                          Git Layer                               │
│  git.js (facade)  git-providers/registry                         │
│  git-providers/base   gitea · github · gitlab · local            │
├──────────────────────────────────────────────────────────────────┤
│                          Core Layer                              │
│  core.js: State, EventBus, Storage, Plugins, Providers, Roles    │
│  providers/registry  providers/venice  providers/openrouter      │
│  storage/idb   version.js   utils/html   workers/   release-mgr  │
└──────────────────────────────────────────────────────────────────┘
```

Layer ordering note: Intelligence sits *below* Tool but *above* LLM because tools call into the intelligence subsystems (e.g. `find_relevant_files` → `retrieval/manager.compose()`), and the intelligence subsystems call into the LLM (e.g. paraphrase strategy → `LLM.chat`). **Profiles is load-bearing as of 2.0.0** (per ROADMAP Decision §2) — the picker replaced the role selector, and `Profiles.filterTools()` is the canonical tool admission for both the API tools-array and the system-prompt enumeration.

## Core Layer

### `core.js`

The shared kernel. Everything imports from here. Exports:

| Export | Type | Purpose |
|--------|------|---------|
| `State` | Object | Mutable global state (settings, runtime, chat history) |
| `EventBus` | Object | Pub/sub: `.on(event, cb)`, `.emit(event, data)` |
| `Storage` | Object | Sync reads from in-memory cache; async writes to IndexedDB + localStorage |
| `Plugins` | Object | Plugin lifecycle: register, init, hooks, config persistence |
| `window.AIEditor` | Global | API for external plugins: `{ Plugins, EventBus, State, Storage, Providers, Roles }` |
| `Roles` | Object | Role definitions + tool filtering (`full`, `coder`, `pm`, `reviewer`) |
| `Providers` | Object | Backward-compat facade over `ProviderRegistry` |
| `ProviderRegistry` | Object | LLM API provider plugins (OpenAI, Venice, OpenRouter) |
| `loadSettings()` | Function | Hydrate `State.settings` from Storage with deep-merge |
| `saveSettings()` | Function | Persist `State.settings` to Storage |

**Import rule:** `core.js` imports only from `providers/index.js`. No other module
may import from `core.js` and also be imported by `core.js` (no cycles).

### `storage/idb.js`

IndexedDB wrapper. Single object store (`ai-editor`), key-value pairs.
Loaded lazily by `Storage.init()`. Falls back to localStorage if IDB
is unavailable (incognito mode, old browsers).

### `providers/`

LLM API provider plugins. Each provider transforms request bodies and
response parsing for provider-specific extensions (Venice thinking blocks,
OpenRouter fallback routing, etc.).

**Venice prompt-cache breakpoint (2.50.0.1).** `js/providers/venice.js#_attachSystemCacheBreakpoint` wraps the last system-message content as `[{type:'text', text, cache_control:{type:'ephemeral'}}]` so Venice's Anthropic-style prefix cache retains `(tools + system)` across the session. Toggle via the `enablePromptCache` setting (default ON; Settings → Provider → Venice). Cache-hit tokens already surface through `extractUsage()` → `State.sessionCost.cacheReadTokens`/`cacheCreationTokens`, so the cost dashboard reflects savings without new UI. Scoped to Venice; other providers extend via the same seam.

## Git Layer

### `git.js`

Facade that resolves the active `connection` from `State.settings.connections[]`
and delegates to the correct provider instance from `git-providers/registry`.

### `git-providers/base.js`

Default interface (55 methods + 1 `get capabilities()` getter; see [`ICD-git-providers.md`](ICD-git-providers.md) for the full contract). Providers are plain object literals; the registry merges them onto `BASE_GIT_PROVIDER` via shallow spread (`{ ...BASE_GIT_PROVIDER, ...provider }`) — no class inheritance. Three default behaviors: `notSupported` throw (the rule, 39 of 55 methods post-2.60.0 demote of `resolveReviewThread`), safe-empty return (`null`/`[]` for feature-detection paths — `getLanguages`, all `listWorkflow*`), and functional defaults that compose other base methods (`getMergeConflicts`, `getBranchAheadBehind`, `getChangedFilesBetween`, `addPullRequestComment`). The status-code → `ErrorCode` map at lines 89–104 produces LLM-actionable `EditorError` envelopes. A six-flag capability matrix (`reviewSubmission`, `threadResolve`, `viewedFiles`, `merge`, `rerunCi`, `mergeConflictResolution`) is read by the PR Review surfaces; the `undefined → false` invariant lets providers declare partial subsets — GitLab declares all six explicitly since 2.50.0 (was only `mergeConflictResolution: true`). `getCommitDiff` promoted to base with `notSupported` default at 2.50.0 (ICD #4 finding #1; the three remote providers' pre-existing overrides already conform). **`resolveReviewThread` demoted at 2.60.0** (ICD #4 finding #3) — method removed from base + `git.js` facade + the lone GitLab `notSupported` test; the `threadResolve: false` capability flag is **retained** on the 6-flag matrix as the intentional-gap placeholder for a future GraphQL-capable provider. The **circuit breaker** (`circuitBreakerGuard` + `markUnreachable`/`markReachable` + `healthProbe`, `CIRCUIT_COOLDOWN_MS = 60_000`) is exported separately and wrapped manually by the three remote providers' `request()` overrides; Local skips it. Provider capability-shape contract guarded by [`tests/test-provider-capabilities-shape.mjs`](../tests/test-provider-capabilities-shape.mjs) (2.50.0).

### `git-providers/{gitea,github,gitlab}.js`

Concrete implementations. Each normalizes provider-specific API responses
into the shapes defined in `base.js` typedefs (`BlameData`, `FileCommit`,
`PullRequestData`, `PRFileChange`, `CommitStatus`).

### `git-providers/local.js`

In-memory zip-only provider used when the user uploads a zip without a
Git connection. Backs `getFileTree` / `getFile` / `batchCommitFiles` with
a `Map`. Hidden from Settings → Connections (`hidden: true`). Refreshing
the page wipes its state — by design.

## LLM Layer

### `llm/api.js`

Core LLM client. `LLM.chat()` handles streaming SSE parsing, think-block
stripping, tool call assembly, and cost tracking (writes to
`js/intelligence/cost/cost-store.js`). `buildRequestBody()` applies
provider-specific transforms.

### `chat/summarizer.js`

Context-window-aware chat compression. Modes (`aggressive`/`balanced`/
`conservative`) set a fill-percentage of the model's context window
(30%/50%/75%). Params (recent count, threshold, interval) scale linearly
from `contextTokens × fillPct / 800` with min/max clamps. No discrete tiers.
1.6.4 added a token-based summarization trigger keyed on
`State.lastExchangeTokens.prompt` plus a map-reduce multi-pass when the
utility model's window is small (1M prod ↔ 4–256K utility).

**Session cut-off reason surfacing (2.51.0.1).** Session terminations now carry a structured `reason` field on the trailing assistant message + status pill (`budget-exceeded` / `model-finished` / `user-cancelled` / `tool-cancelled` / etc.) so users (and the model on a Plan-Mode follow-up) can distinguish "we ran out of budget" from "the model stopped cleanly." Closes gitea#425.

### `prompts.js`

System prompt builder. `buildSystemPrompt({ admittedDefs?, composerActive? })` assembles profile instructions, active tool list, scratchpad contents, project context, and summarizer state into a single system message. Two paths since 2.35.0:

- **Composer active** — caller passes `admittedDefs` from `LLMTools.getAdmittedTools()`; enumeration renders directly.
- **Composer not active** — derives enumeration from `Profiles.filterTools(ToolRegistry.getDefinitions(), profileName).map(...)`. Same filter that powers the API tools-array; no second source.

**Tools TOC compaction (2.51.0).** Replaced verbose per-tool enumeration with a compact category index in the system prompt's stable head; the model reads names + groupings from the TOC without consuming the full tool-by-tool prose every turn. Cuts the model's repeat `list_tool_categories` / `list_tools_by_category` calls (the gitea#426 finding). The full per-tool detail is still available via the existing discovery tools when the model wants it.

**Plan-Mode approved-plan read (2.52.0).** `read_approved_plan` (read-only tool) surfaces the approved plan body persisted to `State.approvedPlan` from the most recent Plan-Mode approval card. Closes the cohort regression where the model regenerated `create_file` payloads verbatim from the inlined plan body — the plan now lives in one place that the executor reads, not in two places that drift.

**Untrusted content** — issue / PR / comment bodies fetched during triage are wrapped in `<UNTRUSTED_*>` markers (1.6.12) and the marker enumeration in the system prompt renders from `UNTRUSTED_KINDS` via `renderUntrustedMarkers()` (2.37.0). The 1.9.x-era "no delimiter" gap closed at PR #296 / 1.6.12; the remaining gap (invisible-Unicode scan of tool returns) is `[fuzzy]` per the roadmap. See [`docs/SECURITY.md`](SECURITY.md) §"Untrusted issue / PR / comment content".

### `tools/registry.js`

Dynamic tool registration. Post-2.54.0 (gitea#438) `ToolRegistry.register()` is a pure store — no admission fields are validated; the legacy `roles:` declaration, `_registeredRoles` enrichment, and `LEGAL_GROUP_TAGS` validation block are all retired (and `Profiles.getKnownGroupTags()` is gone with them — there are no group tags to enumerate). `ToolRegistry.getDefinitions()` returns the raw tool defs; profile-side filtering happens via `Profiles.filterTools()` (the canonical admission), which reads the active profile's resolved `tools.admit` array and admits a candidate def when its `function.name` matches a literal entry OR a `'<prefix>__*'` glob entry. Three carve-outs short-circuit the per-name match: `'*'` as a single-entry sentinel → wholesale bypass (`full.v1` only); `'<prefix>__*'` glob entries (e.g. every picker profile carries `'mcp__*'` so MCP-bridge tools admit by name prefix without per-server enumeration); inheritance operators `admit_add` / `admit_remove` (set-union / set-subtract onto a parent's resolved admit, so a child profile narrows or widens without restating the full list). **Default-OFF for new tools** — a newly-registered tool admitted by zero profiles is callable by zero profiles; surfaced at registration time by the gitea#439 dev warn at `js/tools/registry.js:91` (`console.warn` when `Profiles.findAdmittingProfiles(name)` returns empty) and gated in CI by [`tests/test-profile-admit-coverage.mjs`](../tests/test-profile-admit-coverage.mjs) (asserts every registered tool is admitted by at least one profile). Tool unregistration emits `tools:unregistered` so the tool-embeddings cache (`js/intelligence/tools/embeddings.js`) drops stale entries. Post-2.54.0 contract — inheritance resolution + `tools.admit` matching + operator semantics — at [`docs/DESIGN-profiles.md`](DESIGN-profiles.md) §"Inheritance > Tool admission"; [`docs/ICD-tool-registry.md`](ICD-tool-registry.md) is preserved as historical record of the pre-inversion boundary under a §⚠️ Superseded banner. See [`docs/PROFILES_AND_TOOLS.md`](PROFILES_AND_TOOLS.md) for the admission narrative and per-profile admit-list table (renamed from `ROLES_AND_TOOLS.md` at 2.57.0); see [`docs/ICD-chat-handlers.md`](ICD-chat-handlers.md) for the tool-classification axes consumed by the chat tool loop.

**Param-aliasing seam (2.50.0.2).** `js/chat/tools.js` exports a frozen `TOOL_PARAM_ALIASES` map (cross-SDK-prior arg-name remaps — `start`→`start_line`, `pattern`→`query`, etc.) consumed by a pure `applyAliasesAndDefaults` rewriter wired before `validateToolParameters` fires in `executeToolCall`. Same shape as 2.48.0.1's `_detectWrongShape`; mirrors the validator-level rewrite path from gitea#415. Every classified tool's description carries a `**Required:** <comma-list>.` prefix derived from `REQUIRED_TOOL_PARAMS` so the model sees the requirement before tripping the validator.

Errors thrown by tool handlers (and by the rest of the editor) follow the
contract in `js/utils/errors.js`: `EditorError` extends `Error` with a
machine-readable `.code` (from the `ErrorCode` enum — `NETWORK_TIMEOUT`,
`AUTH_INVALID_TOKEN`, `GIT_NOT_FOUND`, `LLM_STREAM_ERROR`, etc.) and a
human-readable `.recoveryHint` rendered in the UI by
`js/error-logger.js`. Consumers compare `err.code` against the enum
rather than parsing `.message`; `EditorError.fromResponse()` and
`EditorError.wrap()` are the canonical constructors.

## Intelligence Layer (`js/intelligence/`)

The 1.5.x retrieval cutover (PR #266 → bundled into the 1.6.0 tag) and the 1.6.x → 2.X follow-ups consolidated all model-context machinery into a single `js/intelligence/` tree. Per-subsystem detail lives in the [`docs/DESIGN-*.md`](.) docs (retrieval, memory, compression, tools, intelligence cross-narrative).

| Subsystem | Path | What it owns |
|---|---|---|
| Retrieval | `intelligence/retrieval/` | `manager.js` (orchestration + query LRU + indexer-readiness gate + soft budget), strategies (`paraphrase`, `bm25`, `structural`, `thematic`, `composer`, `semantic`), `chunkers/code-chunker.js` (AST Phase 1 + lever B), `contracts.js` (envelope typedefs), `paraphrase-cache-idb.js` (7-day TTL), `measurement.js` + `comparison.js` + `test-corpus.js` (offline measurement harness) |
| Memory | `intelligence/memory/` | `file-layer.js` (git-tracked notes in `.aieditor/memory/*`), in-memory + IDB store, consent boundary (see `chat/consent-card/`) |
| Cost | `intelligence/cost/` | `cost-store.js` (per-conv, per-tool, per-strategy; `KeyMutex`-protected; `byStrategy` extension); fed by `LLM.chat` and `retrieval:turn-stats` events. Settings → Cost dashboard ships since 1.2.1; export since 1.6.6 |
| Compression | `intelligence/compression/` | Phase-1 tracker; Rules 1+2 (Subsumption, Invalidation) staged behind cost-dashboard measurement (see DESIGN-compression) |
| Tools (catalog) | `intelligence/tools/` | `embeddings.js` semantic tool admission via `Catalog` (admissibility, not accumulation); consumed by `LLMTools.getAdmittedTools()` Composer path |
| Test loop | `intelligence/test-loop/` | Self-test harness for the subsystems |
| Workspace settings | `intelligence/workspace-settings/` | Per-workspace overrides via `file-layer.js` |

The retrieval manager exposes `findRelevantFiles(query, opts)`, the public entry point used by both the `find_relevant_files` tool and any plugin that wants the same scoring. It returns structured envelopes on cold-start (`indexer_not_ready`) and budget overrun (`retrieval_partial`) under the 30 s hard tool wall. Full manager + ingest-pipeline + lifecycle + persistence + query orchestration contract — 19 public methods, 5 classification axes (Ingest / Lifecycle / Persistence / Query / Diagnostics), 7 event-driven transitions, IDB key namespace, forward-evolution rules — at [`docs/ICD-retrieval-manager.md`](ICD-retrieval-manager.md).

**Composer seam.** Two pure-function Composers sit at the admissibility boundary between registry-or-index and the model: [`js/intelligence/tools/composer.js`](../js/intelligence/tools/composer.js) (`composeAdmission` + `renderForLLM`) and [`js/intelligence/retrieval/composer.js`](../js/intelligence/retrieval/composer.js) (`compose`). Both are wired into production — tools via `js/llm/api.js#LLMTools._runComposer()`; retrieval via `js/intelligence/retrieval/manager.js` (cutover at 1.5.14, replacing legacy `js/context-manager.js`). Full seam contract — frozen exports, classification axes, interaction matrix, forward-evolution rules — at [`docs/ICD-intelligence-composers.md`](ICD-intelligence-composers.md). The Composer algorithm is upstream of the manager's Query axis; the manager owns lifecycle + persistence + event seam (covered by ICD #5), the Composer owns the admission algorithm itself (covered by ICD #2).

## MCP Layer (`js/mcp/`, `plugins/mcp-bridge.js`)

Model Context Protocol bridge. External MCP servers expose tools via the plugin layer; the bridge ([`js/mcp/bridge.js`](../js/mcp/bridge.js), 232 LOC) registers them through `ToolRegistry` under the canonical `mcp__<serverId>__<toolName>` naming convention (double-underscore prefix + double-underscore separator; opaque downstream — no consumer splits MCP names on `_`). Per-server enable/disable from Settings → MCP Servers; the bundled `plugins/mcp-bridge.js` plugin reconnects on `mcp:serversChanged` (Settings tab emits after add/edit/remove/toggle). Admission flows entirely through profile-side `tools.admit` arrays (post-2.54.0 inversion): every picker profile (`chat.v1`, `coder.v1`, `plugin-dev.v1`) declares `'mcp__*'` as a glob entry; `subagent.v1` deliberately omits it as a trust-boundary measure. Disconnect cascades through `ToolRegistry.unregister` + `protocol.abort` (cancels in-flight AbortControllers + clears `Mcp-Session-Id` session) + `sweepLedgersByToolId(toolId => isOwnedBy(serverId, toolId))` (drops sticky-ledger orphans). The `Mcp-Session-Id` cookie captured on `initialize` is echoed on every subsequent JSON-RPC over the 30s-timeout fetch. The discovery surface (`catalog.js` 8-entry bundled list + `catalog-source.js`/`catalog-fetch.js`/`catalog-merge.js` Smithery adapter with 3-tier IDB-cached fallback + `auto-test.js` Save-time test policy) shipped over github#27 Phase 1 (2.3.0) + Phase 2 slice 1 (2.15.0) + Phase 2 slice 2 (2.16.0); Phase 2 OAuth flows still queued behind a `docs/DESIGN-mcp-oauth.md` design slot. **Dead-letter:** the `server.roles` field on persisted MCP server records (validated by `LEGACY_GROUP_TAGS` at `js/mcp/registry.js:36`; surfaced in Settings → MCP Servers as role checkboxes) is **dead post-2.54.0** — the bridge no longer copies it onto registered tools (pinned by [`tests/test-mcp-bridge.mjs:259`](../tests/test-mcp-bridge.mjs)); admission gates entirely on profile-side `tools.admit`. UX clean-up queued per [`ICD-mcp-bridge.md`](ICD-mcp-bridge.md) §"Code-aware findings #1". Full bridge contract — 5 classification axes (Connection / Registration / Invocation / Cleanup / Discovery), session lifecycle invariants, registration name-shape rules, disconnect cascade, catalog merge semantics — at [`docs/ICD-mcp-bridge.md`](ICD-mcp-bridge.md).

## Editor Layer

### `editor/`

CodeMirror 6 setup. `instance.js` creates the EditorView; `setup.js`
configures extensions (language modes, keybindings, line numbers).

### `tab-manager.js`

Multi-tab support. Manages `State.openTabs[]`, handles preview tabs
(single-click) vs pinned tabs (double-click or edit).

### `file-tree.js`

Sidebar file tree. Fetches tree from git provider, renders expandable
directory listing, handles file selection → tab opening.

### `secondary-pane.js`

Right-side panel for markdown preview, diff view, and blame view.
Diff/blame use `diff-overlay` CSS class to fill the editor-split area.

## Touch 3 Surfaces (2.11.0 → 2.21.0)

The third claude.ai/design touch shipped four surfaces over the 2.X arc, all driven by the rail-views + slot-manager machinery below.

### `ui/left-pane-rail.js` — Rail v2 (2.11.0; SlotManager-driven 2.23.0 + body-owned 2.24.0)

Touch 3 sidebar layout: vertical icon rail + single content area that swaps between views. Consumer of the `rail-views` `STRUCTURED_SLOTS` kind. The 4 built-in views (Files / Issues / Pull Requests / Branches) register at boot from `BUILTIN_VIEWS` with frozen `BUILTIN_PRIORITY` (10/20/30/40); provider contributions slot via `priority` (default 50). `view.headerActions[]` shape extension covers per-view header buttons. `view.onActivate(viewId)` fires after rail switches (gitea#393 / 2.38.1) so external changes surface without a project reload. Active view persists via Storage under `leftPaneRail.activeView`.

### `pr-review/` — PR Review surface (2.12.0 → 2.14.0; AI summary 2.14.0)

Preact + `htm` root rendered into the editor middle pane. `PrReviewSurface.js` (the 798-LOC root) takes over the editor frame for the Conversation / Files / Commits / Checks tabs with side-by-side diff and inline comment threads anchored to lines. `PrReviewDock.js` is the submit/save-draft dock (2.13.0). `PrCommentComposer.js` is the per-line composer. `diff-parse.js` / `pair-side-by-side` produces row models; `poll-cadence.js` paces background polls; `review-state.js` persists drafts + viewed-files state per PR. `diagnose-*.js` (2.14.0) drives the AI summary feature.

### `merge-conflict/` — Merge Conflict Resolver (2.18.0 → 2.21.0)

Preact takeover that stacks above PR Review (priority `80 > 70` in `ModalRegistry`). `MergeConflictSurface.js` is the root; `hunks.js` parses Git conflict markers; `Minimap.js` renders the conflict-density gutter; `resolve.js` applies the user's chosen sides; `ai-resolve-*.js` drives the LLM-assisted resolution path.

### `preview/` — In-editor preview (Tier 1 1.22.0, Tier 2 2.7.0, Tier 3a 2.10.0)

`preview-host.js` (1039 LOC) owns the per-session lifecycle: registers the workspace-resolving Service Worker (idempotent), maintains the in-memory `serverId → entry` registry, mounts the iframe in the preview slide-over, probes for `package.json#scripts.dev` to gate Tier-3-only build-step projects. Tier 2 added per-`serverId` ring buffers for console / errors / routes / network captures (`BUFFER_CAP = 200`). Tier 3a added 5 driveable tools (`preview_snapshot` / `preview_click` / `preview_fill` / `preview_inspect` / `preview_resize`) — selector-shaped, no `preview_eval`. The driving tools mutate state and read it, so they appear in both `PREVIEW_MUTATING_TOOLS` and `PREVIEW_READ_TOOLS`; see [`ICD-chat-handlers.md`](ICD-chat-handlers.md) for the cache-invalidation contract. Tier 3b (sidecar / build-step support) is `[fuzzy]` per ROADMAP.

### Sub-agents Phase 1 (2.49.0; github#24)

`delegate_task` (`js/tools/subagent-tools.js`) is the model-facing entry to bounded child conversations. Approval pair: `SubAgentApprovalCard` (Preact + `htm`; mirrors `ScriptApprovalCard` shape per `pendingSubAgentApproval` slot in [`chat/state.js`](../js/chat/state.js)) + `SubAgentTranscriptPanel` (per-conversation transcript surface). The sub-agent runs against the `subagent.v1` profile (read-only default, `coder.v1` base, per-call ceilings) and drives [`chat/tool-loop-core.js`](../js/chat/tool-loop-core.js) (the 2.48.0 Phase 0 extraction, ~720 LOC) with a different context + hooks bag from the parent. Cost attribution threads through `LLM.chat(..., costAttribution)`; per-conversation transcripts persist at `State.subagents = {tree, transcripts, session_cost}`. Profile resolver: `resolveSubAgentConfig` mirrors `resolveCompressionConfig`; admission via `ToolRegistry.executeWithProfile` + `checkRoleAccessForProfile` (additive entry-points; existing `execute` / `checkRoleAccess` delegate). `'delegate_task'` joins `USER_PAUSE_TOOLS`. Full design: [`docs/DESIGN-sub-agents.md`](DESIGN-sub-agents.md). **Phase 2 spec'd 2026-05-16** ([Unreleased] doc-only expansion of `DESIGN-sub-agents.md` §Phasing → Phase 2) — pins batched approval card + `pendingSubAgentApprovalBatch` state + `subagentCostMutex` (KeyMutex keyed by `'session'`, mirrors `cost-store.js` `recordTurn`) + parent-loop batch-await contract (N `delegate_task` blocks → one batched card → `Promise.all` of N runners → N `tool_result` blocks in one round). Implementation gated on falsifiable Triggers A/B/C (none satisfied yet — Phase 1 corpus insufficient).

## Slot & Event Registries (2.22.0 → 2.44.0 — audit-sweep wave; closed 2.44.0)

The 2026-Q2 audit-sweep wave (2.33.0 → 2.41.0) consolidated four ad-hoc patterns into typed registries. Each replaces a hand-rolled chain that had become its own maintenance hazard.

### `slot-manager.js` — declarative UI extension renderer

Six named slots; contract at [`docs/DESIGN-git-providers-and-ui-extensions.md`](DESIGN-git-providers-and-ui-extensions.md). Slot kinds:

- **Flat slots** (`sidebar-panels`, `settings-connections`, `editor-toolbar`, `chat-input-row`, `status-bar`) — contribution declares `render`; SlotManager mounts into the matching `<div data-slot="...">` element.
- **Structured slot** (`rail-views`, the only structured kind today) — owning renderer (`left-pane-rail.js`) reads contributions via `getContributions('rail-views')` and renders them itself; SlotManager validates the structured shape and emits `forSlot('rail-views')` so the consumer re-renders.

`applyProviderContributions()` consumes `GitProviderRegistry.getAllContributions()` and registers each panel. Schema version `'1.1'` only.

### `events/public-channels.js` — `PUBLIC_EVENT_CHANNELS` (2.39.0.0)

Frozen registry of EventBus channels plugins may subscribe to, grouped by surface (`chat`, `editor`, `files`, `git`, `llm`, `plugin`, `issues`, `conversations`, `ghostText`, `mergeConflict`, `slots`). Several channels have **zero in-tree subscribers by design** — they're extension hooks for plugin code; the grep-based channel-discovery audit can't tell "intentional extension point" from "dead wire" without this registry. Single source of truth for `js/profiles/plugin-dev-v1.js`'s Plugin SDK system-prompt enumeration (same shape as 2.35.0 `renderToolEnumeration` and 2.37.0 `renderUntrustedMarkers`). `forSlot(slotId)` helper (2.41.0) generates dynamic `slot:<id>:changed` channel names with strict input validation; the bidirectional codebase-parity guard in `tests/test-public-event-channels.mjs` rejects drift in either direction.

### `ui/modal-registry.js` — overlay close routing (2.33.0)

Every overlay registers once at boot via `registerOverlay({id, isActive, close, priority, poppable})`. Esc and popstate handlers call `closeTopmostOverlay()` which picks the highest-priority active entry. Stacking invariants (Merge Conflict above PR Review) live as priority numbers (`80 > 70`), not as hand-coded chains. 5 core overlays registered at boot with priorities 100/90/80/70/50.

### `ui/hotkey-bindings.js` — document-level shortcut dispatcher (2.36.0)

Replaces the pre-2.36.0 hand-rolled keydown chain in `app.js` (~158 LOC). Every binding registers once at boot via `bindHotkey({id, handler, enabled?})`; a single keydown listener calls `dispatchHotkey(event)`. Combo definitions are the single source of truth in `HOTKEYS` (carrying `documentBound: true` for the 19 entries this dispatcher owns). Combo vocabulary covers `mod` (Ctrl/Cmd), `shift`, `alt`, named keys (`slash`, `comma`, `esc`, `f1`-`f12`), and case-insensitive single chars; modifier-strictness prevents Ctrl+P from firing on Ctrl+Shift+P.

### `ui/dom-bindings.js` — boot-time + slot-aware click/event wiring (2.44.0.1)

Replaces the closure-local `safeAdd` helper that lived in `js/app.js#setupEventListeners` and the parallel `safeClick` in `js/project-manager.js#initProjectListeners`. Every binding registers once via `bindClick(id, handler)` (or `bindEvent(id, event, handler)` for non-click events); 34 production sites flow through it today. Entries whose `getElementById` returns null at registration time record `wired: false`; `rewireUnboundElements()` retries via subscription to `forSlot('rail-views')` so plugin-mounted buttons land wiring as soon as the structured slot re-renders. Duplicate `(id, event)` registration throws — same idempotency contract as `bindHotkey`. Regression-guarded by 5 cases in [`tests/test-slot-manager.mjs`](../tests/test-slot-manager.mjs) under "plugin-mounted button wiring (2.44.0.1)".

### `settings/tab-activation-registry.js` — settings-tab on-activate/on-close dispatch (2.44.0.2)

Replaces the 11-branch `tab.dataset.tab === 'tabX'` switch in `js/settings-manager.js#populateSettingsForm` plus the explicit `unmountMemoryTab()` call in `closeSettings()`. Tab modules register via `registerOnActivate(tabId, handler)` / `registerOnClose(tabId, handler)` at module-load — side-effect registration matches the `js/tools/registry.js` precedent for tool definitions. `dispatchOnActivate(tabId)` (single tab on rail click) and `dispatchAllOnClose()` (modal close) wrap handler calls in `try/catch` with `console.warn` — one tab's failure can't strand the modal. Coverage: 11 tabs registered (Embeddings, Models, Plugins, Ignore, Storage, Cost, Memory, Workspace Settings, Test Loop, Tools, Retrieval); only `tabMemory` carries an on-close registration. 12 cases in [`tests/test-settings-tab-activation.mjs`](../tests/test-settings-tab-activation.mjs) split parity-cluster (3) + shape-cluster (9).

### `tool-classifications.js` (2.25.0 hoist) + `cache-invalidation.js`

Five tool-classification axes — 8 frozen exports — co-located so adding a new tool is a top-to-bottom scan rather than a hunt across files. The 2.25.0 hoist inverted an earlier "deliberately NOT hoisted" decision after the inline-in-handlers location became the recurring source of "missed an axis" bugs. Full contract: [`docs/ICD-chat-handlers.md`](ICD-chat-handlers.md). `cache-invalidation.js` implements the two eviction helpers (`invalidateCachesForPath`, `invalidateCachesForPreviewMutation`) that consume the mutation axes.

### Inline-handler retirement (2.27.0 → 2.32.0)

The 4-phase migration arc (`docs/DESIGN-html-inline-handlers-migration.md`) retired 53 inline `onclick="window.foo()"` strings across `html/*.html` and pure-renderer modules in favor of `data-action`-based event delegation. Phase 4 (2.32.0) retired 56 dead `window.*` aliases from `app.js`. `tests/test-no-inline-onclick.mjs` is the anti-regression CI guard.

### Chat tool-name string-literal pin (2.44.0.0)

`REQUIRED_TOOL_PARAMS` hoisted to module-scope `Object.freeze({...})` in [`js/chat/tools.js`](../js/chat/tools.js) — function-local `requiredParams` map lifted so the test can `import` the keys. [`tests/test-chat-tool-name-literals.mjs`](../tests/test-chat-tool-name-literals.mjs) (4 cases) cross-references against `ToolRegistry`-registered names extracted from `js/tools/*.js` to catch rename drift across `summarizeToolArgs` / `summarizeToolResult` (`js/chat/messages.js`), `_writeRange` / `_readRange` (`js/chat/turn-enrich.js`), and the validator map itself. Anti-regression CI guard against the cosmetic-and-functional degradation class that earlier versions silently absorbed.

### `managers/` directory retirement (2.44.0.3)

The one-file `js/managers/` directory (carrying only `search-manager.js`) retired in favor of top-level sibling placement matching `tab-manager.js` / `project-manager.js` / `file-tree.js`. `SearchManager` moved to [`js/search-manager.js`](../js/search-manager.js); [`tests/test-module-locations.mjs`](../tests/test-module-locations.mjs) is the new anti-regression test (2 cases over a `RETIRED_PATHS` table — directory absence + import-needle scan). Designed as a general-purpose location-pin contract that future sweep slices append rows to.

## Data Flows

### User sends a chat message

```
input.js → handlers.js → LLM.chat()
                            ↓
                     SSE stream parsing
                            ↓
                     Tool calls? ─────→ ToolRegistry.execute()
                        │                       ↓
                        │               Tool handler runs
                        │                       ↓
                        │               Result → messages → LLM.chat() (loop)
                        ↓
                  Content tokens → messages.js → DOM
                        ↓
                  summarizer.shouldSummarize()?
                        ↓ yes
                  summarizer.generateAndStore() → prune history
```

### User opens a file

```
file-tree.js click → git.js.getFile()
                       ↓
               git-providers/{provider}.getFile()
                       ↓
               tab-manager.js → openTab()
                       ↓
               editor/instance.js → set content
                       ↓
               EventBus.emit('editor:fileLoaded')
```

### Settings changed

```
settings-manager.js → State.settings.* = value
                        ↓
                    saveSettings() → Storage.set('settings', ...)
                        ↓
                    EventBus.emit('settings:saved')
                        ↓
                    Listeners (model-manager, llm-tab, etc.) react
```

## File Size Map

The barrel re-export pattern (`llm.js`, `editor.js`, `ui-helpers.js`) keeps import paths clean while modules stay focused. Largest modules in the current tree (2.41.0; `wc -l js/**/*.js`):

| File | Lines | Purpose |
|------|-------|---------|
| `core.js` | ~1668 | Shared kernel (EventBus, State, Storage, Plugins, Providers facade, types) |
| `llm/api.js` | ~1338 | LLM client + streaming SSE parser, tool-call assembly, cost tracking, Composer-aware admission |
| `git-providers/github.js` | ~1268 | GitHub provider |
| `intelligence/retrieval/manager.js` | ~1264 | Retrieval orchestration (paraphrase + BM25 + structural + thematic + composer + semantic + AST chunker); see [`ICD-retrieval-manager.md`](ICD-retrieval-manager.md) |
| `git-providers/gitea.js` | ~1257 | Gitea provider |
| `chat/handlers.js` | ~1244 | Tool-call dispatch, retry, cache management — see [`ICD-chat-handlers.md`](ICD-chat-handlers.md) |
| `chat/messages.js` | ~1222 | Message rendering, markdown sanitization, escape paths, `data-action` delegation (2.31.0) |
| `git-providers/gitlab.js` | ~1217 | GitLab provider |
| `issue-detail.js` | ~1089 | Issue tab renderer + actions (DOMPurify-sanitized markdown render) |
| `preview/preview-host.js` | ~1039 | Tier 1/2/3a preview lifecycle, SW registration, capture ring buffers |
| `intelligence/retrieval/comparison.js` | ~979 | Strategy comparison harness (offline measurement) |
| `git-providers/base.js` | ~973 | Default 55-method + 1-getter provider interface; typedefs (`BlameData`, `FileCommit`, `PullRequestData`, `PRFileChange`, `CommitStatus`); `glyph` field (2.26.0); circuit breaker (`circuitBreakerGuard`, `markUnreachable`/`markReachable`, `healthProbe`). See [`ICD-git-providers.md`](ICD-git-providers.md). |
| `editor/instance.js` | ~953 | CodeMirror EditorView wrapper + edit ops |
| `app.js` | ~944 | Bootstrap, event wiring (post-inline-handler retirement; -80 LOC vs 1.6.11) |
| `zip-upload.js` | ~935 | Zip-flow project loader (2.20.0); placeholder-modal entry for Session zip / Clone-from-URL |
| `git.js` | ~927 | Git facade resolving connectionId → provider+connection |
| `project-manager.js` | ~914 | Project switching, repo fetching, sidebar lists |
| `chat/summarizer.js` | ~894 | Chat compression engine (token-based trigger + map-reduce) |
| `intelligence/retrieval/measurement.js` | ~842 | `tests/retrieval-measurement.html` harness |
| `chat/index.js` | ~825 | Chat init + conversation drawer + tool registration |
| `chat/replay.js` | ~820 | Debug-modal replay of captured sessions |
| `intelligence/memory/file-layer.js` | ~799 | `.aieditor/memory/*` git-tracked notes |
| `pr-review/PrReviewSurface.js` | ~798 | Touch 3 PR Review Preact root |
| `intelligence/retrieval/test-corpus.js` | ~768 | Fixture corpus for retrieval measurement |
| `intelligence/retrieval/contracts.js` | ~722 | Retrieval result-envelope typedefs |
| `intelligence/retrieval/chunkers/code-chunker.js` | ~696 | AST Phase 1 (1.7.0) + Phase 2 lever B (1.8.1) |
| `debug-slideout.js` | ~688 | Debug slideover (replaces older modal) |
| `intelligence/retrieval/strategies/semantic.js` | ~684 | Semantic strategy (embeddings-backed) |
| `ui/left-pane-rail.js` | ~667 | Rail v2 (Touch 3) — `rail-views` consumer, body-owned since 2.24.0 |

Provider files trend large because each implements the same ~55-method base interface. `core.js` is large because it's the only module allowed to import from `providers/`, so all globally-used registries (EventBus, State, Storage, Plugins, Providers) live there to avoid cycles. The intelligence subsystems trend large because each is a self-contained unit. Touch 3 surfaces and `preview-host.js` are Preact-rendering or session-lifecycle modules respectively, both new since 1.9.1.

## Type Coverage

`jsconfig.json` enables project-wide `@ts-check` (`checkJs: true`,
`strict: false`, `module: ES2022`). Core modules carry JSDoc annotations
with `@typedef` blocks for shared shapes. VS Code shows inline type
hints and red squiggles without a build step.

## Document hierarchy

Per the methodology adopted 2026-05-12, every artifact in `docs/` traces upward to this document. If the code contradicts a DESIGN doc, the code is wrong (or the DESIGN doc needs an architecture session). If a DESIGN doc contradicts this ARCHITECTURE doc, this doc takes precedence and the DESIGN doc needs an architecture session to update.

```
ARCHITECTURE.md (source of truth — what you're reading)
│
├── ROADMAP.md (sequenced plan; derived from this doc; band-labeled per §"How to read the bands")
│
├── VERSIONING.md (X.Y.Z.N convention for in-flight work; layered atop the existing release-readiness gate)
│
├── DESIGN-*.md (multi-version design docs — Scale-2 / Scale-3 arcs per methodology §Scales of Work)
│   ├── DESIGN-profiles.md       — the load-bearing 1.X→2.0 flip
│   ├── DESIGN-retrieval.md      — Composer + strategies
│   ├── DESIGN-memory.md         — two-tier persistence
│   ├── DESIGN-compression.md    — Rules 1-5
│   ├── DESIGN-tools.md          — semantic admission
│   ├── DESIGN-intelligence.md   — cross-subsystem narrative
│   ├── DESIGN-preview.md        — Tier 1/2/3 phased delivery
│   ├── DESIGN-llm-authored-automation.md — Tier 0 sandbox + phased graduation
│   ├── DESIGN-cross-device-sync.md       — github#18, parked post-2.0
│   ├── DESIGN-git-providers-and-ui-extensions.md — SlotManager contract
│   ├── DESIGN-html-inline-handlers-migration.md  — closed 2.32.0
│   └── DESIGN-sub-agents.md     — shipped 2.37.0; gated on Phase 0 audit-sweep + post-2.0
│
├── ICD-*.md (single-subsystem interface contracts — Scale-1.5 per methodology §"Per-subsystem ICD backfill program")
│   ├── ICD-chat-handlers.md          — chat tool-loop classification axes; target #1 (RE-EVAL following 2.41.0)
│   ├── ICD-intelligence-composers.md — Tools + Retrieval Composer seam; target #2 (RE-EVAL following 2.44.0)
│   ├── ICD-tool-registry.md          — Tool registry admission contract; target #3 (RE-EVAL following 2.46.0)
│   ├── ICD-git-providers.md          — `BASE_GIT_PROVIDER` 55-method surface + 4 providers + circuit breaker; target #4 (RE-EVAL following 2.49.0)
│   ├── ICD-retrieval-manager.md      — Retrieval manager + ingest pipeline + lifecycle + persistence + diagnostics; target #5 (RE-EVAL following 2.52.0)
│   └── ICD-mcp-bridge.md             — MCP bridge + protocol + registry + catalog/discovery + auto-test; target #6 (RE-EVAL following 2.55.0)
│
├── discussion/ (pre-architecture; not commitments — cited only as "see discussion/X.md for the thinking")
│
├── audit-2026-Q2/inventory.md (refactor-candidate queue; the §"2026-Q2 audit + sweep track" on ROADMAP works through this)
│
├── design/ (claude.ai/design touches 1-3 — third-party deliverables; the canonical reception of UX direction)
│
└── dogfood-battery/ (operational measurement; per-session traces are the artifact)
```

Implementation (code under `js/`) derives from DESIGN docs (or directly from a roadmap line for Scale-1 single-line items). Tests verify implementation against contracts. The reverse direction — code teaching the architecture — runs through the code-aware re-evaluation loop (see ROADMAP §"Re-evaluation cadence"), not through ad-hoc edits of this document during code sessions.

## Testing & CI

Tests run on two tracks:

- **`tests/test-*.mjs`** — pure-logic suites that run under `node --test` (no browser); CI auto-globs and executes them. ~220+ suites at 2.60.0 covering retrieval contracts, compression rules, profiles inheritance, tool classifications, event wiring, public channels, modal-registry, hotkey-bindings, storage migration, slot-channel hygiene, inline-handler retirement, provider capability-shape (2.50.0), chat-tool validation aliases (2.50.0.2), Venice prompt-cache (2.50.0.1), session cut-off reason (2.51.0.1), `read_approved_plan` + plan persistence (2.52.0), profile `findAdmittingProfiles` + tool-registry admit-warning (2.55.0), `Profiles.filterTools` admit-list coverage (2.56.0), `plugin.enabled` overlay membership/freeze/pins (2.58.0), `ChunkStore` typedef-vs-runtime shape pin (2.59.0), etc.
- **`tests/index.html`** — browser-based suites for code that touches DOM, CodeMirror, or vendor scripts. Manual; not gated by CI.

CI (`.gitea/workflows/ci.yaml`) runs **on every PR and on `main` push**:

1. **Version coherence** — `js/version.js` `VERSION` must match the latest `## [X.Y.Z]` heading in `CHANGELOG.md` (in-flight X.Y.Z.N sub-patches relax to startswith). Failure blocks merge.
2. **Security lint — innerHTML audit** — greps `js/` for `return raw;` (DOMPurify bypass); verifies vendor security libs (DOMPurify) in the Dockerfile.
3. **Security lint — invisible Unicode** — Glassworm (U+E0000–U+E007F tags), zero-width chars, Trojan-Source bidi overrides. Ranges match `js/security/invisible-unicode.js#INVISIBLE_RANGES`.
4. **Theme token lint** — standalone hex literals must live only in `css/themes/`; component CSS reads through the alias bridge in `css/base.css`.
5. **Node tests** — `node --test tests/test-*.mjs`.
6. **Docker build** + push to internal registry (+ Docker Hub on tag).
7. **`kubectl apply`** + rollout health-check.

Deployment mapping: PR open/sync → `:dev` → `editor.gobha.ai/dev`; `main` push → `:test` → `editor.gobha.ai/test`; `v*` tag → `:latest` + `:vX.Y.Z` → `editor.gobha.ai/`. The `BASE_PATH` env var lets one image serve at any of those mount points.

**Release-readiness gate** (ROADMAP Decision §12) fires on `X.Y.Z` tag push (not `X.Y.Z.N` sub-patches): the maintainer runs a real 10-turn dogfood chat in this repo before the tag goes out. Honor-system today; recorded on the release tag annotation alongside the bundled-PR list.
