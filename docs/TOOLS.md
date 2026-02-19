# AI Editor - Tool Reference

Quick reference for all available tools.

## 📂 File Tools

### `read_current_file`
Read the content of the currently open file in the editor. Returns line-numbered content. Large files (200+ lines) are truncated by default.
```javascript
read_current_file({ full: true })  // full is optional, default: false
```

### `read_file`
Read any file's content without opening it in the editor. Large files (200+ lines) are truncated by default.
```javascript
read_file({ path: "js/chat.js", full: true })  // full is optional, default: false
```

### `open_file`
Open a specific file in the editor. **Required before using edit tools** (`replace_lines`, `insert_lines`, `delete_lines`).
```javascript
open_file({ path: "js/chat.js" })
```

### `list_open_tabs`
See all open files in the editor.
```javascript
list_open_tabs()
```

## 🔍 Navigation Tools (NEW - Efficient!)

### `scan_file` ⭐ RECOMMENDED FIRST
Get file outline without reading full content. **97% token savings!**
```javascript
scan_file({
  path: "js/chat.js",
  include_signatures: true
})
// Returns: functions, classes, line numbers, params
```

### `read_function` ⭐ READ SPECIFIC PARTS
Read just one function by name. **89% token savings!**
```javascript
read_function({
  path: "js/chat.js",
  name: "handleGeneralRequest"
})
// Returns: function code, line range
```

### `read_lines` ⭐ READ LINE RANGE
Read specific lines with context.
```javascript
read_lines({
  path: "js/chat.js",
  start_line: 740,
  end_line: 750,
  context_lines: 5  // optional
})
```

### `find_references` ⭐ FIND USAGE
Find where a symbol is defined and used.
```javascript
find_references({
  symbol: "executeToolCall",
  scope: "js/"  // optional
})
// Returns: line numbers + snippets
```

**Recommended workflow:**
1. `scan_file` to see structure
2. `read_function` or `read_lines` for specific parts
3. `find_references` to understand usage

---

## 🔎 Search Tools

### `search_in_files` (Enhanced)
Search across project files. Now returns compact snippets!
```javascript
search_in_files({
  query: "executeToolCall",
  path: "js/",  // optional
  max_results: 20,
  compact: true  // default: 80-char snippets
})
// Returns: { line, snippet } for each match
```
**Tip:** Use `read_lines` to see full context around matches.

---

## ✏️ Edit Tools

> **Important:** Edit tools (`replace_lines`, `insert_lines`, `delete_lines`) operate on the **currently open file** in the editor. You must call `open_file` first. They do NOT accept a `path` parameter.

### `replace_lines`
Replace a line range with new content. Line numbers are 1-indexed.
```javascript
replace_lines({
  start_line: 10,
  end_line: 15,
  new_content: "new code here"
})
```

### `insert_lines`
Insert new lines after a specified line. Use `after_line: 0` to insert at the beginning.
```javascript
insert_lines({
  after_line: 42,
  content: "new code"
})
```

### `delete_lines`
Delete a line range. Line numbers are 1-indexed, inclusive.
```javascript
delete_lines({
  start_line: 10,
  end_line: 15
})
```

### `create_file`
Create a new file in the repository. Commits directly to the current branch. Intermediate directories are created automatically.
```javascript
create_file({
  path: "js/new-file.js",
  content: "// new file content",
  message: "Add new-file.js"  // optional, defaults to "Create <path>"
})
```

### `delete_file`
Delete a file from the repository. Commits the deletion directly to the current branch.
```javascript
delete_file({
  path: "js/old-file.js",
  message: "Remove old-file.js"  // optional, defaults to "Delete <path>"
})
```

---

## 📋 Project Tools

### `get_project_tree`
Get file tree structure. Optionally filter by directory path.
```javascript
get_project_tree({ path: "src/" })  // path is optional
```

---

## 🎫 Issue Tools

### `list_issues`
List issues for the current project. Returns open issues by default.
```javascript
list_issues({
  state: "open",     // "open" | "closed" | "all" (default: "open")
  labels: "bug,ui"   // optional comma-separated label filter
})
```

### `read_issue`
Read a specific issue by number, including body, labels, and comments.
```javascript
read_issue({ number: 32 })
```

### `create_issue`
Create a new issue in the current project.
```javascript
create_issue({
  title: "Bug: something broke",
  body: "Description...",           // optional, markdown supported
  labels: ["bug", "priority-high"]  // optional array of label names
})
```

