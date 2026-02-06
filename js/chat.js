/**
 * AI Editor - Chat Module
 * Chat pane logic and LLM interaction
 */

import { State, EventBus, Storage } from './core.js';
import { LLM, LLMDebug, LLMTools, generateEdit, generateCommitMessage, analyzeIssue, buildSystemPrompt, stripThinkBlocks } from './llm.js';
import { applyEdit, getContent, computeSimpleDiff, formatDiffForDisplay } from './editor.js';
import { GiteaAPI, loadFile } from './gitea.js';

// ============================================
// CHAT STATE
// ============================================

let chatContainer = null;
let inputElement = null;
let pendingEdit = null;  // { code, explanation } waiting for user approval

// ============================================
// LLM TOOL HANDLERS
// ============================================

// Register tool handlers for LLM function calling
LLMTools.handlers = {
    read_current_file: async () => {
        if (!State.currentFile) {
            return { error: 'No file is currently open in the editor. Use open_file first to open the target file.' };
        }
        const content = State.editorContent;
        const lines = content.split('\n');
        return {
            path: State.currentFile.path,
            content: content,
            line_count: lines.length,
            language: State.currentFile.path.split('.').pop()
        };
    },

    replace_lines: async ({ start_line, end_line, new_content }) => {
        if (!State.currentFile) {
            return { error: 'No file is currently open in the editor. Use open_file first to open the target file.' };
        }
        
        const lines = State.editorContent.split('\n');
        const totalLines = lines.length;
        
        // Validate line numbers
        if (start_line < 1 || end_line < start_line || start_line > totalLines) {
            return { 
                error: `Invalid line range. File has ${totalLines} lines. Got start=${start_line}, end=${end_line}` 
            };
        }
        
        // Clamp end_line to file length
        const clampedEnd = Math.min(end_line, totalLines);
        
        // Replace lines (convert to 0-indexed)
        const newLines = new_content.split('\n');
        lines.splice(start_line - 1, clampedEnd - start_line + 1, ...newLines);
        
        const newContent = lines.join('\n');
        applyEdit(newContent);
        
        return {
            success: true,
            path: State.currentFile.path,
            replaced_lines: `${start_line}-${clampedEnd}`,
            new_line_count: lines.length,
            message: `Replaced lines ${start_line}-${clampedEnd} with ${newLines.length} new lines. Review and save when ready.`
        };
    },

    insert_lines: async ({ after_line, content }) => {
        if (!State.currentFile) {
            return { error: 'No file is currently open in the editor. Use open_file first to open the target file, then use insert_lines.' };
        }
        
        const lines = State.editorContent.split('\n');
        const totalLines = lines.length;
        
        // Validate
        if (after_line < 0 || after_line > totalLines) {
            return { 
                error: `Invalid line number. File has ${totalLines} lines. after_line must be 0-${totalLines}` 
            };
        }
        
        // Insert lines
        const newLines = content.split('\n');
        lines.splice(after_line, 0, ...newLines);
        
        const newContent = lines.join('\n');
        applyEdit(newContent);
        
        return {
            success: true,
            path: State.currentFile.path,
            inserted_after: after_line,
            lines_inserted: newLines.length,
            new_line_count: lines.length,
            message: `Inserted ${newLines.length} lines after line ${after_line}. Review and save when ready.`
        };
    },

    delete_lines: async ({ start_line, end_line }) => {
        if (!State.currentFile) {
            return { error: 'No file is currently open in the editor. Use open_file first to open the target file.' };
        }
        
        const lines = State.editorContent.split('\n');
        const totalLines = lines.length;
        
        // Validate
        if (start_line < 1 || end_line < start_line || start_line > totalLines) {
            return { 
                error: `Invalid line range. File has ${totalLines} lines.` 
            };
        }
        
        const clampedEnd = Math.min(end_line, totalLines);
        const deletedCount = clampedEnd - start_line + 1;
        
        // Delete lines
        lines.splice(start_line - 1, deletedCount);
        
        const newContent = lines.join('\n');
        applyEdit(newContent);
        
        return {
            success: true,
            path: State.currentFile.path,
            deleted_lines: `${start_line}-${clampedEnd}`,
            lines_deleted: deletedCount,
            new_line_count: lines.length,
            message: `Deleted lines ${start_line}-${clampedEnd}. Review and save when ready.`
        };
    },

    get_project_tree: async ({ path = '' }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        let files = State.fileTree;
        if (path) {
            files = files.filter(f => f.path.startsWith(path));
        }
        return {
            project: `${State.currentProject.owner}/${State.currentProject.repo}`,
            branch: State.currentBranch,
            files: files.map(f => ({
                path: f.path,
                type: f.type,
                name: f.name
            }))
        };
    },

    open_file: async ({ path }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const file = State.fileTree.find(f => f.path === path);
        if (!file) {
            return { error: `File not found: ${path}` };
        }
        if (file.type === 'dir') {
            return { error: `Cannot open directory: ${path}` };
        }
        
        // Trigger file open through the global handler
        if (window.onTreeItemClick) {
            await window.onTreeItemClick(path, 'file', true); // true = pin as non-preview
        }
        
        return {
            success: true,
            path: path,
            message: `Opened ${path} in editor`
        };
    },

    read_file: async ({ path }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const { owner, repo } = State.currentProject;
        try {
            const file = await GiteaAPI.getFile(owner, repo, path, State.currentBranch);
            const lines = file.content.split('\n');
            return {
                path: file.path,
                content: file.content,
                line_count: lines.length,
                language: path.split('.').pop()
            };
        } catch (error) {
            return { error: `Failed to read file: ${error.message}` };
        }
    },

    list_open_tabs: async () => {
        return {
            tabs: State.openTabs.map((tab, index) => ({
                path: tab.path,
                dirty: tab.dirty,
                isPreview: tab.isPreview,
                isActive: index === State.activeTabIndex
            })),
            activeTab: State.activeTabIndex >= 0 ? State.openTabs[State.activeTabIndex]?.path : null
        };
    },

    // === FILE CREATION ===

    create_file: async ({ path, content = '', message = '' }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const { owner, repo } = State.currentProject;
        const branch = State.currentBranch || 'main';
        const commitMsg = message || `Create ${path}`;
        try {
            const result = await GiteaAPI.createFile(owner, repo, path, content, commitMsg, branch);
            EventBus.emit('tree:refresh');
            return {
                success: true,
                path: path,
                message: `Created ${path} on branch ${branch}`
            };
        } catch (error) {
            return { error: `Failed to create file ${path}: ${error.message}` };
        }
    },

    // === SEARCH ===

    search_in_files: async ({ query, path = '', max_results = 20 }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const { owner, repo } = State.currentProject;
        const branch = State.currentBranch || 'main';
        try {
            let files = State.fileTree.filter(f => f.type !== 'dir');
            if (path) files = files.filter(f => f.path.startsWith(path));

            const textExts = new Set([
                'js','ts','jsx','tsx','py','go','rs','c','cpp','h','hpp',
                'java','rb','php','css','scss','html','htm','xml','json',
                'yaml','yml','toml','md','txt','sh','bash','sql','vue',
                'svelte','conf','cfg','ini','pl','pm'
            ]);
            files = files.filter(f => {
                const ext = f.path.split('.').pop().toLowerCase();
                const name = f.path.split('/').pop().toLowerCase();
                return textExts.has(ext) || textExts.has(name);
            });

            const results = [];
            const queryLower = query.toLowerCase();
            for (const file of files.slice(0, 50)) {
                if (results.length >= max_results) break;
                try {
                    const fileData = await GiteaAPI.getFile(owner, repo, file.path, branch);
                    const lines = fileData.content.split('\n');
                    const matches = [];
                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i].toLowerCase().includes(queryLower)) {
                            matches.push({ line: i + 1, text: lines[i].trim().substring(0, 200) });
                            if (matches.length >= 5) break;
                        }
                    }
                    if (matches.length > 0) {
                        results.push({ path: file.path, matches });
                    }
                } catch (e) { /* skip unreadable files */ }
            }
            return {
                query, files_searched: Math.min(files.length, 50),
                results,
                message: results.length > 0
                    ? `Found "${query}" in ${results.length} file(s)`
                    : `No matches for "${query}"`
            };
        } catch (error) {
            return { error: `Search failed: ${error.message}` };
        }
    },

    // === ISSUE TOOL HANDLERS ===

    list_issues: async ({ state = 'open', labels = '' } = {}) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const { owner, repo } = State.currentProject;
        try {
            const params = new URLSearchParams({ state, type: 'issues', limit: '50' });
            if (labels) params.append('labels', labels);
            const url = `${State.settings.giteaUrl}/api/v1/repos/${owner}/${repo}/issues?${params}`;
            const response = await fetch(url, {
                headers: { 'Authorization': `token ${State.settings.giteaToken}` }
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const issues = await response.json();
            return {
                project: `${owner}/${repo}`,
                count: issues.length,
                issues: issues.map(i => ({
                    number: i.number,
                    title: i.title,
                    state: i.state,
                    labels: (i.labels || []).map(l => l.name),
                    created: i.created_at,
                    assignee: i.assignee?.login || null
                }))
            };
        } catch (error) {
            return { error: `Failed to list issues: ${error.message}` };
        }
    },

    read_issue: async ({ number }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const { owner, repo } = State.currentProject;
        try {
            const url = `${State.settings.giteaUrl}/api/v1/repos/${owner}/${repo}/issues/${number}`;
            const response = await fetch(url, {
                headers: { 'Authorization': `token ${State.settings.giteaToken}` }
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const issue = await response.json();

            // Also fetch comments
            const commentsUrl = `${url}/comments`;
            const commentsResp = await fetch(commentsUrl, {
                headers: { 'Authorization': `token ${State.settings.giteaToken}` }
            });
            const comments = commentsResp.ok ? await commentsResp.json() : [];

            return {
                number: issue.number,
                title: issue.title,
                body: issue.body,
                state: issue.state,
                labels: (issue.labels || []).map(l => l.name),
                assignee: issue.assignee?.login || null,
                created: issue.created_at,
                comments: comments.slice(0, 20).map(c => ({
                    user: c.user?.login,
                    body: c.body,
                    created: c.created_at
                }))
            };
        } catch (error) {
            return { error: `Failed to read issue #${number}: ${error.message}` };
        }
    },

    create_issue: async ({ title, body = '', labels = [] }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const { owner, repo } = State.currentProject;
        try {
            const url = `${State.settings.giteaUrl}/api/v1/repos/${owner}/${repo}/issues`;
            const payload = { title, body };
            if (labels.length > 0) payload.labels = labels; // Gitea expects label IDs for creation; names might not work
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `token ${State.settings.giteaToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const issue = await response.json();
            // Refresh issues list
            EventBus.emit('issues:refresh');
            return {
                success: true,
                number: issue.number,
                title: issue.title,
                url: issue.html_url,
                message: `Created issue #${issue.number}: ${issue.title}`
            };
        } catch (error) {
            return { error: `Failed to create issue: ${error.message}` };
        }
    },

    update_issue: async ({ number, title, body, state }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const { owner, repo } = State.currentProject;
        try {
            const url = `${State.settings.giteaUrl}/api/v1/repos/${owner}/${repo}/issues/${number}`;
            const payload = {};
            if (title !== undefined) payload.title = title;
            if (body !== undefined) payload.body = body;
            if (state !== undefined) payload.state = state;
            const response = await fetch(url, {
                method: 'PATCH',
                headers: {
                    'Authorization': `token ${State.settings.giteaToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const issue = await response.json();
            EventBus.emit('issues:refresh');
            return {
                success: true,
                number: issue.number,
                title: issue.title,
                state: issue.state,
                message: `Updated issue #${issue.number}`
            };
        } catch (error) {
            return { error: `Failed to update issue #${number}: ${error.message}` };
        }
    },

    add_issue_comment: async ({ number, body }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const { owner, repo } = State.currentProject;
        try {
            const url = `${State.settings.giteaUrl}/api/v1/repos/${owner}/${repo}/issues/${number}/comments`;
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `token ${State.settings.giteaToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ body })
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const comment = await response.json();
            return {
                success: true,
                issue_number: number,
                comment_id: comment.id,
                message: `Added comment to issue #${number}`
            };
        } catch (error) {
            return { error: `Failed to add comment to issue #${number}: ${error.message}` };
        }
    }
};

// Execute a tool call from the LLM
async function executeToolCall(toolCall) {
    const handler = LLMTools.handlers[toolCall.function.name];
    if (!handler) {
        return { error: `Unknown tool: ${toolCall.function.name}` };
    }
    
    try {
        const args = JSON.parse(toolCall.function.arguments || '{}');
        const result = await handler(args);
        return result;
    } catch (error) {
        return { error: `Tool execution failed: ${error.message}` };
    }
}

// ============================================
// INITIALIZATION
// ============================================

function initChat(containerEl, inputEl) {
    chatContainer = containerEl;
    inputElement = inputEl;

    // Load chat history from storage
    const savedHistory = Storage.get('chatHistory', []);
    State.chatHistory = savedHistory.slice(-50); // Keep last 50 messages

    renderMessages();
    setupInputHandlers();

    // Listen for LLM events
    EventBus.on('llm:token', ({ token, content }) => {
        updateStreamingMessage(content);
    });

    EventBus.on('llm:generating', (isGenerating) => {
        if (inputElement) {
            inputElement.disabled = isGenerating;
        }
    });

    EventBus.on('editor:editApplied', ({ original, updated }) => {
        const diff = computeSimpleDiff(original, updated);
        if (diff.length > 0) {
            addMessage('system', `✅ Applied ${diff.length} change(s) to editor.`);
        }
    });
}

function setupInputHandlers() {
    if (!inputElement) return;

    inputElement.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            await handleUserInput();
        }
    });
}

