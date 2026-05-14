/**
 * Request Handlers
 * Intent detection and specialized request handlers (edit, explain, commit, issue, general)
 */

import { State, EventBus } from '../core.js';
import { LLM, LLMTools, generateEdit, generateCommitMessage, buildSystemPrompt, stripThinkBlocks } from '../llm.js';
import { applyEdit, computeSimpleDiff } from '../editor.js';
import {
    addMessage,
    addStreamingMessage,
    updateStreamingMessage,
    finalizeStreamingMessage,
    cleanupStreamingMessage,
    addToolCallMessage,
    addConsentCardMessage,
    formatMessageContent
} from './messages.js';
import {
    getPendingEdit,
    setPendingEdit,
    clearPendingEdit,
    isToolLoopCancelled,
    resetToolLoopCancel,
    getPendingImages,
    clearPendingImages,
    addPendingImage,
    getUserMessageQueueLength,
    drainUserMessageQueue,
    enqueueUserMessage
} from './state.js';
import { renderImagePreview } from './input.js';
import { ChatSummarizer } from './summarizer.js';
import { ChatHistoryStore } from './history-store.js';
import { getCompressedContextMessages } from './compactor-integration.js';
import { withRetry } from '../retry.js';
import { ConversationManager } from './conversations.js';
import { recordInvocation as recordToolInvocation, recordDiscoveryAdmissions } from './task-state.js';
import { _readDiscoveryCap } from '../intelligence/tools/embeddings.js';
import { Catalog } from '../intelligence/tools/index.js';
import { resolveTools } from '../profiles/resolve.js';
import { runToolLoop } from './tool-loop-core.js';

/**
 * Main entry point for user input
 *
 * On transient API failures, automatically retries the handler (not the user
 * message) up to MAX_INPUT_RETRIES times with exponential backoff.
 * The user message is added to history exactly once — retries re-attempt
 * the handler only, so the conversation is never forked.
 */
const MAX_INPUT_RETRIES = 2;   // 3 total attempts (1 original + 2 retries)
const INPUT_RETRY_BASE_MS = 2000;

/**
 * Build the multimodal user message content from text + attached
 * images/text-files. Plain string when there are no attachments,
 * otherwise an array of `{type:'text'|'image_url', ...}` parts in the
 * shape providers expect. Used by `handleUserInputDirect` (live send)
 * and the queue-drain seam in `handleGeneralRequest` (Phase 2).
 *
 * @param {string} text
 * @param {Array<{type?: string, name?: string, dataUrl?: string, textContent?: string}>} images
 * @returns {string | Array<{type: string, [k: string]: any}>}
 */
export function buildUserContent(text, images) {
    if (!images || images.length === 0) return text;
    const parts = [];
    if (text) parts.push({ type: 'text', text });
    for (const img of images) {
        if (img.type === 'text' && img.textContent) {
            parts.push({
                type: 'text',
                text: `--- Attached file: ${img.name} ---\n${img.textContent}\n--- End of ${img.name} ---`
            });
        } else if (img.dataUrl) {
            parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
        }
    }
    return parts;
}

export async function handleUserInputDirect(input) {
    console.log(`[handleUserInputDirect] Received input="${input}"`);

    const images = getPendingImages().slice(); // snapshot

    if (!input && images.length === 0) return;
    if (State.isGenerating) return;

    const messageContent = buildUserContent(input, images);
    if (images.length > 0) {
        // Clear pending images and preview strip — they belong to this message now.
        clearPendingImages();
        renderImagePreview();
    }

    // Flush any pending prune stash — undo window is over
    ChatSummarizer.flushStash();

    // Add user message ONCE — retries must not duplicate this
    addMessage('user', messageContent);

    // Determine intent from text only
    const intent = detectIntent(input || '');

    /**
     * Build the handler thunk.  On retry this is re-invoked, but the user
     * message is already in history so the handler picks it up via
     * getContextMessages().
     */
    const runHandler = async () => {
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
    };

    try {
        await withRetry(runHandler, {
            maxRetries: MAX_INPUT_RETRIES,
            baseDelay: INPUT_RETRY_BASE_MS,
            maxDelay: 8000,
            onRetry: (attempt, delayMs, err) => {
                // Clean up any orphaned streaming state from the failed attempt
                cleanupStreamingMessage();
                console.warn(
                    `[handleUserInputDirect] Auto-retry ${attempt}/${MAX_INPUT_RETRIES} ` +
                    `in ${Math.round(delayMs)}ms: ${err.message}`
                );
                addMessage('system', `⚠️ Request failed (${_briefError(err)}). Retrying… (attempt ${attempt + 1})`);
            }
        });
    } catch (error) {
        // All retries exhausted — clean up and show error
        cleanupStreamingMessage();
        console.error('Chat error (after retries):', error);
        addMessage('error', `Error: ${error.message}`);
    }
}


