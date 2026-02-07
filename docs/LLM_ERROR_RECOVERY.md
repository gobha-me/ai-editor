# LLM Error Recovery Guidelines

This document provides guidance for LLM agents working with the AI Editor codebase to recover from common errors and avoid getting stuck.

## Critical Encoding Limitations (RESOLVED)

### ✅ Fixed: Unicode in File Content

**Previous Issue:** The Gitea API tools used `btoa()` which only supports Latin1 (ISO-8859-1) encoding.

**Status:** FIXED as of commit `f79091fb` - now uses UTF-8 safe encoding

**What Was Affected:**
- Files with Unicode characters (✓, ▼, emoji, non-Latin alphabets)
- Modern CSS with Unicode pseudo-content
- Internationalized content

**Old Error Pattern:**
```
Failed to execute 'btoa' on 'Window': The string to be encoded 
contains characters outside of the Latin1 range.
```

**Resolution:** The `utf8ToBase64()` and `base64ToUtf8()` helpers now handle all Unicode characters properly.

---

## General Error Recovery Patterns

### Pattern 1: Encoding/Character Issues

**If you encounter character encoding errors:**

1. **Identify the problematic characters** - Look for:
   - Unicode symbols (✓, ✗, ▼, ▲, →, ←)
   - Emoji (😀, 🚀, ⚡)
   - Non-Latin alphabets (中文, العربية, עברית)
   - Special quotes/dashes ('', "", —, –)

2. **Alternative representations:**
   - **CSS Unicode escapes:** `content: '\2713';` instead of `content: '✓';`
   - **HTML entities:** `&check;` instead of ✓
   - **ASCII equivalents:** `>` instead of ▼, `v` instead of ✓

3. **Don't give up** - If file creation fails due to encoding:
   - Scan the content for non-ASCII characters
   - Replace with escapes or equivalents
   - Retry immediately with the modified content

### Pattern 2: Tool Call Validation Failures

**Error:** `Tool call validation failed: Missing required parameters`

**Recovery:**
1. The response was likely truncated - check token limits
2. Review which parameters are actually required
3. Make a new, complete call with ALL required parameters
4. Break large operations into smaller chunks if needed

### Pattern 3: File/Path Not Found

**Error:** `Path not found: js/workers`

**Recovery:**
1. Verify the directory exists first with `list_files()`
2. Create parent directories if needed
3. Check you're on the correct branch
4. Verify the repository context is set

### Pattern 4: Regex Pattern Errors

**Error:** `Invalid regex pattern`

**Recovery:**
1. Escape special regex characters: `. * + ? ^ $ { } ( ) | [ ] \`
2. Test pattern validity before using
3. For literal strings, use exact match instead of regex
4. Provide clear error messages about what went wrong

---

## Best Practices for Resilience

### 1. **Incremental Progress**
- Create files one at a time when possible
- Commit each logical unit of work
- Don't bundle too many changes into one operation

### 2. **Validate Before Acting**
- Check if paths exist before reading/writing
- Validate regex patterns before searching
- Confirm required parameters are present

### 3. **Clear Error Context**
- Log what you were trying to do when an error occurred
- Include the problematic input data
- Suggest next steps for recovery

### 4. **Graceful Degradation**
- If advanced features fail, fall back to simpler approaches
- Use ASCII instead of Unicode when encoding is uncertain
- Break batch operations into individual calls if batching fails

### 5. **Learn from Failures**
- If an approach fails, try a different one
- Don't repeat the exact same call that just failed
- Adapt parameters based on error messages

---

## Common Unicode Replacements

For CSS `content` pseudo-elements:

| Symbol | Unicode | CSS Escape | ASCII Alt |
|--------|---------|------------|-----------|
| ✓      | U+2713  | `\2713`    | `v`       |
| ✗      | U+2717  | `\2717`    | `x`       |
| ▼      | U+25BC  | `\25BC`    | `v`       |
| ▲      | U+25B2  | `\25B2`    | `^`       |
| →      | U+2192  | `\2192`    | `>`       |
| ←      | U+2190  | `\2190`    | `<`       |
| ▶      | U+25B6  | `\25B6`    | `>`       |
| ◀      | U+25C0  | `\25C0`    | `<`       |

Example:
```css
/* Before (risky with old encoding) */
.checkmark::after {
    content: '✓';
}

/* After (CSS escape - recommended) */
.checkmark::after {
    content: '\2713';
}

/* After (ASCII fallback) */
.checkmark::after {
    content: 'v';
}
```

---

## Debugging Checklist

When an operation fails:

- [ ] Is the error message clear about what went wrong?
- [ ] Are all required parameters provided?
- [ ] Is the file path correct and does it exist?
- [ ] Are you on the correct branch?
- [ ] Does the content have Unicode characters?
- [ ] Is the regex pattern valid?
- [ ] Have you tried this exact approach before and failed?
- [ ] Can you break this into smaller steps?
- [ ] Is there a simpler fallback approach?

---

## Examples of Good Error Recovery

### Example 1: CSS File Creation Failure

**Scenario:** Creating CSS with Unicode checkmarks fails

**Bad Response:**
```
Error occurred. Unable to create file.
```

**Good Response:**
```
Encoding error detected with Unicode character '✓' in CSS.
Retrying with CSS escape sequence '\2713' instead...
```

### Example 2: Missing Directory

**Scenario:** Trying to create `js/workers/search.js` but `js/workers/` doesn't exist

**Bad Response:**
```
Failed to create file. Path error.
```

**Good Response:**
```
Directory js/workers/ doesn't exist. Creating it first, then creating the file...
```

### Example 3: Truncated Response

**Scenario:** Response hit token limit mid-operation

**Bad Response:**
```
[truncated, operation incomplete]
```

**Good Response:**
```
Previous response was truncated. Completing the remaining operations now:
1. Creating remaining 2 files
2. Updating configuration
3. Documenting changes
```

---

## When to Ask for Help

If you encounter:
- Repeated failures on the same operation after 3 attempts
- Unclear error messages you can't interpret
- Contradictory requirements or constraints
- Operations that would require significant refactoring

**Don't:** Keep trying the same thing hoping for different results

**Do:** Explain what you've tried, what failed, and ask for clarification or alternative approaches
