/**
 * AI Editor - Chat Module (Modular Entry Point)
 * Ties together all chat submodules and exports public API
 */

import { State, EventBus, Storage } from '../core.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerFileTools } from '../tools/file-tools.js';
import { registerScanTools } from '../tools/scan-tools.js';
import { registerEditTools } from '../tools/edit-tools.js';
import { registerProjectTools } from '../tools/project-tools.js';
import { registerSearchTools } from '../tools/search-tools.js';
import { registerIssueTools } from '../tools/issue-tools.js';
import { registerPRTools } from '../tools/pr-tools.js';
import { registerScratchpadTools } from '../tools/scratchpad-tools.js';
import { registerXRefTools } from '../tools/xref-tools.js';
import { registerDocTools } from '../tools/doc-tools.js';
import { registerMultiFileTools } from '../tools/multifile-tools.js';
import { registerSearchReplaceTools } from '../tools/search-replace-tools.js';
import { registerEvalTools } from '../tools/eval-tools.js';

// Import submodules
import { 
    initChatState,
    getChatContainer,
    getInputElement
} from './state.js';
import { ChatSummarizer } from './summarizer.js';
import { ConversationManager } from './conversations.js';
import { 
    addMessage, 
    renderMessages,
    renderSummaryNotification,
    editMessage,
    cancelEdit,
    commitEdit
} from './messages.js';
import { setupInputHandlers, stopGeneration, removeImage } from './input.js';
import { exportChat } from './export.js';
import { showToast } from '../ui-helpers.js';
import { 
    handleUserInputDirect,
    applyPendingEdit,
    rejectPendingEdit
} from './handlers.js';
import { executeToolCall } from './tools.js';

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
registerPRTools(ToolRegistry);
registerScratchpadTools(ToolRegistry);
registerXRefTools(ToolRegistry);
registerDocTools(ToolRegistry);
registerMultiFileTools(ToolRegistry);
registerSearchReplaceTools(ToolRegistry);
registerEvalTools(ToolRegistry);

// ============================================
// INITIALIZATION
// ============================================

function initChat(containerEl, inputEl) {
    initChatState(containerEl, inputEl);

    // Initialize conversation system (migrates legacy data if needed)
    ConversationManager.init();

    // Load active conversation (or fall back to chatHistory for compat)
    const activeId = ConversationManager.getActiveId();
    if (activeId) {
        ConversationManager.load(activeId);
    }

    // Load chat history from storage (summary-aware)
    const savedHistory = Storage.get('chatHistory', []);
    const summaryInfo = Storage.get('chatSummaryInfo', null);
    
    // CRITICAL FIX: Filter out tool messages from display on page load
    // Tool messages should only be rendered in real-time as collapsible tool call widgets
    // When loading from cache, we skip rendering tool messages to avoid showing raw JSON
    const displayHistory = savedHistory.filter(msg => msg.role !== 'tool');
    
    if (summaryInfo?.summary && displayHistory.length > ChatSummarizer.RECENT_COUNT) {
        // Keep recent messages + prepend summary reference
        State.chatHistory = savedHistory.slice(-ChatSummarizer.RECENT_COUNT);
    } else {
        State.chatHistory = savedHistory.slice(-50);
    }

    renderMessages(displayHistory.slice(-50));
    setupInputHandlers(inputEl, handleUserInputDirect);
    initConversationDrawer();

    // Debounced conversation save — persists after message activity settles
    let _saveTimer = null;
    const debouncedSave = () => {
        clearTimeout(_saveTimer);
        _saveTimer = setTimeout(() => ConversationManager.save(), 2000);
    };
    EventBus.on('chat:message', debouncedSave);
    EventBus.on('chat:pruned', debouncedSave);

    // Save on page unload
    window.addEventListener('beforeunload', () => {
        ConversationManager.save();
    });

    // Re-render conversation list when conversations change
    EventBus.on('conversation:created', () => renderConversationList());
    EventBus.on('conversation:loaded', () => renderConversationList());
    EventBus.on('conversation:deleted', () => renderConversationList());
    EventBus.on('conversation:renamed', () => renderConversationList());

    // Listen for LLM events
    EventBus.on('llm:generating', (isGenerating) => {
        const input = getInputElement();
        if (input) {
            input.disabled = isGenerating;
        }
    });

    EventBus.on('editor:editApplied', async ({ original, updated }) => {
        const { computeSimpleDiff } = await import('../editor.js');
        const diff = computeSimpleDiff(original, updated);
        if (diff.length > 0) {
            addMessage('system', `✅ Applied ${diff.length} change(s) to editor.`);
        }
    });

    // Show summary notification when context is pruned (replaces old summaryGenerated)
    EventBus.on('chat:pruned', (info) => {
        renderMessages();  // Re-render with pruned history + summary badge at top
        const undoAvail = ChatSummarizer.hasStash();
        showToast(
            `📋 ${info.compressedMessages} messages summarized` + (undoAvail ? ' — ↩ undo available' : ''),
            'info'
        );
    });

    // Handle undo prune request from summary notification button
    EventBus.on('chat:undoPrune', () => {
        if (ChatSummarizer.undoPrune()) {
            renderMessages();  // Re-render with restored history, no summary badge
            showToast('↩ Messages restored', 'success');
        }
    });

    // When stash is flushed (next user query), remove undo button from badge
    EventBus.on('chat:stashFlushed', () => {
        const undoBtn = document.querySelector('.btn-summary-undo');
        if (undoBtn) undoBtn.remove();
    });

    // Handle edit-and-resend from inline message editor
    EventBus.on('chat:editAndResend', ({ newContent }) => {
        editAndResend(newContent);
    });

    // Issue triage mode
    EventBus.on('issue:focused', (issue) => {
        const input = getInputElement();
        if (input) input.placeholder = `Discuss issue #${issue.number}… (ask about code, impact, approach)`;
        addMessage('system', `📋 Focused on issue #${issue.number}: ${issue.title}\nAsk me to find relevant code, assess impact, or suggest an approach.`);
    });

    EventBus.on('issue:unfocused', () => {
        const input = getInputElement();
        if (input) input.placeholder = 'Ask me to edit code, explain something, or help with an issue...';
    });
}

