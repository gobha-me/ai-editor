/**
 * AI Editor - Chat Module
 * Chat pane logic and LLM interaction
 */

import { State, EventBus, Storage } from './core.js';
import { LLM, LLMDebug, LLMTools, generateEdit, generateCommitMessage, analyzeIssue, buildSystemPrompt, stripThinkBlocks } from './llm.js';
import { applyEdit, getContent, computeSimpleDiff, formatDiffForDisplay } from './editor.js';
import { GiteaAPI, loadFile } from './gitea.js';
import { ToolRegistry } from './tools/registry.js';
import { registerFileTools } from './tools/file-tools.js';
import { registerScanTools } from './tools/scan-tools.js';
import { registerEditTools } from './tools/edit-tools.js';
import { registerProjectTools } from './tools/project-tools.js';
import { registerSearchTools } from './tools/search-tools.js';
import { registerIssueTools } from './tools/issue-tools.js';

// ============================================
// TOOL REGISTRATION
// ============================================

// Initialize tools on module load
registerFileTools(ToolRegistry);
registerScanTools(ToolRegistry);
registerEditTools(ToolRegistry);
registerProjectTools(ToolRegistry);
registerSearchTools(ToolRegistry);
registerIssueTools(ToolRegistry);

// ============================================
// CHAT HISTORY SUMMARIZER
// ============================================

/**
 * Compresses older chat messages into LLM-generated summaries.
 * Keeps last N messages in full, summarizes everything older.
 * Uses lightweight model (commitModel fallback) to avoid burning tokens.
 */
const ChatSummarizer = {
    RECENT_COUNT: 10,           // messages kept verbatim
    SUMMARY_THRESHOLD: 20,      // min messages before first summary
    SUMMARY_INTERVAL: 15,       // new messages between re-summarizations
    SUMMARY_MAX_CHARS: 2000,
    SUMMARY_TIMEOUT_MS: 30000,

    /** @returns {boolean} true when enough new messages have accumulated */
    shouldSummarize() {
        const total = State.chatHistory.length;
        if (total < this.SUMMARY_THRESHOLD) return false;

        const info = Storage.get('chatSummaryInfo', null);
        if (!info) return true;

        return (total - (info.coveredCount || 0)) >= this.SUMMARY_INTERVAL;
    },

    /** Pick cheapest available model */
    _pickModel() {
        // Prefer dedicated commit/light model
        if (State.settings.commitModel) return State.settings.commitModel;

        // Scan State.models for known cheap models
        const cheap = ['mini', 'haiku', 'flash', 'lite'];
        const hit = (State.models || []).find(m =>
            cheap.some(p => m.id.toLowerCase().includes(p))
        );
        if (hit) return hit.id;

        return State.settings.llmModel; // last resort
    },

    /** Build the summarization prompt */
    _buildPrompt(messages) {
        const convo = messages
            .filter(m => m.role !== 'system')
            .map(m => {
                const who = m.role === 'user' ? 'User' : 'Assistant';
                const text = (typeof m.content === 'string'
                    ? m.content : JSON.stringify(m.content)).slice(0, 500);
                return `${who}: ${text}`;
            })
            .join('\n\n');

        return `Summarize this coding-assistant conversation concisely. Include:
1. Project/branch context
2. User goals and key decisions
3. Files created or modified
4. Where the conversation left off

Keep under 400 words. Output ONLY the summary, no preamble.

CONVERSATION:
${convo}

SUMMARY:`;
    },

    /** Fallback: extract topic snippets without LLM */
    _basicSummary(messages) {
        const user = messages.filter(m => m.role === 'user');
        const asst = messages.filter(m => m.role === 'assistant');
        const topics = user.map(m =>
            (typeof m.content === 'string' ? m.content : 'complex request').slice(0, 80)
        );
        return `${user.length} user / ${asst.length} assistant messages. Topics: ${topics.join('; ')}`;
    },

    /**
     * Generate summary via LLM (non-blocking, fire-and-forget safe).
     * Stores result in localStorage under 'chatSummaryInfo'.
     */
    async generateAndStore() {
        if (!this.shouldSummarize()) return null;

        const history = State.chatHistory;
        const older = history.slice(0, -this.RECENT_COUNT);
        if (older.length < 5) return null;

        let summary;
        try {
            const model = this._pickModel();
            const result = await Promise.race([
                LLM.chat(
                    [{ role: 'user', content: this._buildPrompt(older) }],
                    { model, stream: false, temperature: 0.3, maxTokens: 500 }
                ),
                new Promise((_, rej) =>
                    setTimeout(() => rej(new Error('summary timeout')), this.SUMMARY_TIMEOUT_MS)
                )
            ]);
            summary = (result.content || '').trim();
            if (summary.length > this.SUMMARY_MAX_CHARS) {
                summary = summary.slice(0, this.SUMMARY_MAX_CHARS) + '…';
            }
        } catch (err) {
            console.warn('[ChatSummarizer] LLM failed, using basic:', err.message);
            summary = this._basicSummary(older);
        }

        const info = {
            summary,
            coveredCount: history.length,
            timestamp: Date.now()
        };
        Storage.set('chatSummaryInfo', info);
        EventBus.emit('chat:summaryGenerated', info);
        return info;
    },

    /**
     * Build the message array to send to the LLM.
     * Prepends stored summary as a system message, then appends recent messages.
     */
    getContextMessages() {
        const history = State.chatHistory;
        if (history.length === 0) return [];

        const info = Storage.get('chatSummaryInfo', null);
        const recent = history.slice(-this.RECENT_COUNT).filter(m => !m.isSummary);

        if (info?.summary && history.length > this.RECENT_COUNT) {
            return [
                {
                    role: 'system',
                    content: `CONVERSATION SUMMARY (earlier messages):\n\n${info.summary}\n\n---\nRecent messages follow.`,
                    isSummary: true
                },
                ...recent.filter(m => m.role !== 'system')
            ];
        }

        return recent.filter(m => m.role !== 'system');
    },

    clear() {
        Storage.remove('chatSummaryInfo');
    }
};

