# AI Editor

A browser-based code editor with AI assistance, multi-provider Git integration, and a plugin system. Think Cursor / Windsurf, but runs entirely in the browser — no backend, no build step, no Electron.

## Features

### Core
- **Three-panel layout**: File browser (left), Code editor (center), AI chat (right)
- **CodeMirror 6**: Syntax highlighting for 15+ languages, loaded from CDN
- **Multi-provider Git**: Gitea, GitHub, and GitLab — multiple connections simultaneously
- **Multi-provider LLM**: Venice, OpenRouter, or any OpenAI-compatible API
- **Auto-save drafts**: Changes saved to localStorage, manual commit to Git
- **Template-based HTML**: Modular UI loaded from `html/` partials
- **Containerized deployment**: nginx + Docker with runtime-configurable `BASE_PATH` for multi-environment hosting

### Editor
- **Quick Open (Ctrl+P)**: Fuzzy file finder with ranked results, keyboard navigation, preview/pin support
- **Multi-tab editing**: Open multiple files simultaneously with tab management
- **Preview tabs**: Single-click opens preview (italic), double-click pins the tab
- **Preview pane**: Resizable live preview for HTML, Markdown, and SVG files (Ctrl+Shift+P) with fullscreen toggle
- **Diff pane**: Side-by-side or inline view of original vs modified content (Ctrl+Shift+D)
- **Search & Replace**: Project-wide search with regex support, replace, and Web Worker for performance
- **Line numbers toggle**: Show/hide line numbers via toolbar or settings (Ctrl+Shift+L)
- Full CRUD operations (create, rename, delete files)
- Branch management (create new branches, switch between them)
- Protected branch support (main requires branching)
- Commit with AI-generated messages
- Resizable panels with drag handles

### AI Assistant
- Ask to edit, explain, or refactor code
- **20+ LLM Tools**: AI can read/edit/create/delete files, search the project, manage issues, create PRs, and more
- **Scan tools**: `scan_file` for file outlines, `read_function` for targeted reads (saves tokens)
- **Scratchpad**: Persistent key-value notes that survive chat summarization
- **Role-based tool filtering**: Different roles expose different tool sets
- **Edit Tracker**: Detects stale line numbers after edits to prevent LLM targeting errors
- LLM edits directly in buffer, you review before save
- **Chat history summarization**: Older messages pruned and compressed with one-query undo window
- **Chat export**: Export conversation history as Markdown or JSON
- **Issue triage mode**: Focus an issue in the chat pane for LLM-assisted review with quick actions (accept, deny, comment, start work)
- Context-aware (knows current file, project, branch, open tabs, project tree)
- **Embeddings support**: Client for embedding-based semantic search
- **LLM debug modal**: Inspect raw request/response exchanges for troubleshooting
- **Error logging**: Centralized error capture with UI modal

### Plugin System
- Manifest-based registration with lifecycle hooks
- Hook system (beforeSend, afterResponse, onModelChange, etc.)
- UI slot injection via SlotManager
- Included plugins: Venice AI (model pricing/info), Venice Billing (usage dashboard), Cross-Repo Issues

### Accessibility
- Modal focus trapping with previous-focus restoration
- Arrow key navigation for file tree (expand/collapse directories, open files)
- Arrow key navigation for editor tabs
- Settings tab keyboard navigation
- ARIA roles and labels on interactive elements
- Screen reader announcements for dynamic content

## Project Structure

