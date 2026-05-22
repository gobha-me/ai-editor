/**
 * Message Rendering and Formatting
 * Handles chat message display, formatting, and UI updates
 */

import { State, EventBus, Storage } from '../core.js';
import { stripThinkBlocks, splitThinkBlocks } from '../llm.js';
import { getChatContainer, getPendingEdit } from './state.js';
import { renderUnifiedView } from '../diff-viewer.js';
import { ChatSummarizer } from './summarizer.js';
import { ChatHistoryStore } from './history-store.js';
import { escapeHtml, escapeAttr } from '../utils/html.js';
import { mountConsentCard, unmountAll as unmountAllConsentCards } from './consent-card.js';
import { consentList } from '../intelligence/memory/index.js';
import { Profiles } from '../profiles/registry.js';
import { ConversationManager } from './conversations.js';
import {
    mountVirtualizer,
    teardownVirtualizer,
    notifyAppended as virtNotifyAppended,
} from './message-virtualizer.js';

/**
 * Build the empty-state profile chip row HTML — one chip per
 * `Profiles.list()` entry. The active chip is the per-chat binding (if
 * any) else the workspace default.
 *
 * **2.8.0** — surfaces the new-chat profile picker inside `.chat-welcome`
 * so the user picks at the moment they start a chat (one profile for the
 * life of a chat, per Decision §2). Picker auto-unmounts on first
 * message because `.chat-welcome` is replaced by the message virtualizer.
 *
 * @returns {string} HTML
 */
function _renderEmptyStateProfileChips() {
    const entries = Profiles.list();
    const active = ConversationManager.getEffectiveProfileName();
    const chips = entries.map(e => {
        const isActive = e.name === active;
        return `<button class="welcome-profile-chip${isActive ? ' is-active' : ''}" type="button" data-profile-name="${escapeHtml(e.name)}" title="${escapeHtml(e.description)}">${escapeHtml(e.label)}</button>`;
    }).join('');
    const activeEntry = entries.find(e => e.name === active) || entries[0];
    const desc = activeEntry ? activeEntry.description : '';
    return `
        <div class="welcome-profile-picker" data-welcome-profile-picker>
            <p class="welcome-profile-picker-label">Profile for this chat</p>
            <div class="welcome-profile-chips" role="radiogroup" aria-label="Profile for this chat">
                ${chips}
            </div>
            <p class="welcome-profile-chip-desc" data-welcome-profile-desc>${escapeHtml(desc)}</p>
        </div>
    `;
}

/**
 * Wire the empty-state chip row's click handlers. Called after innerHTML
 * is set on the chat container. Idempotent — bails if the picker isn't
 * mounted (chat is non-empty).
 */
function _wireEmptyStateProfileChips() {
    const picker = document.querySelector('[data-welcome-profile-picker]');
    if (!picker) return;
    const desc = picker.querySelector('[data-welcome-profile-desc]');
    const chips = picker.querySelectorAll('.welcome-profile-chip');
    chips.forEach(chip => {
        chip.addEventListener('click', () => {
            const name = chip.getAttribute('data-profile-name');
            if (!name || !Profiles.has(name)) return;
            chips.forEach(c => c.classList.remove('is-active'));
            chip.classList.add('is-active');
            const entry = Profiles.list().find(e => e.name === name);
            if (desc && entry) desc.textContent = entry.description;
            ConversationManager.setActiveProfile(name);
            EventBus.emit('profile:changed', { profile: name, source: 'welcome-chip' });
        });
    });
}

/**
 * Add a message to chat history and render it.
 *
 * `meta` may carry additional turn properties spread onto the persisted
 * record. Notable optional fields:
 *   - reasoning: ReasoningBlock|null (1.3.1) — captured <think>/<thinking>
 *     content, rendered as a collapsed bubble above the response. Absent
 *     ≡ no-bubble; pre-1.3.1 turns persist with reasoning undefined.
 *   - hasCode, elapsedTime, tool_calls, etc.
 */
/**
 * Build the collapsed reasoning <details> block for an assistant turn.
 * Matches the existing tool-call-details theming (no new CSS tokens).
 *
 * @param {{provider:string|null, format:string, content:string, started_at:number|null, ended_at:number|null}} reasoning
 * @returns {string} HTML
 */
