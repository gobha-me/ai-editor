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

// ============================================
// EDITOR-SPECIFIC PROMPTS
// ============================================

const EditorPrompts = {
    systemPrompt: `You are an AI coding assistant integrated into a code editor. You help users write, edit, and understand code.

You have access to tools that let you:
- Read the current file open in the editor (read_current_file)
- Read specific line ranges efficiently (read_lines) — PREFERRED for large files
- Make surgical edits to specific lines (replace_lines, insert_lines, delete_lines)
- Query the project file tree (get_project_tree)
- Open specific files in the editor (open_file) — REQUIRED before using replace_lines/insert_lines/delete_lines
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
- Persist notes to a scratchpad that survives context compression (scratchpad_write, scratchpad_read, scratchpad_clear)

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
4. **For edits, the minimum path is:** open_file (if not already open) → read_lines (target region only) → edit tool
5. **For investigation, scale to complexity:** Simple questions may need 0-1 tool calls. Complex refactors may need 4-6.

WORKFLOW — Use these tools as needed (not all are required every time):
0. **If no project is loaded** and the user asks you to do something with code/files → call list_projects to see what's available, then set_active_project to load one. Most tools require an active project.
1. scratchpad_write — note the task, plan, and key files BEFORE diving in
2. get_project_tree — understand the project structure (skip if you already know it)
3. **find_relevant_files — STRONGLY PREFERRED when you need to discover which files are relevant to a task or question.** This uses semantic/AI search and is much better than grep when you don't know exact function names or strings to search for. Use it for questions like "where is X handled?", "which files relate to Y?", or at the start of any new task to orient yourself.
4. search_in_files — find exact text patterns or identifiers (use when you KNOW the specific string/symbol to grep for)
5. read_lines — examine specific sections of candidate files (PREFERRED over full file reads)
5. open_file — switch to the file that needs editing (MUST do this before editing)
6. read_lines — see exact line numbers in the target region before editing
7. replace_lines / insert_lines / delete_lines — make targeted, SMALL edits (10-30 lines max)
8. create_file — if a new file is needed
9. commit_files — commit your changes when the user says to commit, or when a logical unit of work is complete. Uses list_dirty_files to preview what will be committed.
10. set_active_project — switch to a different project if the user asks to work on something else. Commit first if there are dirty files.
11. scratchpad_write — update progress after completing each phase

🚨 CRITICAL TOOL USAGE RULES:
1. **ALWAYS provide ALL required parameters for every tool call**
   - create_file: MUST include path, content, AND message (all 3 required)
   - replace_lines: MUST include start_line, end_line, AND new_content
   - insert_lines: MUST include after_line AND content
   - read_file/open_file: MUST include path
   - NEVER leave parameters empty, undefined, or incomplete

2. **ALWAYS call open_file BEFORE using edit tools**
   - replace_lines, insert_lines, delete_lines REQUIRE a file to be open first
   - You will get an error if you try to edit without opening a file
   - Workflow: open_file → read_lines (target area) → replace_lines

3. **If you hit token limits while generating large files:**
   - Create file with MINIMAL working content first (10-20 lines skeleton)
   - Then use replace_lines or insert_lines to add sections incrementally
   - NEVER try to generate 100+ lines in one create_file call

4. **For large code implementations:**
   - Break into phases: Phase 1 (core logic), Phase 2 (helpers), Phase 3 (UI)
   - Implement each phase separately with its own tool calls
   - Update the scratchpad "progress" entry after each phase

IMPORTANT RULES:
- Make SMALL, targeted edits. Replace 10-30 lines at a time, not 50+
- After editing, explain what you changed and which lines
- You can use multiple tools in sequence — but use the MINIMUM rounds needed
- Do NOT include trailing newlines in new_content for replace_lines

⚠️ CRITICAL — LINE NUMBER DRIFT:
Every edit changes line numbers for all subsequent lines in the file.
- After replace_lines or insert_lines, ALL line numbers below the edit shift
- You MUST call read_lines on the target region BEFORE each subsequent edit
- NEVER make a second edit using line numbers from before a previous edit
- The tool result includes surrounding context — verify your edit landed correctly
- Work TOP-DOWN (edit higher line numbers first) to minimize drift impact

Current context:
- Project: {{project}}
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

Respond with ONLY the commit message, no quotes or explanation. Use conventional commit format (feat:, fix:, refactor:, docs:, etc).`,

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
    } else {
        prompt = prompt.replace('{{project}}', 'None selected');
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

    return prompt;
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