```
ai-editor/
├── index.html                  # Main app shell (loads HTML partials)
├── Dockerfile                  # Multi-stage build (node vendor → nginx)
├── docker-entrypoint.sh        # Runtime BASE_PATH → nginx config generation
├── nginx.conf.template         # nginx template with envsubst placeholders
├── deployment.yaml             # Kubernetes deployment manifest
├── CHANGELOG.md
├── css/
│   ├── base.css                # CSS variables, resets, typography
│   ├── editor.css              # Editor panel, tabs, toolbar
│   ├── chat.css                # Chat panel, messages, streaming
│   ├── components.css          # Buttons, forms, toasts, badges
│   ├── modals.css              # Modal overlays and dialogs
│   └── sidebar.css             # File tree and sidebar panels
├── html/                       # UI partials (loaded by template-loader)
│   ├── header.html             # Top toolbar
│   ├── sidebar.html            # File tree, issues, PRs panels
│   ├── editor-panel.html       # Editor area + tabs
│   ├── chat-panel.html         # AI chat panel
│   ├── search-panel.html       # Search & replace UI
│   ├── modals.html             # All modal dialogs
│   ├── settings-tabs.html      # Settings panel tab content
│   └── error-log-modal.html    # Error log viewer
├── js/
│   ├── app.js                  # Application bootstrap & init
│   ├── core.js                 # State, EventBus, Storage, Plugins, Roles
│   ├── version.js              # Version single source of truth
│   ├── accessibility.js        # Focus trapping, keyboard nav, ARIA
│   ├── editor.js               # CodeMirror 6 integration
│   ├── git.js                  # Git operations facade
│   ├── llm.js                  # LLM client, prompts, tool dispatch
│   ├── file-tree.js            # Sidebar file browser
│   ├── tab-manager.js          # Multi-tab management
│   ├── quick-open.js           # Fuzzy file finder (Ctrl+P)
│   ├── search-panel.js         # Search & replace UI logic
│   ├── diff-viewer.js          # Side-by-side diff rendering
│   ├── secondary-pane.js       # Preview/diff pane controller
│   ├── resize-manager.js       # Draggable panel resizing
│   ├── context-manager.js      # Project context for LLM
│   ├── model-manager.js        # LLM model listing, selection, balance polling
│   ├── project-manager.js      # Project/repo management, issue/PR rendering
│   ├── settings-manager.js     # Settings orchestration (delegates to settings/)
│   ├── template-loader.js      # HTML partial loader
│   ├── embeddings-client.js    # Embeddings API client
│   ├── error-logger.js         # Centralized error capture
│   ├── llm-debug-modal.js      # LLM request/response inspector
│   ├── favicon-manager.js      # Dynamic favicon (loading/error states)
│   ├── ui-helpers.js           # Shared UI utilities
│   ├── retry.js                # Retry logic with backoff
│   ├── zip-upload.js           # Zip file import/export
│   ├── chat/                   # Chat subsystem
│   │   ├── index.js            # Chat initialization & event wiring
│   │   ├── state.js            # Chat-specific state
│   │   ├── messages.js         # Message rendering & history management
│   │   ├── input.js            # Chat input handling
│   │   ├── handlers.js         # Request routing & tool loop orchestration
│   │   ├── tools.js            # Tool call execution bridge
│   │   ├── summarizer.js       # History compression with prune/stash/undo
│   │   └── export.js           # Chat export (Markdown/JSON)
│   ├── git-providers/          # Pluggable Git backends
│   │   ├── index.js            # Provider auto-discovery & loader
│   │   ├── registry.js         # Provider registration
│   │   ├── base.js             # Base provider interface (abstract)
│   │   ├── gitea.js            # Gitea provider
│   │   ├── github.js           # GitHub provider
│   │   └── gitlab.js           # GitLab provider
│   ├── providers/              # LLM provider configurations
│   │   ├── index.js            # Provider loader
│   │   ├── registry.js         # Provider registration
│   │   ├── venice.js           # Venice AI provider (balance tracking, DIEM)
│   │   └── openrouter.js       # OpenRouter provider
│   ├── settings/               # Settings module (split from monolith)
│   │   ├── persistence.js      # Load/save/validation layer
│   │   ├── connections-tab.js  # Git connection management UI
│   │   ├── llm-tab.js          # LLM configuration UI
│   │   ├── models-tab.js       # Model selection & pricing UI
│   │   ├── roles-tab.js        # Role-based tool filtering UI
│   │   └── plugins-tab.js      # Plugin management UI
│   ├── tools/                  # LLM tool definitions
│   │   ├── registry.js         # Tool registry & lookup
│   │   ├── file-tools.js       # read_file, read_current_file, open_file, list_open_tabs
│   │   ├── edit-tools.js       # replace_lines, insert_lines, delete_lines, create_file, delete_file
│   │   ├── edit-tracker.js     # Stale line number detection
│   │   ├── project-tools.js    # get_project_tree
│   │   ├── search-tools.js     # search_in_files
│   │   ├── scan-tools.js       # scan_file, read_function, read_lines, find_references
│   │   ├── context-tools.js    # Context-related tools
│   │   ├── issue-tools.js      # list_issues, read_issue, create_issue, update_issue, add_issue_comment
│   │   ├── pr-tools.js         # create_pull_request, list_pull_requests
│   │   └── scratchpad-tools.js # scratchpad_write, scratchpad_read, scratchpad_clear
│   ├── managers/
│   │   └── search-manager.js   # Project-wide search engine
│   ├── utils/
│   │   └── html.js             # HTML/attribute escaping utilities
│   └── workers/
│       └── search-worker.js    # Web Worker for search indexing
├── plugins/
│   ├── venice-ai.js            # Venice AI model info & pricing
│   ├── venice-billing.js       # Venice usage dashboard with day picker
│   └── openrouter-billing.js   # OpenRouter usage dashboard (uses configured API key)
│   └── cross-repo-issues.js    # Cross-repository issue aggregation
├── docs/
│   ├── TOOLS.md                # Tool system documentation
│   ├── ROLES_AND_TOOLS.md      # Role-based tool access
│   ├── scan-tools-guide.md     # Scan tools usage guide
│   ├── LLM_ERROR_RECOVERY.md   # Error recovery patterns
│   └── DESIGN-git-providers-and-ui-extensions.md
├── swaggers/                   # API specifications (reference)
│   ├── gitea.json
│   └── venice.yaml
├── assets/
│   └── favicon.svg
└── .gitea/workflows/
    └── ci.yaml                 # CI/CD pipeline (dev/test/prod)
```

