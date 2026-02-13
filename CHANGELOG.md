# Changelog

All notable changes to AI Editor are documented here.

## [0.9.23-2] - 2026-02-12

### Fixed — Sparse tool call array crash

Streaming tool call deltas with non-zero `index` values created sparse
array holes (e.g., `[undefined, {function: ...}]`). The `for...of` loop
in `handleGeneralRequest` iterated the `undefined` slot, crashing on
`toolCall.function`.

**Root cause (`llm/api.js`):** `toolCalls[tc.index]` indexed by delta
position without filtering. Fixed: `.filter(Boolean)` before returning.

**Belt-and-suspenders (`chat/handlers.js`):** Added `if (!toolCall?.function) continue;` guard in the loop body.

### Added — Public-ready documentation

**`README.md`** — complete rewrite for GitHub readiness. Tighter
structure: Quick Start → What It Does → Features → Config → Shortcuts →
Deployment → Project Structure. No more stale "Future Enhancements"
checkbox list.

**`REPOS.md`** (new) — Git provider setup guide with minimum token
permissions per provider. Covers Gitea (repository + issue + user
scopes), GitHub (fine-grained and classic token options), GitLab (api
scope, explanation of why). Includes connection settings, multiple
connections, and troubleshooting.

**`docs/PLUGIN.md`** (new) — Plugin authoring guide. Covers bundled and
external plugins, manifest fields, hooks (beforeSend, afterResponse,
onModelChange), UI registration (toolbar buttons, modals), config schema
with auto-generated settings UI, `window.AIEditor` API reference
(Plugins, EventBus, State, Storage, Providers, Roles), event catalog,
State properties, and tips.

## [0.9.23-1] - 2026-02-12

### Fixed — Duplicate showToast declaration

Removed local `showToast()` function in `chat/index.js` that conflicted
with the `import { showToast } from '../ui-helpers.js'` added in 0.9.23.
The local copy was a legacy inline version; the imported one is the
canonical implementation.

## [0.9.23] - 2026-02-12

### Added — Conversation Persistence

Chat history now persists across multiple conversations. "New Chat"
saves the current conversation and creates a blank one instead of
destroying history.

**Core system (`js/chat/conversations.js`):**
- `ConversationManager` — CRUD for conversations with Storage backend
- Storage layout: `conversations` (metadata index), `conv-{id}`
  (messages + summaryInfo + pruneStash), `activeConversation` (active ID)
- Auto-migration: on first run, existing `chatHistory`/`chatSummaryInfo`/
  `chatPruneStash` are wrapped into the first conversation entry
- Auto-title: derived from first user message, truncated to 60 chars
- Handles multimodal content (image+text arrays) for title derivation
- Max 50 conversations; oldest auto-pruned when exceeded
- Debounced save on `chat:message` and `chat:pruned` events (2s delay)
- Immediate save on `beforeunload`

**Conversation drawer UI:**
- 📚 button in chat header toggles a slide-down drawer
- Shows all conversations sorted by most recent, with:
  - Title (from first message)
  - Relative time ("3h ago", "2d ago")
  - Message count
  - Active conversation highlighted with `--bg-active`
  - ✕ delete button (appears on hover)
- Click to switch: saves current → loads target → re-renders messages
- Click outside or toggle button to close drawer
- Auto-re-renders on create/load/delete/rename events

**Behavioral changes:**
- "New Chat" button: 🗑️ → ➕ icon, toast says "New conversation
  started" instead of "Chat cleared"
- `clearChat()` now calls `ConversationManager.create()` instead of
  wiping State — current conversation is saved first
- Each conversation stores its own summary and prune stash

**New CSS in `chat.css`:** `.conversation-drawer`, `.conv-drawer-header`,
`.conv-drawer-list`, `.conv-item`, `.conv-item-active`,
`.conv-item-content`, `.conv-item-title`, `.conv-item-meta`,
`.conv-item-delete`, `.conv-empty`

**New:** `js/chat/conversations.js` (337 lines)

**Modified:** `js/chat/index.js` (ConversationManager init, drawer UI,
debounced save, beforeunload hook, switchConversation on window.Chat),
`js/app.js` (toast wording), `html/chat-panel.html` (📚 button + drawer
element, ➕ icon), `css/chat.css` (drawer styles),
`docs/ARCHITECTURE.md` (conversations module entry)

## [0.9.22-2] - 2026-02-12

### Fixed — Full UI Theme Audit

Comprehensive audit across all modals, JS-generated HTML, and form
controls. Every inline-styled form element now uses CSS classes from
the design system.

**Merge modal (the reported bug):**
- `#prMergeStrategy` select → `class="select-inline"` — was unstyled
  browser chrome with only inline `font-size`
- Delete branch label/checkbox → `class="label-inline-check"`
- PR comment textarea → `class="textarea-mono"` inside `.form-group`

**New CSS classes in `modals.css`:**
- `.select-inline` — themed select for use outside .form-group
- `.label-inline-check` — compact checkbox+label combo
- `.textarea-mono` — monospace textarea with theme colors/borders
- `.badge-state` + `-open/-closed/-merged` — PR/issue state badges
- `.btn-xs` — extra-small button (toggle comments)
- `.btn-sm` — small button (storage cleanup)
- `.btn-icon-danger` — icon-only delete button with hover→danger
- `.error-type-error/-warn/-log` — error log type badges
- `.error-recovery-hint` — themed recovery hint block

**PR detail (`pr-detail.js`):**
- State badges: hardcoded `#8957e5`, `#238636`, `#da3633` → CSS classes
- Toggle comments button: `font-size: 10px` inline → `.btn-xs`

**Issue detail (`issue-detail.js`):**
- Toggle comments button: same fix as PR detail

**Error logger (`error-logger.js`):**
- Badge highlight: `#dc3545` → `var(--danger)`
- Type colors: hardcoded hex map → `var(--danger)`, `var(--warning)`,
  `var(--text-muted)`
- Recovery hint: hardcoded `#3b82f6`/`#93c5fd` → `.error-recovery-hint`

**Storage metrics (`storage-metrics.js`):**
- Delete embedding button: 8-property inline + onmouseover/out →
  `.btn-icon-danger` (CSS handles hover)
- Cleanup buttons: inline font-size → `.btn-sm`

**Modals HTML cleanup:**
- Removed 6 redundant `style="width: 100%"` on selects/inputs already
  inside `.form-group` (rule provides it)

## [0.9.22-1] - 2026-02-12

### Fixed — Plugin Install UI Theme Consistency

Audited the plugin install UI from 0.9.22 against the design system.
All inline-styled elements now use existing CSS classes or new
purpose-built rules.

**Before → After:**
- Install button: raw `<button>` with inline padding → `class="btn btn-primary"`
- URL input: inline font/size → `.plugin-install-row input` rule with proper
  `background`, `border`, `color`, `padding`, `::placeholder`, `:focus` from theme
- Install section container: inline bg/border/radius → `class="connection-editor"`
  (already existed for connection edit panels)
- Uninstall button: inline `color: var(--error)` → `class="danger"` (uses existing
  `.connection-card-actions button.danger:hover` pattern)
- Section headers: inline uppercase/tracking → `.plugin-section-header` class
- Config panel container: inline bg/border → `class="connection-editor"`
- Config field labels: inline `font-size` → inherited from `.form-group label`
- Config textareas: inline `font-family: mono` → `.plugin-config-panel textarea` rule
- External badge text: inline font-size → `.plugin-badge-external` class
- URL display in external cards: inline word-break → `.plugin-external-meta` class

**New CSS in `css/modals.css`:** `.plugin-section-header`,
`.plugin-install-row` (flex + input), `.plugin-install-status`,
`.plugin-install-hint`, `.plugin-external-meta`, `.plugin-badge-external`,
`.plugin-config-panel textarea`

**Modified:** `js/settings/plugins-tab.js` (replaced inline styles with
classes), `css/modals.css` (new plugin UI rules)

## [0.9.22] - 2026-02-12

### Added — Plugin Install from URL

External plugins can now be installed at runtime from any URL, without
modifying the `plugins/` directory or rebuilding the container image.

**Install flow:**
1. Settings → Plugins → paste URL → Install
2. Plugin JS is fetched, loaded via blob import, verified via
   `Plugins.register()` call detection
3. URL is persisted to localStorage — auto-reloads on next visit
4. Uninstall disables immediately; fully removed on reload

**`window.AIEditor` global API** — external plugins can't use relative
ES module imports, so `core.js` now exposes a global object:
```js
const { Plugins, EventBus, State, Storage, Providers, Roles } = window.AIEditor;
Plugins.register({ id: 'my-plugin', name: 'My Plugin', ... });
```

**Settings UI changes:**
- "Install Plugin from URL" section at top of Plugins tab with URL
  input, install button, and status feedback
- "Installed from URL" section shows external plugins with source URL,
  load status (● loaded / ⚠ error), and ✕ uninstall button
- "All Plugins" section now labels external plugins with 📦 icon and
  "(external)" badge
- Empty state updated to mention URL install option

**New:** `js/plugin-loader.js` — `installPlugin(url)`,
`uninstallPlugin(url)`, `getInstalledPlugins()`,
`loadInstalledPlugins()`

