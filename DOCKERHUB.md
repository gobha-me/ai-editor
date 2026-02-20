# AI Editor

A browser-based code editor with integrated AI assistance. Multi-provider Git, multi-provider LLM, plugin system — no backend, no build step, no Electron.

Think Cursor / Windsurf, but it runs entirely in your browser and talks directly to your Git host.

## Quick Start

```bash
docker run -d -p 8080:8000 gobha/ai-editor
```

Open `http://localhost:8080`, press `Ctrl+,` to configure a Git connection and LLM provider. That's it.

## What's Inside

**Three-panel layout** — file browser, CodeMirror 6 editor, AI chat — with everything stored in your Git host. No database, no cloud sync, no accounts.

**52 AI tools** — The assistant reads, edits, creates, and deletes files; searches the project; manages issues and pull requests; handles cross-project reference; evaluates code; and builds plugins. It makes surgical line-based edits in your buffer — you review before committing.

**Multi-provider Git** — Gitea, GitHub, and GitLab. Multiple connections active simultaneously. Your self-hosted Gitea and your GitHub repos side by side.

**Multi-provider LLM** — Venice, OpenRouter, Ollama, or any OpenAI-compatible endpoint. Streaming, function calling, embeddings.

**Plugin system** — Manifest-based with lifecycle hooks, toolbar buttons, modal UI, LLM tool registration, CSS injection, and configurable settings. Write plugins in the built-in editor with AI assistance, or install from URL.

## Features

- CodeMirror 6 with syntax highlighting for 19 languages
- Quick Open (`Ctrl+P`) with fuzzy matching
- Multi-tab editing with preview/pin tabs
- Project-wide regex search & replace (Web Worker)
- Live preview for HTML, Markdown, SVG
- Side-by-side and unified diff views
- Git blame with commit-colored gutter and interactive history
- AI-generated commit messages
- Branch management with protected branch enforcement
- Pull request creation, review, and merge with CI/CD status
- Release manager with AI-generated release notes
- Issue management with triage mode
- Conversation persistence with history summarization
- Image/screenshot paste for vision models
- Download project/branch as zip
- Settings export/import with plugin state
- Gitignore-style ignore patterns for LLM tool scoping
- Resizable panels, mobile responsive layout
- Built-in plugin editor with hot-reload

## Configuration

All configuration happens in the browser UI via `Ctrl+,` (Settings).

### Git Connection

Click **+ Add Connection**, select a provider (Gitea / GitHub / GitLab), enter your instance URL and API token. See [REPOS.md](https://github.com/gobha-me/ai-editor/blob/main/REPOS.md) for minimum token permissions per provider.

### LLM Provider

| Setting | Description |
|---------|-------------|
| Provider | Venice, OpenRouter, Ollama, or Custom (any OpenAI-compatible) |
| Endpoint | Auto-filled per provider, or your custom URL |
| API Key | Your API key (not required for Ollama) |
| Model | Default model for chat |
| Commit Model | Optional: cheaper model for commit messages |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_PATH` | `/` | Serve the app from a sub-path (e.g. `/editor`, `/test`) |

### Multi-environment example

```bash
# Root path
docker run -d -p 80:8000 gobha/ai-editor

# Sub-path: /editor
docker run -d -p 80:8000 -e BASE_PATH=/editor gobha/ai-editor

# Multiple environments on one host
docker run -d -p 8001:8000 -e BASE_PATH=/dev gobha/ai-editor:dev
docker run -d -p 8002:8000 -e BASE_PATH=/test gobha/ai-editor:test
docker run -d -p 8003:8000 gobha/ai-editor:latest
```

## Tags

| Tag | Description |
|-----|-------------|
| `latest` | Stable release (tagged versions) |
| `vX.Y.Z` | Pinned release version |
| `test` | Pre-release (merged to main, not yet tagged) |
| `dev` | Development preview (PR builds) |

## Kubernetes

A Kubernetes deployment manifest is included in the repository (`k8s/deployment.yaml`) with Ingress definitions for 3-environment promotion (dev → test → production).

## Image Details

- **Base**: `nginx:1-alpine`
- **Architecture**: `linux/amd64`
- **Port**: `8000`
- **Size**: ~30MB
- **Runtime dependencies**: None — all vendor libraries (CodeMirror, marked, DOMPurify, JSZip, htmx) are bundled at build time. The container requires no internet access to serve the application.

## Links

- **Source**: [github.com/gobha-me/ai-editor](https://github.com/gobha-me/ai-editor)
- **Changelog**: [CHANGELOG.md](https://github.com/gobha-me/ai-editor/blob/main/CHANGELOG.md)
- **Plugin guide**: [docs/PLUGIN.md](https://github.com/gobha-me/ai-editor/blob/main/docs/PLUGIN.md)
- **License**: MIT

---

If you find AI Editor useful, [☕ buy me a coffee](https://buymeacoffee.com/jeffasmith).
