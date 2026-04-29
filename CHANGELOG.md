# Changelog

All notable changes to AI Editor are documented here.

## [Unreleased]

### Docs

- **SlotManager — contract locked** (`docs/DESIGN-git-providers-and-ui-extensions.md`
  §4). Closes the last design-only deliverable from `docs/ROADMAP.md`
  §1.1.0: *"during 1.1 we lock the contract."* Adds four subsections
  to the existing SlotManager design:
  - **Slot catalog** — closed registry of five named slots
    (`sidebar-panels`, `settings-connections`, `editor-toolbar`,
    `chat-input-row`, `status-bar`) with host element and purpose for
    each. Plugins cannot invent private slot names; new slots require
    a DESIGN-doc PR.
  - **Error semantics, security, and ordering** — `render()` errors
    are caught, logged, and skipped (no sibling-render abort);
    `HTMLElement` returns mount via `appendChild`, `string` returns
    via `insertAdjacentHTML('beforeend', ...)` and are **not**
    sanitized by SlotManager (plugin authors own sanitization, same
    rule as the CI `return raw;` lint); priority sorts ascending with
    default `50` and stable tie-break by registration order; CSS
    isolation is via plugin-id namespacing — no shadow DOM in 1.4.x.
  - **Schema additions** — `version: '1.1'` field on each panel /
    setting / menuItem entry; future renderers can reject unknown
    versions for forward-compat.
  - **Implementation status callout** at the top of §4 — clarifies
    that the renderer (`js/slot-manager.js`) is deferred to 1.4.x
    while the contract is now locked.

  Why: 1.4.0 (Tools Phase 1) is two tracks away. Without the
  catalog/error/security clarifications now, the 1.4.x SlotManager
  patch would have to redesign these in flight — and the four
  ambiguities (what slots exist, what happens on render error, who
  sanitizes HTML, how priorities tie-break) are exactly the kind of
  decisions that quietly bind plugin-author expectations once the
  first plugin uses them.

  `docs/PLAN.md` updated to reflect the locked contract under both
  the 1.1.x landed table and the SlotManager Future Work bullet; the
  doc/code drift entry is updated rather than deleted so the resolution
  history is traceable.

### Changed

- **`docs/ARCHITECTURE.md` § `tools/registry.js`** — paragraph expanded to
  name the canonical error contract directly: `EditorError` extends
  `Error` with a machine-readable `.code` (from the `ErrorCode` enum)
  and a human-readable `.recoveryHint`; consumers compare `err.code`
  rather than parse `.message`; `js/error-logger.js` renders the hint;
  `EditorError.fromResponse()` and `.wrap()` are the canonical
  constructors. Closes a doc/code drift item flagged in
  `docs/PLAN.md` § Known doc/code drift.

- **`js/tools/doc-tools.js` `DOC_MANIFEST`** — entries can now declare
  an `inline` content string instead of a `path` to fetch. The
  `read_docs` handler short-circuits the fetch path for inline entries
  and returns the inline content directly. The manifest-listing branch
  surfaces inline entries with `inline: true` in place of `path` so the
  LLM can tell them apart.

### Removed

