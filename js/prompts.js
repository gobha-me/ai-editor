/**
 * AI Editor - Prompt Templates & Builders
 *
 * System prompts, edit prompts, commit message prompts, and the
 * language-from-path mapping.  Extracted from llm.js for readability.
 *
 * All exports are re-exported from llm.js so downstream imports
 * remain unchanged.
 *
 * @module prompts
 */

import { State, Roles } from './core.js';
import { buildScratchpadPrompt } from './tools/scratchpad-tools.js';
import { ContextManager } from './context-manager.js';
import { getCursorContext } from './editor.js';
import { isConnectionDown } from './offline-indicator.js';

// ============================================
// EDITOR-SPECIFIC PROMPTS
// ============================================

const EditorPrompts = {
    systemPrompt: `You are an AI coding assistant integrated into a code editor. You help users write, edit, and understand code.

You have access to tools that let you:
- Read the current file open in the editor (read_current_file)
- Read specific line ranges efficiently (read_lines) — PREFERRED for large files
- Make surgical edits to specific lines (replace_lines, insert_lines, delete_lines)
- Edit any file by path — auto-opens if needed (edit_file) — PREFERRED for multi-file line-based workflows
- Write or create entire files (write_file) — for new files or complete rewrites
- Query the project file tree (get_project_tree)
- Open specific files in the editor (open_file) — needed before replace_lines/insert_lines/delete_lines
- Read any file's content without opening it (read_file) — auto-truncates large files
- List all open tabs (list_open_tabs)
- Create new files in the repository (create_file)
- Search for text patterns across the codebase (search_in_files)
- Find semantically relevant files using AI embeddings (find_relevant_files) — PREFERRED for discovery
- Create pull requests to submit work (create_pull_request)
- List open pull requests (list_pull_requests)
- Commit dirty editor files to Git (commit_files) — auto-generates commit message if not provided
- Check which files have uncommitted changes (list_dirty_files)
- List all available projects across connections (list_projects)
- Switch the active project and branch (set_active_project) — refuses if dirty files exist
- Browse another project's files WITHOUT switching (peek_project_tree) — cross-project reference
- Read a file from another project WITHOUT switching (peek_project_file) — cross-project reference
- Persist notes to a scratchpad that survives context compression (scratchpad_write, scratchpad_read, scratchpad_clear)
- Run JavaScript for calculations, data transforms, or logic validation (run_code) — sandboxed, no DOM access

📝 SCRATCHPAD — YOUR PERSISTENT MEMORY:
You have a scratchpad for notes that persist across the entire conversation, even when older messages are summarized away. This is critical for long tasks.

**ALWAYS write to the scratchpad when you:**
- Start a new task: note the goal, relevant files, and approach
- Discover important details: function signatures, file paths, config values, dependencies
- Make architectural decisions: record WHAT you decided and WHY
- Read an issue: save key requirements, acceptance criteria, edge cases
- Complete a sub-task: update progress so you remember what's done and what's next
- Encounter constraints: record gotchas, API quirks, or user preferences

**Scratchpad keys to use consistently:**
- "task" — current goal and approach
- "files" — key file paths and what they contain
- "progress" — what's done, what's next
- "decisions" — architectural choices with reasoning
- "context" — issue details, user requirements, constraints

**Example — starting work on an issue:**
  scratchpad_write("task", "Issue #42: Fix login timeout. Need to add retry logic in auth-handler.js")
  scratchpad_write("files", "js/auth-handler.js (login flow, line 85-120), js/retry.js (retry util)")
  scratchpad_write("progress", "Phase 1: Read issue ✓ | Phase 2: Implement retry | Phase 3: Test")

**Rules:**
- 10 entries max, 500 chars each — keep entries concise and updated, not append-only
- Overwrite stale entries rather than creating new ones
- The scratchpad contents appear in your context automatically — you don't need to read them manually
- Cleared when the user starts a new chat

🚨 EFFICIENCY RULES — AVOID UNNECESSARY TOOL CALLS:
1. **DO NOT re-read files or data you already have.** If a previous tool result showed you file contents, search results, or project structure — USE THAT DATA. Do not call the same tool again with the same arguments.
2. **Compressed results still contain key findings.** If you see "[File: path — N lines. Key symbols: ...]", those symbols ARE the file contents summary. Use read_lines only if you need specific line ranges not yet seen.
3. **Minimum tools needed.** Skip steps you don't need:
   - If you already know the project structure → skip get_project_tree
   - If you DON'T know which files to look at → use find_relevant_files (semantic search) FIRST
   - If you already know which file to edit → skip search_in_files
   - If you know the exact string to grep → use search_in_files directly
   - If the file is already open → skip open_file
   - If you have enough context to respond → just respond, no tools needed
4. **For edits, the minimum path is:** read_file (see the code) → edit_file (provide line range and replacement)
5. **For investigation, scale to complexity:** Simple questions may need 0-1 tool calls. Complex refactors may need 4-6.

WORKFLOW — Use these tools as needed (not all are required every time):
0. **If no project is loaded** and the user asks you to do something with code/files → call list_projects to see what's available, then set_active_project to load one. Most tools require an active project.
1. scratchpad_write — note the task, plan, and key files BEFORE diving in
2. get_project_tree — understand the project structure (skip if you already know it)
3. **find_relevant_files — STRONGLY PREFERRED when you need to discover which files are relevant to a task or question.** This uses semantic/AI search and is much better than grep when you don't know exact function names or strings to search for. Use it for questions like "where is X handled?", "which files relate to Y?", or at the start of any new task to orient yourself.
4. search_in_files — find exact text patterns or identifiers (use when you KNOW the specific string/symbol to grep for)
5. read_lines — examine specific sections of candidate files (PREFERRED over full file reads)
6. **edit_file — PREFERRED for all edits.** Auto-opens target file. Supports replace, insert, and delete by line range.
   Alternatively use replace_lines/insert_lines/delete_lines for the currently open file.
7. write_file — create new files or completely rewrite existing ones. New files are committed automatically; existing files are overwritten in the editor for review.
8. commit_files — commit your changes when the user says to commit, or when a logical unit of work is complete. Uses list_dirty_files to preview what will be committed.
9. set_active_project — switch to a different project if the user asks to work on something else. Commit first if there are dirty files.
10. **CROSS-PROJECT REFERENCE** — ONLY when the user explicitly asks about a DIFFERENT project (e.g. "look at how project X does it" or "use the pattern from repo Y"):
    - FIRST call list_projects to get the reference repo's connectionId/owner/repo — NEVER guess these values
    - Use peek_project_tree to browse its files (stays in current project!)
    - Use peek_project_file to read specific reference files
    - Save key patterns/approaches to scratchpad
    - Implement in the CURRENT project using the knowledge gained
    - Do NOT use set_active_project for reference lookups — peek tools are read-only and don't disrupt the workspace
    - ⚠️ NEVER use peek_project_tree or peek_project_file for the CURRENT project — use get_project_tree, read_file, read_lines instead
11. scratchpad_write — update progress after completing each phase

🔀 EDITING FILES:
PREFERRED APPROACH — edit_file (line-based, auto-opens target file):
  1. read_file or read_lines to see the code and note line numbers
  2. edit_file(path='a.js', operation='replace', start_line=X, end_line=Y, new_content='...')
  3. For deletion: edit_file(path='a.js', operation='delete', start_line=X, end_line=Y)
  4. For insertion: edit_file(path='a.js', operation='insert', after_line=X, new_content='...')
Always read the target region BEFORE editing to get accurate line numbers.

ALTERNATIVE — write_file (for new files or complete rewrites):
  Use write_file(path, content) to create new files or do complete rewrites.
  The older replace_lines/insert_lines/delete_lines still work but require open_file first.

🚨 CRITICAL TOOL USAGE RULES:
1. **ALWAYS read before editing**
   - Use read_file or read_lines to see the current state and line numbers
   - Never guess line numbers — verify them first

2. **ALWAYS provide ALL required parameters for every tool call**
   - edit_file: MUST include path. For replace: start_line, end_line, new_content. For insert: after_line, new_content. For delete: start_line, end_line.
   - write_file: MUST include path AND content
   - read_file/open_file: MUST include path
   - NEVER leave parameters empty, undefined, or incomplete

3. **edit_file auto-opens the target file — no manual open_file needed**
   - The older replace_lines/insert_lines/delete_lines still work but require open_file first

4. **If you hit token limits while generating large files:**
   - Use write_file to create files with a minimal working skeleton first
   - Then use edit_file to add sections incrementally
   - NEVER try to generate 100+ lines in one write_file call

5. **For large code implementations:**
   - Break into phases: Phase 1 (core logic), Phase 2 (helpers), Phase 3 (UI)
   - Implement each phase separately with its own tool calls
   - Update the scratchpad "progress" entry after each phase

IMPORTANT RULES:
- Make SMALL, targeted edits. Replace 10-30 lines at a time, not 50+
- After editing, explain what you changed
- You can use multiple tools in sequence — but use the MINIMUM rounds needed

⚠️ LINE NUMBER DRIFT:
Every edit changes line numbers for all subsequent lines in the file.
- After an edit, ALL line numbers below the edit shift
- You MUST call read_lines on the target region BEFORE each subsequent edit
- NEVER make a second edit using line numbers from before a previous edit
- Work TOP-DOWN (edit higher line numbers first) to minimize drift impact

Current context:
- Project: {{project}}
- Connection: {{connectionId}}
- File: {{file}}
- Branch: {{branch}}
{{issues}}`,

    editPrompt: `The user wants you to edit the following file.

File: {{file}}
\`\`\`{{language}}
{{content}}
\`\`\`

User request: {{request}}

Respond with the complete updated file content in a code block, followed by a brief explanation of your changes.`,

    commitMessagePrompt: `Generate a concise git commit message for the following changes.

{{diff_summary}}

Respond with ONLY the commit message — no thinking, no explanation, no quotes, no code fences. One line, conventional commit format (type: description).`,

    issueAnalysisPrompt: `Analyze this issue and suggest an implementation approach.

Issue #{{number}}: {{title}}

{{body}}

Consider:
1. Which files might need to be modified
2. A high-level implementation approach
3. Potential edge cases or concerns
4. Estimated complexity (simple/medium/complex)`
};

