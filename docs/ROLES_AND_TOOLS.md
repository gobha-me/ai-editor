# Roles and Tools

This document describes the role-based access control system for LLM tools in AI Editor.

## Overview

Tools explicitly declare which roles can access them via the `roles` field at registration time. The registry validates role references and filters tools based on the active role.

## Role Definitions

### 🔓 Full Access (`full`)
**Description:** All tools enabled. Maximum capability, highest token overhead.

**Tool Count:** All tools (19+)

**Use Case:** Development, debugging, unrestricted AI assistance

---

### 💻 Coder (`coder`)
**Description:** Read/edit/create code, search the codebase, navigate project tree, read issues for context. No issue creation.

**Allowed Tools:**
- **File Operations (Read):** read_current_file, read_file, read_lines, open_file, list_open_tabs
- **File Operations (Write):** replace_lines, insert_lines, delete_lines, create_file
- **Project Navigation:** get_project_tree, scan_file, read_function, find_references
- **Search:** search_in_files
- **Issues (Read-Only):** list_issues, read_issue

**Restricted:**
- Cannot create or update issues
- Cannot comment on issues

**Use Case:** Code implementation, refactoring, bug fixes

---

### 📋 Project Manager (`pm`)
**Description:** Create/manage issues, search and read code for context. No code editing.

**Allowed Tools:**
- **File Operations (Read):** read_current_file, read_file, read_lines, open_file, list_open_tabs
- **Project Navigation (Read):** get_project_tree, scan_file, read_function, find_references
- **Search:** search_in_files
- **Issues (Full Access):** list_issues, read_issue, create_issue, update_issue, add_issue_comment

**Restricted:**
- Cannot edit code (no replace_lines, insert_lines, delete_lines)
- Cannot create files

**Use Case:** Issue management, project planning, code review coordination

---

### 🔍 Reviewer (`reviewer`)
**Description:** Read-only code access with search, can comment on issues. No code editing or issue creation.

**Allowed Tools:**
- **File Operations (Read):** read_current_file, read_file, read_lines, open_file, list_open_tabs
- **Project Navigation (Read):** get_project_tree, scan_file, read_function, find_references
- **Search:** search_in_files
- **Issues (Read + Comment):** list_issues, read_issue, add_issue_comment

**Restricted:**
- Cannot edit code
- Cannot create files
- Cannot create or update issues (only comment)

**Use Case:** Code review, security audits, documentation review

---

### 🧩 Plugin Developer (`plugin-dev`)
**Description:** Plugin editor tools (read/write/run plugin source) plus read-only code access and SDK reference. Auto-activated when a plugin editor tab is open.

**Allowed Tools:**
- **Plugin Editor:** read_plugin_source, write_plugin_source, run_plugin, list_user_plugins
- **File Operations (Read):** read_current_file, read_file, read_lines, open_file, list_open_tabs
- **Project Navigation (Read):** get_project_tree, scan_file, read_function, find_references
- **Search:** search_in_files
- **Scratchpad:** scratchpad_read, scratchpad_write, scratchpad_list
- **Documentation:** read_docs (includes Plugin SDK reference)
- **Issues (Read-Only):** list_issues, read_issue

**Restricted:**
- Cannot edit project files (no replace_lines, insert_lines, delete_lines)
- Cannot create/delete project files
- Cannot create/update issues or PRs
- Cannot commit

**Auto-activation:** When a plugin editor tab becomes active, the role auto-switches to `plugin-dev` and restores the previous role when switching away.

**System prompt:** Includes the full Plugin SDK API reference (hooks, events, state, storage, UI registration).

**Use Case:** Building and debugging plugins in the built-in plugin editor

---

## Tool Reference by Category

### File Operations (Read)
All roles can read files.

- `read_current_file` - Read currently open file (roles: `all`)
- `read_file` - Read any file by path (roles: `all`)
- `read_lines` - Read specific line range (roles: `all`)
- `open_file` - Open file in editor (roles: `all`)
- `list_open_tabs` - List open editor tabs (roles: `all`)