// ============================================
// CHAT STATE
// ============================================

let chatContainer = null;
let inputElement = null;
let pendingEdit = null;  // { code, explanation } waiting for user approval
let _cancelToolLoop = false;  // Module-level cancel flag for stop button

// ============================================
// TOOL EXECUTION
// ============================================

// Execute a tool call using the registry
async function executeToolCall(toolCall) {
    try {
        const args = JSON.parse(toolCall.function.arguments || '{}');
        const result = await ToolRegistry.execute(toolCall.function.name, args);
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

    // Load chat history from storage (summary-aware)
    const savedHistory = Storage.get('chatHistory', []);
    const summaryInfo = Storage.get('chatSummaryInfo', null);
    if (summaryInfo?.summary && savedHistory.length > ChatSummarizer.RECENT_COUNT) {
        // Keep recent messages + prepend summary reference
        State.chatHistory = savedHistory.slice(-ChatSummarizer.RECENT_COUNT);
    } else {
        State.chatHistory = savedHistory.slice(-50);
    }

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

    // Use keydown to detect Enter, but defer reading value until after the key is processed
    inputElement.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            
            // Capture input value IMMEDIATELY before any async operations
            const inputValue = inputElement.value.trim();
            inputElement.value = '';
            
            // Process the captured value
            if (inputValue && !State.isGenerating) {
                handleUserInputDirect(inputValue);
            }
        }
    });
}

// ============================================
// MESSAGE MANAGEMENT
// ============================================

function addMessage(role, content, meta = {}) {
    console.log(`[addMessage] role=${role}, content length=${content?.length}, content="${content}"`);
    
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

    // Async summarization — fire and forget, never blocks UI
    if (ChatSummarizer.shouldSummarize()) {
        setTimeout(() => {
            ChatSummarizer.generateAndStore().catch(e =>
                console.warn('[ChatSummarizer] background fail:', e.message)
            );
        }, 1500);
    }

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
        // Strip think blocks for display only
        const displayContent = stripThinkBlocks(content);
        contentEl.innerHTML = formatMessageContent(displayContent);
        scrollToBottom();
    }
}