// ============================================
// MESSAGE MANAGEMENT
// ============================================

function addMessage(role, content, meta = {}) {
    const message = {
        role,
        content,
        timestamp: Date.now(),
        ...meta
    };

    State.chatHistory.push(message);
    
    // Persist (keep last 100)
    const toSave = State.chatHistory.slice(-100);
    Storage.set('chatHistory', toSave);

    renderMessage(message);
    scrollToBottom();

    EventBus.emit('chat:message', message);
    return message;
}

function addStreamingMessage() {
    const messageEl = document.createElement('div');
    messageEl.className = 'chat-message assistant streaming';
    messageEl.id = 'streaming-message';
    messageEl.innerHTML = `
        <div class="message-header">
            <span class="message-role">🤖 Assistant</span>
            <span class="message-time">now</span>
        </div>
        <div class="message-content">
            <span class="typing-indicator">●●●</span>
        </div>
    `;
    chatContainer.appendChild(messageEl);
    scrollToBottom();
    return messageEl;
}

function updateStreamingMessage(content) {
    const messageEl = document.getElementById('streaming-message');
    if (messageEl) {
        const contentEl = messageEl.querySelector('.message-content');
        contentEl.innerHTML = formatMessageContent(content);
        scrollToBottom();
    }
}

function finalizeStreamingMessage(content, meta = {}) {
    const messageEl = document.getElementById('streaming-message');
    if (messageEl) {
        messageEl.classList.remove('streaming');
        messageEl.removeAttribute('id');
        
        const contentEl = messageEl.querySelector('.message-content');
        contentEl.innerHTML = formatMessageContent(content);
        
        // Add action buttons if there's code
        if (meta.hasCode) {
            const actionsEl = document.createElement('div');
            actionsEl.className = 'message-actions';
            actionsEl.innerHTML = `
                <button class="btn-apply" onclick="window.Chat.applyPendingEdit()">✅ Apply to Editor</button>
                <button class="btn-reject" onclick="window.Chat.rejectPendingEdit()">❌ Reject</button>
            `;
            messageEl.appendChild(actionsEl);
        }
    }

    // Add to history
    State.chatHistory.push({
        role: 'assistant',
        content,
        timestamp: Date.now(),
        ...meta
    });
    Storage.set('chatHistory', State.chatHistory.slice(-100));
}