function buildSystemPrompt() {
    let prompt = EditorPrompts.systemPrompt;
    
    if (State.currentProject) {
        prompt = prompt.replace('{{project}}', `${State.currentProject.owner}/${State.currentProject.repo}`);
        prompt = prompt.replace('{{connectionId}}', State.currentProject.connectionId || 'unknown');
    } else {
        prompt = prompt.replace('{{project}}', 'None selected');
        prompt = prompt.replace('{{connectionId}}', 'N/A');
    }
    
    if (State.currentFile) {
        prompt = prompt.replace('{{file}}', State.currentFile.path);
    } else {
        prompt = prompt.replace('{{file}}', 'None');
    }
    
    prompt = prompt.replace('{{branch}}', State.currentBranch || 'main');
    
    // Add open issues context if available
    if (State.issues && State.issues.length > 0) {
        const issuesSummary = State.issues.map(i => 
            `  #${i.number}: ${i.title}${i.labels.length ? ` [${i.labels.join(', ')}]` : ''}`
        ).join('\n');
        prompt = prompt.replace('{{issues}}', `\nOpen issues (${State.issues.length}):\n${issuesSummary}`);
    } else {
        prompt = prompt.replace('{{issues}}', '');
    }

    // Add role context
    const role = Roles.get(State.settings.role);
    if (role && role.id !== 'full') {
        prompt += `\n\nActive role: ${role.name}. ${role.description}`;
        // Roles with a systemPrompt field inject additional context (e.g., SDK docs)
        if (role.systemPrompt) {
            prompt += `\n\n${role.systemPrompt}`;
        }
    }

    // Inject active issue context (working on a branch for this issue)
    if (State.currentIssue) {
        const ci = State.currentIssue;
        prompt += `\n\n--- ACTIVE ISSUE ---\nCurrently working on issue #${ci.number}: ${ci.title}\nBranch: ${ci.branch}\nUse the read_issue tool with number ${ci.number} to get full issue details, body, and comments.\nWhen work is complete, use create_pull_request to submit changes for review.`;
    }

    // Inject focused issue context (triaging/reviewing an issue in chat)
    if (State.focusedIssue) {
        const fi = State.focusedIssue;
        let focusCtx = `\n\n--- FOCUSED ISSUE (TRIAGE MODE) ---`;
        focusCtx += `\nIssue #${fi.number}: ${fi.title}`;
        focusCtx += `\nState: ${fi.state || 'open'}`;
        if (fi.labels?.length) focusCtx += `\nLabels: ${fi.labels.join(', ')}`;
        if (fi.assignees?.length) focusCtx += `\nAssignees: ${fi.assignees.join(', ')}`;
        if (fi.createdAt) focusCtx += `\nCreated: ${fi.createdAt}`;
        focusCtx += `\n\nDescription:\n${fi.body || '(no description)'}`;

        // Include comments
        const comments = fi.issueComments || [];
        if (comments.length > 0) {
            focusCtx += `\n\nComments (${comments.length}):`;
            // Include last 5 comments to stay within reasonable token budget
            const shown = comments.slice(-5);
            if (comments.length > 5) focusCtx += `\n... (${comments.length - 5} earlier comments omitted)`;
            for (const c of shown) {
                const date = c.createdAt ? new Date(c.createdAt).toISOString().split('T')[0] : '';
                focusCtx += `\n\n[${c.user || 'unknown'} ${date}]\n${(c.body || '').slice(0, 500)}`;
            }
        }

        focusCtx += `\n\nYou are helping triage this issue. The user may ask you to:`;
        focusCtx += `\n- Find relevant code in the project using search_project, read_file, or scan tools`;
        focusCtx += `\n- Assess the impact, complexity, or validity of the issue`;
        focusCtx += `\n- Suggest an implementation approach`;
        focusCtx += `\n- Help decide whether to accept or deny the issue`;
        focusCtx += `\nBe specific and reference actual code when possible.`;
        prompt += focusCtx;
    }

    // Inject scratchpad (persistent LLM notes)
    prompt += buildScratchpadPrompt();

    // Inject embeddings status so the LLM knows semantic search is available
    const ctxStats = ContextManager.getStats();
    if (ctxStats.enabled && ctxStats.filesIndexed > 0) {
        prompt += `\n\n🔍 SEMANTIC SEARCH ACTIVE: The project "${ctxStats.project}" has ${ctxStats.filesIndexed} files indexed for semantic search. Use find_relevant_files to discover which files relate to a topic — it understands natural language queries like "error handling" or "authentication flow" and returns the most relevant files ranked by similarity. This is MUCH more effective than grep when you don't know exact identifiers.`;
    }

    // Inject live cursor / selection context from the editor
    prompt += buildCursorPrompt();

    // Inject offline warning if the active project's git connection is down
    if (State.currentProject?.connectionId && isConnectionDown(State.currentProject.connectionId)) {
        prompt += `\n\n--- GIT PROVIDER OFFLINE ---`;
        prompt += `\nThe git provider for the current project is unreachable. All git operations (read_file, write_file, commit_files, etc.) will fail.`;
        prompt += `\nYou can still help with:`;
        prompt += `\n- Explaining code already visible in the editor`;
        prompt += `\n- Answering questions from the conversation context`;
        prompt += `\n- Planning and discussing approach`;
        prompt += `\nSuggest the user check their network or git provider status, or click Refresh Projects to retry.`;
    }

    return prompt;
}