**Modified:** `js/core.js` (window.AIEditor global),
`js/app.js` (import + call loadInstalledPlugins at init),
`js/settings/plugins-tab.js` (install UI, external plugin list,
uninstall), `html/settings-tabs.html` (description update),
`docs/ARCHITECTURE.md` (window.AIEditor entry)

## [0.9.21] - 2026-02-12

### Added — Multi-File Editing

Two new tools let the LLM edit across files without manual `open_file`
calls, cutting the tool-call overhead for multi-file tasks roughly in
half.

**`edit_file`** — surgical edit on any file by path. Accepts `path`,
`operation` (replace/insert/delete), and the relevant line parameters.
Auto-opens the target file if it's not already active, switching tabs
transparently. The LLM can now do:
```
edit_file(path='a.js', operation='replace', start_line=10, end_line=15, new_content='...')
edit_file(path='b.js', operation='insert', after_line=5, new_content='...')
```
No intermediate `open_file` calls needed.

**`write_file`** — create new files or completely overwrite existing
ones. For existing files, opens in the editor and replaces all content
(not committed until user saves). For new files, creates via Git API,
refreshes the tree, and opens the new file.

### Fixed — open_file Race Condition

`open_file` used `setTimeout(100)` to record the EditTracker read after
the file loaded. Since `onTreeItemClick` already `await`s the full load
chain, the setTimeout was both unreliable and unnecessary. Replaced with
inline recording after the await.

### Fixed — replaceRange Missing Return Fields

`replaceRange()` in `editor/instance.js` didn't return `originalLineCount`
or `lineDelta` — both were `undefined` in edit tool responses and
EditTracker recordings. Added both fields. Also added `insertedAfter`
and `newLineCount` alias to `insertAtLine()` return for consistency.

### Changed — System Prompt Multi-File Guidance

Updated the system prompt to:
- List `edit_file` and `write_file` in capabilities
- Add `edit_file` as step 6 in the workflow (preferred over open_file + replace_lines)
- Add a dedicated "MULTI-FILE EDITING" workflow section
- Update critical rules to prefer `edit_file` over the manual open→edit pattern
- 35 tools total (2 new)

**New:** `js/tools/multifile-tools.js` (edit_file, write_file + ensureFileActive helper)

**Modified:** `js/tools/file-tools.js` (open_file setTimeout fix),
`js/editor/instance.js` (replaceRange + insertAtLine return fields),
`js/chat/index.js` (import + register), `js/prompts.js` (multi-file
workflow), `docs/ARCHITECTURE.md` (tool diagram)

## [0.9.20] - 2026-02-12

### Added — Image/Screenshot Paste for Vision Models

Chat now supports sending images alongside text prompts for use with
vision-capable LLMs. Three input methods:

- **Clipboard paste** — paste a screenshot or copied image directly into
  the chat textarea (Ctrl+V / Cmd+V)
- **Drag & drop** — drop image files onto the textarea
- **Attach button** — 📎 button opens a file picker (PNG/JPEG/GIF/WebP,
  5 MB max)

Pending images appear as thumbnails in a preview strip above the input
with ✕ to remove. Images-only sends (no text) are allowed.

Messages are stored using the OpenAI multimodal content format
(`content: [{type:'text',...}, {type:'image_url',...}]`), which passes
through the existing LLM pipeline to any vision-capable model. Image
thumbnails render inline in user chat messages and can be clicked for
a fullscreen overlay preview (Escape or click to dismiss).

The summarizer already guards against non-string content with
`typeof m.content === 'string' ? ... : JSON.stringify(...)`, so
multimodal messages are handled gracefully in context management.

**New:** `js/chat/state.js` (pendingImages state), `js/chat/input.js`
(paste/drop/attach handlers + preview strip), `js/chat/index.js`
(previewImage overlay + window.Chat wiring), `js/chat/handlers.js`
(multimodal content builder + alreadyInContext fix), `js/chat/messages.js`
(image rendering in messages), `js/app.js` (send button images-only),
`html/chat-panel.html` (📎 button), `css/chat.css` (preview strip,
message images, overlay, drag-over styles)

## [0.9.19-1] - 2026-02-12

### Fixed — Settings Save Clears Project

When saving settings, `refreshProjects()` rebuilt the dropdown but lost
the selection. The project appeared to vanish, leaving an orphaned branch
selector. Fix: after rebuilding the dropdown, re-select the current
`State.currentProject` value if one is loaded.

### Added — Session Persistence

Project, branch, and open tabs now survive page reloads:

- **`saveSession()`** — writes `connectionId`, `owner`, `repo`, `branch`,
  and pinned tab paths to `Storage` on every project switch, branch
  change, file open, or tab close (debounced at 1 s).
- **`restoreSession()`** — called once at startup after `refreshProjects`.
  Re-opens the saved project + branch, then re-opens each saved tab
  (best-effort, skips files that no longer exist on the branch).
- Preview tabs are intentionally excluded — only pinned tabs persist.
- The previously-active tab is re-activated after all tabs reopen.

### Added — Clear Project Button

New **✕** button in the sidebar project header:

- Prompts for confirmation if there are dirty (unsaved) tabs.
- Resets all project state (`currentProject`, `fileTree`, `openTabs`,
  `branches`, `issues`, `pullRequests`).
- Clears session storage so next reload starts fresh.
- Emits `project:cleared` event for other modules.

### Changed — `tab:closed` Event

`closeTab()` in `tab-manager.js` now emits `EventBus.emit('tab:closed')`
so session persistence can track tab removals (previously only
`tab:switched` existed).

### Fixed — Zip Upload Fires N Commits Instead of One

`uploadExtractedFiles()` called `provider.createFile()` / `updateFile()`
in a loop — one API call per file, each creating a separate commit and
push event. Uploading 137 files to a repo with CI triggered 137
concurrent pipeline runs.

Replaced with `provider.batchCommitFiles()`, a new method that uses
Gitea's multi-file contents endpoint (`POST /repos/{owner}/{repo}/contents`)
to commit ALL file operations in a **single atomic commit**. One push
event, one CI trigger, regardless of file count.

**Renamed across all providers:** `batchUpdateFiles` → `batchCommitFiles`.
The Gitea provider now uses the real batch API; GitHub/GitLab retain the
sequential fallback (can be upgraded later). The `batchSaveFiles()` facade
(used by the commit flow for dirty tabs) also benefits from this — dirty
tab commits that previously created N pushes now create one.

**New file parameter:** `encoding: 'base64' | 'text'` tells the batch
method whether content is pre-encoded (binary from JSZip) or needs
base64 conversion (text files).

### Fixed — Retry Leaves Dangling User Message

`retryLastMessage()` only popped the last assistant reply before re-
sending, leaving the original user message in place — resulting in a
duplicate. Now uses the same truncate-from-user-message-onward pattern
as `editAndResend()`, which also cleans up any interleaved tool messages.

**Modified:** `js/zip-upload.js` (single batch commit), `js/git-providers/gitea.js`
(real batch API), `js/git-providers/base.js` + `github.js` + `gitlab.js`
(method rename), `js/git.js` (facade + batchSaveFiles), `js/project-manager.js`
(refreshProjects fix + session persistence + clearProject), `js/app.js`
(imports + wiring), `js/tab-manager.js` (tab:closed event),
`js/chat/index.js` (retry fix), `html/sidebar.html` (✕ button)

## [0.9.19] - 2026-02-12

### Added — Cross-Project Reference Tools

Two new LLM tools that allow reading files from OTHER projects without
switching away from the current workspace:

- **`peek_project_tree`** — browse the file tree of any connected repo.
  Takes `connectionId`, `owner`, `repo`, optional `branch` and `path`.
  Returns the same shape as `get_project_tree`.
- **`peek_project_file`** — read a file from any connected repo (read-
  only). Supports the same truncation and `full=true` semantics as
  `read_file`. Returns `reference_project` and `current_project` fields
  so the LLM always knows which repo it's looking at.

**Why this matters:** The user can now say "look at how the billing
service handles pagination and implement the same pattern here" and the
LLM will peek at the billing repo's files, save the pattern to
scratchpad, and implement it in the current project — all without
disrupting the workspace, losing dirty tabs, or triggering UI refreshes.

**Workflow guidance:** System prompt updated with step 11: Cross-Project
Reference, instructing the LLM to prefer `peek_*` tools over
`set_active_project` for read-only reference lookups.

**New file:** `js/tools/xref-tools.js` (190 lines)
**Modified:** `js/chat/index.js` (import + registration),
`js/prompts.js` (tool list + workflow), `docs/ARCHITECTURE.md`

## [0.9.18] - 2026-02-12

### Fixed — V Hotkey Captured in Commit Modal

The diff viewer's keyboard shortcut handler (`initDiffKeyboardShortcuts`)
now checks for active inputs/textareas and open modals before handling
bare key presses. Typing "v" in the commit message textarea no longer
toggles the diff view mode.

**Guards added:** `activeElement` is INPUT/TEXTAREA/contentEditable,
or any `.modal-overlay.active` is present.

**File modified:** `js/diff-viewer.js`

### Fixed — Generated Commit Message Not Populating

Root cause: `buildCommitMessagePrompt(original, updated)` expected two
arguments (single-file original/updated), but `generateCommitMessage()`
passed one combined diff summary string. `{{updated}}` resolved to the
literal string "undefined".

