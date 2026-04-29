# AI Editor — Architecture

> Module dependency map, layer boundaries, and key data flows.
> Last sync: `1.0.4` source with manual annotations.

## Design Constraints

- **No build step.** Every `.js` file is a native ES module (`<script type="module">`).
- **No framework.** DOM manipulation is vanilla JS; CodeMirror is the only large library.
- **No package.json.** Vendor scripts are fetched from CDN with SRI hashes.
- **Single global state.** `State` in `core.js` is the truth; `EventBus` decouples consumers.

## Layer Diagram

```
┌─────────────────────────────────────────────────────────┐
│                      app.js (entry)                     │
│   Boots all modules, wires EventBus listeners, loads UI │
├──────────────┬───────────────┬──────────────────────────┤
│   UI Layer   │  Editor Layer │       Chat Layer         │
│              │               │                          │
│ settings/    │ editor/       │ chat/                    │
│   llm-tab    │   instance    │   index (tool register)  │
│   connections│   setup       │   handlers (send/recv)   │
│   persistence│ tab-manager   │   input (user entry)     │
│   plugins-tab│ file-tree     │   messages (render)      │
│   roles-tab  │ resize-manager│   summarizer             │
│   models-tab │ secondary-pane│   conversations           │
│ ui/          │ diff-viewer   │   export                 │
│   branch     │ search-panel  │   tools (dispatch)       │
│   commit     │ quick-open    │                          │
│   file-create│               │                          │
│   revert     │               │                          │
│ onboarding   │               │                          │
│ mobile       │               │                          │
├──────────────┴───────────────┴──────────────────────────┤
│                    Tool Layer (52 tools)                │
│  tools/registry        tools/file-tools                 │
│  tools/edit-tools      tools/multifile-tools            │
│  tools/cursor-tools    tools/scan-tools                 │
│  tools/search-tools    tools/project-tools              │
│  tools/xref-tools      tools/issue-tools                │
│  tools/pr-tools        tools/commit-tools               │
│  tools/scratchpad-tools tools/context-tools             │
│  tools/plugin-tools    tools/doc-tools                  │
│  tools/eval-tools      tools/edit-tracker               │
├─────────────────────────────────────────────────────────┤
│                    LLM Layer                            │
│  llm.js (barrel)  llm/api  llm/debug  llm/utils       │
│  prompts.js  context-manager  embeddings-client        │
├─────────────────────────────────────────────────────────┤
│                    Git Layer                            │
│  git.js (facade)  git-providers/registry               │
│  git-providers/base  git-providers/gitea               │
│  git-providers/github  git-providers/gitlab            │
├─────────────────────────────────────────────────────────┤
│                    Core Layer                           │
│  core.js: State, EventBus, Storage, Plugins, Roles     │
│  providers/registry  providers/venice  providers/openrouter │
│  storage/idb  version.js  utils/html                   │
└─────────────────────────────────────────────────────────┘
```

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
stripping, tool call assembly, and cost tracking. `buildRequestBody()`
applies provider-specific transforms.

### `chat/summarizer.js`

Context-window-aware chat compression. Modes (`aggressive`/`balanced`/
`conservative`) set a fill-percentage of the model's context window
(30%/50%/75%). Params (recent count, threshold, interval) scale linearly
from `contextTokens × fillPct / 800` with min/max clamps. No discrete tiers.

### `prompts.js`

System prompt builder. Assembles role instructions, active tool list,
scratchpad contents, project context, and summarizer state into a single
system message.

### `tools/registry.js`

Dynamic tool registration. Tools declare allowed roles at registration
time. `ToolRegistry.getToolsForRole()` applies role-based filtering.
`ToolRegistry.execute()` runs handlers with structured error recovery.

Errors thrown by tool handlers (and by the rest of the editor) follow the
contract in `js/utils/errors.js`: `EditorError` extends `Error` with a
machine-readable `.code` (from the `ErrorCode` enum — `NETWORK_TIMEOUT`,
`AUTH_INVALID_TOKEN`, `GIT_NOT_FOUND`, `LLM_STREAM_ERROR`, etc.) and a
human-readable `.recoveryHint` rendered in the UI by
`js/error-logger.js`. Consumers compare `err.code` against the enum
rather than parsing `.message`; `EditorError.fromResponse()` and
`EditorError.wrap()` are the canonical constructors.

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
in the current tree (1.0.4):

| File | Lines | Purpose |
|------|-------|---------|
| `core.js` | ~1655 | Shared kernel (EventBus, State, Storage, Plugins, Roles, Providers facade, types) |
| `git-providers/gitlab.js` | ~1140 | GitLab provider (full base.js interface) |
| `context-manager.js` | ~1085 | Embeddings index, retrieval, similarity scoring |
| `app.js` | ~1083 | Bootstrap, event wiring, `window.*` exposures |
| `git-providers/gitea.js` | ~1044 | Gitea provider |
| `git-providers/github.js` | ~1031 | GitHub provider |
| `issue-detail.js` | ~1003 | Issue tab renderer + actions |
| `project-manager.js` | ~856 | Project switching, repo fetching, sidebar lists |
| `chat/handlers.js` | ~832 | Tool-call dispatch, retry, cache management |
| `llm/api.js` | ~817 | LLM client + streaming SSE parser |
| `chat/messages.js` | ~802 | Message rendering, markdown sanitization |
| `editor/instance.js` | ~771 | CodeMirror EditorView wrapper + edit ops |
| `git.js` | ~743 | Git facade resolving connectionId → provider+connection |
| `git-providers/base.js` | ~684 | Provider interface (43 methods) |
| `chat/summarizer.js` | ~646 | Chat compression engine |
| `zip-upload.js` | ~646 | Zip parse, batch commit, local-mode loader |
| `scan-tools.js` | ~599 | scan_file / read_function / find_references / read_lines |
| `chat/index.js` | ~583 | Chat init + conversation drawer + tool registration |

Provider files trend large because each implements the same ~43-method
base interface. `core.js` is large because it's the only module
allowed to import from `providers/`, so all globally-used registries
(EventBus, State, Storage, Plugins, Roles) live there to avoid cycles.

## Type Coverage

`jsconfig.json` enables project-wide `@ts-check` (`checkJs: true`,
`strict: false`, `module: ES2022`). Core modules carry JSDoc annotations
with `@typedef` blocks for shared shapes. VS Code shows inline type
hints and red squiggles without a build step.

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
