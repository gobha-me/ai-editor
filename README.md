# AI Editor

A browser-based code editor with integrated AI assistance. Multi-provider Git, multi-provider LLM, plugin system — no backend, no build step, no Electron.

**Think Cursor / Windsurf, but it runs entirely in your browser and talks directly to your Git host.**

## Quick Start

```bash
# Option 1: Docker
docker build -t ai-editor .
docker run -p 8080:8000 ai-editor

# Option 2: Any static file server
python3 -m http.server 8080
# or
npx serve .
```

Open `http://localhost:8080`, press **Ctrl+,** to open Settings, and configure a Git connection and LLM provider. See [REPOS.md](REPOS.md) for provider setup details.

## What It Does

**Three-panel layout** — file browser, CodeMirror 6 editor, AI chat — with everything stored in your Git host. No separate database, no cloud sync, no accounts.

**The AI assistant has 53 tools** for reading, editing, creating, and deleting files; searching the project; managing issues and pull requests; cross-project reference; code evaluation; and plugin development. It makes surgical line-based edits in your buffer — you review before committing.

**Multi-provider Git** — Gitea, GitHub, and GitLab connections, multiple active simultaneously. Your self-hosted Gitea and your GitHub repos side by side.

**Multi-provider LLM** — Venice, OpenRouter, Ollama, or any OpenAI-compatible endpoint. Streaming, function calling, embeddings. Ollama gets dedicated capability detection via `/api/show`.

**Active development** — semantic retrieval, git-tracked memory, cost dashboard, and an MCP bridge ship today; see [docs/ROADMAP.md](docs/ROADMAP.md) for the outcome-based product direction and [docs/SECURITY.md](docs/SECURITY.md) for the threat model.

**Plugin system** — manifest-based registration with lifecycle hooks, toolbar buttons, modal UI, LLM tool registration, CSS injection, and configurable settings. Write plugins in the built-in editor with AI assistance, or install from URL. See [docs/PLUGIN.md](docs/PLUGIN.md) and [docs/SECURITY.md](docs/SECURITY.md) for the threat model.

**Mobile responsive** — full mobile layout with bottom tab bar, swipe gestures, soft keyboard detection, and PWA support.

## Features

### Editor
- CodeMirror 6 with syntax highlighting for 19 languages (JS, TS, JSX, TSX, Python, Go, Rust, C, C++, Java, PHP, SQL, HTML, CSS, SCSS, JSON, XML, Markdown)
- Quick Open (Ctrl+P) with fuzzy matching
- Multi-tab editing with preview/pin tabs
- Project-wide search & replace with regex (Web Worker)
- Live preview for HTML, Markdown, SVG
- Side-by-side diff view with inline toggle
- Git blame with commit-colored gutter and file history
- Resizable panels with drag handles

### Git
- Full CRUD: create, rename, delete files and folders
- Branch management with protected branch enforcement
- AI-generated commit messages
- Pull request creation, review, and merge with CI/CD status polling
- Issue management with triage mode
- Release manager with AI-generated release notes
- Zip upload with batch commit (atomic)
- Download project/branch as zip

### AI Assistant
- 53 LLM tools organized by role (plus MCP-bridged tools when an MCP server is enabled)
- `scan_file` / `read_function` for token-efficient reads
- Cross-project reference (`peek_project_tree`, `peek_project_file`, `peek_read_lines`)
- Multi-file editing (`edit_file`, `write_file`) without manual open
- Image/screenshot paste for vision models
- Conversation persistence — switch between saved chats
- History summarization with prune/undo
- Scratchpad for persistent notes across summarization
- 5 built-in roles: Full Access, Coder, Project Manager, Reviewer, Plugin Developer
- Edit tracker (detects stale line numbers)
- LLM debug modal for inspecting raw requests
- Configurable ignore patterns (gitignore syntax) to scope what tools can discover

### Settings
- Settings export/import (JSON) including plugin state and user plugins
- Gitignore-style ignore patterns with per-project `.aieditorignore` override
- Semantic context indexing with configurable embedding provider

### Accessibility
- Full keyboard navigation for file tree, editor tabs, and settings
- ARIA roles, roving tabindex, aria-expanded sync
- Screen reader announcer
- `prefers-reduced-motion` support

### Mobile
- Bottom tab bar with panel switching (Files / Editor / Chat)
- Swipe gestures between panels
- Soft keyboard detection with layout adjustment
- Touch-friendly targets (≥44px)
- PWA meta tags for home screen install

### Plugins
- Lifecycle hooks: `beforeSend`, `afterResponse`, `onModelChange`, `resolveIssueConnection`
- Toolbar button and modal dialog registration
- `registerTool()` — add custom LLM tools
- `injectCSS()` / `removeCSS()` — scoped stylesheet injection
- Configurable settings with auto-generated UI from schema
- Built-in plugin editor with CodeMirror, hot-reload, and auto-role switching
- Install external plugins from URL via `window.AIEditor`
- Ships with: Venice AI, Venice Billing, OpenRouter Billing, Cross-Repo Issues, Release Sync

See [docs/PLUGIN.md](docs/PLUGIN.md) for the authoring guide and [docs/SECURITY.md](docs/SECURITY.md) for the supply-chain threat model.

## Configuration

Press **Ctrl+,** or click the ⚙️ button.