function buildReasoningHtml(reasoning) {
    const elapsed =
        (reasoning.started_at && reasoning.ended_at)
            ? Math.max(0, Math.round((reasoning.ended_at - reasoning.started_at) / 100) / 10)
            : null;
    const meta = [
        reasoning.provider || null,
        elapsed != null ? `${elapsed}s` : null,
    ].filter(Boolean).join(' · ');
    return `
        <details class="message-reasoning">
            <summary class="reasoning-summary">
                <span class="reasoning-icon"><svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5a3 3 0 0 0-3 3 3 3 0 0 0-3 3 3 3 0 0 0 1 2.2 3 3 0 0 0-.5 1.8 3 3 0 0 0 3 3 3 3 0 0 0 2.5 1.5A3 3 0 0 0 12 21V5a3 3 0 0 0-3-3M15 5a3 3 0 0 1 3 3 3 3 0 0 1 3 3 3 3 0 0 1-1 2.2 3 3 0 0 1 .5 1.8 3 3 0 0 1-3 3 3 3 0 0 1-2.5 1.5A3 3 0 0 1 12 21"/></svg></span>
                <span class="reasoning-label">Reasoning</span>
                ${meta ? `<span class="reasoning-meta">${escapeHtml(meta)}</span>` : ''}
            </summary>
            <div class="reasoning-body">${formatMessageContent(reasoning.content)}</div>
        </details>
    `;
}

export function addMessage(role, content, meta = {}) {
    console.log(`[addMessage] role=${role}, content length=${content?.length}`);

    const message = {
        role,
        content,
        timestamp: Date.now(),
        ...meta
    };

    ChatHistoryStore.append(message);

    // Async summarization — fire and forget, never blocks UI
    if (ChatSummarizer.shouldSummarize()) {
        setTimeout(() => {
            ChatSummarizer.generateAndStore().catch(e =>
                console.warn('[ChatSummarizer] background fail:', e.message)
            );
        }, 1500);
    }

    // Clear welcome screen on first message — when present, mount the
    // virtualizer fresh so the just-pushed message anchors the rendered
    // window. Otherwise append + notify so the existing window grows.
    const chatContainer = getChatContainer();
    const welcome = chatContainer?.querySelector('.chat-welcome');
    if (welcome) {
        welcome.remove();
        chatContainer.innerHTML = '';
        const lastUserIdx = _findLastUserIndex(State.chatHistory);
        mountVirtualizer(State.chatHistory, renderMessage, lastUserIdx);
    } else {
        renderMessage(message);
        // Tag the freshly-rendered node so the virtualizer's prune logic
        // counts it. Without the tag, live-appended turns would bloat past
        // MAX_WINDOW indefinitely.
        const node = chatContainer?.lastElementChild;
        if (node && !node.hasAttribute('data-virt-idx')) {
            node.setAttribute('data-virt-idx', String(State.chatHistory.length - 1));
        }
        virtNotifyAppended();
    }
    scrollToBottom();

    EventBus.emit('chat:message', message);
    return message;
}

/** Find the index of the last 'user' message in `history`, or -1. */
function _findLastUserIndex(history) {
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === 'user') return i;
    }
    return -1;
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
            <span class="message-role"><svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3-2 5-5 2 5 2 2 5 2-5 5-2-5-2ZM19 3v4M21 5h-4M3 17v4M5 19H1"/></svg> Assistant</span>
            <span class="message-time" id="streaming-elapsed">${formatElapsedTime(getStreamingElapsed())}</span>
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
    // Ensure the last user message gets edit/retry buttons after an error
    _injectUserEditButtons();
}

/**
 * Update streaming message content.
 * Timer is handled by the interval started in addStreamingMessage().
 */
export function updateStreamingMessage(content) {
    const messageEl = document.getElementById('streaming-message');
    if (messageEl) {
        const contentEl = messageEl.querySelector('.message-content');
        // Strip think blocks for display only; guard null/undefined
        const displayContent = stripThinkBlocks(content || '');
        contentEl.innerHTML = formatMessageContent(displayContent);
        
        scrollToBottom();
    }
}

/**
 * Finalize streaming message and add to history
 */