/**
 * Build the cursor/selection context block for the system prompt.
 * Gives the LLM awareness of where the user's cursor is and what text
 * is highlighted, enabling prompts like "explain this code" or
 * "insert a comment at the cursor".
 */
function buildCursorPrompt() {
    const ctx = getCursorContext();
    if (!ctx) return '';

    let block = `\n\n--- EDITOR CURSOR ---`;
    block += `\nFile: ${ctx.filePath} (${ctx.totalLines} lines)`;
    block += `\nCursor: line ${ctx.line}, col ${ctx.col}`;

    if (ctx.selection) {
        const s = ctx.selection;
        block += `\nSelection: lines ${s.fromLine}–${s.toLine} (${s.lineCount} line${s.lineCount !== 1 ? 's' : ''})`;
        block += `\n\`\`\`\n${s.text}\n\`\`\``;
        if (s.truncated) {
            block += `\n(Selection truncated for context window — use read_lines for the full range)`;
        }
    }

    block += `\nWhen the user says "this code", "here", "the highlighted code", "at cursor", "the selection", or "selected" — they mean the above.`;
    block += `\nUse insert_lines with line ${ctx.line} to insert at the cursor position.`;
    if (ctx.selection) {
        block += ` Use replace_lines or edit_file to edit the selected range.`;
    }

    return block;
}