### 1. Git Connection (Connections tab)

Click **+ Add Connection**, select a provider (Gitea, GitHub, or GitLab), enter your instance URL and token.

See [REPOS.md](REPOS.md) for minimum token permissions per provider, setup walkthroughs, and what API access the editor requires.

### 2. LLM Provider (LLM tab)

| Setting | Description |
|---------|-------------|
| Provider | Venice, OpenRouter, Ollama, or Custom (any OpenAI-compatible) |
| Endpoint | Auto-filled per provider, or your custom URL |
| API Key | Your API key (not required for Ollama) |
| Model | Default model for chat |
| Commit Model | Optional cheaper model for commit messages |
| Summarizer Model | Optional lightweight model for chat compression |

### 3. Roles (Roles tab)

Roles control which tools the AI can access. Five built-in roles range from Full Access (all 53 tools) to Reviewer (read-only). The Plugin Developer role auto-activates when a plugin editor tab is open. Plugins can register additional roles via `Roles.register()`.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| F1 | Help / keyboard shortcuts |
| Ctrl+P | Quick Open |
| Ctrl+S | Commit dialog |
| Ctrl+B | Toggle sidebar |
| Ctrl+F | Search panel |
| Ctrl+, | Settings |
| Ctrl+Shift+P | Toggle preview pane |
| Ctrl+Shift+D | Toggle diff pane |
| Ctrl+Shift+B | Toggle blame / file history |
| Ctrl+Shift+L | Toggle line numbers |
| Ctrl+Shift+Z | Revert to last commit |
| Escape | Close modal / stop generation |
| Enter | Send chat message |
| Shift+Enter | New line in chat |

## Deployment

Static site served by nginx. No build step — the Dockerfile bundles vendor dependencies (CodeMirror, Preact + htm, marked, DOMPurify, JSZip, htmx) at build time. From 1.3.0, select new state-heavy surfaces (Memory tab first; later the active-tools chip row and the profile picker) are built with [Preact](https://preactjs.com/) + [htm](https://github.com/developit/htm) — loaded as a single ~5KB ESM bundle, no JSX, no build-time transform. Existing tabs, sidebar, file tree, editor frame, and chat stay vanilla.

### Docker

```bash
docker build -t ai-editor .
docker run -p 8080:8000 ai-editor
```

See [CONTAINERS.md](CONTAINERS.md) for locked build inputs and future GHCR
release coordinates.

### Multi-environment with BASE_PATH

```bash
docker run -p 80:8000 ai-editor                          # root
docker run -p 80:8000 -e BASE_PATH=/test ai-editor        # /test
docker run -p 80:8000 -e BASE_PATH=/dev ai-editor         # /dev
```

### Deployment authority

GitHub Actions validates pull requests and `main`; approved `vX.Y.Z` tags can
publish `ghcr.io/gobha-me/ai-editor:vX.Y.Z` and `latest`. No repository workflow
deploys the application. The existing `k8s/deployment.yaml` is a legacy,
non-authoritative reference pending a cluster-owned provenance, secrets,
environment-protection, health-check, and rollback contract.

### Local development

```bash
python3 -m http.server 8080
```

Vendor dependencies load from CDN fallback when not bundled locally.

## Project Structure

```
ai-editor/
├── index.html              # App shell (loads HTML partials)
├── Dockerfile              # Multi-stage build (vendor → nginx)
├── CONTAINERS.md           # Container build and publication policy
├── REPOS.md                # Git provider setup & permissions
├── CHANGELOG.md
├── css/                    # Design system (CSS variables, no build)
├── html/                   # UI partials (loaded by template-loader)
├── js/
│   ├── app.js              # Bootstrap and event wiring
│   ├── core.js             # State, EventBus, Storage, Plugins, Roles
│   ├── ignore.js           # Gitignore-style pattern engine
│   ├── chat/               # Chat subsystem (9 modules)
│   ├── editor/             # CodeMirror setup, blame, diff, preview
│   ├── git-providers/      # Gitea, GitHub, GitLab, local backends
│   ├── providers/          # LLM provider configs (Venice, OpenRouter, Ollama, generic)
│   ├── tools/              # 52 LLM tool definitions
│   ├── settings/           # Settings panel modules (6 files)
│   └── ...                 # Search, resize, managers, workers, etc.
├── plugins/                # 5 bundled plugins
├── tests/                  # Node and browser test suites
├── docs/                   # Architecture, tools, plugin guide, roadmap
└── k8s/                    # Legacy deployment reference (not automated)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full module map and data flow.

## Built With AI

The vast majority of this codebase was written by [Claude](https://www.anthropic.com/), Anthropic's AI assistant. The human ([Jeff Smith](https://github.com/gobha-me)) served as architect, engineer, and tester — setting direction, making architectural decisions, reviewing every change, and testing in the browser. Claude wrote the code.

This project was built over ~11 days of evening sessions through claude.ai's chat interface. The development process is documented in detail in [this Medium article](https://medium.com/@xcaliberalgo/i-built-a-30-000-line-code-editor-in-11-days-my-co-developer-was-an-ai-f2bef1b4ecc6).

We believe in transparency about AI-assisted development. This is how software is increasingly going to be built, and pretending otherwise does everyone a disservice.

## License

MIT