- **`docs/LLM_ERROR_RECOVERY.md`** retired. The doc was ~160 lines of
  agent-troubleshooting guidance built around a 2024 Gitea-only fix
  (commit `f79091fb`); the canonical error contract has lived in
  `js/utils/errors.js` for several releases now (`EditorError`,
  `ErrorCode`, `recoveryHint`), and the doc had no live readers
  outside `read_docs({doc_id:'error-recovery'})`. The `read_docs`
  entry is preserved (so existing LLM tool calls don't 404) but now
  returns an inline pointer string referencing `js/utils/errors.js`
  and the new `ARCHITECTURE.md` paragraph. Closes the
  `docs/ROADMAP.md` §1.1.0 deliverable: *"Retire/rewrite
  `docs/LLM_ERROR_RECOVERY.md`. Either fold its useful content into a
  new section in PLUGIN.md / TOOLS.md, or replace with a thin pointer
  to `js/utils/errors.js`."* — shrink-to-pointer chosen because the
  surviving content was three sentences, which fold into ARCHITECTURE
  more honestly than into PLUGIN/TOOLS.

## [1.0.6] - 2026-04-29

### Added
- **Profile scaffolding + unified `TaskLedger`** (`js/profiles/`) — data-only
  module landing the typedef contract from `docs/DESIGN-profiles.md` and
  `docs/DESIGN-tools.md`. Four files:
  - `task-ledger.js` — `TaskLedger` typedef + record typedefs
    (`AdmissionRecord`, `ExclusionRecord`, `ToolAdmissionRecord`,
    `ToolInvocationRecord`) + `createTaskLedger(...)` empty-state factory
    + `isTaskLedger(...)` type guard. One ledger struct, four record
    arrays — chunk admissions/exclusions for retrieval (1.5.0) and tool
    admissions/invocations for tools (1.4.0).
  - `profile-contract.js` — `Profile` typedef plus `BudgetSpec`,
    `RetrievalConfig`, `MemoryConfig`, `CompressionConfig`,
    `SummarizerConfig`, `ToolsConfig`, `TaskLedgerConfig` sub-typedefs
    + `isProfile(...)` type guard.
  - `coder-v1.js` — `CODER_V1` Profile object that mirrors *current*
    coder-role behavior (single-strategy semantic retrieval, scratchpad-only
    memory, Rule-5-only compression, all 52 tools loaded). Field-by-field
    provenance comments link each value back to the source it mirrors
    (`State.settings.summarizer`, DESIGN docs, ROADMAP decisions).
  - `index.js` — barrel export.

  Why: the unified TaskLedger ships once now so 1.4.0 (tool admissions /
  invocations) and 1.5.0 (chunk admissions / exclusions) fill in the same
  struct rather than each shipping its own ledger schema and a future
  merge step. Per `docs/ROADMAP.md:114` *"One schema, no migration"* —
  this lands that schema. The roadmap exit criteria for §1.1.0 is
  explicit: *"Unified `TaskLedger` typedef + empty-state struct present
  in `js/profiles/`; no consumer wires up yet."* This PR satisfies that
  by introducing zero behavior change. The `coder.v1` profile is data
  only — no subsystem reads it yet. 1.2.0/1.3.0/1.4.0/1.5.0 will each
  begin reading the relevant slice; 2.0 makes the profile contract
  load-bearing.

  Tests: `tests/test-profiles.{mjs,js}` — 19 node:test cases plus a
  parallel browser suite covering ledger empty-state shape, type-guard
  behavior, coder.v1 budget arithmetic (residual = 12500), and the
  documented field-by-field provenance against `State.settings`.

- **Pre-merge version coherence CI lint** (`.gitea/workflows/ci.yaml`) — new
  step in the `build-and-deploy` job, runs before the existing security lint.
  Parses the `VERSION` constant from `js/version.js` and the most recent
  `## [X.Y.Z]` heading from `CHANGELOG.md`; fails the build if they disagree.
  Skips the `## [Unreleased]` block (matched only on numeric headings).

  Why: AI Editor has shipped two release-sync drifts in a row
  (`0.9.42 → 1.0.4 → 1.0.5`) where `js/version.js` lagged the production
  tag and required a retroactive sync PR. Per `docs/ROADMAP.md` §1.1.0
  this lint is the machine replacement for the human "remember to bump
  version.js" rule. Pure CI tooling — no runtime impact.

- **Migration coverage probe** (`js/chat/metadata-probe.js`) — read-only
  consistency check that surfaces in dev mode via `?debug=metadata`. At
  session load, counts how many tool-result turns carry the enrichment
  fields added in the previous turn-metadata work (`tool_name`, `tool_args`,
  `tool_result_for`, `file_ops`) and reports per-field coverage to the
  console. Pure module — no Storage, no DOM, no `State` mutation. Tests:
  `tests/test-metadata-coverage.{mjs,js}`.

  Why: when Compression Phase 1 (1.2.0) starts measuring eviction rates, the
  probe's coverage signal is what lets us tell "no rule applied" apart from
  "rule skipped because metadata absent on a pre-#170 turn." Without that
  distinction, an under-target eviction rate is ambiguous evidence. Per
  `docs/ROADMAP.md` §1.1.0, the enrichment + probe ship as one shippable
  unit; this lands the second half.

  Wired in `js/app.js` (parses the query string once at boot, exposes
  `window.__AIE_DEBUG_METADATA`) and consumed in `js/chat/index.js`
  `initChat()` after history rehydration. Default-off; zero behavior change
  when the flag is absent.

- **`node --test` CI step** (`.gitea/workflows/ci.yaml`) — new
  `Node tests (node --test)` step in the `build-and-deploy` job, runs
  `tests/test-*.mjs` after the version coherence check and before the
  security lint. Pinned to Node 22 LTS via `actions/setup-node@v4`. A
  failing test blocks PR merge before any Docker work happens.

  Why: per `docs/ROADMAP.md` §1.1.0 exit criteria, "`node --test` runs in
  CI, all existing `.mjs` suites pass after porting." Until this lands,
  the only test runner is `tests/index.html` in a browser, which is not
  exercised by CI. Closes the loop on regression detection at the chat
  enrichment / summarizer / retry boundaries.

- **Runner-health smoke test** (`tests/test-smoke.mjs`) — three sanity
  checks (`1+1`, ESM resolution from `tests/` to `../js/`, Node major
  version ≥ 20). Catches a broken CI runner config before it manifests as
  a confusing failure in a real test suite.

- **Node-side browser-globals shim** (`tests/_node-shim.mjs`) — minimal
  `window` / `localStorage` / `indexedDB` / `document` / `navigator` stubs
  so test files whose transitive imports touch `js/core.js` or `js/git.js`
  can run under `node --test`. Side-effect-only module; consumers
  `import './_node-shim.mjs';` at the top before any `../js/...` import.

### Changed
- **`tests/test-retry.mjs`, `tests/test-edit-tracker.mjs`,
  `tests/test-summarizer.mjs`, `tests/test-blame-normalize.mjs`** — ported
  from the in-page `window.T` framework to `node:test` +
  `node:assert/strict`. The browser parallel suites
  (`tests/test-*.js`) are unchanged and continue to run under
  `tests/index.html`. The Node ports are aligned with current `.js`
  sibling coverage (the previous `.mjs` files were stale: `test-retry`
  asserted the wrong shape for `ConnectionError`, `test-edit-tracker`
  used a long-renamed API). The two stateful tests load
  `tests/_node-shim.mjs` first; pure-utility tests (`test-retry`,
  `test-edit-tracker`) need no shim. Single DOM-bound assertion in
  `test-blame-normalize` is `test.skip()`d under Node with a comment
  pointing at the `.js` sibling.

### Fixed
- **`tests/test-context-filter.js`** — Browser test now seeds
  `IgnoreManager._globalRaw` with `DEFAULT_IGNORE_PATTERNS` and calls
  `_recompile()` at the top. Production calls `IgnoreManager.init()` at app
  startup; the test never did, leaving `_compiled = []` so `isIgnored()`
  returned `false` for every input. 32 of the 35 failing browser tests
  (binary/media, lock files, path patterns, edge cases) were the same root
  cause; all green after seeding.
- **`js/ignore.js` `DEFAULT_IGNORE_PATTERNS`** — Added `*.bundle.js` and
  `*.bundle.css` alongside the existing bare `bundle.js` / `bundle.css`.
  The bare patterns are exact-basename matches (gitignore semantics) and
  miss real-world webpack output like `vendor.bundle.js` and
  `styles.bundle.css`. Affects new installs only — existing users keep
  their saved patterns until they reset.
- **`tests/test-summarizer.js`** — Updated the 3 "1M model, balanced"
  expectations from `{200, 60, 100}` to `{625, 219, 375}`. The summarizer
  multiplies its upper clamps by `getContextScale().scale` (1×/2×/4×/8×
  per `js/llm/api.js` lines 99–102); 1M-ctx models hit scale 8 so capacity
  (625) sits well under the scaled cap (1600/480/800) and is no longer
  clamped. Test was written when scale was always 1; production scaling
  was added later.

## [1.0.5] - 2026-04-29

### Added
- **`docs/ROADMAP.md`** — Versioned plan through 2.0 covering the four
  intelligence subsystems (retrieval, memory, compression, tools) and
  profile contract. Tracks: foundations → compression → memory → tools →
  retrieval → profiles. Biweekly minor cadence; ~5-month arc to 2.0.
- **DESIGN docs landed** — `DESIGN-intelligence.md`, `DESIGN-retrieval.md`,
  `DESIGN-memory.md`, `DESIGN-compression.md`, `DESIGN-profiles.md`,
  `DESIGN-tools.md` relocated from project root into `docs/`. These
  describe the architecture target ROADMAP.md sequences toward.

### Changed
- **`js/version.js`** — Bumped 1.0.4 → 1.0.5. The 1.0.5 release shipped
  to production via PRs #165, #166, #167 but the version constant wasn't
  bumped in lockstep; this corrects the drift.
- **`docs/TOOLS.md`** — Full rewrite covering all 52 tools across 16
  modules with accurate per-tool role assignments. Previous version
  documented ~25 tools and missed cursor/multifile/xref/eval/scratchpad/
  doc/commit/PR-merge/CI/embeddings tools entirely.
- **`docs/ARCHITECTURE.md`** — Updated File Size Map with current line
  counts (replaces stale "no file >600 lines" claim). Added Local
  provider section, Testing & CI section. Removed deleted
  `search-replace-tools` reference.
- **`docs/ROLES_AND_TOOLS.md`** — Full rewrite. Tool counts per role
  now accurate (52/36/28/27/22 instead of "19+"). Tool/role matrix
  derived from actual `roles:` fields in source.
- **`docs/scan-tools-guide.md`** — Fixed `js/chat.js` reference (now
  `js/chat/`); replaced "Coming soon: Go/Rust/Java/C++" with description
  of current empty-outline behavior for non-JS/Python files.
- **`docs/PLAN.md`** — Added 1.0.4 + recent shipped items; flagged
  SlotManager as designed-but-not-built; added Scan Tool Coverage and
  Testing sections; added Known doc/code drift section.

### Fixed (already shipped on `main` ahead of this version bump)
- **PR #165:** PR detail merge button state now resets on every PR load
  (issue #10).
- **PR #166:** Editable model definitions — capabilities and context
  window can now be overridden per model (issue #8).
- **PR #167:** Tool widgets persist across redraws via `_display`
  metadata (issue #6).

## [1.0.4] - 2026-02-23

### Security

- **P0 — DOMPurify bypass patched** — Three independent markdown renderers
  (`chat/messages.js`, `secondary-pane.js`, `markdown-modal.js`) had a
  conditional pattern that returned raw `marked.parse()` output to `innerHTML`
  when DOMPurify was unavailable. All three now fail closed — escaping content
  rather than passing through unsanitized HTML. This affects rendering of LLM
  responses, Git issue/PR bodies, and comments.

- **P1 — Regex markdown fallback XSS fixed** — The `renderMarkdown()` fallback
  in `secondary-pane.js` applied regex formatting to raw input without
  escaping first, allowing injection via headings, inline code, links, and
  images. Now calls `escapeHtml()` before regex processing, matching the
  existing safe pattern in `chat/messages.js`.

- **P2a — Error messages escaped** — `e.message` and `docPath` strings from
  API errors and fetch failures were injected into `innerHTML` without
  escaping in `release-manager.js`, `app.js`, and `markdown-modal.js`. All
  error paths now use `escapeHtml()`. Release URL attribute also now uses
  `escapeAttr()`.

- **P2b — Image filename escaped** — Pasted/dropped image filenames in
  `chat/input.js` were injected into a `title` attribute without
  `escapeAttr()`, allowing attribute breakout from crafted filenames.

- **P2c — Plugin metadata escaped** — Role names, descriptions, icons, and
  tool definitions from plugins were rendered unescaped in
  `settings/roles-tab.js`. A malicious plugin could inject HTML via
  `Roles.register()` or tool registration. All plugin-provided strings now
  pass through `escapeHtml()` / `escapeAttr()`.

- **P3a — Label color CSS injection fixed** — `issue-detail.js` injected
  Git API label colors directly into `style` attributes. Crafted color values
  could inject arbitrary CSS. Now stripped to hex characters only via
  `replace(/[^0-9a-fA-F]/g, '')`.

- **P3b — Issue state escaped** — `issue.state` from Git APIs was injected
  into `innerHTML` without escaping. Now uses `escapeHtml()`.

### Changed
- **CI: Security lint step** — Gitea CI workflow now includes a pre-build
  security lint that checks for DOMPurify bypass patterns (`return raw;`)
  and verifies vendor security libraries are referenced in the Dockerfile.
  Fails the build if regressions are detected.

## [1.0.0] - 2026-02-20

### Added
- **`Plugins.registerTool()`** — Convenience wrapper for registering LLM
  tools from plugins. Auto-formats the tool definition and handles
  ToolRegistry import via lazy `import()` to avoid circular deps.
  ```javascript
  await Plugins.registerTool('my-plugin', {
      name: 'fetch_weather',
      description: 'Get weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      roles: 'all',
      handler: async ({ city }) => ({ temp: 72, city })
  });
  ```

- **`Plugins.injectCSS()` / `Plugins.removeCSS()`** — Scoped `<style>`
  tag injection for plugins. Multiple calls with the same plugin ID
  replace the previous stylesheet. Enables theme plugins, custom UI
  styling, and visual tweaks without modifying core CSS.
  ```javascript
  Plugins.injectCSS('my-plugin', `.my-class { color: var(--accent); }`);
  Plugins.removeCSS('my-plugin');  // cleanup in destroy()
  ```

- **`plugin:toolRegistered`** EventBus event — Emitted when a plugin
  registers a tool via `Plugins.registerTool()`.

- **Download project as zip** — 📥 button in the branch selector row
  downloads the current project/branch as a zip archive. Supported on
  all remote providers (Gitea, GitHub, GitLab). Shows progress toast,
  triggers browser save dialog with `{repo}-{branch}.zip` filename.

- **Ignore patterns** — New Settings → Ignore tab with gitignore-syntax
  patterns that control what the LLM can discover via tools (`get_project_tree`,
  `search_in_files`, `find_references`, context indexing). Defaults ship
  with sensible exclusions (node_modules, binaries, lockfiles, etc.).
  Per-project `.aieditorignore` file at repo root merges on top.
  File tree sidebar and explicit `read_file` are unaffected — only
  the LLM's autonomous discovery is scoped.
  - `js/ignore.js` — shared module with pattern compiler, three-layer
    merge (defaults → global settings → project `.aieditorignore`)
  - Context manager refactored to delegate to `IgnoreManager.isIgnored()`
  - Settings export/import includes `ignorePatterns`

### Changed
- **Plugin SDK "What Is Not Possible"** — Removed "CSS injection" and
  "file system events" entries (both now implemented). Remaining:
  SlotManager, CodeMirror bridge, plugin settings tabs, provider
  settings UI auto-discovery.

### Fixed
- **Dockerfile labels** — Added OCI metadata labels
  (`org.opencontainers.image.*`) and blanked inherited `maintainer`.
  Without this, container registries displayed "NGINX Docker
  Maintainers" as the image author.

### Docs
- **PLUGIN.md**: New "LLM Tools" and "CSS Injection" sections with
  full examples. Updated capability tables — registerTool and injectCSS
  moved from "Possible But Not Bridged" to "What Works".
- **PLAN.md**: Rewritten as 1.0 release roadmap. Completed items in a
  table, remaining items organized as "Future Work" by category.
- **Plugin-dev role systemPrompt**: Documents `registerTool()` and
  `injectCSS()` with examples. Updated "WHAT IS NOT POSSIBLE" list.

## [0.9.42] - 2026-02-20

### Added
- **Built-in Plugin Editor** — Create, edit, and test plugins without
  leaving the editor:
  - Settings → Plugins → "Create Plugin" opens a dedicated tab with
    full CodeMirror syntax highlighting (JavaScript mode, dark theme)
  - Ctrl+S saves source to Storage, Ctrl+Enter saves & runs (hot-reload)
  - User plugins stored in `userPlugins` Storage key, loaded on startup
    via same blob-URL import() mechanism as URL-installed plugins
  - Edit button (✏️) on user-created plugin cards in Settings
  - Unsaved changes warning on tab close
  - Delete button removes source from Storage and disables plugin
  - New "User-Created Plugins" section in Settings → Plugins tab
  - Plugin template pre-populated with hooks, config schema, and docs

- **Plugin Editor LLM Tools** — Dedicated tools for the plugin-dev role:
  - `read_plugin_source` — Read current plugin editor content (numbered)
  - `write_plugin_source` — Replace full plugin source in the editor
  - `run_plugin` — Save + hot-reload via blob import
  - `list_user_plugins` — List all user-created plugins with status
  - Auto-role switching: entering a plugin editor tab switches to
    `plugin-dev` role, leaving restores previous role
  - System prompt includes tool usage instructions + full SDK reference

- **Plugin-dev role scoping** — `plugin-dev` no longer gets "full"
  tool access. Scoped to: read-only file/project/search/scratchpad
  tools (roles: 'all'), plugin editor tools (roles: 'plugin-dev'),
  and read_docs. No file editing, commits, issue creation, or PRs.

- **Settings Export includes Plugin State** — Export/import now covers:
  - `pluginState`: enabled/disabled status + config for all plugins
  - `installedPlugins`: external plugin URLs (re-fetched on reload)
  - `userPlugins`: full source code of user-created plugins
  - Import merges gracefully — doesn't overwrite existing plugins,
    skips duplicate URLs, unknown plugin IDs sit harmlessly in storage
    until their plugin registers
  - Settings export version bumped to 1.1

### Changed
- **Tab manager**: `_tabDisplay()` handles `plugin-editor` tab type
  (🧩 icon). Dirty indicator shown for plugin editor tabs. Close-tab
  warns about unsaved changes for plugin editor tabs.
- **Tool registry**: `plugin-dev` removed from "return everything"
  shortcut — now properly filtered through role-based access control
- **Plugin-dev role description**: Updated to reflect scoped tools and
  auto-activation behavior

### Docs
- **PLUGIN.md**: New "Built-in Plugin Editor" quick start section
- **TOOLS.md**: Plugin Editor tools section + updated role table
- **ROLES_AND_TOOLS.md**: Full Plugin Developer role definition with
  tool list, restrictions, and auto-activation docs
- **Help modal**: Plugin editor hotkeys (Ctrl+S, Ctrl+Enter)

## [0.9.41] - 2026-02-20

### Fixed
- **Chat defaulting to wrong repo context** (Issue #4): LLM used
  `peek_project_tree` for the current project (inventing connectionId/
  owner/repo) instead of using `get_project_tree` or `read_file`.
  Three-layer fix:
  1. Tool guard: `peek_project_tree` and `peek_project_file` now reject
     calls targeting the current project with a corrective error message
  2. Prompt hardening: cross-project instructions now say "ONLY when the
     user explicitly asks about a DIFFERENT project" and warn against
     guessing connectionId values
  3. Context injection: `connectionId` now included in the "Current
     context" block so the LLM has it available when needed
- **Ollama model capabilities not detected** (Issue #3): Models like
  `granite4:latest` have tool support but the regex heuristic didn't
  always detect it. New Ollama provider queries `/api/show` for real
  capability metadata.

### Added
- **Ollama provider** (`js/providers/ollama.js`):
  - Auto-detects capabilities via native `/api/show` endpoint (tools,
    vision, context length, quantization, parameter size, family)
  - Parallel enrichment with concurrency cap (6 models at a time)
  - 5 s timeout per model — falls back to defaults on failure
  - Derives native API base by stripping `/v1` from endpoint
  - Select "Ollama" in Settings → LLM → Provider to use it
- **`ProviderRegistry.enrichModels()`**: New async hook called after
  `parseModels()`. Providers can implement `enrichModels(models, settings)`
  to augment model data with async API calls. No-op for providers that
  don't implement it.

### Changed
- **`peek_project_tree`**: Description strengthened — "NEVER use this for
  the current project", "You MUST call list_projects first". Rejects calls
  where owner/repo matches current project.
- **`peek_project_file`**: Same guard and description hardening.
- **System prompt**: Current context block now includes `Connection:
  {{connectionId}}`. Cross-project workflow section emphasizes calling
  `list_projects` first and never guessing connection values.
- **`listModels()`** (`js/llm/api.js`): Now calls `enrichModels()` after
  parsing, enabling providers to augment capabilities asynchronously.

## [0.9.40] - 2026-02-20

### Fixed
- **LLM overwrites issue descriptions**: `update_issue` tool had a `body`
  parameter that replaced the user's entire issue description. The LLM
  would reach for `update_issue({ body: "..." })` instead of
  `add_issue_comment()` when asked to "update an issue" with new info.
  Removed `body` from `update_issue` — it is now metadata-only
  (title, state, labels).
- **Multi-tab data corruption**: Two browser tabs of the editor would
  stomp each other's chat history, session state, summarizer context,
  and active conversation. Now 5 session-volatile keys are scoped per
  tab using a tab ID from `sessionStorage`.
- **scratchpad-tools**: `chatSummaryInfo` was read via direct
  `localStorage.getItem()` without the `ai-editor-` prefix — always
  returned null. Fixed to use `Storage.get()`.

### Added
- **Tab isolation** in `Storage` (`core.js`):
  - `_tabId` from `sessionStorage` (persists on refresh, unique per tab)
  - `_resolveKey()` transparently prefixes tab-scoped keys: `~t{id}~key`
  - `_parseTabKey()` reverse parser for cache iteration
  - Tab registry with 60 s heartbeat for stale detection
  - `beforeunload` marks tab as "closing"; refresh clears the flag
  - `_cleanStaleTabs()` on init removes data for dead tabs (>5 min stale
    or marked closing)
  - `_migrateTabScopedKeys()` one-time upgrade: moves unscoped volatile
    keys into the first tab's scope
  - `keys()` filters to show only this tab's scoped data + shared data
- **Tab-scoped keys**: `chatHistory`, `chatSummaryInfo`, `chatPruneStash`,
  `activeConversation`, `session`
- **Shared keys** (unchanged): `settings`, `models`, `conversations`,
  `conv-*`, `draft-*`, `pluginState`, `searchHistory`, layout widths

### Changed
- **`update_issue` tool**: Removed `body` parameter entirely. Added
  `labels` array parameter (was documented but missing from schema).
  Description now explicitly says "metadata only" and directs the LLM
  to `add_issue_comment` for posting content.
- **`add_issue_comment` tool**: Description expanded to clarify this is
  the correct tool for updates, responses, analysis, status reports,
  and any new content on an issue.
- **`Storage.get/set/remove`**: Now route through `_resolveKey()` for
  transparent tab scoping. External API unchanged.
- **`Storage.keys()`**: Returns bare (unprefixed) keys for this tab's
  scoped data; hides other tabs' keys entirely.
- Updated `docs/TOOLS.md` to match issue tool changes.

## [0.9.39-1] - 2026-02-19

### Added
- **Themed dialog system** (`js/ui/dialogs.js`): `showAlert()`, `showConfirm()`,
  and `showPrompt()` — Promise-based replacements for native `alert()`,
  `confirm()`, and `prompt()`. Styled to match editor theme with proper
  backdrop, animation, keyboard support (Esc, Enter, Ctrl+Enter for
  textarea), and focus management.
- **Prompt dialog for issue actions**: Accept, Deny, and Comment actions
  now use a proper themed modal with title, textarea, and
  contextual button labels instead of browser `prompt()`.

### Changed
- **Eliminated all native browser dialogs** — removed every `alert()`,
  `confirm()`, and `prompt()` call across 12 files:
  - `issue-detail.js` (6 prompt → showPrompt)
  - `tab-manager.js` (confirm → showConfirm, closeTab now async)
  - `error-logger.js` (confirm + 3 alert → showConfirm + showToast)
  - `llm-debug-modal.js` (confirm + alert → showConfirm + showToast)
  - `search-panel.js` (confirm → showConfirm)
  - `storage-metrics.js` (2 confirm → showConfirm)
  - `ui-helpers.js` (2 confirm → showConfirm)
  - `settings/plugins-tab.js` (confirm → showConfirm)
  - `settings/connections-tab.js` (confirm → showConfirm)
  - `project-manager.js` (confirm → showConfirm)
  - `zip-upload.js` (confirm → showConfirm)
  - `ui/revert.js` (2 confirm → showConfirm)
  - `file-tree.js` (2 confirm → showConfirm)
- **Destructive confirms use red button**: Delete, Clear, Revert, Deny
  actions render with `variant: 'danger'` for a red confirm button.
- **Issue tab action buttons restyled**: Start Work, Accept, Deny, and
  Comment buttons now use themed hover states with semantic colors
  matching the rest of the editor UI.

## [0.9.39] - 2026-02-19

### Added
- **Issue tabs**: Issues now open as editor tabs instead of being crushed
  in the chat window or a blocking modal. Clicking an issue in the sidebar
  opens it as a preview tab in the editor pane — same pattern as files.
  Double-click to pin. Full issue detail, comments, labels, branch info,
  and action buttons (Accept, Deny, Comment, Start Work) are all rendered
  in-tab with room to breathe.
- **Typed tab system**: `tab-manager.js` now supports a `registerTabRenderer()`
  API for custom tab types beyond files. Issue tabs are the first consumer;
  the pattern is ready for PR tabs or other views.
- **Tab visual distinction**: Issue tabs show a 🔖 icon and accent-colored
  left border + label so they're visually distinguishable from file tabs.
- **In-tab actions**: Accept, Deny, Comment, and Start Work buttons in the
  issue tab body — no more switching to the focus bar or modal to triage.
- **Refresh button**: Each issue tab has a 🔄 button to re-fetch data.

### Changed
- Sidebar issue click now opens a tab (was: chat focus bar)
- Focus bar "📄 Full details" button now opens a pinned tab (was: modal)
- `State.openTabs` entries now support a `type` field (`'file'` | `'issue'`)
- `switchToTab()` routes to registered renderers for non-file tab types
- Editor toolbar buttons (Preview, Diff, Blame) are auto-disabled when
  viewing non-file tabs

## [0.9.28-3] - 2026-02-13

### Fixed
- **Issue focus bar display**: Comments section now has proper containment
  with background, border, max-height, and scroll — matches body section
  visual style. Comment items use accent-colored left border and bolder
  meta line for clearer hierarchy
- **Issue body overflow**: Reduced body max-height from 120px to 80px,
  font from `--font-md` to `--font-sm` — tighter in the focus bar
- **Comments header**: Shows "💬 Comments (N)" label with "showing last 3"
  note when truncated — clearly separates body from comments
- **Accept tooltip**: Changed from "close with comment" to "comment and
  keep open" — accept posts a comment but does not close the issue
- **README ports**: Fixed `docker run` examples from `:80` to `:8000`
  to match Dockerfile `EXPOSE 8000`

## [0.9.28-2] - 2026-02-13

### Fixed
- **Commit message truncation**: Removed `maxTokens: 256` cap from
  commit message generation. Thinking models would burn the token
  budget on `<think>` blocks, leaving the actual message truncated.
  Prompt instructions now control output length instead
- **Think block stripping**: `stripThinkBlocks()` now handles both
  `<think>` and `<thinking>` tag variants (used by different model
  families). Applies to both non-streaming util and streaming parser
- **Commit message prompts**: Strengthened system and user prompts to
  explicitly instruct against thinking, explanations, quotes, and
  code fences — reduces think-block output from models that respect
  system instructions

### Added
- CI/CD workflow (`.gitea/workflows/ci.yaml`): Docker Hub dual-push
  on release tags — `gobha/ai-editor:latest` + `gobha/ai-editor:vX.Y.Z`
- `DOCKERHUB.md`: Docker Hub repository overview page
- `Ctrl+Shift+B` added to README keyboard shortcuts table

## [0.9.28-1] - 2026-02-13

### Fixed
- **Blame gutter empty column**: Rewrote inline blame gutter from
  `StateField` + `gutter()` (always renders column) to `Compartment`
  pattern — gutter column only exists when blame data is dispatched.
  Empty compartment = zero pixels. No more 180px blank column on load
  or when providers lack blame support (Gitea, GitHub)
- **Help modal**: Added `Ctrl+Shift+B` (blame/history) to keyboard
  shortcuts help

## [0.9.28] - 2026-02-13

### Added — Blame/History Interactive Cluster

Three features that build on the existing blame and file history
infrastructure (shipped in 0.9.10), making them interactive.

**Inline blame gutter** (`js/editor/blame-gutter.js`):
- CodeMirror 6 gutter extension showing blame annotations directly
  in the editor: SHA · author · relative date, color-coded by commit
- Uses CM6 `gutter()` + `GutterMarker` + `StateField` architecture
- Only marks the first line of each blame range (GitLens-style) to
  avoid visual noise
- Activates automatically when blame pane is toggled on; clears when
  closed
- SHA elements are clickable → opens commit diff in secondary pane
- Graceful no-op when blame data isn't available (GitHub/Gitea fall
  back to file history as before)
- New CM namespace exports: `gutter`, `GutterMarker`, `StateField`,
  `StateEffect` (both vendor bundle and CDN fallback paths)

**File history → diff** (`js/secondary-pane.js`):
- History table rows are now clickable — click any commit to view a
  unified diff between that commit's version of the file and the
  current editor content
- Fetches historical file via `Git.getFile(owner, repo, path, sha)`
  (works across all 3 providers since `getFile` already accepts a ref)
- Shows "No changes" state when file is identical
- "← Back" button returns to the history table

**Blame → commit diff** (`js/secondary-pane.js`, providers):
- Blame SHA elements are now clickable — click any SHA to see the
  full commit summary: author, date, and table of changed files with
  status icons and +/- line counts
- New provider method `getCommitDiff(sha)` added to all 3 providers:
  - **Gitea**: `GET /repos/{owner}/{repo}/commits/{sha}` (files array)
  - **GitHub**: `GET /repos/{owner}/{repo}/commits/{sha}` (files + patches)
  - **GitLab**: `GET /projects/{id}/repository/commits/{sha}/diff`
- Normalized return format: `{sha, shortSha, message, author, date, files[]}`
- "← Back" button returns to blame view

**CSS** (`css/editor.css`):
- Blame SHA elements now show pointer cursor and underline on hover
- History rows show hover background highlight
- New `.blame-back` button styles for in-pane navigation
- New `.commit-files` container for commit diff view

## [0.9.27-2] - 2026-02-13

### Fixed
- Markdown viewer modal z-index bumped to `10001` — onboarding overlay
  was `10000`, not `1000` as assumed in -1 patch
- File tree now refreshes after every git commit — both the UI commit
  modal (`ui/commit.js`) and the LLM tool commit (`tools/commit-tools.js`)
  now emit `tree:refresh` on success. Previously the tree stayed stale
  until manual refresh, causing UX confusion and potential sha conflicts
  on subsequent operations

## [0.9.27] - 2026-02-13

### Added — UX polish

**Markdown viewer modal** (`js/markdown-modal.js`):
- Generic reusable modal for rendering local `.md` files in-app
- Fetches file, pipes through `marked` → `DOMPurify`, displays in a
  scrollable overlay with styled headings, tables, code blocks, and links
- Caches rendered content per path (no re-fetch on repeat opens)
- Lazy DOM injection — modal element created on first use only
- Keyboard accessible: Escape to close, backdrop click to close,
  focus trapped on close button
- Onboarding "see setup guide" link now opens `REPOS.md` in the modal
  instead of downloading the raw file
- Exposed as `window.openMarkdownModal(path, title)` for global access
  (e.g. from help menus, settings links, or plugins)

**Conversation search** (`html/chat-panel.html`, `js/chat/index.js`):
- Search input at top of conversation drawer, filters by title as you type
- Auto-focuses when drawer opens for immediate keyboard use
- Escape clears search text before closing drawer
- "No matches" empty state when filter has no results

**Conversation sort** (`js/chat/index.js`):
- Sort toggle button (↕) in drawer header cycles through 3 modes:
  🕐 Recent (default) → 🔤 Alphabetical → 💬 Most messages
- Toast notification shows current sort mode on each cycle
- Sort state persists within session (resets to Recent on reload)

## [0.9.26-1] - 2026-02-13

### Fixed — Lighthouse audit & mobile chat input

**Critical: Mobile chat input offscreen**
- `100vh` → `100dvh` (with `vh` fallback) on `.app-container` — fixes
  mobile Safari/Chrome where `100vh` includes browser chrome, pushing the
  chat input below the visible area
- Chat and sidebar overlays use `bottom: 0` instead of `height: 100%`
  for robustness against viewport height mismatches
- Modal overrides also use `dvh` units
- Added `flex-shrink: 0` to `.chat-header` and `.chat-input-area` —
  prevents flex compression from squishing the input off-screen
- Added `min-height: 0` to `.chat-messages` — standard fix for flex
  children with `overflow: auto` in a column; without this the messages
  area won't shrink below its content size and can push the input out

**Performance (CLS 0.181 → target <0.1)**
- Added `contain: layout style` and `min-height: 0` to `.main-content`
  to prevent child panels from shifting ancestor layout during JS init
- Vendor scripts (`marked`, `purify`, `jszip`) now load with `defer` —
  no longer render-blocking (P2: 3 fewer blocking resources)

**Accessibility (89 → target 95+)**
- Welcome tab placeholder now has `role="tab"` and `aria-selected` (A1)
- Color contrast: bumped `--text-secondary` (#858585→#9e9e9e) and
  `--text-muted` (#6e6e6e→#8e8e8e) for WCAG AA 4.5:1 on dark
  backgrounds; `.cost-balance` uses brighter blue (#5bbdf5) (A2)
- Sidebar action buttons: bumped to 28×28px min touch targets (A3)
- File tree: switched from `aria-label` to `aria-labelledby` pointing
  at the visible `.name` span to fix label/name mismatch (A4)

**Best Practices**
- Balance polling no longer starts eagerly on page load — deferred
  until after `fetchModels()` succeeds, preventing 401 console errors
  from unconfigured Venice API keys (B2)

**Hardening**
- `previewImage()` now uses DOM API (`createElement`/`appendChild`)
  instead of `innerHTML` with string interpolation — eliminates a
  potential XSS vector from crafted image URLs

## [0.9.26] - 2026-02-13

### Added — Mobile responsive layout

Full mobile support at ≤768px breakpoint. The three-column desktop
layout (sidebar | editor | chat) becomes a single-panel mode with
bottom tab bar navigation.

**Bottom tab bar** (`js/mobile.js`, `css/mobile.css`):
- Three tabs: 📁 Files | ⚡ Editor | 💬 Chat
- Only one panel visible at a time
- Activity badges: blue dot on Chat when assistant responds, on Files
  when tree refreshes (while user is on another panel)
- Panel switching via `.mobile-active` CSS class
- Auto-switch to Editor when a file is opened or tab is switched
- Injected dynamically by `initMobile()` — no HTML template changes
- `mobileShowPanel(panel)` exported for programmatic switching

**Panel layout changes** (CSS-only, no JS layout changes):
- Sidebar: `position: absolute; width: 100%; height: 100%` overlay
- Chat: same overlay treatment
- Editor: persistent base layer (always mounted)
- Resize handles: hidden
- Desktop `.hidden` class overridden by `.mobile-active` on mobile

**Header simplification:**
- Hidden: sidebar/chat toggles (replaced by tab bar), debug buttons,
  help button, version number
- Remaining buttons: settings, commit, revert — all 36×36px touch targets
- Cost tracker: truncated to 100px max

**Touch-friendly targets (44px minimum):**
- All header buttons: 36×36px minimum
- Tab bar tabs: 44px min-height
- File tree items: 36px min-height
- Chat input actions: 40×40px
- Project/branch selectors: 36px min-height

**Modal sizing:**
- All modals: full-screen (100vw × 100vh, no border-radius)
- Settings: full-screen with horizontal-scrolling tab bar
- Onboarding: full-width, tighter padding

**Text input zoom prevention:**
- All text inputs, textareas, and selects set to `font-size: 16px`
  (iOS auto-zooms on inputs below 16px)

**Chat panel tweaks:**
- Header wraps: model selector and action buttons flow to second line
- Chat textarea: 16px font-size, 44px min-height

**Editor tweaks:**
- Tabs: horizontal scroll with hidden scrollbar, 80px min-width
- Toolbar buttons: 36×36px touch targets

**Toast positioning:**
- `.toast-container` raised to `bottom: 62px` (above 52px tab bar)

**Small phone (≤480px):**
- Tighter header text, smaller tab labels, compact onboarding cards

**Integration with existing code:**
- `toggleSidebar()` / `toggleChat()` updated to delegate to
  `mobileShowPanel()` at ≤768px
- No changes to any tool, provider, or chat module — only UI layer

**New files:**
- `css/mobile.css` — all mobile styles (dedicated file, no pollution
  of existing CSS)
- `js/mobile.js` — tab bar injection, panel switching, badge logic

**Modified files:**
- `index.html` — mobile.css stylesheet link
- `js/app.js` — import + `initMobile()` call
- `js/ui-helpers.js` — toggleSidebar/toggleChat delegate to mobile module

## [0.9.25-1] - 2026-02-13

### Added — Local filesystem provider (zip-only mode)

Uploading a zip no longer requires a Git connection. When no project is
active, the Upload Zip modal switches to "local mode":

- Git-specific controls hidden (target directory, commit message, Scan
  for Diffs button)
- Upload button reads "📂 Load into Editor"
- Files load into an in-memory filesystem provider
- File tree, tabs, editor, and all LLM tools work normally

**New file: `js/git-providers/local.js`**

A full git provider implementation backed by an in-memory Map. Implements
the same interface as Gitea/GitHub/GitLab so all existing code works
without modification:

- `listRepos()` — returns locally loaded projects
- `getFileTree()` — builds tree from Map keys
- `getFile()` / `createFile()` / `updateFile()` — read/write Map entries
- `batchCommitFiles()` — batch update Map (so "commit" saves to memory)
- `listBranches()` — returns `[{name: 'main'}]`
- `listIssues()` / `listMergeRequests()` — returns `[]`
- `getBlame()` / `getFileCommits()` — returns empty (no history)
- `hidden: true` — excluded from Settings → Connections dropdown

**How it works:**
1. User clicks Upload Zip (or drops a zip) with no project loaded
2. `openZipUpload()` detects no `State.currentProject`, hides git controls
3. On "Load into Editor", `_loadLocal()`:
   - Creates a `__local__` connection in `GitProviderRegistry` (ephemeral)
   - Calls `loadFilesIntoLocal()` to populate the in-memory file store
   - Calls `switchProject()` which triggers the standard project load flow
   - `loadProject()` calls `provider.getFileTree()` → file tree renders
   - `refreshProjects()` adds local projects to the sidebar dropdown
4. Everything downstream (editor, tabs, tools, AI) works unchanged

**Data lifetime:** In-memory only — refreshing the page clears local
projects. This is by design: no persistence, no privacy concerns, no
stale state.

**Settings isolation:**
- Local provider hidden from connection settings UI
- Local connection excluded from settings persistence (not in `connections[]`)
- Settings → Connections only shows Gitea/GitHub/GitLab

## [0.9.25] - 2026-02-13

### Added — First-run onboarding wizard

New users see a guided setup wizard on first launch when no Git
connections and no LLM are configured. Four-step flow:

**Step 0 — Welcome:** Three paths presented as clickable cards:
- "Connect to Git + LLM" → full setup flow
- "Just browse & edit code" → Git only, skip LLM
- "Zip upload only" → dismiss immediately, no config needed
- "I'll configure later in Settings (Ctrl+,)" → skip all

**Step 1 — Git Connection:** Provider selector (Gitea/GitHub/GitLab),
URL with auto-fill for GitHub/GitLab, token, test button. Saves
connection directly to GitProviderRegistry + persists to Storage.
Links to REPOS.md for token setup guide.

**Step 2 — LLM Provider:** Venice/OpenRouter/Custom selector, endpoint
auto-fill, API key. Saves to State.settings + Storage.

**Step 3 — Done:** Quick reference card: select project, upload zip,
ask AI, Settings (Ctrl+,), F1 for shortcuts.

**Implementation:**
- `js/onboarding.js` (new) — wizard logic, form wiring, persistence
- `html/modals.html` — onboarding overlay with 4-step wizard
- `css/modals.css` — 24 new CSS classes for wizard styling
- `html/editor-panel.html` — improved welcome screen: shows both
  Settings and Upload Zip buttons, F1 hint
- `js/app.js` — calls `checkOnboarding()` at end of init

**Completion flag:** `Storage.get('onboardingComplete')` — set on any
exit path (finish, skip, or dismiss). Also auto-set if user already has
connections + LLM configured (e.g., imported settings).

### Added — LICENSE file

MIT license. Referenced by README.md.

## [0.9.24-2] - 2026-02-12

### Fixed — `run_code` always returning `undefined`

The IIFE wrapper `(function(){ CODE })()` treated expressions as
statements — `42 * 17` ran but never returned its value.

**Fix:** REPL-style auto-return. `_wrapForReturn()` prepends `return`
to the last non-empty, non-comment line. If that creates a SyntaxError
(last line is a declaration like `const x = 5;`), falls back gracefully
to running code as-is (result stays `undefined`, console output still
captured).

Examples now working correctly:
- `42 * 17` → result: `714`
- `Array.from(...)...reduce(...)` → result: `385`
- `const fib = ...; fib(10)` → result: `55`
- `'world'.split('').reverse().join('')` → result: `dlrow`

## [0.9.24-1] - 2026-02-12

### Added — `run_code` tool (sandboxed JavaScript execution)

LLMs can now run JavaScript to verify calculations, transform data,
test regex patterns, or prototype logic instead of doing mental math.

**Sandbox security (`js/tools/eval-tools.js`):**
- Runs in `Function()` constructor — not `eval()`
- Blocked globals set to `undefined` inside sandbox: `window`, `self`,
  `globalThis`, `document`, `fetch`, `XMLHttpRequest`, `WebSocket`,
  `eval`, `Function`, `localStorage`, `sessionStorage`, `indexedDB`,
  `navigator`, `location`, `setTimeout`, `setInterval`, `Worker`,
  `alert`, `confirm`, `prompt`, `postMessage`, and more
- 3-second timeout via `Promise.race`
- Console capture: `console.log/warn/error/info` output returned in
  `console_output` field
- Max 100KB output to prevent memory bombs
- Last expression auto-returned (REPL-style) unless code contains
  explicit `return`

**System prompt:** Added to tool inventory — models know it exists for
math, string manipulation, data transforms, and logic validation.

**Tool count:** 41 → 42

## [0.9.24] - 2026-02-12

### Added — `search_replace` tool (text-based editing for all models)

Small and medium LLMs consistently fail with line-number-based editing
tools. They miscalculate line numbers, lose track after edits shift
lines, and confuse `start_line`/`end_line`/`after_line` parameters.
The new `search_replace` tool eliminates this entirely.

**How it works:** The model reads the file, copies the exact text it
wants to change (including whitespace/indentation), and provides the
replacement. No line numbers involved.

**Four explicit operations — no magic empty-string behavior:**
- `replace` — find exact text, swap with new text
- `delete` — find exact text, remove it entirely
- `insert_after` — find anchor text, add new content after it
- `insert_before` — find anchor text, add new content before it

**Uniqueness requirement:** The `find` text must match exactly once in
the file. If it matches multiple times, the tool returns an error with
the match count and asks the model to include more surrounding context.

**New files:**
- `js/tools/search-replace-tools.js` — tool definition + ensureFileActive
- `js/editor/instance.js` — new `replaceText()` function for character-
  offset find-and-replace through CodeMirror

**System prompt updated (`js/prompts.js`):**
- `search_replace` listed first in tool inventory
- Editing workflow rewritten: search_replace as PREFERRED approach,
  line-based tools as alternative "when you have confident line numbers"
- Efficiency rules updated: minimum edit path is now `read_file →
  search_replace`
- Line number drift warning explicitly notes "use search_replace to
  avoid this problem entirely"

**Cache handling (`js/chat/handlers.js`):**
- `search_replace`, `edit_file`, `write_file`, `delete_file` added to
  all three cache exclusion lists (bypass, invalidation, don't-cache).
  These were missing for `edit_file`/`write_file` since 0.9.21.

**Tool count:** 40 → 41

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