export function finalizeStreamingMessage(content, meta = {}) {
    // Coerce null/undefined to empty string
    content = content || '';

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
        // Strip think blocks for display only (no-op when streaming layer
        // already split them into meta.reasoning).
        const displayContent = stripThinkBlocks(content);
        contentEl.innerHTML = formatMessageContent(displayContent);

        // Reasoning bubble (1.3.1): prepend a collapsed <details> when
        // reasoning was captured; absent ≡ no-bubble.
        if (meta.reasoning && meta.reasoning.content && meta.reasoning.content.length > 0) {
            const wrapper = document.createElement('div');
            wrapper.innerHTML = buildReasoningHtml(meta.reasoning);
            const detailsEl = wrapper.firstElementChild;
            if (detailsEl) {
                contentEl.parentNode.insertBefore(detailsEl, contentEl);
            }
        }
        
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
            // github#38 — render an edit-proposal card mirroring the
            // tool-call chrome (path + diff) so the user can see what
            // they're approving instead of bare buttons over an empty
            // body. Reads pendingEdit at render time so virtualizer
            // re-renders Just Work without stashing state into meta.
            const proposalEl = buildEditProposalCard();
            if (proposalEl) {
                messageEl.appendChild(proposalEl);
            }
            actionsEl.innerHTML = `
                <button class="btn-apply" data-action="applyPendingEdit">✅ Apply to Editor</button>
                <button class="btn-reject" data-action="rejectPendingEdit">❌ Reject</button>
            `;
        } else {
            // Standard assistant message buttons (continue/copy)
            actionsEl.innerHTML = `
                <button class="btn-action btn-continue" data-action="continueResponse" title="Continue generating">🔄 Continue</button>
                <button class="btn-action btn-copy" data-action="copyMessage" title="Copy to clipboard"><svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/></svg> Copy</button>
            `;
        }
        
        messageEl.appendChild(actionsEl);
    }

    // Inject edit/retry buttons on the last user message now that response is complete
    _injectUserEditButtons();

    // Skip persisting empty assistant turns — they pollute chatHistory and
    // Storage, and `sanitizeMessages` would silently drop them on every
    // future request anyway. The DOM render above still handled any
    // visible side; only history persistence is gated here.
    if (!String(content).trim()) {
        return;
    }

    // Add to history. Content is the visible response text (reasoning
    // already split off into meta.reasoning by the streaming layer in
    // 1.3.1; pre-1.3.1 turns may still carry inline think blocks, which
    // the renderer's `splitThinkBlocks` fallback handles at display time).
    ChatHistoryStore.append({
        role: 'assistant',
        content,
        timestamp: Date.now(),
        ...meta
    });

    // Tag the finalized streaming node so the virtualizer prune treats it
    // like any other rendered turn (the streaming placeholder pre-dates the
    // virtualizer's tag pass), then count it toward the rendered window.
    if (messageEl) {
        messageEl.setAttribute('data-virt-idx', String(State.chatHistory.length - 1));
    }
    virtNotifyAppended();
}

/**
 * Render a single message
 */
export function renderMessage(message, isLastUserMessage = false) {
    console.log(`[renderMessage] role=${message.role}, content length=${message.content?.length}`);
    
    // Render tool messages using _display metadata
    if (message.role === 'tool') {
        if (message._display) {
            const { toolName, args, result } = message._display;
            addToolCallMessage(toolName, args, result);
        } else {
            console.log('[renderMessage] Skipping tool message (no _display metadata)');
        }
        return;
    }

    // Skip assistant messages that are tool-call-only (no visible content)
    if (message.role === 'assistant' && !message.content && message.tool_calls) {
        console.log('[renderMessage] Skipping tool-call-only assistant message');
        return;
    }

    const chatContainer = getChatContainer();
    if (!chatContainer) return;

    const messageEl = document.createElement('div');
    messageEl.className = `chat-message ${message.role}`;
    
    // 1.3.11: role icon swapped from emoji to inline Lucide SVG. The map
    // is hand-maintained alongside `js/ui/icons.js` rather than imported,
    // because messages.js is loaded in many contexts and these strings
    // are short enough not to warrant a circular-dep risk.
    const roleIconSvg = {
        user:      '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
        assistant: '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3-2 5-5 2 5 2 2 5 2-5 5-2-5-2ZM19 3v4M21 5h-4M3 17v4M5 19H1"/></svg>',
        system:    '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
        error:     '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2 21h20Z"/><path d="M12 9v4M12 17h.01"/></svg>'
    }[message.role] || '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/></svg>';

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
    let displayContent;
    let messageImages = [];  // data URLs for inline image rendering

    if (Array.isArray(message.content)) {
        // Multimodal content — extract text and images
        const textParts = message.content
            .filter(c => c.type === 'text')
            .map(c => c.text);
        displayContent = textParts.join('\n') || '';
        messageImages = message.content
            .filter(c => c.type === 'image_url')
            .map(c => c.image_url?.url)
            .filter(Boolean);
    } else {
        displayContent = (message.role === 'assistant') 
            ? stripThinkBlocks(message.content || '')
            : (message.content || '');
    }
    
    // If content is an object or array, stringify it for display
    if (typeof displayContent !== 'string') {
        displayContent = JSON.stringify(displayContent, null, 2) || '';
    }

    // Build image HTML for multimodal messages
    const imageHtml = messageImages.length > 0
        ? `<div class="message-images">${messageImages.map(url =>
            `<img src="${escapeAttr(url)}" alt="Attached image" class="message-image" data-action="previewImage" data-src="${escapeAttr(url)}">`
          ).join('')}</div>`
        : '';

    // Reasoning bubble (1.3.1): collapsed <details> above content for assistant
    // turns whose <think>/<thinking> content was captured by the streaming
    // layer. Guard rejects empty strings so an empty bubble shell never renders.
    const reasoningHtml = (
        message.role === 'assistant' &&
        message.reasoning &&
        message.reasoning.content &&
        message.reasoning.content.length > 0
    )
        ? buildReasoningHtml(message.reasoning)
        : '';

    messageEl.innerHTML = `
        <div class="message-header">
            <span class="message-role">${roleIconSvg} ${roleName}</span>
            <span class="message-time">${timeDisplay}</span>
        </div>
        ${imageHtml}
        ${reasoningHtml}
        <div class="message-content">${formatMessageContent(displayContent)}</div>
    `;

    // Add action buttons to appropriate message types
    if (message.role === 'assistant') {
        const actionsEl = document.createElement('div');
        actionsEl.className = 'message-actions';
        actionsEl.innerHTML = `
            <button class="btn-action btn-copy" data-action="copyMessage" title="Copy to clipboard"><svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/></svg> Copy</button>
        `;
        messageEl.appendChild(actionsEl);
    } else if (message.role === 'user' && isLastUserMessage) {
        // Only show retry/edit on the most recent user message
        const actionsEl = document.createElement('div');
        actionsEl.className = 'message-actions';
        actionsEl.innerHTML = `
            <button class="btn-action btn-edit" data-action="editMessage" title="Edit and resend"><svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.85 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg> Edit</button>
            <button class="btn-action btn-retry" data-action="retryLastMessage" title="Retry this request"><svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg> Retry</button>
        `;
        messageEl.appendChild(actionsEl);
    }

    chatContainer.appendChild(messageEl);
}