### `update_issue`
Update issue metadata only (title, state, labels). Does **not** modify the issue body — use `add_issue_comment` to post new content.
```javascript
update_issue({
  number: 32,
  title: "Updated title",  // optional
  state: "closed",         // optional: "open" | "closed"
  labels: ["bug", "p1"]    // optional: replaces label list
})
```

### `add_issue_comment`
Post a comment on an issue. Use this to add updates, responses, analysis, or any new information.
```javascript
add_issue_comment({
  number: 32,
  body: "Work completed!"  // markdown supported
})
```

---

## 🔀 Pull Request Tools

### `create_pull_request`
Create a pull/merge request. Head defaults to the current branch, base defaults to the repository default branch.
```javascript
create_pull_request({
  title: "Add user authentication",
  body: "## Changes\n- Added login flow\n- Added session management",  // optional
  head: "feature/auth",  // optional, defaults to current branch
  base: "main"           // optional, defaults to repo default branch
})
```

### `list_pull_requests`
List pull/merge requests for the current project.
```javascript
list_pull_requests({
  state: "open"  // "open" | "closed" | "all" (default: "open")
})
```

---

## 🎯 Best Practices

### ✅ DO:
1. **Use `scan_file` before `read_file`** — Save 97% tokens
2. **Use `read_function` for specific functions** — Save 89% tokens
3. **Use `search_in_files` with `compact: true`** — Save 85% tokens
4. **Use `read_lines` to examine search results** — Only read what you need
5. **Use `find_references` to understand code flow** — Line numbers only
6. **Call `open_file` before using edit tools** — Edit tools operate on the open file

### ❌ DON'T:
1. Don't read full files when you only need structure
2. Don't read full files when you only need one function
3. Don't search without compact mode
4. Don't read entire files to see one section
5. Don't manually search when `find_references` can help
6. Don't pass `path` to `replace_lines`/`insert_lines`/`delete_lines` — they work on the open file

### 📊 Token Usage Comparison

| Task | Old Method | New Method | Savings |
|------|-----------|------------|---------|
| "Show me function X" | `read_file` (18K) | `scan_file` + `read_function` (2.5K) | **86%** |
| "Find uses of Y" | Multiple `read_file` (50K+) | `find_references` + `read_lines` (5K) | **90%** |
| "Search for Z" | `search_in_files` verbose (10K) | `search_in_files` compact (2K) | **80%** |

---

## 🚀 Example Workflows

### Understand Unknown Codebase
```
1. get_project_tree({ path: "src/" })
2. scan_file({ path: "js/main.js" })
3. read_function({ path: "js/main.js", name: "init" })
4. find_references({ symbol: "handleEvent" })
5. read_lines({ path: "js/events.js", start_line: 120, end_line: 130 })
```

### Fix a Bug
```
1. search_in_files({ query: "error message", compact: true })
2. read_lines({ path: "js/module.js", start_line: 245, end_line: 255, context_lines: 10 })
3. scan_file({ path: "js/module.js" })
4. read_function({ path: "js/module.js", name: "buggyFunction" })
5. open_file({ path: "js/module.js" })
6. replace_lines({ start_line: 250, end_line: 253, new_content: "fixed code" })
```

### Implement Feature
```
1. find_references({ symbol: "similar_feature" })
2. read_function({ path: "js/existing.js", name: "similar_feature" })
3. scan_file({ path: "js/target.js" })
4. open_file({ path: "js/target.js" })
5. insert_lines({ after_line: 42, content: "new feature code" })
```

### Create a PR After Work
```
1. create_pull_request({
     title: "Fix: resolve login timeout issue",
     body: "## Summary\nFixed the session timeout bug..."
   })
```

---

## 🔐 Role-Based Access

Not all tools are available to all roles. The tool registry enforces role-based access:

| Tool | Roles |
|------|-------|
| `read_file`, `read_lines`, `scan_file`, etc. | All roles |
| `get_project_tree`, `search_in_files` | All roles |
| `list_issues`, `read_issue` | All roles |
| `list_pull_requests` | All roles |
| `replace_lines`, `insert_lines`, `delete_lines` | Coder |
| `create_file`, `delete_file` | Coder |
| `create_issue`, `update_issue` | PM |
| `add_issue_comment` | PM, Reviewer |
| `create_pull_request` | Coder, PM |

---

For detailed documentation, see:
- **Navigation Tools:** `docs/scan-tools-guide.md`
- **Tool Registry:** `js/tools/registry.js`
- **Individual Tool Modules:** `js/tools/*.js`