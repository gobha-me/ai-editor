# AI Editor

A browser-based code editor with integrated AI assistance. Multi-provider Git, multi-provider LLM, plugin system — no backend, no build step, no Electron.

**Think Cursor / Windsurf, but it runs entirely in your browser and talks directly to your Git host.**

## Quick Start

```bash
# Option 1: Docker
docker build -t ai-editor .
docker run -p 8080:80 ai-editor

# Option 2: Any static file server
python3 -m http.server 8080
# or
npx serve .
```

Open `http://localhost:8080`, press **Ctrl+,** to open Settings, and configure a Git connection and LLM provider. See [REPOS.md](REPOS.md) for provider setup details.

## What It Does

**Three-panel layout** — file browser, CodeMirror 6 editor, AI chat — with everything stored in your Git host. No separate database, no cloud sync, no accounts.

**The AI assistant has 25+ tools** for reading, editing, creating, and deleting files; searching the project; managing issues and pull requests; and cross-project reference. It makes surgical line-based edits in your buffer — you review before committing.

**Multi-provider Git** — Gitea, GitHub, and GitLab connections, multiple active simultaneously. Your self-hosted Gitea and your GitHub repos side by side.

**Multi-provider LLM** — Venice, OpenRouter, or any OpenAI-compatible endpoint. Streaming, function calling, embeddings.

**Plugin system** — manifest-based registration with lifecycle hooks, toolbar buttons, modal UI, and configurable settings. Install from URL or bundle locally. See [docs/PLUGIN.md](docs/PLUGIN.md).

## Features

### Editor
- CodeMirror 6 with syntax highlighting for 15+ languages
- Quick Open (Ctrl+P) with fuzzy matching
- Multi-tab editing with preview/pin tabs
- Project-wide search & replace with regex (Web Worker)
- Live preview for HTML, Markdown, SVG
- Side-by-side diff view with inline toggle
- Git blame with commit-colored gutter
- Resizable panels with drag handles

### Git
- Full CRUD: create, rename, delete files
- Branch management with protected branch enforcement
- AI-generated commit messages
- Pull request creation, review, and merge
- Issue management with triage mode
- CI/CD status polling in PR modal
- Zip upload with batch commit (atomic)

### AI Assistant
- 25+ LLM tools organized by category
- `scan_file` / `read_function` for token-efficient reads
- Cross-project reference (`peek_project_tree`, `peek_project_file`)
- Multi-file editing (`edit_file`, `write_file`) without manual open
- Image/screenshot paste for vision models
- Conversation persistence — switch between saved chats
- History summarization with prune/undo
- Scratchpad for persistent notes across summarization
- Role-based tool filtering
- Edit tracker (detects stale line numbers)
- LLM debug modal for inspecting raw requests

### Plugins
- Lifecycle hooks: `beforeSend`, `afterResponse`, `onModelChange`
- Toolbar button and modal registration
- Configurable settings with schema
- Install external plugins from URL
- Ships with: Venice AI, Venice Billing, OpenRouter Billing, Cross-Repo Issues

See [docs/PLUGIN.md](docs/PLUGIN.md) for the authoring guide.

## Configuration

Press **Ctrl+,** or click the ⚙️ button.

### 1. Git Connection (Connections tab)

Click **+ Add Connection**, select a provider, enter your instance URL and token.

See [REPOS.md](REPOS.md) for minimum token permissions per provider, setup walkthroughs, and what API access the editor requires.

### 2. LLM Provider (LLM tab)

| Setting | Description |
|---------|-------------|
| Provider | Venice, OpenRouter, or Custom (any OpenAI-compatible) |
| Endpoint | Auto-filled per provider, or your custom URL |
| API Key | Your API key |
| Model | Default model for chat |
| Commit Model | Optional cheaper model for commit messages |
| Summarizer Model | Optional lightweight model for chat compression |

### 3. Roles (Roles tab)

Roles control which tools the AI can access. The default role exposes all tools. Create restricted roles for read-only or code-only workflows.

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
| Ctrl+Shift+L | Toggle line numbers |
| Ctrl+Shift+Z | Revert to last commit |
| Escape | Close modal / stop generation |
| Enter | Send chat message |
| Shift+Enter | New line in chat |

## Deployment

Static site served by nginx. No build step — the Dockerfile bundles vendor dependencies (CodeMirror, marked, DOMPurify) at build time.

### Docker

```bash
docker build -t ai-editor .
docker run -p 8080:80 ai-editor
```

### Multi-environment with BASE_PATH

```bash
docker run -p 80:80 ai-editor                          # root
docker run -p 80:80 -e BASE_PATH=/test ai-editor        # /test
docker run -p 80:80 -e BASE_PATH=/dev ai-editor         # /dev
```

### Kubernetes

Deployment manifest included (`deployment.yaml`). The CI/CD pipeline automates:

| Trigger | Image tag | BASE_PATH |
|---------|-----------|-----------|
| PR opened/synced | `:dev` | `/dev` |
| Push to main | `:test` | `/test` |
| Tag `v*` | `:latest` + `:vX.Y.Z` | `/` |

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
├── REPOS.md                # Git provider setup & permissions
├── CHANGELOG.md
├── css/                    # Design system (CSS variables, no build)
├── html/                   # UI partials (loaded by template-loader)
├── js/
│   ├── app.js              # Bootstrap
│   ├── core.js             # State, EventBus, Storage, Plugins, Roles
│   ├── chat/               # Chat subsystem (8 modules)
│   ├── git-providers/      # Gitea, GitHub, GitLab backends
│   ├── providers/          # LLM provider configs
│   ├── tools/              # 25+ LLM tool definitions
│   ├── settings/           # Settings panel modules
│   └── ...                 # Editor, search, diff, resize, etc.
├── plugins/                # Bundled plugins
├── docs/                   # Architecture, tools, plugin guide
└── .gitea/workflows/       # CI/CD pipeline
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full module map and data flow.

## License

MIT