/**
 * Build the edit-proposal card shown above the Apply/Reject buttons when
 * `finalizeStreamingMessage` runs with `meta.hasCode = true`. Mirrors the
 * `addToolCallMessage` chrome — same `tool-call-*` classes, same diff
 * tokens — so we don't introduce new CSS surface (github#38).
 *
 * Three rendering tiers, picked from what `pendingEdit` carries:
 *
 *   1. Full      — path + originalContent + code: unified diff via
 *                  `renderUnifiedView`.
 *   2. No baseline — path + code only (no originalContent): proposed
 *                    code in a `<pre>` (no diff possible).
 *   3. Defensive — pendingEdit null: returns null, caller falls back to
 *                  bare buttons. Should be unreachable in normal flow;
 *                  defends against virtualizer re-renders racing
 *                  pendingEdit clears.
 *
 * @returns {HTMLElement|null}
 */
function buildEditProposalCard() {
    const pendingEdit = getPendingEdit();
    if (!pendingEdit || typeof pendingEdit !== 'object' || !pendingEdit.code) {
        return null;
    }

    const path = pendingEdit.path || null;
    const proposedCode = String(pendingEdit.code);
    const originalContent = pendingEdit.originalContent;
    const hasBaseline = typeof originalContent === 'string';

    const cardEl = document.createElement('div');
    cardEl.className = 'chat-message tool-call tool-success edit-proposal';

    const argSummary = path ? path : '(no file open)';
    let body;
    if (hasBaseline) {
        const originalLines = originalContent.split('\n');
        const modifiedLines = proposedCode.split('\n');
        body = `
            <div class="tool-call-section">
                <div class="tool-call-label">Diff</div>
                <div class="diff-viewer">${renderUnifiedView(originalLines, modifiedLines)}</div>
            </div>
        `;
    } else {
        body = `
            <div class="tool-call-section">
                <div class="tool-call-label">Proposed contents</div>
                <pre class="tool-call-json">${escapeHtml(proposedCode)}</pre>
            </div>
        `;
    }

    cardEl.innerHTML = `
        <details class="tool-call-details" open>
            <summary class="tool-call-summary">
                <span class="tool-call-icon">✏️</span>
                <span class="tool-call-name">edit_file (proposed)</span>
                <span class="tool-call-args-summary">${escapeHtml(argSummary)}</span>
                <span class="tool-call-status">⏳ awaiting approval</span>
            </summary>
            <div class="tool-call-body">
                ${body}
            </div>
        </details>
    `;
    return cardEl;
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

    // Invisible-Unicode warning band — surfaces the `_security.invisibleUnicode`
    // attached by `ToolRegistry.execute()` (registry-level scan, 2.17.1) and by
    // the issue/PR tools (1.6.12). Render-side fallback so visibility doesn't
    // depend on the model honoring the system-prompt rule that re-feeds the
    // warning on the next turn.
    //
    // Shape note: issue/PR tools attach an ARRAY of per-source scan results
    // (PR body + each comment scanned independently); the registry attaches
    // a single scan result over the whole envelope. Normalizing here lets one
    // band render both — and reading both shapes is preferable to changing
    // either attachment site.
    const invisibleUnicode = result?._security?.invisibleUnicode;
    const invisibleScans = Array.isArray(invisibleUnicode)
        ? invisibleUnicode
        : (invisibleUnicode ? [invisibleUnicode] : []);
    let invisibleCount = 0;
    const invisibleFamilies = new Set();
    for (const scanEntry of invisibleScans) {
        if (!scanEntry) continue;
        if (typeof scanEntry.count === 'number') invisibleCount += scanEntry.count;
        if (Array.isArray(scanEntry.families)) {
            for (const fam of scanEntry.families) invisibleFamilies.add(fam);
        }
    }
    let securityWarningHtml = '';
    if (invisibleCount > 0) {
        const familiesText = invisibleFamilies.size > 0
            ? Array.from(invisibleFamilies).join(', ')
            : '(unspecified)';
        securityWarningHtml = `
                <div class="tool-call-security-warning">
                    ⚠ Invisible Unicode detected (${invisibleCount}): ${escapeHtml(familiesText)}
                </div>`;
    }

    // 2.49.0 — Sub-agents Phase 1 slice 2. For `delegate_task` tool
    // calls, surface a "View sub-agent transcript" button when the
    // result envelope carries a `transcript_id`. The button emits
    // `subagent:open_transcript` which `subagent-transcript-panel.js`
    // listens for to mount the slide-over.
    const subagentTranscriptId = (toolName === 'delegate_task' && typeof result?.transcript_id === 'string' && result.transcript_id)
        ? result.transcript_id
        : null;
    const subagentLinkHtml = subagentTranscriptId ? `
                <div class="tool-call-section tool-call-subagent-link">
                    <button type="button" class="subagent-transcript-link" data-transcript-id="${escapeHtml(subagentTranscriptId)}">
                        🔍 View sub-agent transcript
                    </button>
                </div>` : '';

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
            <div class="tool-call-body">${securityWarningHtml}
                <div class="tool-call-section">
                    <div class="tool-call-label">Arguments</div>
                    <pre class="tool-call-json">${escapeHtml(argsJson)}</pre>
                </div>
                <div class="tool-call-section">
                    <div class="tool-call-label">Result</div>
                    <pre class="tool-call-json">${escapeHtml(truncatedResult)}</pre>
                </div>${subagentLinkHtml}
            </div>
        </details>
    `;
    // Wire the sub-agent transcript button.
    if (subagentTranscriptId) {
        const btn = messageEl.querySelector('.subagent-transcript-link');
        if (btn) {
            btn.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                try {
                    EventBus.emit('subagent:open_transcript', { transcriptId: subagentTranscriptId });
                } catch { /* best-effort */ }
            });
        }
    }
    chatContainer.appendChild(messageEl);
    virtNotifyAppended();
    scrollToBottom();
}

/**
 * Append an inline memory-consent slot for an `agent_proposed`
 * `memory_remember` proposal (Memory PR #6, Touch 1 Flow 1). Sits below
 * the tool-call panel for the originating call. The Preact component
 * mounts asynchronously; the slot DOM element is reachable immediately
 * via `data-candidate-id` for tests + reflows.
 *
 * @param {string} candidateId
 */
export function addConsentCardMessage(candidateId) {
    if (typeof candidateId !== 'string' || candidateId.length === 0) return;
    const chatContainer = getChatContainer();
    if (!chatContainer) return;

    // Don't double-mount the same candidate (e.g. renderMessages re-walk
    // race with a freshly-emitted CONSENT_REQUESTED event).
    const existing = chatContainer.querySelector(
        `.mem-consent-slot[data-candidate-id="${CSS && CSS.escape ? CSS.escape(candidateId) : candidateId}"]`
    );
    if (existing) return;

    const slot = document.createElement('div');
    slot.className = 'chat-message mem-consent-slot';
    slot.dataset.candidateId = candidateId;
    chatContainer.appendChild(slot);

    // Fire-and-forget; mount errors are logged inside `mountConsentCard`.
    mountConsentCard(slot, candidateId);
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
 * Render all messages in chat history.
 *
 * Delegates to the message virtualizer (1.6.x dogfood fix): only the
 * trailing window is mounted; older messages page in via a top sentinel +
 * IntersectionObserver. See `js/chat/message-virtualizer.js`.
 */
export function renderMessages(historyOverride = null) {
    const chatContainer = getChatContainer();
    if (!chatContainer) return;

    // Drain Preact consent-card mounts and tear down any prior virtualizer
    // before nuking the DOM. Without the consent drain, listeners
    // subscribed in the component would leak across re-renders.
    unmountAllConsentCards();
    teardownVirtualizer();
    chatContainer.innerHTML = '';

    const history = historyOverride || State.chatHistory;

    if (history.length === 0) {
        chatContainer.innerHTML = `
            <div class="chat-welcome">
                <h3 style="display: inline-flex; align-items: center; gap: 0.4em;">
                    <svg class="icn icn--lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3-2 5-5 2 5 2 2 5 2-5 5-2-5-2ZM19 3v4M21 5h-4M3 17v4M5 19H1"/></svg>
                    <span>Welcome to AI Editor</span>
                </h3>
                <p>Ask me to:</p>
                <ul>
                    <li>Edit or refactor code</li>
                    <li>Explain what code does</li>
                    <li>Write new functions or files</li>
                    <li>Fix bugs or improve code</li>
                </ul>
                <p class="hint">Tip: Select code in the editor and ask about it specifically!</p>
                ${_renderEmptyStateProfileChips()}
            </div>
        `;
        _wireEmptyStateProfileChips();
        return;
    }

    const lastUserMessageIndex = _findLastUserIndex(history);
    mountVirtualizer(history, renderMessage, lastUserMessageIndex);

    // Show summary badge at top if a summary exists. `renderSummaryNotification`
    // inserts before chatContainer.firstChild — that becomes the sentinel,
    // so the badge ends up above the sentinel, which is fine visually and
    // doesn't affect the observer (it tracks viewport intersection).
    const summaryInfo = Storage.get('chatSummaryInfo', null);
    if (summaryInfo?.summary) {
        renderSummaryNotification(summaryInfo, ChatSummarizer.hasStash());
    }

    // Re-mount any pending consent candidates at the chat tail. Surviving
    // proposals from the same session — e.g. user navigated tabs and the
    // chat re-rendered, or `editMessage` triggered a re-render mid-flow —
    // get their cards restored without re-prompting the agent.
    try {
        const pending = consentList();
        for (const c of pending) {
            addConsentCardMessage(c.candidate_id);
        }
    } catch (e) {
        console.warn('[messages] consent re-mount failed:', e);
    }

    scrollToBottom();
}

/**
 * Clear all chat messages
 */
export function clearChat() {
    ChatHistoryStore.clear();
    State.lastExchangeTokens = null;
    ChatSummarizer.clear();
    // Drain consent-card mounts before renderMessages rebuilds the DOM.
    // The `chat:cleared` event below also drains the consent *queue*
    // (subscribed in app.js), so re-mount won't restore stale candidates.
    unmountAllConsentCards();
    renderMessages();
    EventBus.emit('chat:cleared');
}

/**
 * Format message content with markdown-like formatting
 */
export function formatMessageContent(content) {
    if (!content) return '';

    // Use marked.js if available, fall back to basic formatting
    if (typeof marked !== 'undefined') {
        try {
            const raw = marked.parse(content, { breaks: true, gfm: true });
            // Sanitize with DOMPurify if available
            if (typeof DOMPurify !== 'undefined') {
                return DOMPurify.sanitize(raw);
            }
            // SECURITY: DOMPurify not loaded — escape rather than pass through raw HTML
            console.warn('[SECURITY] DOMPurify not loaded — falling back to escaped output');
            return escapeHtml(content);
        } catch (e) {
            console.warn('Marked parse error, falling back to basic formatting:', e);
        }
    }

    // Fallback: basic regex formatting
    let html = escapeHtml(content);
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
        const langClass = lang ? `language-${lang}` : '';
        return `<pre class="code-block ${langClass}"><code>${code.trim()}</code></pre>`;
    });
    html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(/\n/g, '<br>');
    return html;
}

/**
 * Escape HTML special characters
 */
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

/**
 * Render a summary notification in the chat.
 * Shows a collapsible bar with the summary text and an undo button
 * that lets the user restore pruned messages (TTL = 1 user query).
 *
 * @param {Object} info - Summary info from ChatSummarizer
 * @param {string} info.summary - The generated summary text
 * @param {number} info.compressedMessages - Number of messages that were compressed
 * @param {number} info.keptMessages - Number of messages kept verbatim
 * @param {boolean} [showUndo=true] - Whether to show the undo button
 */
export function renderSummaryNotification(info, showUndo = true) {
    const chatContainer = getChatContainer();
    if (!chatContainer) return;

    // Remove any existing summary notification first
    const existing = chatContainer.querySelector('.chat-summary-notification');
    if (existing) existing.remove();

    const id = `summary-${Date.now()}`;
    const el = document.createElement('div');
    el.className = 'chat-summary-notification';
    el.innerHTML = `
        <div class="summary-bar" data-action="toggleExpanded" data-target="${escapeAttr(id)}">
            <span class="summary-icon">📋</span>
            <span class="summary-label">Context compressed — ${info.compressedMessages} messages → summary (${info.keptMessages} kept)</span>
            ${showUndo ? '<button type="button" class="btn-summary-undo" title="Restore original messages (available until next query)">↩ Undo</button>' : ''}
            <span class="summary-chevron">▸</span>
        </div>
        <div class="summary-detail" id="${escapeAttr(id)}">
            <div class="summary-text">${escapeHtml(info.summary)}</div>
        </div>
    `;

    // Wire undo button — stops event propagation so it doesn't toggle the detail
    if (showUndo) {
        const undoBtn = el.querySelector('.btn-summary-undo');
        undoBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            EventBus.emit('chat:undoPrune');
        });
    }

    // Insert at top of chat container
    chatContainer.insertBefore(el, chatContainer.firstChild);
}

/**
 * Inject edit/retry buttons onto the last user message in the DOM.
 * Called after an assistant response completes (finalize or error).
 * Safe to call multiple times — skips if buttons already exist.
 */
function _injectUserEditButtons() {
    const chatContainer = getChatContainer();
    if (!chatContainer) return;

    // Find the last user message element in the DOM
    const userMessages = chatContainer.querySelectorAll('.chat-message.user');
    if (userMessages.length === 0) return;

    const lastUserEl = userMessages[userMessages.length - 1];

    // Skip if buttons already exist
    if (lastUserEl.querySelector('.message-actions')) return;

    const actionsEl = document.createElement('div');
    actionsEl.className = 'message-actions';
    actionsEl.innerHTML = `
        <button class="btn-action btn-edit" data-action="editMessage" title="Edit and resend">✏️ Edit</button>
        <button class="btn-action btn-retry" data-action="retryLastMessage" title="Retry this request">🔁 Retry</button>
    `;
    lastUserEl.appendChild(actionsEl);
}

/**
 * Inject continue/copy buttons onto the last assistant message in the DOM.
 * Used by the tool-loop early-return path in handlers.js when the loop ends
 * with a tool-result-only turn — by that point `finalizeStreamingMessage`'s
 * placeholder is already gone (id stripped or element removed by
 * `onRoundCommit`), so the standard finalize path can't attach buttons.
 * Safe to call multiple times — skips if buttons already exist.
 *
 * gobha-me/ai-editor#41.
 */
function _injectAssistantContinueButtons() {
    const chatContainer = getChatContainer();
    if (!chatContainer) return;

    const assistantMessages = chatContainer.querySelectorAll('.chat-message.assistant');
    if (assistantMessages.length === 0) return;

    const lastAssistantEl = assistantMessages[assistantMessages.length - 1];

    if (lastAssistantEl.querySelector('.message-actions')) return;

    const actionsEl = document.createElement('div');
    actionsEl.className = 'message-actions';
    actionsEl.innerHTML = `
        <button class="btn-action btn-continue" data-action="continueResponse" title="Continue generating">🔄 Continue</button>
        <button class="btn-action btn-copy" data-action="copyMessage" title="Copy to clipboard"><svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/></svg> Copy</button>
    `;
    lastAssistantEl.appendChild(actionsEl);
}

/**
 * Inject finalization buttons on both the last assistant message (continue +
 * copy) and the last user message (edit + retry). Single entry point for
 * code paths that need to render the post-turn affordances without going
 * through `finalizeStreamingMessage` (which requires the streaming-message
 * placeholder to still be in the DOM).
 */
export function injectFinalizationButtons() {
    _injectAssistantContinueButtons();
    _injectUserEditButtons();
}

/**
 * Replace a user message bubble with an inline editor for editing and resending.
 * @param {HTMLElement} buttonEl - The edit button that was clicked
 */
export function editMessage(buttonEl) {
    const messageEl = buttonEl.closest('.chat-message');
    if (!messageEl) return;

    const contentEl = messageEl.querySelector('.message-content');
    const actionsEl = messageEl.querySelector('.message-actions');
    if (!contentEl) return;

    // Get the raw text content (strip any HTML formatting)
    const originalText = contentEl.innerText || contentEl.textContent;

    // Replace content with editable textarea
    contentEl.classList.add('editing');
    contentEl.innerHTML = `
        <textarea class="edit-message-input">${escapeHtml(originalText)}</textarea>
        <div class="edit-message-actions">
            <button class="btn-action btn-edit-save" data-action="commitEdit">💾 Send</button>
            <button class="btn-action btn-edit-cancel" data-action="cancelEdit">✖ Cancel</button>
        </div>
    `;

    // Hide the retry/edit buttons while editing
    if (actionsEl) actionsEl.style.display = 'none';

    // Focus and select the textarea
    const textarea = contentEl.querySelector('.edit-message-input');
    textarea.focus();
    textarea.select();

    // Auto-resize to fit content
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
    textarea.addEventListener('input', () => {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
    });
}

/**
 * Cancel inline edit — restore the original message content.
 * @param {HTMLElement} buttonEl - The cancel button
 */
export function cancelEdit(buttonEl) {
    // Just re-render everything to restore original state
    renderMessages();
}

/**
 * Commit the edited message — truncate history from this point and resend.
 * @param {HTMLElement} buttonEl - The save button
 */
export function commitEdit(buttonEl) {
    const messageEl = buttonEl.closest('.chat-message');
    if (!messageEl) return;

    const textarea = messageEl.querySelector('.edit-message-input');
    if (!textarea) return;

    const newText = textarea.value.trim();
    if (!newText) return;

    // Emit event — index.js handles the history truncation and resend
    EventBus.emit('chat:editAndResend', { newContent: newText });
}

/**
 * Bind a delegated click handler for chat-message action buttons —
 * Phase 3b of the inline-handlers migration
 * (docs/DESIGN-html-inline-handlers-migration.md). Scoped to
 * `#chatMessages` (the persistent message container declared in
 * `html/chat-panel.html`); `renderMessages()` rewrites the panel's
 * innerHTML on every refresh and the virtualizer recycles message
 * nodes, so the document-level listener survives both.
 *
 * Routes 9 callback actions plus an internal DOM-only `toggleExpanded`
 * (per Decision 5 — `classList.toggle` doesn't deserve a callback).
 * The five `this`-passing call sites (`copyMessage`, `editMessage`,
 * `retryLastMessage` — though the latter takes no arg — `commitEdit`,
 * `cancelEdit`) receive the matched button element so the existing
 * `buttonEl.closest('.chat-message')` traversals in
 * `editMessage`/`commitEdit`/etc. keep working unchanged.
 *
 * `previewImage` receives the URL string read from `data-src` so the
 * old `this.src` access on the `<img>` survives translation.
 */
let _chatMessagesWired = false;
export function mountChatMessages({
    onApplyPendingEdit,
    onRejectPendingEdit,
    onContinueResponse,
    onCopyMessage,
    onEditMessage,
    onRetryLastMessage,
    onCommitEdit,
    onCancelEdit,
    onPreviewImage,
} = {}) {
    if (_chatMessagesWired) return;
    _chatMessagesWired = true;

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        if (!btn.closest('#chatMessages')) return;
        const action = btn.getAttribute('data-action');
        switch (action) {
            case 'applyPendingEdit':
                if (typeof onApplyPendingEdit === 'function') onApplyPendingEdit();
                break;
            case 'rejectPendingEdit':
                if (typeof onRejectPendingEdit === 'function') onRejectPendingEdit();
                break;
            case 'continueResponse':
                if (typeof onContinueResponse === 'function') onContinueResponse();
                break;
            case 'copyMessage':
                if (typeof onCopyMessage === 'function') onCopyMessage(btn);
                break;
            case 'editMessage':
                if (typeof onEditMessage === 'function') onEditMessage(btn);
                break;
            case 'retryLastMessage':
                if (typeof onRetryLastMessage === 'function') onRetryLastMessage();
                break;
            case 'commitEdit':
                if (typeof onCommitEdit === 'function') onCommitEdit(btn);
                break;
            case 'cancelEdit':
                if (typeof onCancelEdit === 'function') onCancelEdit(btn);
                break;
            case 'previewImage':
                if (typeof onPreviewImage === 'function') {
                    onPreviewImage(btn.getAttribute('data-src'));
                }
                break;
            case 'toggleExpanded': {
                const target = btn.getAttribute('data-target');
                if (target) document.getElementById(target)?.classList.toggle('expanded');
                break;
            }
            default:
                // Unknown data-action — ignore. Other chat-internal
                // surfaces (consent card, ask-user card, queued-input
                // panel) own their own data-action namespaces and
                // mount their own dispatchers.
                break;
        }
    });
}
