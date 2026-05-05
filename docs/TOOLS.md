# AI Editor — LLM Tool Reference

Reference for all 53 LLM tools. Roles control which tools are available; see [ROLES_AND_TOOLS.md](ROLES_AND_TOOLS.md) for role definitions and access matrix.

> **Counts at a glance** — 53 tools across 17 modules (`js/tools/*.js`). Tool definitions live with their handler in the same module and self-register at app startup via `js/app.js`.

---

## Quick reference by module

| Module | Tools | Theme |
|---|---|---|
| `file-tools` | 4 | Read files; manage open tabs |
| `scan-tools` | 4 | Token-efficient file outline / function / line / xref reads |
| `search-tools` | 1 | Full-text grep across project |
| `edit-tools` | 3 | Line-range edits on the active editor buffer |
| `cursor-tools` | 4 | Cursor-relative navigate / select / replace / insert |
| `multifile-tools` | 2 | Edit/write any file by path (auto-opens) |
| `project-tools` | 5 | Project list / switch / tree; create/delete files |
| `xref-tools` | 3 | Cross-project peeks (tree + file reads) |
| `issue-tools` | 5 | Issue tracker CRUD (list, create, update, comment) |
| `pr-tools` | 7 | PR lifecycle (create, list, read, review, merge) + CI status/logs |
| `commit-tools` | 2 | Commit dirty editor tabs from chat |
| `git-log-tools` | 1 | Inspect commit history (`git_log`) |
| `context-tools` | 3 | Embeddings-based file relevance + index control |
| `scratchpad-tools` | 3 | Persistent notes that survive chat summarization |
| `plugin-tools` | 4 | Plugin editor read/write/run + listing |
| `doc-tools` | 1 | Read built-in docs (`read_docs`) |
| `eval-tools` | 1 | Sandboxed JS execution (`run_code`) |

---

## File reading (`file-tools`)

### `read_current_file`
Read the currently open file. Large files (200+ lines) are head/tail-truncated unless `full: true`.
```js
read_current_file({ full: true })  // optional
```

### `read_file`
Read any file by path without opening it. Same truncation rules.
```js
read_file({ path: "js/chat/index.js", full: true })
```

### `open_file`
Open a file in the editor. Required before `replace_lines` / `insert_lines` / `delete_lines` operate on it.
```js
open_file({ path: "js/chat/index.js" })
```

### `list_open_tabs`
List all tabs currently open in the editor (file + plugin-editor + issue tabs).
```js
list_open_tabs()
```

---

## Token-efficient navigation (`scan-tools`)

For large files prefer this group over `read_file` — see [scan-tools-guide.md](scan-tools-guide.md).

### `scan_file` — file outline
Returns functions, classes, exports with line numbers. JS/TS and Python supported (other extensions return an empty outline).
```js
scan_file({ path: "js/chat/handlers.js", include_signatures: true })
```

### `read_function`
Extract a single function by name.
```js
read_function({ path: "js/chat/handlers.js", name: "handleGeneralRequest" })
```

### `find_references`
Find a symbol's definitions and usages across the project.
```js
find_references({ symbol: "executeToolCall", scope: "js/" })
```

### `read_lines`
Read a line range with optional context.
```js
read_lines({ path: "js/chat/handlers.js", start_line: 200, end_line: 220, context_lines: 3 })
```

---

## Search (`search-tools`)

### `search_in_files`
Compact text search across project files. Honors ignore patterns.
```js
search_in_files({ query: "executeToolCall", path: "js/", max_results: 20, compact: true })
```

---

## Line-based editing (`edit-tools`)

> Operate on the **currently open file**. Call `open_file` first. No `path` parameter.

### `replace_lines`
```js
replace_lines({ start_line: 10, end_line: 15, new_content: "..." })
```

### `insert_lines`
```js
insert_lines({ after_line: 42, content: "..." })  // after_line: 0 = top of file
```

### `delete_lines`
```js
delete_lines({ start_line: 10, end_line: 15 })
```

---

## Cursor-relative editing (`cursor-tools`)

For step-by-step edits where the LLM verifies position before mutating. All operations are buffer-only — undo with Ctrl+Z.

### `goto_line`
Move the cursor; returns line content + word_before/after for verification.
```js
goto_line({ line: 120, col: 15 })  // col optional, defaults to 1
```

### `select_range`
```js
select_range({ from_line: 10, from_col: 1, to_line: 12, to_col: 80 })
```

