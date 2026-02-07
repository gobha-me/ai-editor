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

// Import submodules
import { chatState, setChatContainer, setInputElement, getPendingEdit, setPendingEdit, getCancelFlag, setCancelFlag } from './state.js';
import { ChatSummarizer } from './summarizer.js';
import { validateToolParameters, executeToolCall, parseTextToolCalls } from './tools.js';
import { 
    addMessage, 
    addStreamingMessage, 
    updateStreamingMessage, 
    finalizeStreamingMessage,
    renderMessage,
    renderMessages,
    clearChat,
    addToolCallMessage,
    scrollToBottom
} from './messages.js';
import { setupInputHandlers, handleUserInputDirect, sendMessage, stopGeneration } from './input.js';
import { exportChat } from './export.js';
import { 
    detectIntent,
    handleEditRequest,
    handleExplainRequest,
    handleCommitRequest,
    handleIssueRequest,
    handleGeneralRequest,
    applyPendingEdit,
    rejectPendingEdit
} from './handlers.js';

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
// INITIALIZATION
// ============================================

function initChat(containerEl, inputEl) {
    setChatContainer(containerEl);
    setInputElement(inputEl);

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
    setupInputHandlers();

    // Listen for LLM events
    EventBus.on('llm:token', ({ token, content }) => {
        updateStreamingMessage(content);
    });

    EventBus.on('llm:generating', (isGenerating) => {
        const inputElement = chatState.inputElement;
        if (inputElement) {
            inputElement.disabled = isGenerating;
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