function renderMessage(message) {
    const messageEl = document.createElement('div');
    messageEl.className = `chat-message ${message.role}`;
    
    const roleIcon = {
        user: '👤',
        assistant: '🤖',
        system: 'ℹ️',
        error: '❌'
    }[message.role] || '💬';

    const roleName = {
        user: 'You',
        assistant: 'Assistant',
        system: 'System',
        error: 'Error'
    }[message.role] || message.role;

    const time = new Date(message.timestamp).toLocaleTimeString();

    messageEl.innerHTML = `
        <div class="message-header">
            <span class="message-role">${roleIcon} ${roleName}</span>
            <span class="message-time">${time}</span>
        </div>
        <div class="message-content">${formatMessageContent(message.content)}</div>
    `;

    chatContainer.appendChild(messageEl);
}

/**
 * Add a collapsible tool call message showing tool name, args summary, and result.
 * Renders inline in the chat as a compact system message with expandable details.
 */
function addToolCallMessage(toolName, args, result) {
    // Build a short args summary for the header
    const argSummary = summarizeToolArgs(toolName, args);
    
    // Determine result status
    const isError = result?.error;
    const statusIcon = isError ? '❌' : '✅';
    const resultSummary = summarizeToolResult(toolName, result);
    
    // Format full args and result for the expandable section
    const argsJson = JSON.stringify(args, null, 2);
    const resultJson = JSON.stringify(result, null, 2);
    // Truncate very long results (e.g., file contents)
    const truncatedResult = resultJson.length > 2000 
        ? resultJson.substring(0, 2000) + '\n... (truncated)'
        : resultJson;

    const messageEl = document.createElement('div');
    messageEl.className = `chat-message tool-call ${isError ? 'tool-error' : 'tool-success'}`;
    messageEl.innerHTML = `
        <details class="tool-call-details">
            <summary class="tool-call-summary">
                <span class="tool-call-icon">🔧</span>
                <span class="tool-call-name">${escapeHtml(toolName)}</span>
                <span class="tool-call-args-summary">${escapeHtml(argSummary)}</span>
                <span class="tool-call-status">${statusIcon} ${escapeHtml(resultSummary)}</span>
            </summary>
            <div class="tool-call-body">
                <div class="tool-call-section">
                    <div class="tool-call-label">Arguments</div>
                    <pre class="tool-call-json">${escapeHtml(argsJson)}</pre>
                </div>
                <div class="tool-call-section">
                    <div class="tool-call-label">Result</div>
                    <pre class="tool-call-json">${escapeHtml(truncatedResult)}</pre>
                </div>
            </div>
        </details>
    `;
    chatContainer.appendChild(messageEl);
    scrollToBottom();

    // Don't add to chatHistory (tool calls are tracked in the message thread already)
}