/**
 * Shorten an error message for user-facing display.
 * Strips JSON noise from provider error payloads.
 */
export function _briefError(err) {
    const msg = err.message || String(err);
    // Strip JSON wrapper from "LLM stream error: ConnectionError: {...}" style messages
    const match = msg.match(/"message"\s*:\s*"([^"]+)"/);
    if (match) return match[1];
    // Truncate long messages
    return msg.length > 120 ? msg.slice(0, 117) + '…' : msg;
}

/**
 * Detect user intent from input text
 */
export function detectIntent(input) {
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
        if ((lower.includes('edit') || lower.includes('change') || lower.includes('modify') ||
            lower.includes('refactor') || lower.includes('rewrite'))
            && !lower.includes('review')) {
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

/**
 * Handle edit request (direct code modification)
 */
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
        // github#38 — stash path + originalContent snapshot so the
        // approval card renderer can show what's being approved (path +
        // diff against the file the user is currently looking at).
        // Snapshot at proposal time so the diff baseline doesn't drift if
        // the user edits the file before clicking Apply/Reject.
        setPendingEdit({
            ...result,
            path: State.currentFile?.path || null,
            originalContent: State.currentFile?.content ?? null,
        });
        finalizeStreamingMessage(result.raw, { hasCode: true });
    } else {
        finalizeStreamingMessage(result.raw, { hasCode: false });
    }
}

/**
 * Handle explain request
 */
async function handleExplainRequest(input) {
    // Explain requests benefit from tool access (reading files, searching code)
    // Delegate to general handler which has the full tool loop
    await handleGeneralRequest(input);
}

/**
 * Handle commit message generation request
 */
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

/**
 * Handle issue-based request
 */
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

/**
 * Handle general request with full tool access and iterative tool loop
 *
 * 2.48.0 — wrapper around `runToolLoop` (`./tool-loop-core.js`). The tool-loop
 * body, dup detection, cache invalidation, history-rollback, and per-round
 * compression all moved to the pure-ish core for reuse by Phase 1 sub-agents
 * (github#24). This wrapper owns the parent-conversation context shape:
 * compactor read, `State.chatHistory` writes via `ChatHistoryStore` hooks,
 * streaming DOM hooks, the user-input queue, and the `coder.v1` ledger gate.
 *
 * History safety: Snapshots chatHistory length on entry. The core calls
 * `setHistoryLength(snapshot)` via the injected hook when a request fails
 * catastrophically mid-loop, so the history isn't poisoned with orphaned
 * tool-call sequences.
 */