## Configuration

1. Open Settings (⚙️ button or Ctrl+,)

2. **Add a Git Connection** (Connections tab):
   - Click **+ Add Connection**
   - Select provider: **Gitea**, **GitHub**, or **GitLab**
   - Enter the instance URL and API token
   - Multiple connections can be active simultaneously (e.g., Gitea homelab + GitHub public repos)

   | Provider | Token source | Scopes needed |
   |----------|-------------|---------------|
   | Gitea | Settings → Applications → Generate Token | `repo`, `issue`, `package` |
   | GitHub | Settings → Developer Settings → Personal Access Tokens | `repo`, `read:org` |
   | GitLab | Preferences → Access Tokens | `api` |

3. **Configure LLM** (LLM tab):
   - **Provider**: Select LLM provider (Venice, OpenRouter, or Custom)
   - **Endpoint**: Auto-filled per provider, or custom OpenAI-compatible URL
   - **API Key**: Your API key
   - **Model**: Default model for chat
   - **Commit Model**: Optional separate model for commit message generation (cheaper/faster)
   - **Summarizer Model**: Optional lightweight model for chat history compression

4. **Roles** (Roles tab):
   - Select a role to control which tools the LLM has access to
   - Default role exposes all tools; restricted roles can limit to read-only or code-only operations

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+P` | Quick Open file finder |
| `Ctrl+S` | Open commit dialog |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+F` | Open search panel |
| `Ctrl+,` | Open settings |
| `Ctrl+Shift+P` | Toggle Preview pane |
| `Ctrl+Shift+D` | Toggle Diff pane |
| `Ctrl+Shift+L` | Toggle line numbers |
| `Ctrl+Shift+Z` | Revert file to last commit |
| `Escape` | Close modals / Stop generation |
| `Enter` | Send chat message |
| `Shift+Enter` | New line in chat |

## API Requirements

### Git Providers

All three providers use their respective REST APIs through a common abstraction layer (`js/git-providers/base.js`). The editor calls the same operations regardless of provider.

**Common operations used**: list repos, list/create branches, get/put/delete file contents, list/create/update issues, list/create pull requests, list workflow runs (if CI available).

### LLM (OpenAI-compatible)
- `GET /models` — List available models
- `POST /chat/completions` — Chat completion (streaming supported)
- `POST /embeddings` — Embeddings (optional, for semantic search)

