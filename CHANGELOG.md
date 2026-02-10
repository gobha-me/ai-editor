# Changelog

All notable changes to AI Editor are documented here.

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