function summarizeToolArgs(toolName, args) {
    if (!args || Object.keys(args).length === 0) return '';
    
    switch (toolName) {
        case 'read_file':
        case 'open_file':
            return args.path || '';
        case 'read_current_file':
        case 'list_open_tabs':
        case 'get_project_tree':
            return args.path || '';
        case 'replace_lines':
            return `L${args.start_line}-${args.end_line}`;
        case 'insert_lines':
            return `after L${args.after_line} (${(args.content || '').split('\n').length} lines)`;
        case 'delete_lines':
            return `L${args.start_line}-${args.end_line}`;
        case 'create_file':
            return args.path || '';
        case 'search_in_files':
            return `"${args.query}"${args.path ? ` in ${args.path}` : ''}`;
        case 'read_issue':
            return `#${args.number}`;
        case 'list_issues':
            return args.state || 'open';
        case 'create_issue':
            return args.title ? `"${args.title.substring(0, 50)}"` : '';
        case 'update_issue':
            return `#${args.number}`;
        case 'add_issue_comment':
            return `#${args.number}`;
        default:
            // Show first string arg
            const firstArg = Object.entries(args).find(([k, v]) => typeof v === 'string');
            return firstArg ? `${firstArg[0]}=${firstArg[1].substring(0, 40)}` : '';
    }
}

function summarizeToolResult(toolName, result) {
    if (!result) return 'no result';
    if (result.error) return result.error.substring(0, 80);
    
    switch (toolName) {
        case 'read_file':
        case 'read_current_file':
            return `${result.line_count || '?'} lines`;
        case 'get_project_tree':
            return `${result.files?.length || 0} files`;
        case 'open_file':
            return result.message || 'opened';
        case 'replace_lines':
        case 'insert_lines':
        case 'delete_lines':
            return result.message || 'edited';
        case 'create_file':
            return result.message || 'created';
        case 'search_in_files':
            return `${result.results?.length || 0} matches in ${result.files_searched || 0} files`;
        case 'list_issues':
            return `${result.count || 0} issues`;
        case 'read_issue':
            return result.title ? `#${result.number}: ${result.title.substring(0, 50)}` : 'loaded';
        case 'create_issue':
            return result.message || 'created';
        case 'update_issue':
            return result.message || 'updated';
        case 'add_issue_comment':
            return result.message || 'commented';
        default:
            return result.message || result.success ? 'done' : JSON.stringify(result).substring(0, 60);
    }
}

function renderMessages() {
    if (!chatContainer) return;
    
    chatContainer.innerHTML = '';
    
    if (State.chatHistory.length === 0) {
        chatContainer.innerHTML = `
            <div class="chat-welcome">
                <h3>👋 Welcome to AI Editor</h3>
                <p>Ask me to:</p>
                <ul>
                    <li>Edit or refactor code</li>
                    <li>Explain what code does</li>
                    <li>Write new functions or files</li>
                    <li>Fix bugs or improve code</li>
                </ul>
                <p class="hint">Tip: Select code in the editor and ask about it specifically!</p>
            </div>
        `;
        return;
    }

    State.chatHistory.forEach(msg => renderMessage(msg));
    scrollToBottom();
}

function clearChat() {
    State.chatHistory = [];
    Storage.set('chatHistory', []);
    renderMessages();
    EventBus.emit('chat:cleared');
}

// ============================================
// MESSAGE FORMATTING
// ============================================

function formatMessageContent(content) {
    if (!content) return '';
    
    let html = escapeHtml(content);
    
    // Code blocks with syntax highlighting hint
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
        const langClass = lang ? `language-${lang}` : '';
        return `<pre class="code-block ${langClass}"><code>${code.trim()}</code></pre>`;
    });
    
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
    
    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    
    // Italic
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    
    // Line breaks
    html = html.replace(/\n/g, '<br>');
    
    return html;
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