Fixes:
- Template now uses single `{{diff_summary}}` placeholder for multi-file diffs
- `buildCommitMessagePrompt()` takes one argument matching the caller
- `generateCommitMessage()` now prefers `result.content` (think-blocks
  stripped) over `result.rawContent` (may contain `<think>` blocks)
- Strips markdown code fences some models wrap commit messages in
- Empty result shows warning toast instead of silent failure

**Files modified:** `js/prompts.js`, `js/llm/api.js`, `js/ui/commit.js`

### Fixed — Favicon Replaced by Canvas Icon on Load

`FaviconManager.init()` stored the original SVG favicon (⚡ lightning
bolt) but immediately replaced it with a canvas-drawn code-brackets icon
via `_drawIdleIcon()`. The idle state now restores the original HTML
favicon. Canvas drawing is only used for loading spinner and error states.

**File modified:** `js/favicon-manager.js`

## [0.9.17] - 2026-02-12

### Improved — Error Logger + EditorError Integration

The error log modal now surfaces structured fields from `EditorError`:

- **Code badge** — monospace `AUTH_INVALID_TOKEN`, `GIT_NOT_FOUND`, etc.
  displayed inline next to the error type
- **Recovery hint** — blue-highlighted 💡 block below the error message
  with actionable suggestions (e.g. "Check your API token in Settings →
  Connections.")
- **HTTP status** — shown when available (e.g. `HTTP 404`)
- Text export (`exportText()`) includes code, status, and hint
- `serializeValue()` extracts EditorError fields when logging via
  `console.error()`
- Backward-compatible: regular `Error` objects render unchanged

**Files modified:** `js/error-logger.js`

### Added — Buy Me a Coffee Badge

☕ badge in the Help modal footer linking to
https://buymeacoffee.com/jeffasmith — visible but not intrusive.

**Files modified:** `html/modals.html`

## [0.9.16-1] - 2026-02-12

### Removed — Dead Scroll Sync Code

With diffs now overlaying the editor pane (since 0.9.14-2), the
editor-to-diff scroll sync was OBE. Removed:

- `initEditorDiffSync()` — bidirectional editor↔diff scroll polling
- `syncEditorToChange()` — editor scroll on change navigation
- `toggleScrollSync()` — toggle function and state variable
- `scrollSyncEnabled` / `editorScrollListener` state
- 🔗 Sync button from diff controls toolbar
- `S` keyboard shortcut (was mapped to sync toggle, help page incorrectly said "syntax highlighting")
- `toggleScrollSync` from `window.DiffViewer` global

**Kept:** Left↔right pane sync in side-by-side mode (still needed).

**Files modified:** `js/diff-viewer.js` (746→597 lines, −149),
`html/modals.html` (removed `S` from help), `js/version.js`

## [0.9.16] - 2026-02-12

### Changed — Summarizer: Percentage-Based Scaling (replaces tier system)

The old tier system (`Huge`/`Large`/`Medium`/`Small` + mode shift) is
replaced with smooth, linear scaling from the loaded model's actual
context window size.

**How it works:**
- Mode sets a *fill percentage* of the context window:
  - Aggressive: **30%** — summarize early, keep context lean
  - Balanced: **50%** — default middle ground
  - Conservative: **75%** — preserve more, still safe from overflow
- All params (recent count, threshold, interval, maxChars) derived from
  `contextTokens × fillPct / 800` with per-param min/max clamps
- No discrete tiers → no "cliff" when a model sits near a boundary
- Custom mode still uses user-specified values, unchanged

**Examples (128K model):**
| Mode | Threshold | Recent (base/tools) | Interval |
|------|-----------|---------------------|----------|
| Aggressive | 48 | 17/29 | 22 |
| Balanced | 80 | 28/48 | 36 |
| Conservative | 120 | 42/72 | 54 |

**Files modified:** `js/chat/summarizer.js`, `js/settings/llm-tab.js`,
`js/tools/scratchpad-tools.js`, `tests/test-summarizer.js`

### Added — `docs/ARCHITECTURE.md`

Module dependency map, layer diagram, key data flows, and file size
budget. Auto-derived from source with manual annotations.

### Added — Structured Error Objects (`js/utils/errors.js`)

`EditorError` class extends native `Error` with:
- `.code` — machine-readable enum (`ErrorCode.GIT_NOT_FOUND`, etc.)
- `.recoveryHint` — actionable suggestion for the user
- `.status` — HTTP status code (when applicable)
- `.context` — metadata (endpoint, rawBody, etc.)
- `EditorError.fromResponse(response)` — factory from fetch Response
- `EditorError.wrap(err)` — wrap any thrown value with code inference

Wired into:
- `git-providers/base.js` — `request()` now throws `EditorError`
- `git-providers/gitea.js` — blame unsupported uses `ErrorCode.BLAME_UNSUPPORTED`
- `tools/registry.js` — `execute()` checks `.code` + `.recoveryHint` first

### Added — Offline Indicator Banner (`js/offline-indicator.js`)

Fixed-position banner at screen bottom when network connectivity is lost.
- Listens for browser `online`/`offline` events
- Periodic fetch probe (every 10s when offline) catches captive portal / DNS failures
- `aria-live="assertive"` for screen reader announcement
- Emits `EventBus('network:status', { online })` for other modules to react

## [0.9.15] - 2026-02-12

### Added — JSDoc Type Annotations & `@ts-check`

First pass of static type coverage across the five core modules. Zero
runtime changes — every edit is a JSDoc comment or a new `jsconfig.json`.

**New file:**
- `jsconfig.json` — VS Code project config enabling `@ts-check` IDE
  support project-wide (ES2022, bundler resolution, `js/**/*.js` scope)

**Typed modules (41 `@typedef`, 5 `@ts-check`):**
- `js/core.js` — 14 typedefs: `GitConnection`, `Settings`,
  `VeniceParameters`, `OpenRouterParameters`, `SummarizerConfig`,
  `SummarizerMode`, `ModelEntry`, `ModelMeta`, `TabEntry`,
  `ChatMessage`, `SessionCost`, `ProviderBalance`, `Role`,
  `PluginManifest`. All `EventBus`, `Storage`, `Plugins` methods typed.
- `js/git-providers/base.js` — 9 typedefs: `TestConnectionResult`,
  `BlameCommit`, `BlameRange`, `BlameData`, `FileCommit`,
  `PullRequestData`, `PRFileChange`, `CommitStatus`. Every provider
  method annotated with `@param`/`@returns`.
- `js/tools/registry.js` — 2 typedefs + 1 callback:
  `ToolDefinition`, `ToolFunctionSchema`, `ToolHandler`. Typed
  `handlers` Map and `definitions` array.
- `js/llm/api.js` — 9 typedefs: `LLMChatOptions`, `LLMUsage`,
  `ToolCallDelta`, `LLMChatResult`, `RequestBodyOptions`. Re-imports
  shared types from core and registry.
- `js/chat/summarizer.js` — 7 typedefs: `TierParams`, `Tier`,
  `SummaryInfo`, `AutoParams`. Re-imports `ChatMessage`,
  `SummarizerMode`, `SummarizerConfig` from core.

**Developer experience:**
- VS Code now shows inline type hints, autocomplete, and red squiggles
  for type mismatches across the entire `js/` tree
- Hover over any `State.settings.*` property to see its type
- Tool handlers get full parameter and return-type checking
- Cross-module imports resolve typed interfaces (e.g. `GitConnection`
  defined in core.js, used in base.js via `@typedef {import(...)}`)

## [0.9.14-3] - 2026-02-12

### Fixed — Summarizer Mode Radio Buttons

- Mode radio buttons (Aggressive/Balanced/Conservative/Custom) were
  non-functional — clicking a different mode re-read the old value from
  `State.settings.summarizerMode` and re-checked it, ignoring the click
- Change handler now writes `e.target.value` into State before
  re-populating the sliders, so mode switches take effect immediately

## [0.9.14-2] - 2026-02-12

### Fixed — Diff/Blame Full-Width & Gitea Blame

- Diff and Blame panes now fill 100% of the editor-split area — cleared
  inline `style.width` set by the resize manager so the `diff-overlay`
  CSS class takes effect properly
- Gitea blame now immediately throws `BLAME_UNSUPPORTED` since the Gitea
  REST API has no blame endpoint, cleanly triggering the file history
  fallback instead of hitting a 404
- Fixed Gitea file history endpoint from `/git/commits` (non-existent)
  to `/commits` — the correct Gitea API path for listing commits with
  path filtering

## [0.9.14-1] - 2026-02-12

### Fixed — Diff/Blame Fullscreen Button

- Fullscreen button now hidden for Diff and Blame modes — these already
  overlay the editor at full width via `diff-overlay`, making the button
  redundant and confusing
- Button remains visible for Preview mode where split/fullscreen toggle
  is meaningful

## [0.9.14] - 2026-02-12

### Changed — Summarizer Modes & Scratchpad Scaling

**Summarizer: named modes replace auto/manual**
- New modes: 🔥 Aggressive, ⚖️ Balanced, 🧊 Conservative, 🔧 Custom
- All non-custom modes remain context-window-aware via tier detection
- Aggressive shifts detected tier toward smaller (prune early, save tokens)
- Conservative shifts toward larger (preserve history, use more context)
- Legacy `auto` → `balanced`, `manual` → `custom` (auto-migrated)
- System prompt now injects "Summary in ~N messages" countdown when
  approaching summarization — encourages scratchpad note-taking

**Scratchpad scaling by mode**
- Limits now scale with summarizer mode (tied to context capability):
  - Aggressive: 8 keys, 400 chars/value, 1.5K auto-inject
  - Balanced: 15 keys, 1000 chars/value, 4K auto-inject
  - Conservative: 20 keys, 2000 chars/value, 8K auto-inject
- Gives large-context models proportionally more working space

### Fixed

**Gitea blame fallback**
- Blame now falls back to file history for ANY error, not just
  BLAME_UNSUPPORTED — fixes broken Gitea blame (404 on older instances,
  format mismatches)
- Gitea blame normalizer hardened: handles multiple response shapes
  (`commit.sha` vs `commit_sha`, string vs object lines, etc.)
- Fallback view now shows reason: "Line blame unavailable (reason)"

### Improved

**Test runner TLDR**
- Summary + per-suite pills now render at top of page before detailed results
- Instant pass/fail visibility without scrolling

**Test coverage: mode shifting**
- New tests for aggressive/conservative tier shifting
- Legacy mode migration tests (`auto`→`balanced`, `manual`→`custom`)
- Boundary clamping tests (aggressive on smallest, conservative on largest)

## [0.9.13] - 2026-02-12

### Changed — Module Decomposition

Three monolithic modules split into focused sub-modules using barrel re-export
pattern. Zero downstream import changes required (except app.js for ui/).

**editor.js (1036→4 files)**
- `editor/setup.js` — CodeMirror loading, CDN fallback, language config
- `editor/instance.js` — Editor creation, content ops, line-level editing
- `editor/file-utils.js` — `isTextFile`, `getFileIcon` (pure, zero deps)
- `editor/diff.js` — `computeSimpleDiff`, `formatDiffForDisplay` (pure)
- `editor.js` — barrel re-export (all existing imports preserved)

**llm.js (919→3 files)**
- `llm/utils.js` — `stripThinkBlocks`, `sanitizeMessages` (pure, tested)
- `llm/debug.js` — `LLMDebug` ring-buffer logger (self-contained)
- `llm/api.js` — `LLM` client, streaming, tool calling, cost tracking
- `llm.js` — barrel re-export (all existing imports preserved)

**ui-helpers.js (634→4 files)**
- `ui/commit.js` — Commit modal workflow
- `ui/revert.js` — Single & batch revert with confirmation modal
- `ui/branch.js` — Branch creation with git-ref sanitization
- `ui/file-create.js` — New file modal
- `ui-helpers.js` — shared utilities (toggles, toast, draft mgmt, status bar)

### Architecture
- CM namespace pattern (`CM` object) eliminates module-level `let` sharing
  between setup and instance modules
- Direct import from `prompts.js` in `editor/setup.js` eliminates the
  editor→llm→prompts indirection for `getLanguageFromPath`
- No circular dependencies: sub-modules import parent utilities,
  barrels only re-export

### Files Modified
- `js/editor.js` → barrel re-export
- `js/editor/setup.js` — NEW
- `js/editor/instance.js` — NEW
- `js/editor/file-utils.js` — NEW
- `js/editor/diff.js` — NEW
- `js/llm.js` → barrel re-export
- `js/llm/utils.js` — NEW
- `js/llm/debug.js` — NEW
- `js/llm/api.js` — NEW
- `js/ui-helpers.js` → trimmed to shared utilities
- `js/ui/commit.js` — NEW
- `js/ui/revert.js` — NEW
- `js/ui/branch.js` — NEW
- `js/ui/file-create.js` — NEW
- `js/app.js` — updated imports for ui/ sub-modules
- `js/version.js` — 0.9.13

## [0.9.12] - 2026-02-12

Test coverage expansion for pure functions across the codebase.
Adds 7 new test modules (~248 assertions) covering LLM message handling,
chat intent routing, tool call parsing, context filtering, HTML escaping,
event bus, and secondary pane utilities.

### Added
- **test-eventbus.js** — on/off/emit, return-value unsubscribe, error isolation, data passing (13 assertions)
- **test-llm-pure.js** — `stripThinkBlocks` edge cases, `sanitizeMessages` field stripping/role filtering/tool call sparse gap handling, `getLanguageFromPath` mapping (53 assertions)
- **test-handlers.js** — `detectIntent` routing for commit/issue/edit/explain/general intents with and without open file, `_briefError` JSON extraction and truncation (45 assertions)
- **test-tools-parse.js** — `validateToolParameters` required/missing/edge cases, `parseTextToolCalls` JSON tags/function_call variant/argument formats (35 assertions)
- **test-context-filter.js** — `ContextManager.shouldIndex` for source files, binary/media exclusions, lock files, path patterns, edge cases (47 assertions)
- **test-secondary-pane.js** — `isPreviewable`, `_shortAuthor` name formatting, `_shortDate` relative time (30 assertions)
- **test-html-escape.js** — `escapeHtml` and `escapeAttr` XSS prevention, null/coercion handling (25 assertions)

### Changed
- **js/llm.js** — exported `sanitizeMessages` for testability
- **js/secondary-pane.js** — exported `_shortAuthor`, `_shortDate` for testability
- **js/chat/handlers.js** — exported `detectIntent`, `_briefError` for testability
- **tests/index.html** — organized imports by category (infrastructure → core → modules → LLM/chat → UI/context → deployment)

### Files
- `tests/test-eventbus.js` — NEW
- `tests/test-llm-pure.js` — NEW
- `tests/test-handlers.js` — NEW
- `tests/test-tools-parse.js` — NEW
- `tests/test-context-filter.js` — NEW
- `tests/test-secondary-pane.js` — NEW
- `tests/test-html-escape.js` — NEW
- `tests/index.html` — updated with 7 new imports
- `js/llm.js` — added `sanitizeMessages` to exports
- `js/secondary-pane.js` — exported `_shortAuthor`, `_shortDate`
- `js/chat/handlers.js` — exported `detectIntent`, `_briefError`
- `js/version.js` — bumped to 0.9.12

## [0.9.11-1] - 2026-02-12

### Fixed
- **IDB test stability** — `test-idb.js` now clears IDB on startup to prevent stale data from prior runs causing false failures (IndexedDB persists across page reloads unlike in-memory state)

### Added
- **External dependency audit test** (`test-dependencies.js`) — SCIF readiness validation
  - Manifest of all 5 external dependencies with local/CDN paths and bundling status
  - Local vendor file probing (HEAD fetch for each vendor path)
  - CDN reachability check (5s timeout, no-cors mode)
  - Runtime global verification (marked, DOMPurify, JSZip)
  - SCIF summary: asserts all 4 required deps are Docker-bundled, flags 1 optional dep (Transformers.js)

## [0.9.11] - 2026-02-12

### Added
- **IndexedDB storage backend** — primary persistence layer replacing localStorage
  - `js/storage/idb.js` — async key-value wrapper with single `kv` object store
  - Methods: `open()`, `get()`, `set()`, `remove()`, `keys(prefix)`, `getAll()`, `setMany()`, `clear()`, `estimate()`
  - Automatic migration from localStorage to IndexedDB on first load
  - In-memory `Map` cache keeps `Storage.get()` synchronous — zero API changes for callers
  - Write-through: `set()` writes to cache + IDB (async) + localStorage (fallback)
  - `remove()` cleans all three layers: cache, IDB, localStorage
- **Storage.keys(prefix)** — list all keys with optional prefix filter (synchronous, reads from cache)
- **Storage.isIDBActive** — boolean property indicating whether IndexedDB is active
- **Large draft support** — drafts >512KB now saved to IDB (previously skipped entirely)
- **New tests** — `test-idb.js` (IDB low-level operations) and `test-storage.js` (cache layer, keys, drafts)

### Changed
- **Storage.init()** — new async initialization step called before `loadSettings()` in app boot
  - Loads IDB → cache on startup; falls back to localStorage → cache if IDB unavailable
  - Migration runs once: all `ai-editor-*` localStorage keys copied to IDB, flag set
- **Storage Metrics tab** — now reads from in-memory cache instead of iterating localStorage
  - Shows active backend (IndexedDB or localStorage) in total label and quota section
  - Tab description updated to reflect IDB-primary architecture
- **ContextManager.cleanupOrphanedIndexes()** — uses `Storage.keys()` / `Storage.remove()` instead of direct `localStorage` iteration
- **SearchManager** — ported from raw `localStorage` to `Storage` API with one-time migration of legacy unprefixed `searchHistory` key

### Fixed
- **EditTracker** — same-millisecond timestamp collision caused `checkStale()` to miss edits
  - Added monotonic `_seq` counter for guaranteed logical ordering
  - `checkStale()` now filters on `e.seq > lastRead.seq` instead of timestamp comparison
  - Delta-zero edits (same-size replacements) no longer falsely trigger staleness
- **Vendor bundle paths** — hardcoded absolute `/vendor/` paths broke deployments at sub-paths (e.g. `/editor-dev/`)
  - `editor.js`: CodeMirror bundle import now resolves via `document.baseURI` instead of absolute `/vendor/`
  - `embeddings-client.js`: Transformers.js import uses same baseURI resolution

### Files
- `js/storage/idb.js` — NEW: IndexedDB wrapper module
- `js/core.js` — Storage object rewritten: _cache Map, init(), keys(), IDB integration
- `js/app.js` — `await Storage.init()` added to boot sequence before `loadSettings()`
- `js/context-manager.js` — `cleanupOrphanedIndexes()` uses Storage API
- `js/managers/search-manager.js` — imports Storage, ported from raw localStorage
- `js/storage-metrics.js` — `measureStorage()` reads from cache, IDB-aware rendering
- `js/ui-helpers.js` — updated string references (localStorage → storage)
- `js/tools/edit-tracker.js` — `_seq` counter, `clearAll()` resets seq
- `html/settings-tabs.html` — updated tab description and heading
- `js/editor.js` — vendor bundle path: absolute → baseURI-relative
- `js/embeddings-client.js` — vendor transformers path: absolute → baseURI-relative
- `tests/test-idb.js` — NEW: IDB wrapper tests (open, CRUD, keys, setMany, clear)
- `tests/test-storage.js` — NEW: Storage cache layer tests (keys, consistency, drafts)
- `tests/index.html` — added IDB and Storage test imports

## [0.9.10] - 2026-02-11

### Added
- **Git blame view** — line-by-line blame data displayed in the secondary pane
  - Gitea: Full blame via `GET /repos/{owner}/{repo}/git/blames/{ref}/{path}` (requires Gitea 1.22+)
  - GitLab: Full blame via `GET /projects/:id/repository/files/:path/blame`
  - GitHub: Falls back to file commit history (REST API lacks blame endpoint)
  - Color-coded by commit with alternating backgrounds for visual range separation
  - Blame gutter shows short SHA (with commit message tooltip), author, and relative date
  - Stats bar: total lines and unique commit count
  - Keyboard shortcut: `Ctrl+Shift+B`
  - Toolbar button: 🔍 Blame (disabled when no file is open)
  - Auto-refreshes on tab switch
- **File commit history** — `getFileCommits()` API across all three providers
  - Gitea: `GET /repos/{owner}/{repo}/git/commits?path=...`
  - GitHub: `GET /repos/{owner}/{repo}/commits?path=...`
  - GitLab: `GET /projects/:id/repository/commits?path=...`
  - Used as fallback when blame is unavailable, displayed as a sortable table
- **Test suite** — browser-based test runner with 4 test modules
  - `tests/index.html` — minimal test framework (assert, eq, deepEq, throws/throwsAsync)
  - `tests/test-edit-tracker.mjs` — EditTracker stale detection, multi-edit tracking, cross-file isolation
  - `tests/test-retry.mjs` — isRetryable classification (transient vs permanent errors, all error patterns)
  - `tests/test-summarizer.mjs` — auto-tune tier boundaries, mode toggle, _extractSymbols (JS/Python/Rust), _summarizeToolResult (file/tree/search/error results)
  - `tests/test-blame-normalize.mjs` — blame export validation and guard checks

### Files
- `js/git-providers/base.js` — `getBlame()`, `getFileCommits()` base methods
- `js/git-providers/gitea.js` — `getBlame()` (blame API), `getFileCommits()` (commits API)
- `js/git-providers/github.js` — `getBlame()` (throws BLAME_UNSUPPORTED), `getFileCommits()` (commits API)
- `js/git-providers/gitlab.js` — `getBlame()` (blame API), `getFileCommits()` (commits API)
- `js/git.js` — `getBlame()`, `getFileCommits()` facade methods
- `js/secondary-pane.js` — `toggleBlamePane()`, `renderBlame()`, `_renderBlameView()`, `_renderFileHistory()`, `_shortAuthor()`, `_shortDate()`, blame color palette
- `js/app.js` — blame import, `Ctrl+Shift+B` shortcut, blame button wiring
- `html/editor-panel.html` — 🔍 Blame toolbar button
- `css/editor.css` — blame-view, blame-table, blame-gutter, file-history, history-table styles
- `tests/` — new test directory with runner and 4 test modules

## [0.9.9] - 2026-02-11

### Added
- **Summarizer auto-tune** — automatically scales summarizer parameters based on the active model's context window size
  - Four tiers: Small (<32K, aggressive), Medium (32K+), Large (128K+), Huge (500K+, nearly disabled)
  - New auto/manual mode toggle in Settings → LLM → Chat Summarizer
  - Auto mode: sliders show computed values (read-only), info badge shows tier and detected context window
  - Manual mode: sliders work as before with full user control
  - `summarizerMode` setting persisted; defaults to `auto`
  - Slider ranges expanded (max recent: 80/120, threshold: 250, interval: 100) for large-context models
  - Recomputes on model change via `model:changed` EventBus event
- **Smarter tool result handling in summarizer** — tool results now get structured compression instead of being discarded
  - File read results → `[File: path — N lines. Key symbols: fn1, fn2, ...]`
  - File tree results → `[File tree: N files. Sample: path1, path2, ...]`
  - Search results → `[Search: N matches in M files: path1, path2, ...]`
  - Error results preserved in full
  - `_extractSymbols()` extracts function/class/const/def names from source code (JS, Python, Rust, Go)
  - Assistant tool_calls now listed in summary prompt: `[Tools called: read_file → path, search_in_files → "query"]`
  - `_basicSummary()` fallback now includes file paths from tool results
- **`maxTokens` scaling** — LLM summary generation token budget now scales with `maxChars` setting instead of hardcoded 500

### Files
- `js/chat/summarizer.js` — auto-tune tiers, mode property, `getAutoParams()`, `_getContextWindow()`, `_getTier()`, `_summarizeToolResult()`, `_extractSymbols()`, rewritten `_buildPrompt()`, `_basicSummary()` with tool paths, scaled `maxTokens`
- `js/settings/llm-tab.js` — rewritten `populateSummarizerSliders()` with auto/manual toggle, `updateSummarizerForModel()`, `model:changed` listener, ChatSummarizer import
- `js/settings/persistence.js` — `summarizerMode` persistence, conditional slider save (skip in auto mode)
- `js/model-manager.js` — emit `model:changed` event on model selection
- `html/settings-tabs.html` — auto/manual radio toggle, auto-tune info badge, expanded slider ranges

## [0.9.8-4] - 2026-02-11

### Added
- **New Project button** (➕) in sidebar header — opens a modal to create a new repository on any connected git provider
  - Connection selector, repo name, description, private/public toggle, auto-init README
  - Validates repo name format, auto-selects the new project after creation
  - `createRepo()` implemented for all three providers (Gitea, GitHub, GitLab) + Git facade
- **LLM `list_projects` tool** — lists all available projects across all connections with current active project/branch info. Scoped to all roles.
- **LLM `set_active_project` tool** — programmatic project switching from chat
  - Refuses if there are dirty (unsaved) files — tells the LLM to commit first
  - Accepts optional `branch` parameter to switch to a specific branch
  - Clears tabs, editor state, updates branch selector, emits `project:loaded`
  - Reuses the same `switchProject()` function as the UI dropdown
- **`switchProject()` extracted** from `onProjectChange` as a reusable exported function — accepts `(connectionId, owner, repo, { branch })`, used by both UI and LLM tool
- **System prompt updated** with step 0 ("if no project is loaded → list_projects → set_active_project") and step 10 for project switching during workflow

### Files
- `js/project-manager.js` — `switchProject()`, `openNewProjectModal()`, `closeNewProjectModal()`, `submitNewProject()`, wiring in `initProjectListeners`
- `js/tools/project-tools.js` — `list_projects` and `set_active_project` tools
- `js/git.js` — `createRepo()` facade method
- `js/git-providers/base.js` — `createRepo()` base method
- `js/git-providers/gitea.js` — `createRepo()` via POST `/user/repos`
- `js/git-providers/github.js` — `createRepo()` via POST `/user/repos`
- `js/git-providers/gitlab.js` — `createRepo()` via POST `/projects`
- `js/llm.js` — system prompt additions for project tools
- `html/sidebar.html` — ➕ New Project button
- `html/modals.html` — New Project modal

## [0.9.8-3] - 2026-02-11

### Added
- **Per-index delete** on embedding cards in Settings → Storage — each embedding index now has an × button to delete it individually instead of only the nuclear "Clear Embeddings" option
  - Confirm dialog shows the project/branch name
  - Clears in-memory index if the deleted entry was the active one
  - Re-renders the metrics view after deletion

### Files
- `js/storage-metrics.js` — delete button on each embedding card, event delegation, ContextManager import

## [0.9.8-2] - 2026-02-11

### Fixed
- **Embeddings indexing 75 files instead of respecting limits** — `indexProject()` was indexing every file from `State.fileTree` with no extension filtering, no path exclusions, and no max count. Now:
  - **Extension filter**: skips binary, media, fonts, archives, compiled, lockfiles, maps, office docs (40+ extensions)
  - **Path filter**: skips `node_modules/`, `vendor/`, `dist/`, `build/`, `.git/`, minified bundles, lockfiles
  - **Max cap**: respects `maxIndexFiles` setting (default: 200, configurable 25–500 via new slider)
  - `shouldIndex()` method shared by `indexProject`, `updateFileIndex`, `reindexChanged`, and file event handlers
- Fixed duplicate `type="button"` attributes across settings-tabs.html

### Added
- **Branch lifecycle for embeddings**:
  - `git:branchDeleted` → removes that branch's embedding index from localStorage
  - `branch:switch` → loads cached index for new branch or auto-indexes if none exists
  - `context:prMerged` → incrementally re-indexes only the changed files on the target branch after merge
  - `removeIndexForBranch(name)` method for explicit branch index cleanup
  - `cleanupOrphanedIndexes(liveBranches)` method for bulk orphan cleanup
- **Incremental re-indexing** via `reindexChanged(paths)` — re-embeds only specific files instead of full project rebuild
- **Max files to index** setting (Settings → Context): slider 25–500, default 200
  - Status display shows when index is at the cap with a warning to increase
- `context:prMerged` event emitted from `submitMergePR` with `baseBranch`, `headBranch`, `changedFiles`, and `deletedBranch` data

### Files
- `js/context-manager.js` — filtering, branch lifecycle, reindexChanged, event listeners overhaul
- `js/project-manager.js` — emit `context:prMerged` after successful merge
- `js/settings-manager.js` — maxIndexFiles slider init and handler
- `js/settings/persistence.js` — maxIndexFiles read/write
- `js/settings/llm-tab.js` — enhanced status display with limit info
- `html/settings-tabs.html` — maxIndexFiles slider, fixed duplicate type attrs

## [0.9.8-1] - 2026-02-11

### Fixed
- **"null" rendered in assistant messages** — tool-call-only assistant responses (no text content) were stored with `content: null` in chatHistory. On page refresh or re-render, `JSON.stringify(null)` produced the literal string "null" in the UI. Fixed in three places:
  - `renderMessage` now skips assistant messages that have `tool_calls` but no content (these are protocol artifacts, not user-facing messages)
  - `renderMessage` null-guards content with `|| ''` before passing to `stripThinkBlocks` and `JSON.stringify`
  - `updateStreamingMessage` and `finalizeStreamingMessage` both null-coerce content at entry
- **Tab-switch streaming resilience** — if the browser backgrounded the tab during streaming and chunks were lost, the same null content path could trigger. The guards prevent "null" from ever reaching the DOM regardless of how content becomes null/undefined.

### Files
- `js/chat/messages.js` — null guards in `renderMessage`, `updateStreamingMessage`, `finalizeStreamingMessage`; skip-render logic for tool-call-only assistant messages

## [0.9.8] - 2026-02-11

### Added
- **LLM commit tool** (`commit_files`) — the LLM can now commit dirty editor files directly from chat:
  - Accepts optional `paths` array to commit specific files (defaults to all dirty files)
  - Accepts optional `message` for a custom commit message; if omitted, auto-generates one using the same `generateCommitMessage` pipeline as the commit modal
  - Syncs current editor content to tab state before committing
  - Updates tab dirty state and triggers UI refresh after commit
  - Returns committed paths, failed paths (with errors), and the commit message used
- **List dirty files tool** (`list_dirty_files`) — LLM can check which files have uncommitted changes before committing, with line change and size info
- Both tools scoped to the `coder` role
- System prompt updated with commit tools in tool list and workflow (step 9)

### Files
- `js/tools/commit-tools.js` — new module with `commit_files` and `list_dirty_files`
- `js/app.js` — imports commit-tools for self-registration
- `js/llm.js` — system prompt additions

## [0.9.7-2] - 2026-02-11

### Changed
- **System prompt now promotes `find_relevant_files`** — LLMs were ignoring semantic search because the prompt never mentioned it:
  - Added to tool list with "PREFERRED for discovery" annotation
  - Workflow step 3 (before grep) with strong guidance on when to use it vs `search_in_files`
  - Efficiency rules updated: "DON'T know which files → find_relevant_files FIRST"
  - Conditional context injected at end of prompt: when embeddings index is active, tells the LLM exactly how many files are indexed and that natural language queries work
- This should cause LLMs to actually fire `find_relevant_files` during exploration, which in turn increments the query counters visible in the Storage tab

### Files
- `js/llm.js` — system prompt updates + imports `ContextManager` for stats injection

## [0.9.7-1] - 2026-02-11

### Added
- **Embeddings usage tracking** — `ContextManager.findRelevantFiles()` now records `queryCount` and `lastQueried` timestamps, persisted to the index metadata in localStorage
- **Enriched embeddings detail in Storage tab** — each embedding index now shows:
  - File count, build age (relative time), last queried time
  - Color-coded usage badges: red "unused", yellow "< 5 queries", green "5+ queries"
  - Individual size bars per index
- Storage Details section now splits embeddings (card view with stats) from other items (compact list)

### Changed
- `ContextManager.getStats()` now includes `queryCount` and `lastQueried`
- Index metadata format extended with `queryCount` and `lastQueried` fields (backward-compatible)
- Query stats reset on full re-index (new vectors = new tracking baseline)

## [0.9.7] - 2026-02-11

### Added
- **Storage Metrics tab** in Settings — live dashboard showing browser storage usage:
  - **Origin quota** bar using `navigator.storage.estimate()` (localStorage + IndexedDB + Cache Storage)
  - **Category breakdown** with stacked color bar: Chat History, Drafts, Settings, Model Cache, Embeddings, UI State, Other
  - **Per-key drill-down** — top 20 largest items with size bars and monospace key names
  - **Cleanup actions** — per-category clear buttons (Chat, Drafts, Embeddings, Model Cache) with confirmation dialogs
  - All metrics render live when tab activates, re-render after cleanup

### Files
- `js/storage-metrics.js` — new module (measurement, aggregation, rendering)
- `html/settings-tabs.html` — Storage tab HTML skeleton
- `html/modals.html` — Storage tab button in tab bar
- `js/settings-manager.js` — imports and wires `renderStorageMetrics()` on tab switch

## [0.9.6] - 2026-02-11

### Added
- **CI status polling in PR detail modal** — When a PR is open and CI is in a non-terminal state (pending/unknown), polls `getCommitStatus` every 10 seconds. Badge updates live in both the modal and the sidebar PR list. Polling stops automatically when CI reaches success/failure/error or when the modal is closed.
- **Collapsible comments in issue and PR detail modals** — Comments now render as `<details>` elements with chevron indicators. First comment open by default, rest collapsed. "Expand All / Collapse All" toggle button appears when 2+ comments exist. Each comment shows a text preview snippet in the collapsed header. Scrollable container capped at 400px (issues) / uncapped (PRs).
- All comments are now shown in the issue detail modal (previously capped at last 5).

### Changed
- PR detail modal CI badge now has `.pr-ci-live` class for targeted live updates without re-rendering the full meta bar.

## [0.9.5-3] - 2026-02-11

### Fixed
- **Branch list not refreshing after merge** — After merging a PR (especially with "delete branch" checked), the branch dropdown still showed the deleted branch. Added `refreshBranches()` that re-fetches the branch list and updates the selector. If the current branch was deleted, automatically switches to the repo's default branch.
- **`branches:refresh` EventBus event was a no-op** — The LLM tool `merge_pull_request` emitted this event but nothing listened for it. Now wired to `refreshBranches()` alongside the existing `issues:refresh` and `prs:refresh` listeners.

### Changed
- Removed redundant branch-switch logic from the merge handler — `refreshBranches()` handles the "current branch was deleted" case with proper select dropdown sync.

## [0.9.5-2] - 2026-02-11

### Added
- **OpenRouter Billing Plugin** (`plugins/openrouter-billing.js`) — full billing dashboard using the same API key configured in LLM settings (no separate key required). Two-tier design:
  - **Regular API key**: Shows all-time/daily/weekly/monthly usage from `/api/v1/key`, key credit limit progress bar. Balance and per-model breakdown show "—" with a tip linking to provisioning key docs.
  - **Provisioning key**: Unlocks real account balance from `/api/v1/credits`, per-model per-day activity breakdown from `/api/v1/activity` with token counts (prompt/completion/reasoning), cost bars, provider attribution on hover, and day navigation (30 days back).
  - Day picker with ◀/▶ navigation, 🔄 refresh, session caching per day key.
  - Auto-detects key type on first fetch — no config needed.
- **`defaultEnabled` support in plugin manifest** — plugins can set `defaultEnabled: false` to register disabled. Only activates when the user explicitly enables in Settings → Plugins.

### Changed
- **Venice Billing and OpenRouter Billing plugins now default to OFF** — billing dashboards are opt-in via Settings → Plugins toggle.

## [0.9.5-1] - 2026-02-11

### Fixed
- **OpenRouter balance showing $40 instead of real balance** — Root cause: `limit_remaining` from `/api/v1/key` is the **API key's spending cap**, not the account balance. If a key has a $40 limit, it shows "$40 remaining" regardless of actual account credits. Fix: try `/api/v1/credits` first (returns real `total_credits - total_usage`); fall back to `/api/v1/key` with corrected labeling that shows usage stats instead of misleading "remaining" figure. Also reverted the `/auth/key` endpoint change from 0.9.5 — the original `/key` was correct per OpenRouter docs.

### Changed
- Cost tracker header now shows provider tooltip on hover with detailed breakdown (all-time, monthly, daily usage; key limit if set)
- Balance display falls back to `label` text when `usd` is null (OpenRouter /key fallback path)

## [0.9.5] - 2026-02-11

### Fixed
- **OpenRouter balance showing wrong/null** — Was hitting `/api/v1/key` (non-existent). Corrected to `/api/v1/auth/key` per OpenRouter API docs.
- **GitLab (and all providers) "Test" button broken** — `GitProviderRegistry.testConnection()` was called in the connection editor but never implemented. Added `testConnection` to the base provider (hits `GET /user` endpoint), registry method that creates a temporary connection object and delegates to the provider. Works for Gitea, GitHub, and GitLab without per-provider overrides since all three return `login` or `username` from their user endpoint.

## [0.9.4] - 2026-02-11

### Fixed
- **Chat history localStorage quota exceeded** — `ChatSummarizer` generated summaries but never pruned `State.chatHistory`. The in-memory array grew unbounded, causing `QuotaExceededError` on every save. Fixed with a prune→stash→flush lifecycle: summary generates, old messages splice out and stash for one-query undo, then flush permanently on the next user input.
- **Stash save order-of-operations** — Pruned messages couldn't be stashed because the old (large) chatHistory was still in localStorage, leaving no room. Fixed by removing the old key before writing the smaller array, freeing space for the stash write.
- **Invisible summary notification** — Summary badge rendered at `chatContainer.firstChild` but user was scrolled to bottom. Added toast notifications on prune and undo events.
- **Commit message generation returning empty** — Non-streaming `LLM.chat` applied `stripThinkBlocks` before returning. Models that wrap short utility responses in `<think>` blocks (e.g., minimax-m21) had their commit messages nuked to empty string. Added `skipThinkStrip` option and `rawContent` field to the response; `generateCommitMessage` now handles think blocks locally with fallback extraction.
- **JS-generated buttons missing `type="button"`** — 3 buttons in file-tree, chat messages, and plugin settings defaulted to `type="submit"`.

### Changed
- **Venice Billing Plugin v2** — Complete rewrite: fetches all pages in parallel batches (was capped at 5 pages, missing 73%+ of data), day picker for 24hr totals navigable 30 days back, paginated transaction log, fixed model name extraction for cache SKUs, filtered non-inference entries from totals.
- **README rewrite** — Updated to reflect current state: GitHub + GitLab providers documented, project structure updated (settings/, git-providers/, accessibility.js, etc.), deployment guide with BASE_PATH multi-environment docs, CI/CD pipeline reference, provider comparison table removed from "Future Enhancements".
- **CHANGELOG catch-up** — Added missing entries for 0.8.6 through 0.9.3.

## [0.9.3] - 2026-02-11

### Added
- **Accessibility module** (`js/accessibility.js`) — Comprehensive keyboard navigation and screen reader support:
  - Modal focus trapping with Tab/Shift+Tab cycling and previous-focus restoration on close
  - File tree arrow key navigation: Up/Down to move, Right to expand directory, Left to collapse/go to parent, Enter/Space to open file or toggle directory
  - Editor tab arrow key navigation with Home/End support
  - Settings tab keyboard navigation
  - ARIA roles and labels across all interactive elements
  - `MutationObserver`-based modal watcher for automatic focus management
- 114 `aria-*` attributes and 49 `role` attributes added across HTML templates
- 26 `tabindex` attributes for keyboard-focusable elements

## [0.9.2] - 2026-02-11

### Fixed
- **PR merge button silent failure** — `confirm()` dialogs can be suppressed by browsers in modal contexts. Replaced with inline confirmation: first click turns button red with "⚠️ Confirm squash?", second click merges, auto-resets after 3 seconds. All three providers now pass `head_commit_id`/`sha` to the merge API. Error handling upgraded from `alert()` to `showToast()`.

### Added
- **AI-generated PR review comments** — "Add Comment" section in PR detail modal with ✨ Generate with AI button. Analyzes PR title, description, diffs, and existing comments, writes a code review comment using the commit model. Post button submits via provider API and refreshes comments inline.

## [0.9.1] - 2026-02-11

### Changed
- **Settings manager split** — Refactored 1,753-line `settings-manager.js` monolith into 7 focused modules:
  - `settings-manager.js` (298 lines) — Orchestrator: open/close, tab switching
  - `settings/persistence.js` (287 lines) — DOM→State collection, export/import (backend swap target for switchboard)
  - `settings/llm-tab.js` (402 lines) — Provider settings, advanced params, sliders
  - `settings/connections-tab.js` (276 lines) — Git connection CRUD
  - `settings/models-tab.js` (301 lines) — Model browser, fetch, capabilities
  - `settings/plugins-tab.js` (125 lines) — Plugin config UI
  - `settings/roles-tab.js` (88 lines) — Role cards + tool list
- External API surface unchanged; no circular dependencies

## [0.9.0] - 2026-02-11

### Added
- **Runtime BASE_PATH** — Container accepts `BASE_PATH` environment variable for sub-path deployment. `docker-entrypoint.sh` generates nginx config from `nginx.conf.template` via `envsubst` at startup. Supports root (`/`), sub-path (`/editor`, `/test`, `/dev`), and arbitrary prefixes.
- **CI/CD pipeline** (`.gitea/workflows/ci.yaml`) — Three-environment deployment:
  - PR opened/synced → build `:dev` → deploy `ai-editor-dev` with `BASE_PATH=/dev`
  - Push to main → build `:test` → deploy `ai-editor-test` with `BASE_PATH=/test`
  - Tag `v*` → build `:latest` + `:vX.Y.Z` → deploy `ai-editor` with `BASE_PATH=/`
  - Concurrency groups prevent duplicate builds
- `docker-entrypoint.sh` and `nginx.conf.template` — New files for runtime config generation

### Changed
- All hardcoded `editor/` path prefixes in `index.html`, `template-loader.js`, `search-manager.js` converted to `./` relative paths. App is now truly path-agnostic.
- Removed Traefik `stripPrefix` middleware dependency from deployment

## [0.8.7] - 2025-02-10

### Added
- **Full PR workflow — never leave the editor**:
  - **Create PR**: ➕ button in PR panel header. Auto-populates title from branch name (e.g., `issue/42-fix-bug` → "Fix bug (#42)"), branch selectors pre-filled.
  - **Review PR**: Click any PR → full detail modal with state/CI/mergeable badges, markdown description, changed files with expandable inline diffs (syntax-colored), and all comments rendered as markdown.
  - **Merge PR**: Strategy picker (squash/merge/rebase), "delete branch" checkbox, auto-switches to main if you delete the branch you're on.
- **Provider methods**: `addPullRequestComment()`, `mergePullRequest()` — implemented on Gitea, GitHub, and GitLab with normalized return shapes
- **`merge_pull_request` LLM tool** — strategy, title, message, delete_branch params
- PR detail modal is resizable

## [0.8.6] - 2025-02-10

### Added
- **Plugin infrastructure**:
  - Settings → Plugins tab with connection-card-style UI (icon, name, status dot, ⚙️ config expand, ✅/⬜ toggle)
  - Plugin button/modal registration API via SlotManager
  - `beforeFetchIssues` / `resolveIssueConnection` hooks in Git facade for cross-repo routing
- **Cross-repo issues plugin** (`plugins/cross-repo-issues.js`) — Route issues from a GitHub connection to a Gitea working repo. Entire issue pipeline (sidebar, focus bar, triage, LLM tools) works against the mapped connection.
- **Venice billing plugin** (`plugins/venice-billing.js`) — Opens modal via plugin toolbar, calls Venice billing-usage endpoint, renders cost breakdown. Requires admin API key.
- **Markdown rendering in issues** — Issue bodies and comments in the detail modal and focus bar now render through `marked` + `DOMPurify` using the existing `preview-markdown` class. Full support for code blocks, blockquotes, links, images, headings.
- **Resizable modals** — New `.modal-resizable` class with CSS `resize: both`, min/max constraints, flex body that fills available space. Applied to issue detail and plugin modals.

### Fixed
- Rogue plugin modal visible on page load (used `class="modal"` instead of `class="modal-overlay"`)
- Removed 300-char truncation on issue comments — full markdown renders with scroll overflow


## [0.8.5] - 2025-02-10

### Added
- **Conversational Issue Triage** — click any issue in the sidebar to focus it in the chat panel for LLM-assisted review
  - **Issue Focus Bar**: Rendered at the top of the chat panel showing title, state, labels, assignees, description, and last 3 comments
  - **Rich LLM context injection**: Full issue body, labels, assignees, and up to 5 comments injected into the system prompt so the LLM can find relevant code, assess impact, and suggest approaches
  - **Quick actions**: Accept (comments, keeps open), Deny (comments + closes), Comment (adds note), Start Work (creates branch via existing workflow)
  - **Expand button** (📄): Opens the full issue detail modal for additional info
  - **Dismiss button** (✕): Returns chat to normal mode, clears focused state
  - **Sidebar highlight**: Focused issue gets purple left-border highlight (distinct from blue active-work highlight)
  - **Chat integration**: System message announces focused issue, input placeholder updates to triage-specific hint
  - `State.focusedIssue` — new state field, separate from `State.currentIssue` (active work branch)
  - EventBus events: `issue:focused`, `issue:unfocused`

### Changed
- Issue sidebar items now focus in chat (single click) instead of opening the modal directly
  - Modal still accessible via expand button in the focus bar
- System prompt now includes two distinct issue contexts:
  - `ACTIVE ISSUE` — when on a work branch for an issue (existing behavior)
  - `FOCUSED ISSUE (TRIAGE MODE)` — when reviewing/discussing an issue in chat (new)

### Workflow
1. Third party creates an issue/ticket
2. Click the issue in the left sidebar → focus bar appears at top of chat
3. Discuss with the LLM: "What code is relevant to this?", "Is this a valid bug?", "How complex is this?"
4. LLM uses search_project, read_file, scan tools to find and reference actual code
5. Accept → posts ✅ comment | Deny → posts ❌ comment + closes | Comment → posts note | Start Work → creates branch

## [0.8.4] - 2025-02-10

### Added
- **GitLab Provider** (`js/git-providers/gitlab.js`): Third git provider, completes the trifecta (Gitea, GitHub, GitLab)
  - Auth: `PRIVATE-TOKEN` header
  - API v4 with URL-encoded `owner/repo` project identifiers
  - Full recursive tree API with pagination (capped at 10K items)
  - **Atomic batch commits**: Uses GitLab's Commits API for multi-file operations in a single commit (unlike GitHub/Gitea's sequential approach), falls back to sequential on failure
  - **MR terminology mapping**: `source_branch`/`target_branch` → `head`/`base`, `iid` → `number`, `opened` → `open`, `description` → `body`
  - **Rename via Commits API**: Atomic delete + create in one commit (no intermediate state)
  - **CI status**: Commit statuses API with pipeline fallback — fetches latest pipeline + jobs when commit statuses are empty (common with GitLab CI)
  - Issue comments filter out system-generated notes automatically
  - MR comments distinguish inline (position-based) from general notes
  - Labels handled as comma-separated strings (GitLab convention)
  - Settings: URL field (defaults to `https://gitlab.com`) + PAT token (`glpat-xxx`)
  - Self-hosted GitLab: any URL works, `/api/v4` appended automatically