// ============================================
// PUBLIC API WRAPPERS
// ============================================

/**
 * Send a message to the chat
 */
function sendMessage(content) {
    const input = getInputElement();
    if (input) {
        input.value = content;
    }
    handleUserInputDirect(content);
}

/**
 * Start a new chat conversation.
 * Saves the current conversation and creates a blank one.
 */
function clearChat() {
    ConversationManager.create();
    renderMessages();
    EventBus.emit('chat:cleared');
}

/**
 * Continue the last response - prompt LLM to keep working
 */
function continueResponse() {
    if (State.isGenerating) {
        showToast('⚠️ Already generating a response', 'warning');
        return;
    }
    handleUserInputDirect('Please continue.');
}

/**
 * Retry the last user message
 */
function retryLastMessage() {
    if (State.isGenerating) {
        showToast('⚠️ Already generating a response', 'warning');
        return;
    }
    
    // Find the last user message in history
    let lastUserIdx = -1;
    for (let i = State.chatHistory.length - 1; i >= 0; i--) {
        if (State.chatHistory[i].role === 'user') {
            lastUserIdx = i;
            break;
        }
    }
    
    if (lastUserIdx === -1) {
        showToast('⚠️ No previous message to retry', 'warning');
        return;
    }

    const content = State.chatHistory[lastUserIdx].content;
    
    // Truncate from the user message onward (removes user + assistant + tool messages)
    State.chatHistory.splice(lastUserIdx);
    Storage.set('chatHistory', State.chatHistory.slice(-100));
    renderMessages();
    
    // Resend the same content as a fresh message
    handleUserInputDirect(content);
}

/**
 * Edit the last user message and resend with new content.
 * Truncates history from the last user message forward, then sends the edited text.
 * @param {string} newContent - The edited message text
 */
function editAndResend(newContent) {
    if (State.isGenerating) {
        showToast('⚠️ Already generating a response', 'warning');
        return;
    }

    // Find and remove the last user message and everything after it
    let lastUserIdx = -1;
    for (let i = State.chatHistory.length - 1; i >= 0; i--) {
        if (State.chatHistory[i].role === 'user') {
            lastUserIdx = i;
            break;
        }
    }

    if (lastUserIdx === -1) {
        showToast('⚠️ No message to edit', 'warning');
        return;
    }

    // Truncate from the user message onward
    State.chatHistory.splice(lastUserIdx);
    Storage.set('chatHistory', State.chatHistory.slice(-100));
    renderMessages();

    // Send the edited content as a fresh message
    handleUserInputDirect(newContent);
}

/**
 * Copy message content to clipboard
 * @param {HTMLElement} buttonEl - The button that was clicked (to find parent message)
 */
function copyMessage(buttonEl) {
    const messageEl = buttonEl.closest('.chat-message');
    if (!messageEl) return;
    
    const contentEl = messageEl.querySelector('.message-content');
    if (!contentEl) return;
    
    // Get text content (strip HTML formatting)
    const text = contentEl.innerText || contentEl.textContent;
    
    navigator.clipboard.writeText(text).then(() => {
        showToast('📋 Copied to clipboard', 'success');
    }).catch(err => {
        console.error('Failed to copy:', err);
        showToast('❌ Failed to copy', 'error');
    });
}

// ============================================
// IMAGE PREVIEW
// ============================================

/**
 * Open an image in a fullscreen overlay for closer inspection.
 * @param {string} src - Data URL or image URL
 */