### `replace_selection`
Requires an active selection (use `select_range` first).
```js
replace_selection({ new_content: "..." })
```

### `insert_at_cursor`
```js
insert_at_cursor({ content: "// new code\n" })
```

---

## Multi-file editing (`multifile-tools`)

Auto-opens or switches to the target file — no manual `open_file` needed.

### `edit_file`
Replace, insert, or delete by path. Stale-line-number guard via EditTracker.
```js
edit_file({ path: "js/app.js", operation: "replace", start_line: 100, end_line: 105, new_content: "..." })
edit_file({ path: "js/app.js", operation: "insert", after_line: 50, new_content: "..." })
edit_file({ path: "js/app.js", operation: "delete", start_line: 200, end_line: 210 })
```

### `write_file`
Create a new file or overwrite an existing one. New files commit immediately; existing files are buffer-edits awaiting save.
```js
write_file({ path: "js/new-module.js", content: "..." })
```

---

## Project & file management (`project-tools`)

### `list_projects`
List all repos across all enabled connections.

### `set_active_project`
Switch the editor's active project context.
```js
set_active_project({ connectionId: "default-gitea", owner: "user", repo: "name", branch: "main" })
```

### `get_project_tree`
Filtered file tree. Honors ignore patterns.
```js
get_project_tree({ path: "js/" })
```

### `create_file`
Create a new file in the repo with a direct commit.
```js
create_file({ path: "js/new.js", content: "...", message: "Add new.js" })
```

### `delete_file`
Delete a file with a direct commit.
```js
delete_file({ path: "js/old.js", message: "Remove old.js" })
```

---

## Cross-project reference (`xref-tools`)

Read-only access to *other* projects without switching the active project. Reject calls targeting the current project — use the regular tools instead.

### `peek_project_tree`
```js
peek_project_tree({ connectionId, owner, repo, branch, path })
```

### `peek_project_file`
```js
peek_project_file({ connectionId, owner, repo, path, branch, full: false })
```

### `peek_read_lines`
```js
peek_read_lines({ connectionId, owner, repo, path, branch, start_line, end_line })
```

---

## Issues (`issue-tools`)

### `list_issues`
```js
list_issues({ state: "open", labels: "bug,ui", page: 1 })
```

### `read_issue`
```js
read_issue({ number: 32 })
```

### `create_issue`
```js
create_issue({ title: "...", body: "...", labels: ["bug"] })
```

### `update_issue`
Metadata only — title, state, labels. **Does not modify the body.** Use `add_issue_comment` to post new content.
```js
update_issue({ number: 32, title: "...", state: "closed", labels: ["bug", "p1"] })
```

### `add_issue_comment`
```js
add_issue_comment({ number: 32, body: "..." })
```

---

## Pull requests & CI (`pr-tools`)

### `create_pull_request`
```js
create_pull_request({ title, body, head, base })  // head/base optional
```

### `list_pull_requests`
```js
list_pull_requests({ state: "open" })
```

### `read_pull_request`
```js
read_pull_request({ number: 12 })
```

### `add_pr_review`
General PR comment (not line-level).
```js
add_pr_review({ number: 12, body: "..." })
```

### `merge_pull_request`
Verifies the PR is mergeable before attempting. Emits `context:prMerged` so the embedding index reindexes the base branch.
```js
merge_pull_request({ number: 12, merge_type: "squash", delete_branch: true })
```

### `get_ci_status`
```js
get_ci_status({ ref: "feature/x" })  // defaults to current branch
```

### `get_ci_logs`
Output is trimmed proportional to the active model's context window.
```js
get_ci_logs({ run_id: 123, job_id: 456 })
```

---

## Commit from chat (`commit-tools`)

### `commit_files`
Commit dirty editor tabs. Generates an AI commit message if `message` is omitted.
```js
commit_files({ paths: ["js/a.js"], message: "..." })  // both optional
```

### `list_dirty_files`
Preview what `commit_files` would touch.

---

## Git log (`git-log-tools`)

### `git_log`
View the commit history of the current repository. Returns compact commit entries with hash, author, date, and subject line.
```js
git_log()                                    // last 20 commits
git_log({ max_count: 50 })                   // last 50 commits
git_log({ path: "js/chat/index.js" })        // commits touching a specific file
git_log({ author: "alice" })                 // commits by a specific author
git_log({ since: "2024-01-15T00:00:00Z" })   // commits after a date
git_log({ sha: "feature-branch" })           // commits on a specific branch
```