- Registered in `js/git-providers/index.js` — previously a placeholder comment

### Provider comparison
| Feature | Gitea | GitHub | GitLab |
|---------|-------|--------|--------|
| Auth | `token` | `Bearer` | `PRIVATE-TOKEN` |
| Tree | walk dirs | `git/trees?recursive` | `tree?recursive` + paginate |
| Batch | sequential | sequential | atomic Commits API |
| CI | commit status | status + check-runs | commit status + pipelines |
| File path | path segment | path segment | URL-encoded |
| MR naming | `head`/`base` | `head`/`base` | `source_branch`/`target_branch` |

## [0.8.3-2] - 2025-02-10

### Added
- **`read_pull_request` tool**: LLMs can now read full PR details — description, per-file diffs, CI status, and all comments (review + general) in a single call. Patches auto-truncated at ~8K chars to stay within tool result limits. Available to all roles.
- **`add_pr_review` tool**: Post review feedback on a PR as a general comment. Available to reviewer, coder, and pm roles. Triggers sidebar PR refresh.
- **`get_ci_status` tool**: Check CI/CD pipeline status for any branch or commit SHA. Defaults to current branch. Available to all roles.
- **Provider methods**: `getPullRequest()`, `getPullRequestFiles()`, `getPullRequestComments()`, `addPullRequestComment()` — implemented on both GitHub and Gitea providers with normalized return shapes
- **Git facade**: Five new methods wiring provider PR operations to the tool layer

