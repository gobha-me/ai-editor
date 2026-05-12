# AI Editor — Architecture

> Module dependency map, layer boundaries, and key data flows.
> Last sync: **1.9.1** (2026-05-07). Per-subsystem detail lives in [`docs/DESIGN-*.md`](.); this doc tracks structural shape only.

> **⚠ Doc-vs-code drift status (added 2026-05-12).** This document is at 1.9.1 sync; `main` is at 2.38.0+[Unreleased]. The following 2.X structural work has not been folded back: Touch 3 surfaces (Rail v2 2.11.0, PR Review 2.12.0–2.14.0, Merge Conflict Resolver 2.18.0–2.21.0, zip-flow 2.20.0); SlotManager rails + body migration (2.22.0–2.24.0); the 4-phase inline-handlers migration arc (2.27.0–2.32.0); the 2026-Q2 audit-sweep wave (2.33.0–2.38.0). A code-aware re-evaluation session is scheduled per [`ROADMAP.md`](ROADMAP.md) §"Re-evaluation cadence" to refresh this doc against current `js/`. Until then: treat the layer diagram and §"File Size Map" as 1.9.1-shaped, and the per-subsystem details as authoritative only where corroborated by a DESIGN-\*.md still in force.
>
> **Commitment bands.** Per the methodology adopted 2026-05-12 (see [`VERSIONING.md`](VERSIONING.md) and [`ROADMAP.md`](ROADMAP.md) §"How to read the bands"), unlabeled sections in this document are implicit `[strong]`-band commitments — load-bearing for the next ~3 milestones. The Intelligence Layer carries `[medium]` for Phase 2 picker promotion (`kb.v1` shipped 2.8.0; `chat_multi.v1` / `rp.v1` deprioritized for ai-editor) and `[fuzzy]` for Phase 3 operational maturity and Phase 4 extensibility. Per-section band labels are out of scope for this stale-banner pass; that's the refresh session's work.

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
├──────────────┬───────────────┬───────────────────┬───────────────┤
│   UI Layer   │  Editor Layer │     Chat Layer    │   Help Layer  │
│              │               │                   │               │
│ settings/    │ editor/       │ chat/             │ help/         │
│   llm-tab    │   instance    │   index           │   pages/      │
│   connections│   setup       │   handlers        │ (in-app)      │
│   persistence│ tab-manager   │   messages        │               │
│   plugins-tab│ file-tree     │   summarizer      │               │
│   roles-tab  │ resize-manager│   conversations   │               │
│   models-tab │ secondary-pane│   replay (debug)  │               │
│   memory-tab/│ diff-viewer   │   consent-card/   │               │
│   cost-tab   │ search-panel  │   memory-chip/    │               │
│ ui/          │ quick-open    │   export          │               │
│ onboarding   │               │                   │               │
│ mobile       │               │                   │               │
├──────────────┴───────────────┴───────────────────┴───────────────┤
│             Tool Layer (53 native + MCP-bridged)                 │
│  tools/registry        tools/file-tools     tools/edit-tools     │
│  tools/multifile-tools tools/cursor-tools   tools/scan-tools     │
│  tools/search-tools    tools/project-tools  tools/xref-tools     │
│  tools/issue-tools     tools/pr-tools       tools/commit-tools   │
│  tools/scratchpad-tools tools/context-tools tools/plugin-tools   │
│  tools/doc-tools       tools/eval-tools     tools/git-log-tools  │
│  tools/edit-tracker                                              │
│  ── MCP bridge (js/mcp/, plugins/mcp-bridge.js) ─────────────    │
├──────────────────────────────────────────────────────────────────┤
│         Intelligence Layer (js/intelligence/)                    │
│  retrieval/manager + strategies (paraphrase, BM25, structural,   │
│      thematic, composer; 7-day IDB paraphrase cache)             │
│  memory/file-layer (.aieditor/memory/* git-tracked notes)        │
│  cost/cost-store (per-conv, per-tool, per-strategy)              │
│  compression/  (Rules 1+2 phase; tracker only)                   │
│  tools/embeddings  (semantic tool-admission catalog)             │
│  test-loop/  (subsystem self-test harness)                       │
│  workspace-settings/                                             │
├──────────────────────────────────────────────────────────────────┤
│                          LLM Layer                               │
│  llm.js (barrel)   llm/api  (streaming SSE, tool-call asm)       │
│  llm/debug   llm/utils                                           │
│  prompts.js  (system prompt builder; ⚠ untrusted-content gap —   │
│               see docs/SECURITY.md §"Untrusted issue / PR")      │
│  embeddings-client                                               │
├──────────────────────────────────────────────────────────────────┤
│                          Git Layer                               │
│  git.js (facade)  git-providers/registry                         │
│  git-providers/base   gitea / github / gitlab / local            │
├──────────────────────────────────────────────────────────────────┤
│             Profiles (data-only; data lives in js/profiles/)     │
│  coder.v1 (only canonical profile wired today)                   │
├──────────────────────────────────────────────────────────────────┤
│                          Core Layer                              │
│  core.js: State, EventBus, Storage, Plugins, Roles, Providers    │
│  providers/registry  providers/venice  providers/openrouter      │
│  storage/idb   version.js   utils/html   security/invisible-     │
│                                          unicode (Glassworm)     │
└──────────────────────────────────────────────────────────────────┘
```

Layer ordering note: Intelligence sits *below* Tool but *above* LLM because tools call into the intelligence subsystems (e.g. `find_relevant_files` → `retrieval/manager.compose()`), and the intelligence subsystems call into the LLM (e.g. paraphrase strategy → `LLM.chat`). Profiles is data-only at 1.6.x; it activates as the load-bearing configuration surface in 2.0.

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

## Git Layer

### `git.js`

Facade that resolves the active `connection` from `State.settings.connections[]`
and delegates to the correct provider instance from `git-providers/registry`.

### `git-providers/base.js`

Default interface (43 methods). Providers extend this and override only
the methods they support. Unimplemented methods throw `"not supported"`.

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

### `prompts.js`

System prompt builder. Assembles role instructions, active tool list,
scratchpad contents, project context, and summarizer state into a single
system message. **⚠ Untrusted content gap** — issue/PR/comment bodies fetched
during issue triage flow into the system prompt at lines ~281–292 with no
delimiter or "data not commands" instruction. See
[`docs/SECURITY.md`](SECURITY.md) §"Untrusted issue / PR / comment content".

### `tools/registry.js`

Dynamic tool registration. Tools declare allowed roles at registration
time. `ToolRegistry.getToolsForRole()` applies role-based filtering.
`ToolRegistry.execute()` runs handlers with structured error recovery.
Tool unregistration emits `tools:unregistered` (1.6.10) so the
tool-embeddings cache (`js/intelligence/tools/embeddings.js`) can drop
stale entries.

Errors thrown by tool handlers (and by the rest of the editor) follow the
contract in `js/utils/errors.js`: `EditorError` extends `Error` with a
machine-readable `.code` (from the `ErrorCode` enum — `NETWORK_TIMEOUT`,
`AUTH_INVALID_TOKEN`, `GIT_NOT_FOUND`, `LLM_STREAM_ERROR`, etc.) and a
human-readable `.recoveryHint` rendered in the UI by
`js/error-logger.js`. Consumers compare `err.code` against the enum
rather than parsing `.message`; `EditorError.fromResponse()` and
`EditorError.wrap()` are the canonical constructors.

## Intelligence Layer (`js/intelligence/`)

The 1.5.x retrieval cutover (PR #266 → bundled into the 1.6.0 tag) and the
1.6.6–1.6.11 follow-ups consolidated all model-context machinery into a
single `js/intelligence/` tree. Per-subsystem detail lives in the four
[`docs/DESIGN-*.md`](.) docs (retrieval, memory, compression, tools).

| Subsystem | Path | What it owns |
|---|---|---|
| Retrieval | `intelligence/retrieval/` | `manager.js` (orchestration + 1.6.9 query LRU + indexer-readiness gate), strategies (`paraphrase`, `bm25`, `structural`, `thematic`, `composer`), `paraphrase-cache-idb.js` (7-day TTL), `measurement.js` + `comparison.js` + `test-corpus.js` (offline measurement harness) |
| Memory | `intelligence/memory/` | `file-layer.js` (git-tracked notes in `.aieditor/memory/*`), in-memory + IDB store, consent boundary (see `chat/consent-card/`) |
| Cost | `intelligence/cost/` | `cost-store.js` (per-conv, per-tool, per-strategy; 1.6.7 `KeyMutex`-protected; 1.6.8 `byStrategy` extension); fed by `LLM.chat` and `retrieval:turn-stats` events |
| Compression | `intelligence/compression/` | Phase-1 tracker; Rules 1+2 (Subsumption, Invalidation) gated on cost-dashboard measurement |
| Tools (catalog) | `intelligence/tools/` | `embeddings.js` semantic tool admission (admissibility, not accumulation) |
| Test loop | `intelligence/test-loop/` | Self-test harness for the subsystems |
| Workspace settings | `intelligence/workspace-settings/` | Per-workspace overrides |

The retrieval manager exposes `findRelevantFiles(query, opts)`, the public
entry point used by both the `find_relevant_files` tool and any plugin
that wants the same scoring. From 1.6.11 it returns structured envelopes
on cold-start (`indexer_not_ready`) and budget overrun (`retrieval_partial`)
under the 30 s hard tool wall.

## MCP Layer (`js/mcp/`, `plugins/mcp-bridge.js`)

Model Context Protocol bridge. External MCP servers expose tools via the
plugin layer; the bridge registers them through `ToolRegistry` so the
LLM sees them alongside native tools. Per-server enable/disable from
Settings → MCP Servers; 1.6.10 added diff-based state messages on
`mcp:serversChanged` so the model's prior-turn tool list does not go
stale silently. 1.6.11 added role-based access (github#21):
backward-compatible default of `'all'` when no roles are set.

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

The barrel re-export pattern (`llm.js`, `editor.js`, `ui-helpers.js`)
keeps import paths clean while modules stay focused. Largest modules
in the current tree (1.6.11):

| File | Lines | Purpose |
|------|-------|---------|
| `core.js` | ~1812 | Shared kernel (EventBus, State, Storage, Plugins, Roles, Providers facade, types) |
| `llm/api.js` | ~1198 | LLM client + streaming SSE parser, tool-call assembly, cost tracking |
| `git-providers/gitlab.js` | ~1174 | GitLab provider |
| `chat/handlers.js` | ~1121 | Tool-call dispatch, retry, cache management (1.6.11 `MUTATING_TOOLS`, `STATEFUL_READ_TOOLS`) |
| `intelligence/retrieval/manager.js` | ~1113 | Retrieval orchestration; 1.6.9 query LRU + 1.6.11 readiness gate / soft budget |
| `git-providers/gitea.js` | ~1082 | Gitea provider |
| `git-providers/github.js` | ~1065 | GitHub provider |
| `app.js` | ~1024 | Bootstrap, event wiring, `window.*` exposures |
| `issue-detail.js` | ~1003 | Issue tab renderer + actions (DOMPurify-sanitized markdown render) |
| `intelligence/retrieval/comparison.js` | ~979 | Strategy comparison harness (offline measurement) |
| `chat/messages.js` | ~971 | Message rendering, markdown sanitization, escape paths |
| `editor/instance.js` | ~938 | CodeMirror EditorView wrapper + edit ops |
| `chat/summarizer.js` | ~891 | Chat compression engine (1.6.4 token-based trigger + map-reduce) |
| `project-manager.js` | ~888 | Project switching, repo fetching, sidebar lists |
| `intelligence/retrieval/measurement.js` | ~842 | `tests/retrieval-measurement.html` harness |
| `intelligence/memory/file-layer.js` | ~799 | `.aieditor/memory/*` git-tracked notes |
| `chat/replay.js` | ~794 | Debug-modal replay of captured sessions |
| `chat/index.js` | ~776 | Chat init + conversation drawer + tool registration |
| `git.js` | ~772 | Git facade resolving connectionId → provider+connection |
| `intelligence/retrieval/test-corpus.js` | ~768 | Fixture corpus for retrieval measurement |

Provider files trend large because each implements the same ~43-method
base interface. `core.js` is large because it's the only module
allowed to import from `providers/`, so all globally-used registries
(EventBus, State, Storage, Plugins, Roles) live there to avoid cycles.
The intelligence subsystems trend large because each is a self-contained
unit (retrieval is a multi-strategy orchestrator + offline harness all
under the same root).

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

Tests are browser-based — open `tests/index.html` to run the suite.
A handful of pure-logic suites have parallel `.mjs` versions that run
under `node --test` (e.g. `test-summarizer.mjs`, `test-retry.mjs`,
`test-edit-tracker.mjs`).

CI (`.gitea/workflows/ci.yaml`) does **not** execute tests. It runs:

1. Security lint — greps for `return raw;` (DOMPurify bypass)
2. Docker build
3. Push to internal registry (+ Docker Hub on tag)
4. `kubectl apply` and rollout health-check

The `BASE_PATH` env var lets the same image serve at `/`, `/test`, or
`/dev` so PRs and main can be deployed side-by-side.
