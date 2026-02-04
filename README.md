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
- Full CRUD operations (create, rename, delete files)
- Branch management (create new branches, switch between them)
- Protected branch support (main requires branching)
- Commit with AI-generated messages

### AI Assistant
- Ask to edit, explain, or refactor code
- LLM edits directly in buffer, you review before save
- Issue analysis and implementation suggestions
- Context-aware (knows current file, project, branch)

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
| `Ctrl+S` | Open commit dialog |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+,` | Open settings |
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

- [ ] Multi-tab editing
- [ ] Diff viewer for pending changes
- [ ] PR creation workflow
- [ ] Tool/function calling for LLMs
- [ ] File search (fuzzy finder)
- [ ] Git blame/history view
- [ ] Collaborative editing (WebRTC?)
- [ ] Mobile responsive layout
- [ ] Offline support (Service Worker)

## License

MIT