### Changed
- **PR tools now enable full review loop**: Coder creates PR → Reviewer reads diff + CI → Reviewer posts feedback → Coder resolves → repeat
- Tool count: 25 → 28

## [0.8.3-1] - 2025-02-10

### Changed
- **Sidebar: Workflows → Pull Requests**: Replaced the Workflows panel with a PR panel showing CI status
  - Branch-contextual: on default branch shows all open PRs, on feature branch shows only that branch's PRs
  - Each PR displays CI status badge (✅ success, 🔄 pending, ❌ failure, ⚪ unknown)
  - CI status fetched in parallel from combined commit status API
  - Re-renders automatically on branch switch

### Added
- **`getCommitStatus()`**: New provider method on both GitHub and Gitea
  - GitHub: tries `/commits/{ref}/status` first, falls back to `/commits/{ref}/check-runs` (Actions use checks API)
  - Gitea: uses `/commits/{ref}/status`
  - Returns normalized `{ state, total, statuses[] }` shape
- **`State.pullRequests`**: New state property for cached PR data with CI annotations

### Fixed
- Settings toggle renamed from "Show Workflows" to "Show Pull Requests" with matching state key

## [0.8.3] - 2025-02-10

### Added
- **GitHub Provider**: Full GitHub.com support as second git provider implementation
  - All repository, branch, file, issue, PR, and Actions operations
  - `Bearer` token auth with `X-GitHub-Api-Version` header
  - Efficient `git/trees?recursive=true` for file tree (single request vs directory walking)
  - Automatic fallback to contents-walk for repos exceeding git/trees limit
  - Rate limit detection with reset time in error messages
  - GitHub Actions workflow run listing
  - `fixedUrl` set to `https://api.github.com` — no URL field needed in connection settings
  - GitHub Enterprise support via `getBaseUrl()` (auto-appends `/api/v3`)
  - Filters PRs from issues endpoint (GitHub returns both)
  - Strips RFC 2045 newlines from base64 file content