function previewImage(src) {
    // Remove existing overlay if any
    document.getElementById('imageOverlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'imageOverlay';
    overlay.className = 'image-overlay';
    const img = document.createElement('img');
    img.src = src;
    img.alt = 'Image preview';
    overlay.appendChild(img);
    overlay.addEventListener('click', () => overlay.remove());
    document.addEventListener('keydown', function _esc(e) {
        if (e.key === 'Escape') {
            overlay.remove();
            document.removeEventListener('keydown', _esc);
        }
    });
    document.body.appendChild(overlay);
}

// ============================================
// CONVERSATION DRAWER
// ============================================

/** Drawer state */
let _convSortMode = 'recent';   // 'recent' | 'alpha' | 'messages'
const SORT_MODES = ['recent', 'alpha', 'messages'];
const SORT_LABELS = { recent: '🕐 Recent', alpha: '🔤 A–Z', messages: '💬 Most messages' };

/**
 * Initialize the conversation list drawer toggle.
 */
function initConversationDrawer() {
    const toggle = document.getElementById('btnConversations');
    const drawer = document.getElementById('conversationDrawer');
    if (!toggle || !drawer) return;

    toggle.addEventListener('click', () => {
        const isOpen = drawer.classList.contains('open');
        if (isOpen) {
            drawer.classList.remove('open');
        } else {
            renderConversationList();
            drawer.classList.add('open');
            // Focus search input when opening
            const searchInput = document.getElementById('convSearchInput');
            if (searchInput) setTimeout(() => searchInput.focus(), 50);
        }
    });

    // Close drawer when clicking outside
    document.addEventListener('click', (e) => {
        if (drawer.classList.contains('open') &&
            !drawer.contains(e.target) &&
            !e.target.closest('#btnConversations')) {
            drawer.classList.remove('open');
        }
    });

    // Search input — filter as you type
    const searchInput = document.getElementById('convSearchInput');
    if (searchInput) {
        searchInput.addEventListener('input', () => renderConversationList());
        // Don't close drawer on Escape if search has text — clear it first
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (searchInput.value) {
                    e.stopPropagation();
                    searchInput.value = '';
                    renderConversationList();
                }
            }
        });
    }

    // Sort button — cycle through sort modes
    const sortBtn = document.getElementById('btnConvSort');
    if (sortBtn) {
        sortBtn.addEventListener('click', () => {
            const idx = SORT_MODES.indexOf(_convSortMode);
            _convSortMode = SORT_MODES[(idx + 1) % SORT_MODES.length];
            sortBtn.title = `Sort: ${SORT_LABELS[_convSortMode]}`;
            sortBtn.setAttribute('aria-label', `Sort: ${SORT_LABELS[_convSortMode]}`);
            renderConversationList();
            showToast(SORT_LABELS[_convSortMode], 'info');
        });
    }
}

/**
 * Render the conversation list inside the drawer.
 * Applies current search filter and sort mode.
 */
function renderConversationList() {
    const list = document.getElementById('conversationList');
    if (!list) return;

    let conversations = ConversationManager.list();
    const activeId = ConversationManager.getActiveId();

    // Filter by search query
    const searchInput = document.getElementById('convSearchInput');
    const query = (searchInput?.value || '').trim().toLowerCase();
    if (query) {
        conversations = conversations.filter(c =>
            (c.title || '').toLowerCase().includes(query)
        );
    }

    // Apply sort
    switch (_convSortMode) {
        case 'alpha':
            conversations.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
            break;
        case 'messages':
            conversations.sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0));
            break;
        case 'recent':
        default:
            conversations.sort((a, b) => b.updatedAt - a.updatedAt);
            break;
    }

    if (conversations.length === 0) {
        list.innerHTML = query
            ? '<div class="conv-empty">No matches</div>'
            : '<div class="conv-empty">No saved conversations</div>';
        return;
    }

    list.innerHTML = conversations.map(c => {
        const isActive = c.id === activeId;
        const date = _formatRelativeTime(c.updatedAt);
        const msgCount = c.messageCount || 0;
        const title = c.title || 'New Chat';
        const activeClass = isActive ? ' conv-item-active' : '';

        return `
            <div class="conv-item${activeClass}" data-conv-id="${c.id}">
                <div class="conv-item-content" data-conv-load="${c.id}" title="${_escapeAttr(title)}">
                    <div class="conv-item-title">${_escapeHtml(title)}</div>
                    <div class="conv-item-meta">${date} · ${msgCount} msg${msgCount !== 1 ? 's' : ''}</div>
                </div>
                <button type="button" class="btn-icon-danger conv-item-delete" data-conv-delete="${c.id}" title="Delete">✕</button>
            </div>
        `;
    }).join('');

    // Wire click handlers
    list.querySelectorAll('[data-conv-load]').forEach(el => {
        el.addEventListener('click', () => {
            const id = el.dataset.convLoad;
            if (id === ConversationManager.getActiveId()) return;
            ConversationManager.load(id);
            renderMessages();
            document.getElementById('conversationDrawer')?.classList.remove('open');
        });
    });

    list.querySelectorAll('[data-conv-delete]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = el.dataset.convDelete;
            ConversationManager.delete(id);
            renderMessages();
        });
    });
}

/** Format timestamp as relative time */
function _formatRelativeTime(ts) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString();
}

function _escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _escapeAttr(s) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
    exportChat,
    continueResponse,
    retryLastMessage,
    copyMessage,
    editMessage,
    cancelEdit,
    commitEdit,
    removeImage,
    previewImage,
    switchConversation: (id) => {
        ConversationManager.load(id);
        renderMessages();
    }
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
    continueResponse,
    retryLastMessage,
    copyMessage,
    editMessage,
    cancelEdit,
    commitEdit
};
