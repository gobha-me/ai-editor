/**
 * Message Rendering and Formatting
 * Handles chat message display, formatting, and UI updates
 */

import { State, EventBus, Storage } from '../core.js';
import { stripThinkBlocks } from '../llm.js';
import { getChatContainer } from './state.js';
import { ChatSummarizer } from './summarizer.js';

/**
 * Add a message to chat history and render it
 */
export function addMessage(role, content, meta = {}) {
    console.log(`[addMessage] role=${role}, content length=${content?.length}`);
    
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

/**
 * Add a streaming message placeholder
 */
export function addStreamingMessage() {
    const chatContainer = getChatContainer();
    if (!chatContainer) return null;

    // Start the response timer on first call; subsequent calls (tool loop rounds)
    // preserve the running timer so elapsed time spans the entire response.
    if (!_streamingTimerInterval) {
        startStreamingTimer();
    }

    const messageEl = document.createElement('div');
    messageEl.className = 'chat-message assistant streaming';
    messageEl.id = 'streaming-message';
    messageEl.innerHTML = `
        <div class="message-header">
            <span class="message-role">🤖 Assistant</span>
            <span class="message-time" id="streaming-elapsed">⏱️ ${formatElapsedTime(getStreamingElapsed())}</span>
        </div>
        <div class="message-content">
            <span class="typing-indicator">●●●</span>
        </div>
    `;
    chatContainer.appendChild(messageEl);
    scrollToBottom();
    return messageEl;
}

/**
 * Format elapsed time as MM:SS
 */
function formatElapsedTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// === RESPONSE TIMER ===
// Interval-based timer that ticks independently of token delivery.
// Prevents the clock from freezing during tool execution or slow responses.
let _streamingTimerInterval = null;
let _streamingTimerStart = null;

function startStreamingTimer() {
    stopStreamingTimer(); // Clean up any leftover
    _streamingTimerStart = Date.now();
    _streamingTimerInterval = setInterval(() => {
        const timerEl = document.getElementById('streaming-elapsed');
        if (timerEl && _streamingTimerStart) {
            const elapsed = Math.floor((Date.now() - _streamingTimerStart) / 1000);
            timerEl.textContent = `⏱️ ${formatElapsedTime(elapsed)}`;
        }
    }, 1000);
}

function stopStreamingTimer() {
    if (_streamingTimerInterval) {
        clearInterval(_streamingTimerInterval);
        _streamingTimerInterval = null;
    }
}

/** Get elapsed seconds since timer started (for finalizing) */
export function getStreamingElapsed() {
    if (!_streamingTimerStart) return 0;
    return Math.floor((Date.now() - _streamingTimerStart) / 1000);
}

/**
 * Clean up an orphaned streaming message element and stop its timer.
 * Safe to call multiple times or when no streaming message exists.
 * 
 * Use this on error paths where finalizeStreamingMessage() was never reached,
 * to prevent:
 *   - Dangling DOM elements with id="streaming-message"
 *   - Timer intervals that tick forever
 *   - Duplicate streaming elements on the next request
 */
export function cleanupStreamingMessage() {
    stopStreamingTimer();
    _streamingTimerStart = null;
    const el = document.getElementById('streaming-message');
    if (el) {
        el.remove();
        console.log('[cleanupStreamingMessage] Removed orphaned streaming element');
    }
}

/**
 * Update streaming message content.
 * Timer is handled by the interval started in addStreamingMessage().
 */
export function updateStreamingMessage(content) {
    const messageEl = document.getElementById('streaming-message');
    if (messageEl) {
        const contentEl = messageEl.querySelector('.message-content');
        // Strip think blocks for display only
        const displayContent = stripThinkBlocks(content);
        contentEl.innerHTML = formatMessageContent(displayContent);
        
        scrollToBottom();
    }
}

/**
 * Finalize streaming message and add to history
 */
export function finalizeStreamingMessage(content, meta = {}) {
    // Stop the interval timer and capture final elapsed time
    const timerElapsed = getStreamingElapsed();
    stopStreamingTimer();
    _streamingTimerStart = null; // Reset so next addStreamingMessage starts fresh
    
    const elapsedTime = timerElapsed || meta.elapsedTime || 0;
    console.log(`[finalizeStreamingMessage] content length=${content?.length}, elapsedTime=${elapsedTime}s`);
    
    const messageEl = document.getElementById('streaming-message');
    if (messageEl) {
        messageEl.classList.remove('streaming');
        messageEl.removeAttribute('id');
        
        const contentEl = messageEl.querySelector('.message-content');
        // Strip think blocks for display only
        const displayContent = stripThinkBlocks(content);
        contentEl.innerHTML = formatMessageContent(displayContent);
        
        // Update time to show elapsed duration
        const timeEl = messageEl.querySelector('.message-time');
        if (timeEl && elapsedTime) {
            timeEl.textContent = `${formatElapsedTime(elapsedTime)} ⏱️`;
            timeEl.title = `Response time: ${elapsedTime} seconds`;
        } else if (timeEl) {
            // Fallback to regular timestamp
            timeEl.textContent = new Date().toLocaleTimeString();
        }
        
        // Add action buttons
        const actionsEl = document.createElement('div');
        actionsEl.className = 'message-actions';
        
        if (meta.hasCode) {
            // Code-specific buttons (apply/reject)
            actionsEl.innerHTML = `
                <button class="btn-apply" onclick="window.Chat.applyPendingEdit()">✅ Apply to Editor</button>
                <button class="btn-reject" onclick="window.Chat.rejectPendingEdit()">❌ Reject</button>
            `;
        } else {
            // Standard assistant message buttons (continue/copy)
            actionsEl.innerHTML = `
                <button class="btn-action btn-continue" onclick="window.Chat.continueResponse()" title="Continue generating">🔄 Continue</button>
                <button class="btn-action btn-copy" onclick="window.Chat.copyMessage(this)" title="Copy to clipboard">📋 Copy</button>
            `;
        }
        
        messageEl.appendChild(actionsEl);
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

/**
 * Render a single message
 */
export function renderMessage(message, isLastUserMessage = false) {
    console.log(`[renderMessage] role=${message.role}, content length=${message.content?.length}`);
    
    // Skip rendering tool messages entirely
    if (message.role === 'tool') {
        console.log('[renderMessage] Skipping tool message (not meant for display)');
        return;
    }

    const chatContainer = getChatContainer();
    if (!chatContainer) return;

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

    // Show elapsed time for assistant messages if available, otherwise timestamp
    let timeDisplay;
    if (message.role === 'assistant' && message.elapsedTime) {
        timeDisplay = `${formatElapsedTime(message.elapsedTime)} ⏱️`;
    } else {
        timeDisplay = new Date(message.timestamp).toLocaleTimeString();
    }

    // CRITICAL FIX: Only strip think blocks from assistant messages, NEVER from user/system/tool messages
    let displayContent = (message.role === 'assistant') 
        ? stripThinkBlocks(message.content)
        : message.content;
    
    // If content is an object or array, stringify it for display
    if (typeof displayContent !== 'string') {
        displayContent = JSON.stringify(displayContent, null, 2);
    }

    messageEl.innerHTML = `
        <div class="message-header">
            <span class="message-role">${roleIcon} ${roleName}</span>
            <span class="message-time">${timeDisplay}</span>
        </div>
        <div class="message-content">${formatMessageContent(displayContent)}</div>
    `;

    // Add action buttons to appropriate message types
    if (message.role === 'assistant') {
        const actionsEl = document.createElement('div');
        actionsEl.className = 'message-actions';
        actionsEl.innerHTML = `
            <button class="btn-action btn-copy" onclick="window.Chat.copyMessage(this)" title="Copy to clipboard">📋 Copy</button>
        `;
        messageEl.appendChild(actionsEl);
    } else if (message.role === 'user' && isLastUserMessage) {
        // Only show retry on the most recent user message
        const actionsEl = document.createElement('div');
        actionsEl.className = 'message-actions';
        actionsEl.innerHTML = `
            <button class="btn-action btn-retry" onclick="window.Chat.retryLastMessage()" title="Retry this request">🔁 Retry</button>
        `;
        messageEl.appendChild(actionsEl);
    }

    chatContainer.appendChild(messageEl);
}

/**
 * Add a collapsible tool call message
 */
export function addToolCallMessage(toolName, args, result) {
    const chatContainer = getChatContainer();
    if (!chatContainer) return;

    // Build a short args summary for the header
    const argSummary = summarizeToolArgs(toolName, args);
    
    // Determine result status
    const isError = result?.error;
    const statusIcon = isError ? '❌' : '✅';
    const resultSummary = summarizeToolResult(toolName, result);
    
    // Format full args and result for the expandable section
    const argsJson = JSON.stringify(args, null, 2);
    const resultJson = JSON.stringify(result, null, 2);
    
    // CRITICAL TOOLS MUST NEVER TRUNCATE - they are foundational for navigation
    const criticalTools = new Set([
        'get_project_tree',    // Project structure
        'list_open_tabs',      // Editor state
        'scan_file',           // File outline
        'find_references',     // Symbol search
        'search_in_files',     // Text search
        'list_issues'          // Issue list
    ]);
    
    // Truncate very long results (e.g., file contents) EXCEPT for critical tools
    const truncatedResult = !criticalTools.has(toolName) && resultJson.length > 2000 
        ? resultJson.substring(0, 2000) + '\n... (truncated, expand to see full result)'
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
}

/**
 * Summarize tool arguments for compact display
 */
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

/**
 * Summarize tool result for compact display
 */
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

/**
 * Render all messages in chat history
 */
export function renderMessages(historyOverride = null) {
    const chatContainer = getChatContainer();
    if (!chatContainer) return;
    
    chatContainer.innerHTML = '';
    
    const history = historyOverride || State.chatHistory;
    
    if (history.length === 0) {
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

    // Find the last user message index for retry button placement
    let lastUserMessageIndex = -1;
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === 'user') {
            lastUserMessageIndex = i;
            break;
        }
    }

    history.forEach((msg, idx) => {
        const isLastUserMessage = msg.role === 'user' && idx === lastUserMessageIndex;
        renderMessage(msg, isLastUserMessage);
    });
    
    scrollToBottom();
}

/**
 * Clear all chat messages
 */
export function clearChat() {
    State.chatHistory = [];
    Storage.set('chatHistory', []);
    ChatSummarizer.clear();
    renderMessages();
    EventBus.emit('chat:cleared');
}

/**
 * Format message content with markdown-like formatting
 */
export function formatMessageContent(content) {
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

/**
 * Escape HTML special characters
 */
export function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

/**
/**
 * Scroll chat container to bottom with smart behavior
 * Only auto-scrolls if user is already at the bottom
 * Preserves user's scroll position when reading older messages
 */
export function scrollToBottom(smooth = false) {
    const container = getChatContainer();
    if (!container) return;

    // Check if user is currently at the bottom (within threshold)
    const isAtBottom = isUserAtBottom();

    // Only auto-scroll if user is already at bottom
    if (isAtBottom) {
        const scrollHeight = container.scrollHeight;
        container.scrollTo({
            top: scrollHeight,
            behavior: smooth ? 'smooth' : 'auto'
        });
    }
}

/**
 * Force scroll to bottom regardless of user position
 * Use this for critical updates that must be visible
 */
export function scrollToBottomForced(smooth = false) {
    const container = getChatContainer();
    if (!container) return;

    const scrollHeight = container.scrollHeight;
    container.scrollTo({
        top: scrollHeight,
        behavior: smooth ? 'smooth' : 'auto'
    });
}

/**
 * Check if user is currently at the bottom of the chat (within threshold)
 */
export function isUserAtBottom() {
    const container = getChatContainer();
    if (!container) return true;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const threshold = 50; // pixels from bottom to consider "at bottom"
    const distanceToBottom = scrollHeight - scrollTop - clientHeight;

    return distanceToBottom <= threshold;
}

/**
 * Get distance from current scroll position to bottom
 */
export function getDistanceToBottom() {
    const container = getChatContainer();
    if (!container) return 0;

    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight;
}