### Fixed
- **Dead event listeners**: `secondary-pane.js` was listening for `gitea:saved`/`gitea:batchSaved` events that were never emitted after provider migration; updated to `git:fileUpdated`/`git:batchCommitted`
- **Tool error handling (0.8.2-5 rework)**: Moved error handling to source instead of downstream hacks
  - `ToolRegistry.execute()` now catches all errors with typed recovery hints (404/403/409/422/timeout)
  - Guarantees non-null, non-empty tool results — LLM always gets actionable feedback
  - `executeToolCall()` catches malformed JSON arguments separately
  - Tool result serialization guards against `"null"`/`"undefined"` content
  - Removed over-engineered 3-pass orphan detection from `sanitizeMessages()`

## [0.8.2] - 2025-02-10

### Added

- **Zip Upload**: Upload entire zip files to the repository from the sidebar.
  - 📦 button in Files header opens the upload modal
  - Drag-and-drop or click to select a `.zip` file
  - JSZip extracts in-browser — no backend needed
  - File preview with checkboxes for selective upload
  - Auto-strips common single-directory prefix (e.g., `project-v1/`)
  - Detects existing files via SHA lookup for create vs. update
  - Target directory field for uploading into subdirectories
  - Progress bar with per-file status tracking
  - Binary files detected and excluded by default
  - Select all / Select none controls
  - File tree auto-refreshes on completion

