/**
 * AI Editor - Chat Module
 * Chat pane logic and LLM interaction
 */

import { State, EventBus, Storage } from './core.js';
import { LLM, generateEdit, generateCommitMessage, analyzeIssue, buildSystemPrompt } from './llm.js';
import { applyEdit, getContent, computeSimpleDiff, formatDiffForDisplay } from './editor.js';

// ============================================
// CHAT STATE
// ============================================

let chatContainer = null;
let inputElement = null;
let pendingEdit = null;  // { code, explanation } waiting for user approval

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
    const div = document.createElement('div');
    div.textContent = text;
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
    
    if (lower.includes('edit') || lower.includes('change') || lower.includes('modify') ||
        lower.includes('add') || lower.includes('remove') || lower.includes('fix') ||
        lower.includes('refactor') || lower.includes('update') || lower.includes('rewrite')) {
        return 'edit';
    }
    
    if (lower.includes('explain') || lower.includes('what does') || lower.includes('how does') ||
        lower.includes('why does') || lower.includes('understand')) {
        return 'explain';
    }
    
    if (lower.includes('commit message') || lower.includes('generate commit')) {
        return 'commit';
    }
    
    if (lower.includes('issue #') || lower.includes('work on issue') || lower.includes('implement issue')) {
        return 'issue';
    }
    
    return 'general';
}

// ============================================
// REQUEST HANDLERS
// ============================================

async function handleEditRequest(input) {
    if (!State.currentFile) {
        addMessage('system', '⚠️ Please open a file first.');
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
    addStreamingMessage();

    const systemPrompt = buildSystemPrompt();
    let content = '';

    await LLM.chat([
        { role: 'system', content: systemPrompt },
        ...State.chatHistory.slice(-6).filter(m => m.role !== 'system'),
        { role: 'user', content: input }
    ], {
        stream: true,
        onToken: (token, fullContent) => {
            content = fullContent;
            updateStreamingMessage(fullContent);
        }
    });

    finalizeStreamingMessage(content, { hasCode: false });
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

    addMessage('system', `📋 **Issue #${issue.number}: ${issue.title}**\n\n${issue.body || 'No description'}`);
    
    addStreamingMessage();

    const analysis = await analyzeIssue(issue, (token, content) => {
        updateStreamingMessage(content);
    });

    finalizeStreamingMessage(analysis, { hasCode: false });
}

async function handleGeneralRequest(input) {
    addStreamingMessage();

    const systemPrompt = buildSystemPrompt();
    let content = '';

    await LLM.chat([
        { role: 'system', content: systemPrompt },
        ...State.chatHistory.slice(-6).filter(m => m.role !== 'system'),
        { role: 'user', content: input }
    ], {
        stream: true,
        onToken: (token, fullContent) => {
            content = fullContent;
            updateStreamingMessage(fullContent);
        }
    });

    finalizeStreamingMessage(content, { hasCode: false });
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

window.Chat = {
    applyPendingEdit,
    rejectPendingEdit,
    stopGeneration,
    clearChat,
    sendMessage
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
    rejectPendingEdit
};