---

## Embeddings / context (`context-tools`)

Requires `Settings → Context → Use Embeddings` to be enabled.

### `find_relevant_files`
```js
find_relevant_files({ query: "authentication logic", max_files: 5 })
```

### `get_embeddings_status`
Reports indexed file count, model, indexing state.

### `index_project`
```js
index_project({ force: false })
```

---

## Scratchpad (`scratchpad-tools`)

Persistent key-value notes that survive chat summarization. Limits scale with the active model's context window.

### `scratchpad_write`
```js
scratchpad_write({ key: "working_files", content: "..." })
```

### `scratchpad_read`
```js
scratchpad_read({ key: "working_files" })  // omit key to read all
```

### `scratchpad_clear`
```js
scratchpad_clear({ key: "working_files" })  // omit key to clear all
```

---

## Plugin editor (`plugin-tools`)

Available only in the **Plugin Developer** role (auto-activates when a plugin editor tab is open).

### `read_plugin_source`
The only way to read plugin tab content (`read_file` does not work for plugin tabs).

### `write_plugin_source`
```js
write_plugin_source({ source: "const { Plugins } = window.AIEditor; ..." })
```

### `run_plugin`
Save + hot-reload the active plugin.

### `list_user_plugins`
List user-created plugins with status.

---

## Documentation (`doc-tools`)

### `read_docs`
Self-serve access to the docs in this directory. Available to **Plugin Developer** and **Full Access** roles.
```js
read_docs()                          // list available docs
read_docs({ doc_id: "plugin-sdk" })  // read one
```

---

## JavaScript execution (`eval-tools`)

### `run_code`
Sandboxed `Function()` constructor with most globals blocked, 3-second timeout, last-expression auto-return. For verifying calculations, parsing data, or testing regex.
```js
run_code({ code: "42 * 17" })  // → result: 714
```

---

## Best practices

| ✅ Do | ❌ Don't |
|---|---|
| `scan_file` before `read_file` for large files | Read full files just to get structure |
| `find_references` to map call graphs | Manually grep when a tool exists |
| `search_in_files` with `compact: true` (default) | Read entire files to inspect a single match |
| `edit_file` for cross-file workflows | Call `open_file` then `replace_lines` repeatedly when `edit_file` does it in one call |
| Use `add_issue_comment` to post content on an issue | Use `update_issue({ body })` — `body` is intentionally not supported |
| Use `peek_*` for OTHER projects, regular tools for the current one | Use `peek_*` to read the active project (it will reject) |
| Re-read after every edit on a long file | Trust line numbers across multiple sequential edits — they drift |

---

## Role access summary

Compact view — see [ROLES_AND_TOOLS.md](ROLES_AND_TOOLS.md) for full matrix.

| Tool | Allowed roles |
|---|---|
| File reads, scan/find tools, project tree, search, peek_*, scratchpad, list issues/PRs, CI status/logs, list_projects, set_active_project | `all` |
| `replace_lines`, `insert_lines`, `delete_lines`, `replace_selection`, `insert_at_cursor`, `edit_file`, `write_file`, `create_file`, `delete_file`, `commit_files`, `list_dirty_files`, `run_code` | `coder` |
| `goto_line`, `select_range` | `all` |
| `create_issue`, `update_issue` | `pm` |
| `add_issue_comment` | `pm`, `reviewer` |
| `create_pull_request` | `coder`, `pm` |
| `add_pr_review`, `merge_pull_request` | `coder`, `pm`, `reviewer` |
| `find_relevant_files` | `full`, `coder`, `reviewer` |
| `index_project` | `full`, `coder` |
| `read_plugin_source`, `write_plugin_source`, `run_plugin`, `list_user_plugins` | `plugin-dev` |
| `read_docs` | `plugin-dev`, `full` |

The `full` role bypasses all role checks (`ToolRegistry.checkRoleAccess` short-circuits).

---

## Adding a new tool

1. Create or extend a module in `js/tools/`.
2. Call `registry.register(name, handler, definition)` with a `roles` field — `'all'` or `string[]` of role IDs.
3. Import the module in `js/app.js` so it registers at startup.
4. (If the role is new) Register the role first via `Roles.register()` in `js/core.js` or a plugin.

The registry validates role IDs at registration time and throws on typos. See [ROLES_AND_TOOLS.md](ROLES_AND_TOOLS.md#adding-new-tools) for the contract.