### Changed

- **Vendor bundle**: Added JSZip 3.10.1 (~25KB minified) with CDN fallback
  for air-gapped deployments.

## [0.8.1-2] - 2025-02-10

### Fixed

- **Import error**: `handlers.js` imported `escapeHtml` from `messages.js`
  where it was no longer exported (moved to `utils/html.js` in 0.8.1).
  Removed the unused import.

## [0.8.1-1] - 2025-02-10

### Fixed

- **Dockerfile build failure**: Inline heredoc (`<< 'NGINX'`) requires BuildKit
  `dockerfile:1.4+` syntax, which Gitea Actions runners don't support by default.
  Extracted nginx config to standalone `nginx.conf` file and use `COPY` instead.
- Clean up `nginx.conf` from served files in final image.

## [0.8.1] - 2025-02-10

### Security

- **XSS sanitization pass**: All `innerHTML` paths now escape external data (file names,
  branch names, connection IDs, workflow data, error metadata) via shared `escapeHtml` /
  `escapeAttr` utilities. Previously, malicious repository names, branch names, or Git API
  responses could inject and execute arbitrary scripts.
- **SVG preview sandboxed**: SVG files rendered in the preview pane now pass through
  DOMPurify (if available) or fall back to a `sandbox=""` iframe with no script execution.