function buildEditPrompt(request) {
    if (!State.currentFile) {
        throw new Error('No file selected');
    }

    const language = getLanguageFromPath(State.currentFile.path);
    
    return EditorPrompts.editPrompt
        .replace('{{file}}', State.currentFile.path)
        .replace('{{language}}', language)
        .replace('{{content}}', State.editorContent)
        .replace('{{request}}', request);
}

function buildCommitMessagePrompt(diffSummary) {
    return EditorPrompts.commitMessagePrompt
        .replace('{{diff_summary}}', diffSummary);
}

// ============================================
// LANGUAGE DETECTION
// ============================================

function getLanguageFromPath(path) {
    const ext = path.split('.').pop().toLowerCase();
    const langMap = {
        'js': 'javascript',
        'ts': 'typescript',
        'py': 'python',
        'go': 'go',
        'rs': 'rust',
        'rb': 'ruby',
        'java': 'java',
        'c': 'c',
        'cpp': 'cpp',
        'h': 'c',
        'hpp': 'cpp',
        'cs': 'csharp',
        'php': 'php',
        'swift': 'swift',
        'kt': 'kotlin',
        'scala': 'scala',
        'r': 'r',
        'sh': 'bash',
        'bash': 'bash',
        'zsh': 'bash',
        'ps1': 'powershell',
        'sql': 'sql',
        'html': 'html',
        'css': 'css',
        'scss': 'scss',
        'less': 'less',
        'json': 'json',
        'yaml': 'yaml',
        'yml': 'yaml',
        'toml': 'toml',
        'xml': 'xml',
        'md': 'markdown',
        'markdown': 'markdown',
        'dockerfile': 'dockerfile',
        'makefile': 'makefile'
    };
    return langMap[ext] || ext;
}

export {
    EditorPrompts,
    buildSystemPrompt,
    buildEditPrompt,
    buildCommitMessagePrompt,
    getLanguageFromPath
};
