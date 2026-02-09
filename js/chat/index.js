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

// Import submodules
import { 
    initChatState,
    getChatContainer,
    getInputElement
} from './state.js';
import { ChatSummarizer } from './summarizer.js';
import { 
    addMessage, 
    renderMessages
} from './messages.js';
import { setupInputHandlers, stopGeneration } from './input.js';
import { exportChat } from './export.js';
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

// ============================================
// INITIALIZATION
// ============================================

function initChat(containerEl, inputEl) {
    initChatState(containerEl, inputEl);

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
 * Clear chat history
 */
function clearChat() {
    State.chatHistory = [];
    Storage.set('chatHistory', []);
    ChatSummarizer.clear();
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
    const lastUserMessage = [...State.chatHistory].reverse().find(msg => msg.role === 'user');
    
    if (!lastUserMessage) {
        showToast('⚠️ No previous message to retry', 'warning');
        return;
    }
    
    // Remove the last assistant response if it exists (to retry fresh)
    const lastMsg = State.chatHistory[State.chatHistory.length - 1];
    if (lastMsg && lastMsg.role === 'assistant') {
        State.chatHistory.pop();
        Storage.set('chatHistory', State.chatHistory.slice(-100));
        renderMessages();
    }
    
    // Resend the last user message
    handleUserInputDirect(lastUserMessage.content);
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

/**
 * Show a toast notification
 * @param {string} message - Toast message
 * @param {string} type - Toast type: success, error, warning
 */
function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
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
    copyMessage
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
    copyMessage
};
