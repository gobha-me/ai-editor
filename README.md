# AI Editor v0.7.3

A pure HTML/JS code editor with AI assistance, multi-provider Git integration, and a plugin system. Think Cursor / Windsurf, but runs entirely in the browser — no backend, no build step, no Electron.

## Features

### Core
- **Three-panel layout**: File browser (left), Code editor (center), AI chat (right)
- **CodeMirror 6**: Syntax highlighting for 15+ languages, loaded from CDN
- **Git Provider Abstraction**: Pluggable Git backends (Gitea built-in, extensible to GitHub/GitLab)
- **LLM Provider System**: Multi-provider support (Venice, OpenRouter, or any OpenAI-compatible API)
- **Auto-save drafts**: Changes saved to localStorage, manual commit to Git
- **Template-based HTML**: Modular UI loaded from `html/` partials
- **Containerized deployment**: Dockerfile + Kubernetes deployment manifest included

### Editor
- **Quick Open (Ctrl+P)**: Fuzzy file finder with ranked results, keyboard navigation, preview/pin support
- **Multi-tab editing**: Open multiple files simultaneously with tab management
- **Preview tabs**: Single-click opens preview (italic), double-click pins the tab
- **Preview pane**: Live-rendered preview for HTML, Markdown, and SVG files (Ctrl+Shift+P)
- **Diff pane**: Side-by-side view of original vs modified content with enhanced styling (Ctrl+Shift+D)
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
- LLM edits directly in buffer, you review before save
- **Chat history summarization**: Older messages compressed via lightweight model to stay within context limits
- **Chat export**: Export conversation history
- Issue analysis with **dependency detection** (parses "depends on #X")
- Context-aware (knows current file, project, branch, open tabs, project tree)
- **Embeddings support**: Client for embedding-based semantic search
- **LLM debug modal**: Inspect raw request/response exchanges for troubleshooting
- **Error logging**: Centralized error capture with UI modal

### Plugin System
- Manifest-based registration
- Hook system (beforeSend, afterResponse, onModelChange, etc.)
- UI slot injection via SlotManager
- See `plugins/venice-ai.js` for example

## Project Structure

```
ai-editor/
├── index.html                  # Main app shell (loads HTML partials)
├── Dockerfile                  # Container build (python http.server)
├── deployment.yaml             # Kubernetes deployment manifest
├── css/
│   ├── editor.css              # Primary styles
│   ├── diff-enhancements.css   # Diff viewer styling
│   └── search-panel.css        # Search panel styling
├── html/                       # UI partials (loaded by template-loader)
│   ├── header.html             # Top toolbar
│   ├── sidebar.html            # File tree & Git panels
│   ├── editor-panel.html       # Editor area + tabs
│   ├── chat-panel.html         # AI chat panel
│   ├── search-panel.html       # Search & replace UI
│   ├── modals.html             # Settings, commit, help modals
│   ├── settings-tabs.html      # Settings panel tabs
│   └── error-log-modal.html    # Error log viewer
├── js/
│   ├── app.js                  # Application bootstrap & init
│   ├── core.js                 # State, EventBus, Storage, Plugins, Roles
│   ├── version.js              # Version single source of truth
│   ├── editor.js               # CodeMirror 6 integration
│   ├── git.js                  # Git operations facade
│   ├── llm.js                  # LLM client, prompts, tool dispatch
│   ├── file-tree.js            # Sidebar file browser
│   ├── tab-manager.js          # Multi-tab management
│   ├── quick-open.js           # Fuzzy file finder (Ctrl+P)
│   ├── search-panel.js         # Search & replace UI logic
│   ├── diff-viewer.js          # Side-by-side diff rendering
│   ├── secondary-pane.js       # Preview/diff pane controller
│   ├── context-manager.js      # Project context for LLM
│   ├── model-manager.js        # LLM model listing & selection
│   ├── project-manager.js      # Project/repo management
│   ├── settings-manager.js     # Settings persistence & UI
│   ├── resize-manager.js       # Draggable panel resizing
│   ├── template-loader.js      # HTML partial loader
│   ├── slot-manager.js         # Plugin UI slot injection
│   ├── embeddings-client.js    # Embeddings API client
│   ├── error-logger.js         # Centralized error capture
│   ├── llm-debug-modal.js      # LLM request/response inspector
│   ├── ui-helpers.js           # Shared UI utilities
│   ├── retry.js                # Retry logic with backoff
│   ├── chat/                   # Chat subsystem (modular)
│   │   ├── index.js            # Chat initialization & orchestration
│   │   ├── state.js            # Chat state management
│   │   ├── messages.js         # Message rendering & history
│   │   ├── input.js            # Chat input handling
│   │   ├── handlers.js         # Message send/receive handlers
│   │   ├── tools.js            # Tool call execution in chat
│   │   ├── summarizer.js       # History compression
│   │   └── export.js           # Chat export functionality
│   ├── git-providers/          # Pluggable Git backends
│   │   ├── index.js            # Provider loader
│   │   ├── registry.js         # Provider registration
│   │   ├── base.js             # Base provider interface
│   │   └── gitea.js            # Gitea implementation
│   ├── providers/              # LLM provider configurations
│   │   ├── index.js            # Provider loader
│   │   ├── registry.js         # Provider registration
│   │   ├── venice.js           # Venice AI provider
│   │   └── openrouter.js       # OpenRouter provider
│   ├── tools/                  # LLM tool definitions
│   │   ├── registry.js         # Tool registry & lookup
│   │   ├── file-tools.js       # read_file, read_current_file, open_file, list_open_tabs
│   │   ├── edit-tools.js       # replace_lines, insert_lines, delete_lines, create_file, delete_file
│   │   ├── edit-tracker.js     # Track pending edits
│   │   ├── project-tools.js    # get_project_tree
│   │   ├── search-tools.js     # search_in_files
│   │   ├── scan-tools.js       # scan_file, read_function, read_lines, find_references
│   │   ├── context-tools.js    # Context-related tools
│   │   ├── issue-tools.js      # list_issues, read_issue, create_issue, update_issue, add_issue_comment
│   │   ├── pr-tools.js         # create_pull_request, list_pull_requests
│   │   └── scratchpad-tools.js # scratchpad_write, scratchpad_read, scratchpad_clear
│   ├── managers/
│   │   └── search-manager.js   # Project-wide search engine
│   └── workers/
│       └── search-worker.js    # Web Worker for search
├── plugins/
│   └── venice-ai.js            # Venice AI plugin (model pricing, etc.)
├── docs/                       # Design & reference docs
│   ├── TOOLS.md                # Tool system documentation
│   ├── ROLES_AND_TOOLS.md      # Role-based tool access
│   ├── scan-tools-guide.md     # Scan tools usage guide
│   ├── LLM_ERROR_RECOVERY.md   # Error recovery patterns
│   ├── FIX-ERROR-LOG-MODAL.md  # Error modal fix notes
│   └── DESIGN-git-providers-and-ui-extensions.md
├── swaggers/                   # API specifications
│   ├── gitea.json              # Gitea API spec
│   └── venice.yaml             # Venice API spec
└── .gitea/workflows/
    └── build-and-push.yaml     # CI/CD pipeline
```

