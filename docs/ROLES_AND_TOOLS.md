# Roles and Tools

Role-based access control for the 52 LLM tools. Tools declare their allowed roles at registration time; the registry filters tools per active role and enforces access at execution time.

For tool descriptions and examples, see [TOOLS.md](TOOLS.md).

---

## Built-in roles

Five roles ship with the editor (`BUILTIN_ROLES` in `js/core.js`). Plugins can register more via `Roles.register()`.

### 🔓 Full Access (`full`)
All tools enabled. Bypasses role filtering entirely (`ToolRegistry.checkRoleAccess` short-circuits for `full`). Use for development and unrestricted assistance.

### 💻 Coder (`coder`)
Read/edit/create code, search, navigate, read issues for context, commit dirty tabs, run sandboxed JS. Cannot create or update issues.

### 📋 Project Manager (`pm`)
Read code for context; full issue lifecycle (create, update, comment); can comment on PRs and merge. Cannot edit code.

### 🔍 Reviewer (`reviewer`)
Read-only code access; can comment on issues and PRs and merge. Cannot create issues or edit code.

### 🧩 Plugin Developer (`plugin-dev`)
Plugin editor tools (`read_plugin_source`, `write_plugin_source`, `run_plugin`, `list_user_plugins`) plus all read-only file/search/scratchpad tools and `read_docs`. **Auto-activates** when a plugin editor tab becomes active and restores the previous role on switch-away. Cannot edit project files, create files, or commit.

---

## Tool access matrix

The matrix below reflects the actual `roles` field on every `registry.register()` call (52 tools). `'all'` means any role; `'full'` always wins.

### File reads — `'all'`
`read_current_file`, `read_file`, `open_file`, `list_open_tabs`, `read_lines`, `scan_file`, `read_function`, `find_references`, `search_in_files`, `get_project_tree`, `list_projects`, `set_active_project`

### Cross-project peek — `'all'`
`peek_project_tree`, `peek_project_file`, `peek_read_lines`

### Cursor navigation — `'all'`
`goto_line`, `select_range`

### Scratchpad — `'all'`
`scratchpad_write`, `scratchpad_read`, `scratchpad_clear`

### Issue read — `'all'`
`list_issues`, `read_issue`

### PR read & CI — `'all'`
`list_pull_requests`, `read_pull_request`, `get_ci_status`, `get_ci_logs`

### Embeddings — varies
- `get_embeddings_status` — `'all'`
- `find_relevant_files` — `full`, `coder`, `reviewer`
- `index_project` — `full`, `coder`

### Code editing — `coder`
`replace_lines`, `insert_lines`, `delete_lines`, `replace_selection`, `insert_at_cursor`, `edit_file`, `write_file`, `create_file`, `delete_file`, `commit_files`, `list_dirty_files`, `run_code`

### Issue management — `pm` (+ `reviewer` for comment)
- `create_issue`, `update_issue` — `pm`
- `add_issue_comment` — `pm`, `reviewer`

### PR management
- `create_pull_request` — `coder`, `pm`
- `add_pr_review` — `reviewer`, `coder`, `pm`
- `merge_pull_request` — `coder`, `pm`, `reviewer`

### Plugin editor — `plugin-dev`
`read_plugin_source`, `write_plugin_source`, `run_plugin`, `list_user_plugins`

### Documentation — `plugin-dev`, `full`
`read_docs`

---

## Tool counts per role

Approximate effective tool count when a role is active:

| Role | Effective tools | Versus Full |
|---|---|---|
| **Full** | 52 (all) | baseline |
| **Coder** | 36 | ~30% fewer |
| **PM** | 28 | ~45% fewer |
| **Reviewer** | 27 | ~48% fewer |
| **Plugin Developer** | ~22 | ~58% fewer (specialized scope) |

Fewer tools = smaller `tools[]` array sent to the LLM = lower input cost and faster response. Switch roles when the task narrows.

---

## Adding a new tool

```javascript
registry.register('my_new_tool', async (args) => {
    // handler
}, {
    type: 'function',
    function: {
        name: 'my_new_tool',
        description: '...',
        parameters: { type: 'object', properties: { ... }, required: [] }
    },
    roles: 'all'  // or ['coder', 'pm']
});
```

**`roles` is required** — the registry throws on missing or invalid role IDs at registration time.

### Choosing a role

| Use | Rule |
|---|---|
| `'all'` | Pure reads or navigation with no side effects |
| `['coder']` | Mutates the workspace (file, buffer, sandboxed code) |
| `['pm']` | Issue creation/update or project-management actions |
| `['pm', 'reviewer']` | Comments / non-destructive feedback |
| `['coder', 'pm']` | Cross-cutting workflow actions (e.g. PR creation) |
| `['plugin-dev']` | Plugin editor introspection or hot-reload |

---

## Adding a new role

```javascript
import { Roles } from './core.js';

Roles.register({
    id: 'security-auditor',
    name: 'Security Auditor',
    icon: '🛡️',
    description: 'Read-only access with security scanning tools',
    systemPrompt: `Optional role-specific system prompt fragment...`
});
```

Tools then reference the role in their `roles` array. Plugins can register roles at init time.

---

## Validation

The registry performs strict validation at tool registration:

1. Missing `roles` field → throws
2. Invalid role ID (typo, unregistered) → throws
3. Wrong type (not `'all'` or array) → throws

Errors fire at app startup, not at runtime, so role typos are caught before users see them.

---

## Future Enhancements

Carried over from PLAN.md — not committed, captured for reference.

- User-defined roles via settings UI (`Roles.register()` exists; UI does not)
- Role inheritance (e.g., `pm` extends `reviewer`)
- Per-project role overrides
- Audit log of role-based tool access
- Per-tool enable/disable UI in settings