### LLM Tools (Function Calling)

The AI assistant has access to **20+ tools** organized by category. Tools are defined in `js/tools/` and filtered per role.

| Category | Tools |
|----------|-------|
| **File reading** | `read_current_file`, `read_file`, `open_file`, `list_open_tabs` |
| **File editing** | `replace_lines`, `insert_lines`, `delete_lines`, `create_file`, `delete_file` |
| **Code intelligence** | `scan_file`, `read_function`, `read_lines`, `find_references` |
| **Project** | `get_project_tree`, `search_in_files` |
| **Issues** | `list_issues`, `read_issue`, `create_issue`, `update_issue`, `add_issue_comment` |
| **Pull requests** | `create_pull_request`, `list_pull_requests` |
| **Scratchpad** | `scratchpad_write`, `scratchpad_read`, `scratchpad_clear` |

The LLM is instructed to use surgical line-based edits rather than replacing entire files. The Edit Tracker detects when the LLM attempts to use stale line numbers after prior edits and forces a re-read. See `docs/TOOLS.md` for full documentation.

## Deployment

The app is a static site served by nginx. No build step required — the Dockerfile handles vendor dependency bundling at build time.

### Docker (single instance)

```bash
docker build -t ai-editor .
docker run -p 8080:80 ai-editor
```

### Multi-environment with BASE_PATH

The container accepts a `BASE_PATH` environment variable to serve from a sub-path. The entrypoint script generates the nginx config at startup from `nginx.conf.template`.

```bash
# Production (root)
docker run -p 80:80 ai-editor

# Test environment at /test
docker run -p 80:80 -e BASE_PATH=/test ai-editor

# Dev environment at /dev
docker run -p 80:80 -e BASE_PATH=/dev ai-editor
```

### Kubernetes

A deployment manifest is included in `deployment.yaml`. The CI/CD pipeline (`.gitea/workflows/ci.yaml`) automates the full flow:

| Trigger | Image tag | Deployment | BASE_PATH |
|---------|-----------|------------|-----------|
| PR opened/synced | `:dev` | `ai-editor-dev` | `/dev` |
| Push to main | `:test` | `ai-editor-test` | `/test` |
| Tag `v*` | `:latest` + `:vX.Y.Z` | `ai-editor` | `/` |

### Local development

```bash
# Serve directly — no container needed
python3 -m http.server 8080
# or
npx serve .
```

Note: Local development serves from `/` without BASE_PATH rewriting. Vendor dependencies must be pre-built (`cd vendor && npm install`) or the CDN fallback paths in `index.html` will be used.

## Plugin Development

```javascript
// plugins/my-plugin.js
import { EventBus, State, Plugins } from '../js/core.js';

const MyPlugin = {
    id: 'my-plugin',
    name: 'My Plugin',
    version: '1.0.0',

    hooks: ['beforeSend', 'afterResponse'],

    async init() {
        // Called when plugin loads
        return { /* instance data */ };
    },

    async beforeSend(data, instance) {
        // Modify request before sending to LLM
        return data;
    },

    async afterResponse(data, instance) {
        // Process LLM response
        return data;
    }
};

Plugins.register(MyPlugin);
export default MyPlugin;
```

Plugins are registered in Settings → Plugins. See `plugins/venice-ai.js` for a minimal example, `plugins/venice-billing.js` for a full-featured plugin with UI slot injection, and `plugins/openrouter-billing.js` for a plugin that reads the configured LLM settings directly. Billing plugins default to off — enable them in the Plugins tab.

## Future Enhancements

- [ ] Git blame / history view
- [x] LLM commit tool — `commit_files` and `list_dirty_files` (v0.9.8)
- [x] LLM project switching — `list_projects` and `set_active_project` (v0.9.8-4)
- [x] New Project button — create repos from the UI (v0.9.8-4)
- [ ] IndexedDB draft storage (replace localStorage) — use Settings → Storage tab to monitor usage
- [x] CI/CD status polling in PR modal (v0.9.6)
- [ ] Mobile responsive layout
- [ ] Offline support (Service Worker)

## License

MIT