## Configuration

1. Open Settings (⚙️ button or Ctrl+,)
2. Configure Git Provider:
   - **Provider**: Select your Git backend (Gitea, etc.)
   - **URL**: Your instance URL (e.g., `https://git.gobha.me`)
   - **Token**: API token from your Git provider's settings
3. Configure LLM:
   - **Provider**: Select LLM provider (Venice, OpenRouter, or Custom)
   - **Endpoint**: Auto-filled per provider, or custom OpenAI-compatible URL
   - **API Key**: Your API key
   - **Model**: Default model for chat
   - **Commit Model**: Optional separate model for commit message generation
   - **Summarizer Model**: Optional lightweight model for chat history compression

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

### Git Provider (Gitea)
- `/api/v1/user/repos` — List repositories
- `/api/v1/repos/{owner}/{repo}/contents/{path}` — File CRUD
- `/api/v1/repos/{owner}/{repo}/branches` — Branch management
- `/api/v1/repos/{owner}/{repo}/issues` — Issue tracking
- `/api/v1/repos/{owner}/{repo}/pulls` — Pull requests
- `/api/v1/repos/{owner}/{repo}/actions/runs` — Workflow runs (if Actions enabled)

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

The LLM is instructed to use surgical line-based edits rather than replacing entire files to prevent accidental data loss. See `docs/TOOLS.md` for full documentation.
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
        // Modify request before sending
        return data;
    },
    
    async afterResponse(data, instance) {
        // Process response
        return data;
    }
};

Plugins.register(MyPlugin);
export default MyPlugin;
```

## Changelog Highlights

- [x] Multi-tab editing (v0.2.0)
- [x] Preview tabs — single click opens preview, double click pins (v0.2.0)
- [x] LLM tools for file operations (v0.2.0)
- [x] Issue dependency parsing (v0.2.0)
- [x] Diff viewer for pending changes (v0.3.6)
- [x] Preview pane for HTML/Markdown/SVG (v0.3.6)
- [x] Line numbers toggle (v0.3.6)
- [x] Quick Open fuzzy file finder (v0.4.x)
- [x] Project-wide search & replace (v0.4.x)
- [x] PR creation workflow via LLM tools (v0.5.x)
- [x] Chat history summarization (v0.5.x)
- [x] Git provider abstraction layer (v0.6.x)
- [x] LLM provider system (Venice, OpenRouter) (v0.6.x)
- [x] Scan tools — `scan_file`, `read_function`, `find_references` (v0.7.x)
- [x] Scratchpad for persistent LLM notes (v0.7.x)
- [x] Embeddings client (v0.7.x)
- [x] Template-based HTML with partials (v0.7.x)
- [x] Error logging modal (v0.7.x)

## Future Enhancements

- [ ] Git blame / history view
- [ ] Collaborative editing (WebRTC?)
- [ ] Mobile responsive layout
- [ ] Offline support (Service Worker)
- [ ] Additional Git providers (GitHub, GitLab)

## Deployment

The app is a static site — no build step required. Serve it with any HTTP server.

```bash
# Docker
docker build -t ai-editor .
docker run -p 8080:8080 ai-editor

# Or just serve locally
python3 -m http.server 8080
```

A Kubernetes manifest is included in `deployment.yaml`.

## License

MIT