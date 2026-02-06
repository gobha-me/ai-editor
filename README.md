# AI Editor

A pure HTML/JS code editor with AI assistance, Gitea integration, and a plugin system. Think Claude Code / Cursor, but runs entirely in the browser.

## Features

### Core
- **Three-panel layout**: File browser (left), Code editor (center), AI chat (right)
- **CodeMirror 6**: Syntax highlighting for 15+ languages, loaded from CDN (~50KB)
- **Gitea Integration**: Browse repos, branches, files, issues, workflow runs
- **LLM Integration**: OpenAI-compatible API for code editing assistance
- **Auto-save drafts**: Changes saved to localStorage, manual commit to Gitea

### Editor
- **Quick Open (Ctrl+P)**: Fuzzy file finder with ranked results, keyboard navigation, preview/pin support
- **Multi-tab editing**: Open multiple files simultaneously
- **Preview tabs**: Single-click opens preview (italic), double-click pins the tab
- **Preview pane**: Live-rendered preview for HTML, Markdown, and SVG files (Ctrl+Shift+P)
- **Diff pane**: Side-by-side view of original vs modified content (Ctrl+Shift+D)
- **Line numbers toggle**: Show/hide line numbers via toolbar or settings (Ctrl+Shift+L)
- Full CRUD operations (create, rename, delete files)
- Branch management (create new branches, switch between them)
- Protected branch support (main requires branching)
- Commit with AI-generated messages

### AI Assistant
- Ask to edit, explain, or refactor code
- **LLM Tools**: AI can directly read/edit files and navigate the project
- LLM edits directly in buffer, you review before save
- **Chat history summarization**: Older messages compressed via lightweight model to stay within context limits
- Issue analysis with **dependency detection** (parses "depends on #X")
- Context-aware (knows current file, project, branch, open tabs)

### Plugin System
- Manifest-based registration
- Hook system (beforeSend, afterResponse, onModelChange, etc.)
- UI slot injection
- See `plugins/venice-ai.js` for example

## Project Structure

```
ai-editor/
├── index.html          # Main app shell
├── css/
│   └── editor.css      # All styles
├── js/
│   ├── core.js         # State, EventBus, Storage, Plugins
│   ├── gitea.js        # Gitea API client
│   ├── llm.js          # LLM API client + prompts
│   ├── editor.js       # CodeMirror integration
│   └── chat.js         # Chat pane logic
└── plugins/
    └── venice-ai.js    # Example plugin
```

## Configuration

1. Open Settings (⚙️ button or Ctrl+,)
2. Configure Gitea:
   - **URL**: Your Gitea instance (e.g., `https://git.gobha.me`)
   - **Token**: API token from Gitea Settings → Applications
3. Configure LLM:
   - **Endpoint**: OpenAI-compatible API (e.g., `https://api.venice.ai/api/v1`)
   - **API Key**: Your API key
   - **Model**: Default model to use

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+P` | Quick Open file finder |
| `Ctrl+S` | Open commit dialog |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+,` | Open settings |
| `Ctrl+Shift+P` | Toggle Preview pane |
| `Ctrl+Shift+D` | Toggle Diff pane |
| `Ctrl+Shift+L` | Toggle line numbers |
| `Ctrl+Shift+Z` | Revert file to last commit |
| `Escape` | Close modals / Stop generation |
| `Enter` | Send chat message |
| `Shift+Enter` | New line in chat |

## API Requirements

### Gitea
- `/api/v1/user/repos` - List repositories
- `/api/v1/repos/{owner}/{repo}/contents/{path}` - File CRUD
- `/api/v1/repos/{owner}/{repo}/branches` - Branch management
- `/api/v1/repos/{owner}/{repo}/issues` - Issue tracking
- `/api/v1/repos/{owner}/{repo}/actions/runs` - Workflow runs (if Actions enabled)

### LLM (OpenAI-compatible)
- `GET /models` - List available models
- `POST /chat/completions` - Chat completion (streaming supported)

### LLM Tools (Function Calling)
The AI assistant has access to these tools for direct file operations:
- `read_current_file` - Read the active file in the editor (returns content + line count)
- `replace_lines` - Replace specific lines (safer than full file replacement)
- `insert_lines` - Insert new lines at a position
- `delete_lines` - Delete specific lines
- `get_project_tree` - Query the project's file structure
- `open_file` - Open a specific file in the editor
- `read_file` - Read any file without opening it
- `list_open_tabs` - List all currently open tabs

**Note:** The LLM is instructed to use surgical line-based edits rather than replacing entire files to prevent accidental data loss.

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

## Future Enhancements

- [x] Multi-tab editing (v0.2.0)
- [x] Preview tabs - single click opens preview, double click pins (v0.2.0)
- [x] LLM tools for file operations (v0.2.0)
- [x] Issue dependency parsing (v0.2.0)
- [x] Diff viewer for pending changes (v0.3.6)
- [x] Preview pane for HTML/Markdown/SVG (v0.3.6)
- [x] Line numbers toggle (v0.3.6)
- [ ] PR creation workflow
- [ ] File search (fuzzy finder)
- [ ] Git blame/history view
- [ ] Collaborative editing (WebRTC?)
- [ ] Mobile responsive layout
- [ ] Offline support (Service Worker)

## License

MIT