export async function handleGeneralRequest(input) {
    console.log(`[handleGeneralRequest] Starting with input="${input}"`);

    const historySnapshot = State.chatHistory.length;

    addStreamingMessage();
    resetToolLoopCancel();

    // 1.3.15: thread the admitted ToolDef[] through to the system prompt so
    // its tool enumeration matches the API tools array. Coder + Composer
    // active → dynamic enumeration of the admitted set; everywhere else →
    // legacy enumeration. The Composer runs once per call here and again
    // in getToolsForRole(); both are pure-function reads of the registry.
    const { admittedDefs, composerActive } = LLMTools.getAdmittedTools();
    const systemPrompt = buildSystemPrompt({ admittedDefs, composerActive });
    const roleTools = LLMTools.getToolsForRole();

    // Build initial message thread (compressed + summary-aware context).
    // Compactor (1.2.0) runs Rules 1+2 over State.chatHistory first;
    // ChatSummarizer.getContextMessages() then handles windowing,
    // tool-pair safety, and summary prefix on the compressed result.
    const contextMessages = await getCompressedContextMessages();
    console.log(`[handleGeneralRequest] Context messages count: ${contextMessages.length}`);

    const lastCtx = contextMessages[contextMessages.length - 1];
    const lastCtxText = lastCtx ? (
        Array.isArray(lastCtx.content)
            ? (lastCtx.content.find(c => c.type === 'text')?.text || '')
            : lastCtx.content
    ) : '';
    const alreadyInContext = lastCtx && lastCtx.role === 'user' && lastCtxText === input;

    const messages = [
        { role: 'system', content: systemPrompt },
        ...contextMessages,
        ...( alreadyInContext ? [] : [{ role: 'user', content: input }] )
    ];

    const profileNameForLedger = ConversationManager.getEffectiveProfileName();
    const conversationId = ConversationManager.getActiveId();

    const context = {
        messages,
        historySnapshot,
        roleTools,
        toolActionLog: State.toolActionLog,
        settings: {
            toolTimeout: State.settings.toolTimeout,
            longRunningToolTimeout: State.settings.longRunningToolTimeout,
            userPauseTimeout: State.settings.userPauseTimeout,
        },
        currentFilePath: State.currentFile?.path || null,
        profileNameForLedger,
        conversationId,
        cancelSignal: () => isToolLoopCancelled(),
        setHistoryLength: (n) => {
            const removed = State.chatHistory.length - n;
            if (removed > 0) {
                ChatHistoryStore.setLength(n);
                console.warn(`[_rollbackHistory] Rolled back ${removed} message(s) from failed request`);
            }
        },
    };

    const hooks = {
        onStreamToken: (content) => updateStreamingMessage(content),
        onStreamStart: () => addStreamingMessage(),
        onSystemMessage: (text) => addMessage('system', text),
        onToolCall: ({ toolName, args, toolResult }) => addToolCallMessage(toolName, args, toolResult),
        onConsentCard: (candidateId) => addConsentCardMessage(candidateId),
        onAssistantTurn: (msg) => ChatHistoryStore.append(msg),
        onToolResultTurn: (tr) => ChatHistoryStore.append(tr),
        onRoundCommit: ({ content, hasNewText }) => {
            // Mid-loop placeholder management. When the round produced new
            // text, commit it into the current placeholder so the next-round
            // `addStreamingMessage()` mounts a fresh element. When the round
            // produced only tool calls, drop the empty placeholder.
            const partialEl = document.getElementById('streaming-message');
            let lastRoundContent = content;
            let textCommittedMidLoop = false;
            if (partialEl) {
                if (hasNewText) {
                    partialEl.querySelector('.message-content').innerHTML = formatMessageContent(stripThinkBlocks(content));
                    partialEl.classList.remove('streaming');
                    lastRoundContent = '';
                    textCommittedMidLoop = true;
                } else {
                    partialEl.remove();
                }
                partialEl.removeAttribute('id');
            }
            return { lastRoundContent, textCommittedMidLoop };
        },
        onUserInputDrain: () => {
            // github#33 Phase 2 — between-round drain. The queued payload
            // becomes a user turn in chat history (via addMessage) AND in
            // the core's `messages[]` for the next LLM call.
            if (getUserMessageQueueLength() === 0) {
                return { drained: [], anyDrained: false };
            }
            const drainedMsgs = drainUserMessageQueue();
            const drainedForCore = [];
            for (const m of drainedMsgs) {
                const content = buildUserContent(m.text, m.images);
                addMessage('user', content);
                drainedForCore.push({ content });
            }
            return { drained: drainedForCore, anyDrained: true };
        },
        onLedgerRecord: ({ conversationId, toolName, args, toolResult, turnId }) => {
            // 1.3.17 / Tools PR 4 — the conversation's TaskLedger makes the
            // just-used non-static tool sticky-admissible on the next turn.
            // Gated to `coder.v1` because that is today's only profile with a
            // populated `tools.static` set; other profiles run the profile-side
            // admission filter which never consults the ledger.
            const tools = resolveTools('coder.v1');
            const td = Catalog.getByName(toolName);
            recordToolInvocation({
                conversationId,
                toolName,
                args,
                toolResult,
                turnId,
                surface: tools.profileName,
                staticNames: tools.static,
                toolCost: td ? td.metadata.cost_estimate : 0,
            });
        },
        onDiscoveryAdmissions: ({ conversationId, candidates }) => {
            // 1.4.1 — promote `find_tool` top matches into the ledger as
            // short-form discovery admissions.
            const tools = resolveTools('coder.v1');
            recordDiscoveryAdmissions({
                conversationId,
                surface: tools.profileName,
                candidates,
                cap: _readDiscoveryCap(),
            });
        },
        onPlanModeApproved: async () => {
            // Dynamic import preserved from pre-2.48.0 — keep state.js out of
            // the top-level import graph for this code path.
            const { setPlanMode } = await import('./state.js');
            setPlanMode(false);
        },
        onChatComplete: () => {
            // `LLM.chat`'s internal `finally` clears `State.isGenerating`
            // per-call; re-assert so any late observer of the wrapper-scoped
            // event sees the still-generating state across rounds.
            State.isGenerating = true;
            EventBus.emit('llm:generating', true);
        },
    };

    const transport = {
        chat: LLM.chat.bind(LLM),
        stop: LLM.stop.bind(LLM),
    };

    // Keep isGenerating true for the entire tool loop. LLM.chat's internal
    // finally clears its flag per-call; re-assert in the wrapper's envelope.
    State.isGenerating = true;
    EventBus.emit('llm:generating', true);

    let loopResult;
    try {
        loopResult = await runToolLoop(context, hooks, transport);
    } finally {
        // Always clean up generating state
        State.isGenerating = false;
        EventBus.emit('llm:generating', false);

        // === QUEUED USER INPUT — KICK NEW RUN (github#33 Phase 2) ===
        // The loop ended (natural stop OR cancellation) while messages
        // were still queued. Take the next queued message and dispatch
        // a fresh handleUserInputDirect so the model sees it. Remaining
        // queued messages stay queued and will drain at iteration
        // boundaries inside the new run. queueMicrotask breaks the
        // call-stack so the current finally completes cleanly.
        if (getUserMessageQueueLength() > 0) {
            const next = drainUserMessageQueue();
            const [first, ...rest] = next;
            for (const m of rest) enqueueUserMessage(m);
            for (const img of first.images) addPendingImage(img);
            queueMicrotask(() => {
                try { handleUserInputDirect(first.text); } catch (e) {
                    console.error('[queue] kick-new-run failed:', e);
                }
            });
        }
    }

    // If text was already committed mid-loop AND the final round produced no
    // new text, just clean up the placeholder and skip re-rendering.
    if (loopResult.textCommittedMidLoop && !loopResult.lastRoundContent.trim()) {
        const placeholder = document.getElementById('streaming-message');
        if (placeholder) placeholder.remove();
        return;
    }

    // Use last round's content for the final DOM element.
    // lastRoundReasoning carries the reasoning captured by _handleStream
    // for the round whose content we're rendering; older rounds' reasoning
    // is already attached to the assistant turns pushed during the loop.
    const finalText = loopResult.lastRoundContent.trim() ? loopResult.lastRoundContent : loopResult.finalContent;
    finalizeStreamingMessage(
        finalText,
        { hasCode: false, reasoning: loopResult.lastRoundReasoning }
    );
}

/**
 * Apply pending edit to editor
 */
export function applyPendingEdit() {
    const pendingEdit = getPendingEdit();
    if (!pendingEdit || !pendingEdit.code) {
        addMessage('system', '⚠️ No pending edit to apply.');
        return;
    }

    applyEdit(pendingEdit.code);
    addMessage('system', '✅ Edit applied to editor. Review and save when ready.');
    clearPendingEdit();

    // Remove action buttons
    document.querySelectorAll('.message-actions').forEach(el => el.remove());
}

/**
 * Reject pending edit
 */
export function rejectPendingEdit() {
    const pendingEdit = getPendingEdit();
    if (!pendingEdit) return;

    addMessage('system', '❌ Edit rejected. Ask me to try a different approach.');
    clearPendingEdit();

    // Remove action buttons
    document.querySelectorAll('.message-actions').forEach(el => el.remove());
}
