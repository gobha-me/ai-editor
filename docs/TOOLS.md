# AI Editor - Tool Reference

Quick reference for all available tools.

## 📂 File Tools

### `read_file` / `open_file`
Read file contents. Use `scan_file` first to check size!
```javascript
read_file({ path: "js/chat.js" })
```

### `read_current_file`
Get currently open file in editor.

### `list_open_tabs`
See all open files.

---

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

### `replace_lines`
Replace line range with new content.
```javascript
replace_lines({
  path: "js/file.js",
  start_line: 10,
  end_line: 15,
  content: "new code here"
})
```

### `insert_lines`
Insert new lines after specified line.
```javascript
insert_lines({
  path: "js/file.js",
  after_line: 42,
  content: "new code"
})
```

### `delete_lines`
Delete line range.
```javascript
delete_lines({
  path: "js/file.js",
  start_line: 10,
  end_line: 15
})
```

### `create_file`
Create new file with content.
```javascript
create_file({
  path: "js/new-file.js",
  content: "// new file content"
})
```

---

## 📋 Project Tools

### `get_project_tree`
Get file tree structure.
```javascript
get_project_tree({ max_depth: 3 })
```

---

## 🎫 Issue Tools

### `read_issue`
Read issue details.
```javascript
read_issue({ number: 32 })
```

### `list_issues`
List issues (open/closed/all).
```javascript
list_issues({
  state: "open",
  limit: 10
})
```

### `create_issue`
Create new issue.
```javascript
create_issue({
  title: "Bug: something broke",
  body: "Description..."
})
```

### `update_issue`
Update issue (title/body/state).
```javascript
update_issue({
  number: 32,
  state: "closed"
})
```

### `add_issue_comment`
Add comment to issue.
```javascript
add_issue_comment({
  number: 32,
  comment: "Work completed!"
})
```

---

## 🎯 Best Practices

### ✅ DO:
1. **Use `scan_file` before `read_file`** - Save 97% tokens
2. **Use `read_function` for specific functions** - Save 89% tokens
3. **Use `search_in_files` with `compact: true`** - Save 85% tokens
4. **Use `read_lines` to examine search results** - Only read what you need
5. **Use `find_references` to understand code flow** - Line numbers only

### ❌ DON'T:
1. Don't read full files when you only need structure
2. Don't read full files when you only need one function
3. Don't search without compact mode
4. Don't read entire files to see one section
5. Don't manually search when `find_references` can help

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
1. get_project_tree({ max_depth: 2 })
2. scan_file("js/main.js")
3. read_function("js/main.js", "init")
4. find_references({ symbol: "handleEvent" })
5. read_lines("js/events.js", 120, 130)
```

### Fix a Bug
```
1. search_in_files({ query: "error message", compact: true })
2. read_lines("js/module.js", 245, 255, context_lines: 10)
3. scan_file("js/module.js")
4. read_function("js/module.js", "buggyFunction")
5. replace_lines({ path: "js/module.js", ... })
```

### Implement Feature
```
1. find_references({ symbol: "similar_feature" })
2. read_function("js/existing.js", "similar_feature")
3. scan_file("js/target.js")
4. insert_lines({ path: "js/target.js", ... })
```

---

For detailed documentation, see:
- **Navigation Tools:** `docs/scan-tools-guide.md`
- **Tool Registry:** `js/tools/registry.js`
- **Individual Tool Modules:** `js/tools/*.js`