- **Consolidated escape functions**: Six duplicate `escapeHtml` implementations across the
  codebase replaced with a single source of truth in `js/utils/html.js`.

**Files modified for XSS fixes:**
  `file-tree.js`, `tab-manager.js`, `project-manager.js`, `ui-helpers.js`,
  `settings-manager.js`, `error-logger.js`, `model-manager.js`, `secondary-pane.js`,
  `chat/messages.js`, `diff-viewer.js`, `quick-open.js`, `search-panel.js`

### Added

- **Resizable preview pane**: Drag handle between editor and preview/diff pane allows
  resizing. Width persists to localStorage across sessions.
- **Preview fullscreen toggle**: Button in secondary pane header (⛶) toggles fullscreen
  mode, hiding the editor and giving the preview/diff the full width.
- **Shared HTML utilities module** (`js/utils/html.js`): Canonical `escapeHtml()` and
  `escapeAttr()` for all HTML construction.

### Changed

- **Dockerfile: python → nginx**: Production image switched from `python3 -m http.server`
  to `nginx:1-alpine`. Adds gzip compression, proper cache headers (immutable for vendor
  bundles, no-cache for app files), and security headers (X-Frame-Options, X-Content-Type-Options,
  Referrer-Policy, Permissions-Policy). Image is smaller and significantly faster.

### Fixed

- Preview pane `.ext` indicator was not escaped (minor XSS in file extension display).
- Connection card `providerName` was not escaped in settings UI.

---

## [0.8.0-1] - Previous Release

Initial 0.8.x series release. See README for full feature list.