### File Operations (Write)
Only `coder` role can modify code.

- `replace_lines` - Replace lines in file (roles: `coder`)
- `insert_lines` - Insert new lines (roles: `coder`)
- `delete_lines` - Delete lines (roles: `coder`)
- `create_file` - Create new file (roles: `coder`)

### Project Navigation
All roles can navigate project structure.

- `get_project_tree` - List files in project (roles: `all`)
- `scan_file` - Get file outline/structure (roles: `all`)
- `read_function` - Read specific function (roles: `all`)
- `find_references` - Find symbol usage (roles: `all`)

### Search
All roles can search the codebase.

- `search_in_files` - Text search across files (roles: `all`)

### Issues
Access varies by role.

- `list_issues` - List project issues (roles: `all`)
- `read_issue` - Read issue details (roles: `all`)
- `create_issue` - Create new issue (roles: `pm`)
- `update_issue` - Update existing issue (roles: `pm`)
- `add_issue_comment` - Comment on issue (roles: `pm`, `reviewer`)

### Plugin Editor
Only available in `plugin-dev` role. Auto-activated when a plugin editor tab is open.

- `read_plugin_source` - Read current plugin editor source (roles: `plugin-dev`)
- `write_plugin_source` - Replace full plugin source (roles: `plugin-dev`)
- `run_plugin` - Save + hot-reload plugin (roles: `plugin-dev`)
- `list_user_plugins` - List user-created plugins (roles: `plugin-dev`)

---

## Adding New Tools

When creating a new tool, you **must** specify the `roles` field:

```javascript
registry.register('my_new_tool', async (args) => {
    // Handler implementation
}, {
    type: 'function',
    function: {
        name: 'my_new_tool',
        description: 'What this tool does',
        parameters: { /* ... */ }
    },
    roles: 'all'  // or ['coder', 'pm', 'reviewer']
});
```

### Role Assignment Guidelines

**Use `'all'`** for:
- Read-only operations (viewing files, project structure)
- Navigation and search
- Operations with no side effects

**Use `['coder']`** for:
- Code modification (editing, creating files)
- Operations that change repository state

**Use `['pm']`** for:
- Issue creation and management
- Project-level configuration changes

**Use `['pm', 'reviewer']`** for:
- Commenting on existing items
- Non-destructive feedback operations

**Use `['coder', 'pm']`** for:
- Operations that both roles need (rare)

---

## Adding New Roles

Roles can be registered dynamically by plugins:

```javascript
import { Roles } from './core.js';

Roles.register({
    id: 'security-auditor',
    name: 'Security Auditor',
    icon: '🛡️',
    description: 'Read-only access with security scanning tools'
});
```

Then tools can reference the new role:

```javascript
registry.register('scan_vulnerabilities', handler, {
    // ... definition ...
    roles: ['security-auditor', 'coder']
});
```

---

## Validation

The registry performs **strict validation** at tool registration time:

1. **Missing `roles` field:** Throws error (required)
2. **Invalid role ID:** Throws error if role doesn't exist
3. **Wrong type:** Throws error if not `'all'` or array

This ensures:
- No typos in role names
- No orphaned tool references
- Clear error messages during development

---

## Token Savings by Role

| Role | Active Tools | Approx. Tokens Saved |
|------|--------------|---------------------|
| **Full** | ~19 tools | 0 (baseline) |
| **Coder** | ~14 tools | ~25% reduction |
| **PM** | ~11 tools | ~40% reduction |
| **Reviewer** | ~10 tools | ~45% reduction |

Fewer tools = smaller context window = faster responses + lower costs.

---

## Future Enhancements

- [ ] User-defined roles via settings UI
- [ ] Role inheritance (e.g., `pm` extends `reviewer`)
- [ ] Per-project role overrides
- [ ] Audit log of role-based tool access
- [ ] Dynamic role switching within a session