function finalizeStreamingMessage(content, meta = {}) {
    console.log(`[finalizeStreamingMessage] content length=${content?.length}, first 100 chars="${content?.slice(0, 100)}"`);
    
    const messageEl = document.getElementById('streaming-message');
    if (messageEl) {
        messageEl.classList.remove('streaming');
        messageEl.removeAttribute('id');
        
        const contentEl = messageEl.querySelector('.message-content');
        // Strip think blocks for display only
        const displayContent = stripThinkBlocks(content);
        contentEl.innerHTML = formatMessageContent(displayContent);
        
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

    // Add to history with FULL content (including think blocks for LLM context)
    State.chatHistory.push({
        role: 'assistant',
        content,  // Full content with think blocks preserved
        timestamp: Date.now(),
        ...meta
    });
    Storage.set('chatHistory', State.chatHistory.slice(-100));
}

function renderMessage(message) {
    console.log(`[renderMessage] role=${message.role}, content length=${message.content?.length}, content="${message.content}"`);
    
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

    // CRITICAL FIX: Only strip think blocks from assistant messages, NEVER from user/system/tool messages
    const displayContent = (message.role === 'assistant') 
        ? stripThinkBlocks(message.content)
        : message.content;
    
    console.log(`[renderMessage] After stripThinkBlocks: length=${displayContent?.length}, content="${displayContent}"`);

    messageEl.innerHTML = `
        <div class="message-header">
            <span class="message-role">${roleIcon} ${roleName}</span>
            <span class="message-time">${time}</span>
        </div>
        <div class="message-content">${formatMessageContent(displayContent)}</div>
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
        case 'read_lines':
            return `${args.path || 'current'} L${args.start_line || 1}-${args.end_line || 'end'}`;
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
        case 'scan_file':
            return args.path || '';
        case 'read_function':
            return `${args.name} in ${args.path || '?'}`;
        case 'find_references':
            return `"${args.symbol}"${args.scope ? ` in ${args.scope}` : ''}`;
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
            return `${result.line_count || '?'} lines${result.truncated ? ' (truncated)' : ''}`;
        case 'read_lines':
            return `L${result.start_line}-${result.end_line} of ${result.line_count}`;
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
        case 'scan_file':
            return `${result.outline?.length || 0} items`;
        case 'read_function':
            return `${result.lines || 0} lines`;
        case 'find_references':
            return `${result.definitions?.length || 0} defs, ${result.references?.length || 0} refs`;
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
    ChatSummarizer.clear();
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

async function handleUserInputDirect(input) {
    console.log(`[handleUserInputDirect] Received input="${input}"`);
    
    if (!input || State.isGenerating) return;
    
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
    console.log(`[handleGeneralRequest] Starting with input="${input}"`);
    
    addStreamingMessage();
    _cancelToolLoop = false;  // Reset cancel flag

    const systemPrompt = buildSystemPrompt();
    const roleTools = LLMTools.getToolsForRole();
    
    // Build initial message thread (summary-aware context).
    const contextMessages = ChatSummarizer.getContextMessages();
    console.log(`[handleGeneralRequest] Context messages count: ${contextMessages.length}`);
    
    const lastCtx = contextMessages[contextMessages.length - 1];
    const alreadyInContext = lastCtx && lastCtx.role === 'user' && lastCtx.content === input;

    const messages = [
        { role: 'system', content: systemPrompt },
        ...contextMessages,
        ...( alreadyInContext ? [] : [{ role: 'user', content: input }] )
    ];

    // Iterative tool call loop — max 8 rounds to support complex workflows
    const MAX_TOOL_ROUNDS = 8;
    let finalContent = '';          // Accumulated across rounds (used for error fallback)
    let lastRoundContent = '';      // Only the current round's text (used for DOM + history)
    const toolActions = []; // Track all tool executions for fallback summary

    // Keep isGenerating true for the entire tool loop
    State.isGenerating = true;
    EventBus.emit('llm:generating', true);

    try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        // Check cancellation before each round
        if (_cancelToolLoop) {
            console.log('[TOOL-LOOP] Cancelled by user');
            break;
        }

        let content = '';
        let result;

        try {
            const timeout = round === 0 ? 60000 : 90000;
            const chatOptions = {
                stream: true,
                tools: roleTools,
                onToken: (token, fullContent) => {
                    content = fullContent;
                    updateStreamingMessage(fullContent);
                }
            };

            if (round > 0) {
                updateStreamingMessage('*(processing tool results…)*');
            }

            result = await Promise.race([
                LLM.chat(messages, chatOptions),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`Response timeout (${timeout/1000}s)`)), timeout)
                )
            ]);

            content = content || result.content || '';

            // Re-assert isGenerating (LLM.chat's finally sets it false)
            State.isGenerating = true;
            EventBus.emit('llm:generating', true);

        } catch (err) {
            // Abort any in-flight request
            LLM.stop();
            lastRoundContent = '';  // Ensure error paths use finalContent fallback
            
            if (_cancelToolLoop) break;
            
            if (toolActions.length > 0) {
                // Show what tools did accomplish
                const summaryLines = toolActions.map(a => {
                    const status = a.error ? '❌' : '✅';
                    const detail = a.result?.message || a.result?.error || '';
                    return `${status} **${a.tool}**${a.args?.path ? ` \`${a.args.path}\`` : ''}${detail ? ` — ${detail}` : ''}`;
                });
                lastRoundContent = `⚠️ Follow-up failed (${err.message}). Tool results:\n\n${summaryLines.join('\n')}`;
                finalContent = lastRoundContent;
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
        if (toolCalls.length === 0 && cleanContent) {
            const parsed = parseTextToolCalls(cleanContent);
            if (parsed.toolCalls.length > 0) {
                toolCalls = parsed.toolCalls;
                cleanContent = parsed.cleanContent;
                toolCallSource = 'text';
                console.log(`[TOOL-LOOP] Text-parsed ${toolCalls.length} tool calls:`, 
                    toolCalls.map(tc => tc.function?.name));
                updateStreamingMessage(cleanContent || finalContent || '');
            }
        }

        // Accumulate text content across rounds
        lastRoundContent = cleanContent;
        if (cleanContent.trim()) {
            finalContent = finalContent ? finalContent + '\n\n' + cleanContent : cleanContent;
        }

        if (toolCalls.length > 0) {
            // === EXECUTE TOOL CALLS ===
            const structuredResults = [];
            const textResults = [];

            for (const toolCall of toolCalls) {
                if (_cancelToolLoop) break;

                const toolName = toolCall.function?.name || 'unknown';
                let args = {};
                try {
                    args = JSON.parse(toolCall.function?.arguments || '{}');
                } catch (e) { /* malformed args */ }

                // Execute with timeout (15s per tool call)
                let toolResult;
                try {
                    toolResult = await Promise.race([
                        executeToolCall(toolCall),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('Tool execution timeout (15s)')), 15000)
                        )
                    ]);
                } catch (e) {
                    toolResult = { error: e.message };
                }

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

            if (_cancelToolLoop) break;

            // === BUILD THREAD FOR NEXT ROUND ===

            // Compress old tool results to prevent token explosion.
            for (let i = 0; i < messages.length; i++) {
                const msg = messages[i];
                if (msg.role === 'tool' && msg.content) {
                    try {
                        const parsed = JSON.parse(msg.content);
                        let compressed = false;

                        // Compress file contents
                        if (parsed.content && parsed.content.length > 500) {
                            parsed.content = `[Content of ${parsed.path || 'file'} — ${parsed.line_count || '?'} lines — already processed]`;
                            compressed = true;
                        }
                        // Compress search results
                        if (parsed.results && Array.isArray(parsed.results) && parsed.results.length > 0) {
                            const matchCount = parsed.results.reduce((sum, r) => sum + (r.matches?.length || 0), 0);
                            parsed.results = `[${matchCount} matches in ${parsed.results.length} files — already processed]`;
                            compressed = true;
                        }
                        // Compress project tree
                        if (parsed.files && Array.isArray(parsed.files) && parsed.files.length > 20) {
                            parsed.files = `[${parsed.files.length} files — already processed]`;
                            compressed = true;
                        }
                        // Compress edit context (already consumed)
                        if (parsed.context && parsed.context.length > 200) {
                            delete parsed.context;
                            compressed = true;
                        }

                        if (compressed) {
                            messages[i] = { ...msg, content: JSON.stringify(parsed) };
                        }
                    } catch (e) { /* not JSON, leave as-is */ }
                }
            }

            // Save assistant response with tool_calls to State.chatHistory
            const assistantMsg = {
                role: 'assistant',
                content: cleanContent || '',
                timestamp: Date.now()
            };
            if (toolCallSource === 'structured') {
                assistantMsg.tool_calls = toolCalls;
            }
            State.chatHistory.push(assistantMsg);
            Storage.set('chatHistory', State.chatHistory.slice(-100));

            // Save tool results to State.chatHistory for context continuity
            if (toolCallSource === 'structured') {
                for (const tr of structuredResults) {
                    State.chatHistory.push({
                        ...tr,
                        timestamp: Date.now()
                    });
                }
                Storage.set('chatHistory', State.chatHistory.slice(-100));
            }

            if (toolCallSource === 'structured') {
                messages.push(assistantMsg);
                for (const tr of structuredResults) {
                    messages.push(tr);
                }
            } else {
                messages.push({ role: 'assistant', content: cleanContent || '' });
                const summary = textResults.map(tr => {
                    // Truncate large results to prevent token explosion
                    let resultStr = JSON.stringify(tr.result, null, 2);
                    if (resultStr.length > 1500) {
                        resultStr = resultStr.slice(0, 1500) + '\n... (truncated)';
                    }
                    return `[Tool: ${tr.name}]\n${resultStr}`;
                }).join('\n\n');
                messages.push({
                    role: 'user',
                    content: `Tool results:\n${summary}\n\nContinue using these results. Use additional tools if needed, otherwise provide your final response.`
                });
            }

            // Prepare UI for next round — commit THIS round's text only
            const partialEl = document.getElementById('streaming-message');
            if (partialEl) {
                if (cleanContent.trim()) {
                    partialEl.querySelector('.message-content').innerHTML = formatMessageContent(stripThinkBlocks(cleanContent));
                    partialEl.classList.remove('streaming');
                } else {
                    // Round produced no text (only tool calls) — remove empty element
                    partialEl.remove();
                }
                partialEl.removeAttribute('id');
            }
            addStreamingMessage();
            continue;
        }

        // === NO TOOL CALLS — DONE ===
        if (result.finishReason === 'tool_calls') {
            console.warn('Model signaled tool_calls but none were parsed — ending loop');
        }

        break;
    }
    } finally {
        // Always clean up generating state
        State.isGenerating = false;
        EventBus.emit('llm:generating', false);
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

    // Use last round's content for the final DOM element
    finalizeStreamingMessage(lastRoundContent.trim() ? lastRoundContent : finalContent, { hasCode: false });
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
    // Cancel any in-flight tool loop
    _cancelToolLoop = true;
    
    LLM.stop();
    State.isGenerating = false;
    EventBus.emit('llm:generating', false);
    
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
        handleUserInputDirect(content);
    }
}

// ============================================
// EXPORT CHAT
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
        lines.push(`**Session:** ${State.sessionCost.totalInputTokens + State.sessionCost.totalOutputTokens} tokens (${State.sessionCost.totalInputTokens}↓ ${State.sessionCost.totalOutputTokens}↑) · ${State.sessionCost.totalCost.toFixed(4)} · ${State.sessionCost.requests} requests`);
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

// ============================================
// EXPOSE TO GLOBAL (for onclick handlers)
// ============================================

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
    executeToolCall
};
