# AI Editor — Architecture

> Module dependency map, layer boundaries, and key data flows.
> Auto-derived from `0.9.16` source with manual annotations.

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
│   models-tab │ secondary-pane│   export                 │
│ ui/          │ diff-viewer   │   tools (dispatch)       │
│   branch     │ search-panel  │                          │
│   commit     │ quick-open    │                          │
│   file-create│               │                          │
│   revert     │               │                          │
├──────────────┴───────────────┴──────────────────────────┤
│                    Tool Layer                           │
│  tools/registry  tools/file-tools  tools/edit-tools    │
│  tools/project-tools  tools/search-tools               │
│  tools/issue-tools  tools/pr-tools  tools/commit-tools │
│  tools/scan-tools  tools/scratchpad-tools              │
│  tools/context-tools  tools/edit-tracker               │
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

## File Size Budget

Post-0.9.13 decomposition, no single file exceeds ~600 lines. The barrel
re-export pattern (`llm.js`, `editor.js`, `ui-helpers.js`) keeps import
paths clean while modules stay focused.

| File | Lines | Purpose |
|------|-------|---------|
| `core.js` | ~1135 | Shared kernel (5 subsystems + types) |
| `llm/api.js` | ~680 | LLM client + high-level functions |
| `chat/summarizer.js` | ~640 | Chat compression engine |
| `prompts.js` | ~580 | System prompt assembly |
| `git-providers/base.js` | ~450 | Provider interface (43 methods) |

## Type Coverage

`jsconfig.json` enables project-wide `@ts-check`. Five core modules carry
full JSDoc annotations (41 `@typedef`, 106 `@param`, 65 `@returns`).
VS Code shows inline type hints and red squiggles without a build step.
