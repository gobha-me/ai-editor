# Changelog

All notable changes to AI Editor are documented here.

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