function scrollToBottom() {
    if (chatContainer) {
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }
}

// ============================================
// USER INPUT HANDLING
// ============================================

async function handleUserInput() {
    const input = inputElement.value.trim();
    if (!input || State.isGenerating) return;

    inputElement.value = '';
    
    // Add user message
    addMessage('user', input);

    // Determine intent
    const intent = detectIntent(input);

    try {
        switch (intent) {
            case 'edit':
                await handleEditRequest(input);
                break;
            case 'explain':
                await handleExplainRequest(input);
                break;
            case 'commit':
                await handleCommitRequest();
                break;
            case 'issue':
                await handleIssueRequest(input);
                break;
            default:
                await handleGeneralRequest(input);
        }
    } catch (error) {
        console.error('Chat error:', error);
        addMessage('error', `Error: ${error.message}`);
    }
}

function detectIntent(input) {
    const lower = input.toLowerCase();
    
    // Commit message is very specific, check first
    if (lower.includes('commit message') || lower.includes('generate commit')) {
        return 'commit';
    }
    
    // Issue reference — but only simple "work on issue" requests
    if ((lower.includes('issue #') || lower.includes('work on issue') || lower.includes('implement issue'))
        && !lower.includes('find') && !lower.includes('search') && !lower.includes('create')) {
        return 'issue';
    }
    
    // Edit intent — ONLY if a file is already open.
    // Without a file, the general handler uses tools to find the right file.
    if (State.currentFile) {
        if (lower.includes('edit') || lower.includes('change') || lower.includes('modify') ||
            lower.includes('refactor') || lower.includes('rewrite')) {
            return 'edit';
        }
        // Weaker signals — only edit if clearly about current file
        if ((lower.includes('fix') || lower.includes('add') || lower.includes('remove') || lower.includes('update'))
            && !lower.includes('find') && !lower.includes('search') && !lower.includes('file')
            && !lower.includes('create') && !lower.includes('new file') && !lower.includes('project')
            && !lower.includes('think') && !lower.includes('can you') && !lower.includes('where')
            && !lower.includes('review') && !lower.includes('which')) {
            return 'edit';
        }
    }
    
    // Explain — works with or without a file
    // Use word boundaries to avoid false positives like "understanding" → should be "general"
    if (/\bexplain\b/.test(lower) || /\bwhat does\b/.test(lower) || /\bhow does\b/.test(lower) ||
        /\bwhy does\b/.test(lower) || /\bunderstand\b/.test(lower)) {
        return 'explain';
    }
    
    // Everything else → general handler with full tool access
    return 'general';
}

// ============================================
// REQUEST HANDLERS
// ============================================

async function handleEditRequest(input) {
    if (!State.currentFile) {
        // No file open — use general handler so LLM can use tools to find the right file
        addMessage('system', 'ℹ️ No file open — investigating with tools...');
        await handleGeneralRequest(input);
        return;
    }

    addStreamingMessage();

    const result = await generateEdit(input, (token, content) => {
        updateStreamingMessage(content);
    });

    if (result.code) {
        pendingEdit = result;
        finalizeStreamingMessage(result.raw, { hasCode: true });
    } else {
        finalizeStreamingMessage(result.raw, { hasCode: false });
    }
}

async function handleExplainRequest(input) {
    // Explain requests benefit from tool access (reading files, searching code)
    // Delegate to general handler which has the full tool loop
    await handleGeneralRequest(input);
}

async function handleCommitRequest() {
    if (!State.currentFile || !State.editorDirty) {
        addMessage('system', '⚠️ No changes to commit.');
        return;
    }

    addMessage('system', '🔄 Generating commit message...');

    try {
        const commitMsg = await generateCommitMessage();
        addMessage('assistant', `Suggested commit message:\n\n\`${commitMsg}\`\n\nYou can use this when saving.`);
        
        // Store for later use
        State.suggestedCommitMessage = commitMsg;
    } catch (error) {
        addMessage('error', `Failed to generate commit message: ${error.message}`);
    }
}

async function handleIssueRequest(input) {
    // Extract issue number
    const match = input.match(/issue\s*#?(\d+)/i);
    if (!match) {
        addMessage('system', '⚠️ Please specify an issue number (e.g., "work on issue #42")');
        return;
    }

    const issueNumber = parseInt(match[1]);
    const issue = State.issues.find(i => i.number === issueNumber);
    
    if (!issue) {
        addMessage('system', `⚠️ Issue #${issueNumber} not found. Try refreshing the project.`);
        return;
    }

    // Show issue context
    addMessage('system', `📋 **Issue #${issue.number}: ${issue.title}**\n\n${issue.body || 'No description'}`);
    
    // Route through general handler with full tool access
    const enrichedInput = `Work on issue #${issue.number}: "${issue.title}"\n\nIssue description:\n${issue.body || 'No description'}\n\nOriginal request: ${input}\n\nPlease investigate the codebase to understand what needs to change, then make the necessary edits.`;
    await handleGeneralRequest(enrichedInput);
}

async function handleGeneralRequest(input) {
    addStreamingMessage();

    const systemPrompt = buildSystemPrompt();
    const roleTools = LLMTools.getToolsForRole();
    
    // DEBUG: Why are tools empty?
    if (!roleTools || roleTools.length === 0) {
        const allDefs = LLMTools.definitions?.length || 0;
        const role = State.settings.role || 'undefined';
        console.error(`[TOOL-DEBUG] roleTools empty! definitions=${allDefs}, role="${role}"`);
        addMessage('system', `⚠️ Tool debug: roleTools=${roleTools?.length || 0}, definitions=${allDefs}, role="${role}"`);
    }

    // Build initial message thread
    const messages = [
        { role: 'system', content: systemPrompt },
        ...State.chatHistory.slice(-6).filter(m => m.role !== 'system'),
        { role: 'user', content: input }
    ];

    // Iterative tool call loop — max 8 rounds to support complex workflows
    const MAX_TOOL_ROUNDS = 8;
    let finalContent = '';
    const toolActions = []; // Track all tool executions for fallback summary

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        let content = '';
        let result;

        try {
            if (round === 0) {
                // First round: STREAM to user for responsiveness
                const chatOptions = {
                    stream: true,
                    tools: roleTools,
                    onToken: (token, fullContent) => {
                        content = fullContent;
                        updateStreamingMessage(fullContent);
                    }
                };

                result = await Promise.race([
                    LLM.chat(messages, chatOptions),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Response timeout (60s)')), 60000)
                    )
                ]);
            } else {
                const chatOptions = { stream: true, tools: roleTools };

                // Show thinking indicator
                updateStreamingMessage(finalContent || '*(processing tool results...)*');

                result = await Promise.race([
                    LLM.chat(messages, chatOptions),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Response timeout (90s)')), 90000)
                    )
                ]);

                content = result.content || '';
                // Show the new content
                if (content) {
                    const combined = finalContent ? finalContent + '\n\n' + content : content;
                    updateStreamingMessage(combined);
                }
            }

            // Keep isGenerating true between rounds
            State.isGenerating = true;
            EventBus.emit('llm:generating', true);

        } catch (err) {
            // Abort any in-flight request
            LLM.stop();
            
            if (toolActions.length > 0) {
                // Show what tools did accomplish
                const summaryLines = toolActions.map(a => {
                    const status = a.error ? '❌' : '✅';
                    const detail = a.result?.message || a.result?.error || '';
                    return `${status} **${a.tool}**${a.args?.path ? ` \`${a.args.path}\`` : ''}${detail ? ` — ${detail}` : ''}`;
                });
                finalContent = (finalContent ? finalContent + '\n\n' : '') + 
                    `⚠️ Follow-up failed (${err.message}). Tool results:\n\n${summaryLines.join('\n')}`;
            } else if (content) {
                finalContent = content;
            } else {
                throw err;
            }
            break;
        }

        // === LAYER 1: Structured tool_calls from API (primary path) ===
        let toolCalls = result.toolCalls ? [...result.toolCalls] : [];
        let cleanContent = stripThinkBlocks(content || result.content || '');
        let toolCallSource = toolCalls.length > 0 ? 'structured' : null;

        // === LAYER 2: Text-format fallback ===
        // If no structured tool_calls, check content for text-format tool calls.
        // Handles APIs (e.g. Venice + Kimi K2) that emit tool call tokens in
        // delta.content instead of delta.tool_calls.
        // Safe: think blocks already stripped by streaming handler + stripThinkBlocks.
        if (toolCalls.length === 0 && cleanContent) {
            const parsed = parseTextToolCalls(cleanContent);
            if (parsed.toolCalls.length > 0) {
                toolCalls = parsed.toolCalls;
                cleanContent = parsed.cleanContent;
                toolCallSource = 'text';
                updateStreamingMessage(cleanContent || finalContent || '');
            }
        }

        // Accumulate text content across rounds
        if (cleanContent.trim()) {
            finalContent = finalContent ? finalContent + '\n\n' + cleanContent : cleanContent;
        }

        if (toolCalls.length > 0) {
            // === EXECUTE TOOL CALLS ===
            const structuredResults = [];  // For proper OpenAI tool threading
            const textResults = [];        // For user-message injection fallback

            for (const toolCall of toolCalls) {
                const toolName = toolCall.function?.name || 'unknown';
                let args = {};
                try {
                    args = JSON.parse(toolCall.function?.arguments || '{}');
                } catch (e) { /* malformed args */ }

                const toolResult = await executeToolCall(toolCall);

                // Show collapsible tool call detail
                addToolCallMessage(toolName, args, toolResult);

                toolActions.push({
                    tool: toolName,
                    args: args,
                    result: toolResult,
                    error: !!toolResult?.error
                });

                if (toolCallSource === 'structured') {
                    structuredResults.push({
                        tool_call_id: toolCall.id,
                        role: 'tool',
                        content: JSON.stringify(toolResult)
                    });
                } else {
                    textResults.push({ name: toolName, result: toolResult });
                }
            }

            // === BUILD THREAD FOR NEXT ROUND ===
            if (toolCallSource === 'structured') {
                // Proper OpenAI threading: assistant with tool_calls → tool results
                messages.push({
                    role: 'assistant',
                    content: cleanContent || null,
                    tool_calls: toolCalls
                });
                for (const tr of structuredResults) {
                    messages.push(tr);
                }
            } else {
                // Text-parsed: inject results as user context
                // (API didn't return structured tool_calls, so we can't use tool role)
                messages.push({ role: 'assistant', content: cleanContent || null });
                const summary = textResults.map(tr =>
                    `[Tool: ${tr.name}]\n${JSON.stringify(tr.result, null, 2)}`
                ).join('\n\n');
                messages.push({
                    role: 'user',
                    content: `Tool results:\n${summary}\n\nContinue using these results. Use additional tools if needed, otherwise provide your final response.`
                });
            }

            // Prepare UI for next round
            const partialEl = document.getElementById('streaming-message');
            if (partialEl) {
                if (finalContent) {
                    partialEl.querySelector('.message-content').innerHTML = formatMessageContent(finalContent);
                    partialEl.classList.remove('streaming');
                }
                partialEl.removeAttribute('id');
            }
            addStreamingMessage();
            continue;
        }

        // === NO TOOL CALLS — CHECK IF WE'RE DONE ===
        // If finish_reason is 'tool_calls' but no tool calls found, model may be confused
        if (result.finishReason === 'tool_calls') {
            console.warn('Model signaled tool_calls but none were parsed — ending loop');
        }

        break;
    }

    // Handle empty responses
    if (!finalContent.trim()) {
        if (toolActions.length > 0) {
            const summaryLines = toolActions.map(a => {
                const status = a.error ? '❌' : '✅';
                const detail = a.result?.message || a.result?.error || '';
                return `${status} **${a.tool}**${a.args?.path ? ` \`${a.args.path}\`` : ''}${detail ? ` — ${detail}` : ''}`;
            });
            finalContent = `Completed ${toolActions.length} tool call${toolActions.length > 1 ? 's' : ''} but the model did not provide a summary:\n\n${summaryLines.join('\n')}`;
        } else {
            finalContent = '*The model returned an empty response. Try rephrasing or switching models.*';
        }
    }

    finalizeStreamingMessage(finalContent, { hasCode: false });
}

/**
 * Parse tool calls embedded as text in LLM content.
 * 
 * IMPORTANT: This is a FALLBACK for APIs that don't return structured tool_calls
 * (e.g. Venice.ai + Kimi K2). Only called when result.toolCalls is empty.
 * Content MUST have think blocks stripped before calling this function.
 * 
 * Returns { toolCalls: [], cleanContent: string }
 */
function parseTextToolCalls(text) {
    if (!text) return { toolCalls: [], cleanContent: text };

    const toolCalls = [];
    let cleanContent = text;
    let match;

    // Kimi K2: <|tool_calls_section_begin|>...<|tool_calls_section_end|>
    const kimiSectionPattern = /<\|tool_calls_section_begin\|>([\s\S]*?)<\|tool_calls_section_end\|>/gi;
    while ((match = kimiSectionPattern.exec(text)) !== null) {
        const sectionBlock = match[1];
        const kimiCallPattern = /<\|tool_call_begin\|>\s*(?:functions\.)?(\S+?)(?::\d+)?\s*<\|tool_call_argument_begin\|>\s*([\s\S]*?)\s*<\|tool_call_end\|>/gi;
        let kimiMatch;
        while ((kimiMatch = kimiCallPattern.exec(sectionBlock)) !== null) {
            const fnName = kimiMatch[1].trim();
            const argsStr = kimiMatch[2].trim();
            let args = {};
            try { args = JSON.parse(argsStr); } catch (e) { args = { _raw: argsStr }; }
            toolCalls.push({
                id: `text_call_${toolCalls.length}`,
                type: 'function',
                function: { name: fnName, arguments: JSON.stringify(args) }
            });
        }
        cleanContent = cleanContent.replace(match[0], '');
    }

    // JSON in tags: <tool_call>{"name":"fn","arguments":{...}}</tool_call> or <function_call>
    const jsonToolPattern = /<(?:tool_call|function_call)>\s*(\{[\s\S]*?\})\s*<\/(?:tool_call|function_call)>/gi;
    while ((match = jsonToolPattern.exec(text)) !== null) {
        try {
            const parsed = JSON.parse(match[1]);
            toolCalls.push({
                id: `text_call_${toolCalls.length}`,
                type: 'function',
                function: {
                    name: parsed.name || parsed.function?.name || '',
                    arguments: typeof parsed.arguments === 'string'
                        ? parsed.arguments
                        : JSON.stringify(parsed.arguments || parsed.parameters || {})
                }
            });
            cleanContent = cleanContent.replace(match[0], '');
        } catch (e) { /* invalid JSON, skip */ }
    }

    // MiniMax XML: <minimax:tool_call><invoke name="fn"><parameter name="k">v</parameter></invoke></minimax:tool_call>
    const minimaxPattern = /<minimax:tool_call>([\s\S]*?)<\/minimax:tool_call>/gi;
    while ((match = minimaxPattern.exec(text)) !== null) {
        const invokeBlock = match[1];
        const invokePattern = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/gi;
        let invokeMatch;
        while ((invokeMatch = invokePattern.exec(invokeBlock)) !== null) {
            const args = {};
            const paramPattern = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/gi;
            let paramMatch;
            while ((paramMatch = paramPattern.exec(invokeMatch[2])) !== null) {
                args[paramMatch[1]] = paramMatch[2].trim();
            }
            toolCalls.push({
                id: `text_call_${toolCalls.length}`,
                type: 'function',
                function: { name: invokeMatch[1], arguments: JSON.stringify(args) }
            });
        }
        cleanContent = cleanContent.replace(match[0], '');
    }

    // Generic XML: <tool_call><name>fn</name><arguments>{...}</arguments></tool_call>
    const genericPattern = /<tool_call>\s*<name>([^<]+)<\/name>\s*<arguments>([\s\S]*?)<\/arguments>\s*<\/tool_call>/gi;
    while ((match = genericPattern.exec(text)) !== null) {
        toolCalls.push({
            id: `text_call_${toolCalls.length}`,
            type: 'function',
            function: { name: match[1].trim(), arguments: match[2].trim() }
        });
        cleanContent = cleanContent.replace(match[0], '');
    }

    return { toolCalls, cleanContent: cleanContent.trim() };
}

// ============================================
// EDIT APPROVAL
// ============================================

function applyPendingEdit() {
    if (!pendingEdit || !pendingEdit.code) {
        addMessage('system', '⚠️ No pending edit to apply.');
        return;
    }

    applyEdit(pendingEdit.code);
    addMessage('system', '✅ Edit applied to editor. Review and save when ready.');
    pendingEdit = null;

    // Remove action buttons
    document.querySelectorAll('.message-actions').forEach(el => el.remove());
}

function rejectPendingEdit() {
    if (!pendingEdit) return;
    
    addMessage('system', '❌ Edit rejected. Ask me to try a different approach.');
    pendingEdit = null;

    // Remove action buttons
    document.querySelectorAll('.message-actions').forEach(el => el.remove());
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

function stopGeneration() {
    LLM.stop();
    
    const streamingEl = document.getElementById('streaming-message');
    if (streamingEl) {
        const content = streamingEl.querySelector('.message-content').textContent;
        streamingEl.remove();
        addMessage('assistant', content + '\n\n*(generation stopped)*');
    }
}

function sendMessage(content) {
    if (inputElement) {
        inputElement.value = content;
        handleUserInput();
    }
}

// ============================================
// EXPOSE TO GLOBAL (for onclick handlers)
// ============================================

/**
 * Export the current chat as markdown text and copy to clipboard.
 * Walks the DOM to capture all messages including tool call details.
 */
function exportChat() {
    if (!chatContainer) return;

    const lines = [];
    const modelName = State.settings.llmModel || 'unknown';
    const project = State.currentProject 
        ? `${State.currentProject.owner}/${State.currentProject.repo}` 
        : 'none';
    
    lines.push(`# AI Editor Chat Export`);
    lines.push(`- **Model:** ${modelName}`);
    lines.push(`- **Project:** ${project}`);
    lines.push(`- **Branch:** ${State.currentBranch || 'main'}`);
    lines.push(`- **Exported:** ${new Date().toLocaleString()}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    const messages = chatContainer.querySelectorAll('.chat-message');
    for (const msg of messages) {
        // Tool call messages
        if (msg.classList.contains('tool-call')) {
            const summary = msg.querySelector('.tool-call-summary');
            const nameEl = msg.querySelector('.tool-call-name');
            const argsSummEl = msg.querySelector('.tool-call-args-summary');
            const statusEl = msg.querySelector('.tool-call-status');
            const argsJson = msg.querySelector('.tool-call-section:first-child .tool-call-json');
            const resultJson = msg.querySelector('.tool-call-section:last-child .tool-call-json');

            const name = nameEl?.textContent?.trim() || 'unknown';
            const argsSumm = argsSummEl?.textContent?.trim() || '';
            const status = statusEl?.textContent?.trim() || '';

            lines.push(`> 🔧 **${name}** ${argsSumm} → ${status}`);

            // Include args and result in collapsed detail
            if (argsJson?.textContent?.trim()) {
                lines.push(`> <details><summary>Details</summary>`);
                lines.push(`>`);
                lines.push(`> **Args:**`);
                lines.push(`> \`\`\`json`);
                for (const line of argsJson.textContent.trim().split('\n')) {
                    lines.push(`> ${line}`);
                }
                lines.push(`> \`\`\``);
                if (resultJson?.textContent?.trim()) {
                    lines.push(`> **Result:**`);
                    lines.push(`> \`\`\`json`);
                    // Truncate very long results
                    const resultText = resultJson.textContent.trim();
                    const resultLines = resultText.split('\n');
                    const maxLines = 30;
                    for (const line of resultLines.slice(0, maxLines)) {
                        lines.push(`> ${line}`);
                    }
                    if (resultLines.length > maxLines) {
                        lines.push(`> ... (${resultLines.length - maxLines} more lines)`);
                    }
                    lines.push(`> \`\`\``);
                }
                lines.push(`> </details>`);
            }
            lines.push('');
            continue;
        }

        // Regular messages
        const roleEl = msg.querySelector('.message-role');
        const timeEl = msg.querySelector('.message-time');
        const contentEl = msg.querySelector('.message-content');

        const role = roleEl?.textContent?.trim() || 'Unknown';
        const time = timeEl?.textContent?.trim() || '';
        const content = contentEl?.textContent?.trim() || '';

        if (msg.classList.contains('user')) {
            lines.push(`### 👤 You (${time})`);
        } else if (msg.classList.contains('assistant')) {
            lines.push(`### 🤖 Assistant (${time})`);
        } else if (msg.classList.contains('system')) {
            lines.push(`### ℹ️ System (${time})`);
        } else if (msg.classList.contains('error')) {
            lines.push(`### ❌ Error (${time})`);
        } else {
            lines.push(`### ${role} (${time})`);
        }

        lines.push(content);
        lines.push('');
    }

    // Cost summary
    if (State.sessionCost.requests > 0) {
        lines.push('---');
        lines.push('');
        lines.push(`**Session:** ${State.sessionCost.totalInputTokens + State.sessionCost.totalOutputTokens} tokens (${State.sessionCost.totalInputTokens}↓ ${State.sessionCost.totalOutputTokens}↑) · $${State.sessionCost.totalCost.toFixed(4)} · ${State.sessionCost.requests} requests`);
    }

    const text = lines.join('\n');

    // Copy to clipboard
    navigator.clipboard.writeText(text).then(() => {
        window.showToast('Chat copied to clipboard', 'success');
    }).catch(() => {
        // Fallback: select in a textarea
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        window.showToast('Chat copied to clipboard', 'success');
    });
}

window.Chat = {
    applyPendingEdit,
    rejectPendingEdit,
    stopGeneration,
    clearChat,
    sendMessage,
    executeToolCall,
    exportChat
};

// ============================================
// EXPORTS
// ============================================

export {
    initChat,
    addMessage,
    clearChat,
    stopGeneration,
    sendMessage,
    applyPendingEdit,
    rejectPendingEdit,
    executeToolCall,
    LLMTools
};