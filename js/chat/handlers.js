/**
 * Request Handlers
 * Intent detection and specialized request handlers (edit, explain, commit, issue, general)
 */

import { State, EventBus, Storage } from '../core.js';
import { LLM, LLMTools, generateEdit, generateCommitMessage, buildSystemPrompt, stripThinkBlocks, getContextScale } from '../llm.js';
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
    clearPendingImages
} from './state.js';
import { renderImagePreview } from './input.js';
import { executeToolCall } from './tools.js';
import { parseTextToolCalls } from './tools.js';
import { ChatSummarizer } from './summarizer.js';
import { enrichToolResultTurn } from './turn-enrich.js';
import { getCompressedContextMessages } from './compactor-integration.js';
import { withRetry } from '../retry.js';
import { ConversationManager } from './conversations.js';
import { recordInvocation as recordToolInvocation, recordDiscoveryAdmissions } from './task-state.js';
import { _readDiscoveryCap } from '../intelligence/tools/embeddings.js';
import { Catalog } from '../intelligence/tools/index.js';
import { CODER_V1 } from '../profiles/coder-v1.js';

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

export async function handleUserInputDirect(input) {
    console.log(`[handleUserInputDirect] Received input="${input}"`);
    
    const images = getPendingImages().slice(); // snapshot
    
    if (!input && images.length === 0) return;
    if (State.isGenerating) return;

    // Build message content — multimodal array if attachments present, plain string otherwise
    let messageContent;
    if (images.length > 0) {
        messageContent = [];
        if (input) {
            messageContent.push({ type: 'text', text: input });
        }
        for (const img of images) {
            if (img.type === 'text' && img.textContent) {
                // Text file — include as labelled text block
                messageContent.push({
                    type: 'text',
                    text: `--- Attached file: ${img.name} ---\n${img.textContent}\n--- End of ${img.name} ---`
                });
            } else if (img.dataUrl) {
                // Image — include as image_url
                messageContent.push({
                    type: 'image_url',
                    image_url: { url: img.dataUrl }
                });
            }
        }
        // Clear pending images and preview strip
        clearPendingImages();
        renderImagePreview();
    } else {
        messageContent = input;
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
        setPendingEdit(result);
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
 * History safety: Snapshots chatHistory length on entry. If the request
 * fails catastrophically (all retries exhausted), intermediate assistant
 * and tool messages pushed mid-loop are rolled back so the history isn't
 * poisoned with orphaned tool-call sequences.
 */
export async function handleGeneralRequest(input) {
    console.log(`[handleGeneralRequest] Starting with input="${input}"`);
    
    // === HISTORY SNAPSHOT ===
    // Capture current history length so we can rollback mid-loop writes on failure
    const historySnapshot = State.chatHistory.length;
    
    addStreamingMessage();
    resetToolLoopCancel();  // Reset cancel flag

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
    // Handle multimodal content: extract text portion for comparison
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

    // Iterative tool call loop — max 8 rounds to support complex workflows
    const MAX_TOOL_ROUNDS = 8;
    let finalContent = '';          // Accumulated across rounds (used for error fallback)
    let lastRoundContent = '';      // Only the current round's text (used for DOM + history)
    let lastRoundReasoning = null;  // Reasoning captured by _handleStream for the last round
    const toolActions = []; // Track all tool executions for fallback summary
    
    // === DUPLICATE TOOL CALL DETECTION ===
    // Track tool+args combinations to prevent re-fetching the same data
    const toolCallCache = new Map(); // key: "toolName|canonicalArgs" → result
    let _hasRetried = false;  // One transient-error retry per request

    // Keep isGenerating true for the entire tool loop
    State.isGenerating = true;
    EventBus.emit('llm:generating', true);

    try {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            // Check cancellation before each round
            if (isToolLoopCancelled()) {
                console.log('[TOOL-LOOP] Cancelled by user');
                break;
            }

            let content = '';
            let result;

            try {
                // Idle-timeout lives inside LLM._handleStream — the timer resets on
                // every reader.read() chunk arrival, so reasoning models that pause
                // before emitting their first token no longer get falsely aborted.
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

                result = await LLM.chat(messages, chatOptions);

                content = content || result.content || '';

                // Re-assert isGenerating (LLM.chat's finally sets it false)
                State.isGenerating = true;
                EventBus.emit('llm:generating', true);

            } catch (err) {
                // Abort any in-flight request
                LLM.stop();
                lastRoundContent = '';  // Ensure error paths use finalContent fallback
                
                if (isToolLoopCancelled()) break;

                // === RETRY LOGIC for transient API errors ===
                // On round 0 with no tool state to lose, retry once after a brief pause.
                // Catches Venice "zero-length empty document", transient 5xx, etc.
                const isTransient = round === 0 && toolActions.length === 0 && !content &&
                    (err.message.includes('zero-length') || err.message.includes('empty document') ||
                     err.message.includes('ConnectionError') || err.message.includes('502') ||
                     err.message.includes('503') || err.message.includes('504') ||
                     err.message.includes('timeout'));
                
                if (isTransient && !_hasRetried) {
                    _hasRetried = true;
                    console.warn(`[TOOL-LOOP] Transient error on round 0, retrying after 1.5s: ${err.message}`);
                    updateStreamingMessage('*(API error — retrying…)*');
                    await new Promise(r => setTimeout(r, 1500));
                    round--; // Don't consume a round for the retry
                    continue;
                }
                
                if (toolActions.length > 0) {
                    // === CRITICAL: Roll back orphaned tool-call messages ===
                    // The tool loop pushed assistant+tool messages to chatHistory
                    // during the `continue` at the end of the previous round.
                    // Since this round failed, those messages are orphaned and
                    // will poison all future requests (Venice/OpenRouter will
                    // reject tool protocol messages they can't process).
                    _rollbackHistory(historySnapshot);
                    
                    // Show what tools did accomplish (as plain text, not tool protocol)
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
                    // === HISTORY ROLLBACK ===
                    // Total failure with no content and no tool progress.
                    // Roll back any mid-loop history writes so the caller
                    // (withRetry in handleUserInputDirect) can retry cleanly.
                    _rollbackHistory(historySnapshot);
                    throw err;
                }
                break;
            }

            // === CHECK FOR TOKEN LIMIT TRUNCATION ===
            if (result.finishReason === 'length') {
                console.warn('[TOOL-LOOP] Response truncated due to token limit');
                // Add guidance message to help AI recover
                const guidanceMsg = {
                    role: 'system',
                    content: '⚠️ Your previous response was truncated due to token limit. Please continue with:\n' +
                             '1. If you were calling tools, make the calls with complete parameters now\n' +
                             '2. If generating code, break it into smaller sections\n' +
                             '3. Focus on completing the current task in smaller steps'
                };
                messages.push(guidanceMsg);
                addMessage('system', guidanceMsg.content);
                
                // Allow one more round to recover
                if (round < MAX_TOOL_ROUNDS - 1) {
                    continue;
                }
            }

            // === LAYER 1: Structured tool_calls from API (primary path) ===
            let toolCalls = result.toolCalls ? [...result.toolCalls] : [];
            // Streaming layer (1.3.1) splits <think>/<thinking> off into result.reasoning,
            // so content/result.content are already reasoning-free. The stripThinkBlocks
            // call below is a defensive no-op for non-streaming providers that emit think
            // blocks intact in the final response.
            let cleanContent = stripThinkBlocks(content || result.content || '');
            let toolCallSource = toolCalls.length > 0 ? 'structured' : null;
            lastRoundReasoning = result.reasoning || null;

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
                    if (isToolLoopCancelled()) break;
                    if (!toolCall?.function) continue; // skip sparse array holes

                    const toolName = toolCall.function?.name || 'unknown';
                    let args = {};
                    try {
                        args = JSON.parse(toolCall.function?.arguments || '{}');
                    } catch (e) { /* malformed args */ }

                    // === DUPLICATE DETECTION ===
                    // Build a canonical cache key from tool name + sorted args
                    const cacheKey = toolName + '|' + JSON.stringify(args, Object.keys(args).sort());
                    const cachedResult = toolCallCache.get(cacheKey);
                    
                    let toolResult;
                    if (cachedResult && !['replace_lines', 'insert_lines', 'delete_lines', 'create_file', 
                                          'edit_file', 'write_file', 'delete_file',
                                          'update_issue', 'add_issue_comment'].includes(toolName)) {
                        // Return cached result for read-only tools with a note
                        toolResult = {
                            ...cachedResult,
                            _cached: true,
                            _cache_note: `[Cached from earlier in this conversation — same ${toolName} call with identical arguments. Data is still current.]`
                        };
                        console.log(`[TOOL-LOOP] Cache hit for ${toolName}(${JSON.stringify(args).slice(0, 80)})`);
                    } else {
                        // Execute with configurable timeout (default 30s)
                        const toolTimeout = State.settings.toolTimeout || 30000;
                        try {
                            toolResult = await Promise.race([
                                executeToolCall(toolCall),
                                new Promise((_, reject) =>
                                    setTimeout(() => reject(new Error(`Tool execution timeout (${toolTimeout/1000}s)`)), toolTimeout)
                                )
                            ]);
                        } catch (e) {
                            toolResult = { error: e.message };
                        }
                        
                        // Invalidate cached reads when a write tool modifies a file
                        // or when open_file changes the active file (stales read_current_file)
                        if (['replace_lines', 'insert_lines', 'delete_lines', 'create_file', 'open_file',
                             'edit_file', 'write_file', 'delete_file'].includes(toolName)) {
                            const affectedPath = args.path || State.currentFile?.path;
                            if (affectedPath) {
                                for (const [key] of toolCallCache) {
                                    // Evict reads that reference this path OR read_current_file
                                    // (which implicitly reads the active file without a path arg)
                                    if (key.includes(affectedPath) || key.startsWith('read_current_file|')) {
                                        toolCallCache.delete(key);
                                        console.log(`[TOOL-LOOP] Cache invalidated: ${key.slice(0, 60)}…`);
                                    }
                                }
                            }
                        }
                        
                        // Cache successful read-only results (skip write tools)
                        if (!toolResult?.error && !['replace_lines', 'insert_lines', 'delete_lines', 
                             'create_file', 'edit_file', 'write_file', 'delete_file',
                             'update_issue', 'add_issue_comment'].includes(toolName)) {
                            toolCallCache.set(cacheKey, toolResult);
                        }
                    }

                    // Show collapsible tool call detail
                    addToolCallMessage(toolName, args, toolResult);

                    // 1.3.17 / Tools PR 4 — record the invocation against
                    // the conversation's TaskLedger so a non-static tool
                    // the model just used becomes sticky-admissible on the
                    // next turn. Gated to the `coder` role because that is
                    // the only role with a populated `tools.static` set
                    // today; other roles run the legacy `Roles.filterTools`
                    // path which never consults the ledger. Failed tool
                    // calls are skipped inside `recordToolInvocation`.
                    if (State.settings.role === 'coder') {
                        const td = Catalog.getByName(toolName);
                        recordToolInvocation({
                            conversationId: ConversationManager.getActiveId(),
                            toolName,
                            args,
                            toolResult,
                            turnId: toolCall.id || null,
                            surface: CODER_V1.name,
                            staticNames: CODER_V1.tools.static,
                            toolCost: td ? td.metadata.cost_estimate : 0,
                        });

                        // 1.4.1 — when the model just called `find_tool`,
                        // promote its top matches into the ledger as
                        // short-form discovery admissions. The next turn
                        // will render `{name, description}` for each
                        // (no schema) at `short_cost`; first invocation
                        // promotes the entry to full via `recordInvocation`.
                        if (toolName === 'find_tool'
                            && toolResult
                            && !toolResult.error
                            && Array.isArray(toolResult.tools)
                            && toolResult.tools.length > 0) {
                            const candidates = toolResult.tools
                                .filter(s => s && typeof s.name === 'string')
                                .map(s => ({
                                    toolName: s.name,
                                    shortCost: typeof s.short_cost === 'number' ? s.short_cost : 0,
                                }));
                            recordDiscoveryAdmissions({
                                conversationId: ConversationManager.getActiveId(),
                                surface: CODER_V1.name,
                                candidates,
                                cap: _readDiscoveryCap(),
                            });
                        }
                    }

                    // Memory PR #6 — when memory_remember enqueues an
                    // agent-proposed candidate (per consent-queue.js), the
                    // tool returns `pending_consent`. Drop an inline
                    // consent card below the tool-call panel so the user
                    // can Accept/Edit/Dismiss before the record durably
                    // lands. user_explicit + inferred sources don't go
                    // through this path; they write immediately.
                    if (toolName === 'memory_remember'
                        && toolResult
                        && toolResult.status === 'pending_consent'
                        && typeof toolResult.candidate_id === 'string') {
                        addConsentCardMessage(toolResult.candidate_id);
                    }

                    toolActions.push({
                        tool: toolName,
                        args: args,
                        result: toolResult,
                        error: !!toolResult?.error
                    });

                    if (toolCallSource === 'structured') {
                        // Truncate large tool results BEFORE sending to API.
                        // Base budget: 12K chars ≈ 300 lines of code.
                        // Scales with context tier: 2× for 128K, 4× for 512K, 8× for 1M+.
                        let toolContent = JSON.stringify(toolResult);
                        
                        // GUARANTEE: tool content is never empty
                        if (!toolContent || toolContent === 'null' || toolContent === 'undefined' || toolContent === '""') {
                            toolContent = JSON.stringify({ error: `Tool '${toolName}' returned empty result. Try a different approach.` });
                        }
                        
                        const { scale } = getContextScale();
                        const TOOL_RESULT_LIMIT = 12000 * scale;
                        
                        if (toolContent.length > TOOL_RESULT_LIMIT) {
                            try {
                                const truncated = JSON.parse(toolContent);
                                if (truncated.content && truncated.content.length > TOOL_RESULT_LIMIT) {
                                    // Smart truncation: keep head + tail of file content
                                    const lines = truncated.content.split('\n');
                                    const headLines = Math.min(150 * scale, Math.floor(lines.length * 0.6));
                                    const tailLines = Math.min(60 * scale, Math.floor(lines.length * 0.25));
                                    const head = lines.slice(0, headLines).join('\n');
                                    const tail = lines.slice(-tailLines).join('\n');
                                    truncated.content = head + 
                                        `\n\n... [${lines.length - headLines - tailLines} lines omitted — use read_lines for specific sections] ...\n\n` + 
                                        tail;
                                    truncated.truncated = true;
                                }
                                if (truncated.results && Array.isArray(truncated.results) && JSON.stringify(truncated.results).length > TOOL_RESULT_LIMIT) {
                                    const matchCount = truncated.results.reduce((sum, r) => sum + (r.matches?.length || 0), 0);
                                    const keepCount = 8 * scale;
                                    const kept = truncated.results.slice(0, keepCount).map(r => ({
                                        path: r.path, matchCount: r.matches?.length || 0,
                                        firstMatch: r.matches?.[0]?.snippet || r.matches?.[0]?.lineContent || ''
                                    }));
                                    truncated.results = kept;
                                    truncated._note = `${matchCount} total matches, showing first ${keepCount} files`;
                                }
                                if (truncated.files && Array.isArray(truncated.files) && JSON.stringify(truncated.files).length > TOOL_RESULT_LIMIT) {
                                    truncated.files = [`[${truncated.files.length} files]`];
                                }
                                toolContent = JSON.stringify(truncated);
                            } catch (e) {
                                toolContent = toolContent.substring(0, TOOL_RESULT_LIMIT) + '... [truncated]';
                            }
                        }
                        structuredResults.push(enrichToolResultTurn({
                            tool_call_id: toolCall.id,
                            role: 'tool',
                            content: toolContent,
                            _display: {
                                toolName,
                                args,
                                result: toolResult
                            }
                        }, toolName, args, toolResult));
                    } else {
                        textResults.push({ name: toolName, result: toolResult });
                    }
                }

                if (isToolLoopCancelled()) break;

                // === BUILD THREAD FOR NEXT ROUND ===

                // Compress old tool results to prevent token explosion.
                // Only compress results older than the LAST 2 rounds (preserve recent context).
                // Threshold: 4000 chars before compression kicks in.
                const recentToolMsgCount = structuredResults.length;
                const compressUpTo = messages.length - recentToolMsgCount;
                
                for (let i = 0; i < compressUpTo; i++) {
                    const msg = messages[i];
                    if (msg.role === 'tool' && msg.content) {
                        try {
                            const parsed = JSON.parse(msg.content);
                            let compressed = false;

                            // Compress file contents — keep path + line count + function signatures
                            if (parsed.content && parsed.content.length > 4000) {
                                const lines = parsed.content.split('\n');
                                // Extract function/class names from the content for a useful summary
                                const signatures = lines
                                    .filter(l => /^\s*\d+:\s*(export\s+)?(async\s+)?function\s+\w+|^\s*\d+:\s*(export\s+)?const\s+\w+\s*=|^\s*\d+:\s*(export\s+)?class\s+\w+|^\s*\d+:\s*def\s+\w+|^\s*\d+:\s*func\s+\w+/.test(l))
                                    .map(l => l.replace(/^\s*\d+:\s*/, '').trim())
                                    .slice(0, 20)
                                    .join('\n  ');
                                const summary = signatures 
                                    ? `Key symbols:\n  ${signatures}`
                                    : `${Math.min(lines.length, 8)} sample lines:\n${lines.slice(0, 8).join('\n')}`;
                                parsed.content = `[File: ${parsed.path || 'unknown'} — ${parsed.line_count || lines.length} lines. ${summary}. Use read_lines if you need specific sections.]`;
                                compressed = true;
                            }
                            // Compress search results — keep file paths and match counts
                            if (parsed.results && Array.isArray(parsed.results) && parsed.results.length > 0) {
                                const matchCount = parsed.results.reduce((sum, r) => sum + (r.matches?.length || 0), 0);
                                const filePaths = parsed.results.map(r => r.path || r.file).filter(Boolean).slice(0, 8);
                                parsed.results = `[${matchCount} matches in ${parsed.results.length} files: ${filePaths.join(', ')}${parsed.results.length > 8 ? '...' : ''}. Use read_lines to examine specific matches.]`;
                                compressed = true;
                            }
                            // Compress project tree — keep directory structure
                            if (parsed.files && Array.isArray(parsed.files) && parsed.files.length > 20) {
                                const dirs = [...new Set(parsed.files.map(f => {
                                    const p = (f.path || f);
                                    return p.includes('/') ? p.split('/').slice(0, 2).join('/') : p;
                                }))].slice(0, 15);
                                parsed.files = `[${parsed.files.length} files in dirs: ${dirs.join(', ')}. Tree already known — use search_in_files or read_lines for specifics.]`;
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

                // Always provide content field: non-empty string for text, null for tool-only.
                // Prevents "zero-length document" errors from providers that reject absent content.
                const assistantMsg = {
                    role: 'assistant',
                    timestamp: Date.now()
                };
                if (lastRoundReasoning && lastRoundReasoning.content && lastRoundReasoning.content.length > 0) {
                    assistantMsg.reasoning = lastRoundReasoning;
                }

                if (toolCallSource === 'structured') {
                    // Always include content field — null when no text content.
                    // OpenAI spec allows null, and some providers (Venice) reject
                    // messages where content is entirely absent.
                    assistantMsg.content = cleanContent.trim() ? cleanContent : null;
                    assistantMsg.tool_calls = toolCalls;
                } else {
                    // No tool calls - always include content to prevent empty message
                    assistantMsg.content = cleanContent || '';
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
                        if (resultStr.length > 8000) {
                            resultStr = resultStr.slice(0, 8000) + '\n... (truncated)';
                        }
                        return `[Tool: ${tr.name}]\n${resultStr}`;
                    }).join('\n\n');
                    messages.push({
                        role: 'user',
                        content: `Tool results:\n${summary}\n\nUse these results to continue. Only call additional tools if you are MISSING information needed to complete the task — do not re-read data you already have.`
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

    // Use last round's content for the final DOM element.
    // lastRoundReasoning carries the reasoning captured by _handleStream
    // for the round whose content we're rendering; older rounds' reasoning
    // is already attached to the assistant turns pushed during the loop.
    finalizeStreamingMessage(
        lastRoundContent.trim() ? lastRoundContent : finalContent,
        { hasCode: false, reasoning: lastRoundReasoning }
    );
}

// ============================================
// HISTORY SAFETY HELPERS
// ============================================

/**
 * Roll back chatHistory to a previous length and re-persist.
 * 
 * Called when handleGeneralRequest fails catastrophically mid-tool-loop.
 * Removes any assistant/tool messages that were pushed during the loop
 * so the history doesn't contain orphaned tool-call sequences that would
 * confuse the LLM context on the next request.
 * 
 * @param {number} snapshotLength - State.chatHistory.length at request start
 */
function _rollbackHistory(snapshotLength) {
    const removed = State.chatHistory.length - snapshotLength;
    if (removed > 0) {
        State.chatHistory.length = snapshotLength;
        Storage.set('chatHistory', State.chatHistory.slice(-100));
        console.warn(`[_rollbackHistory] Rolled back ${removed} message(s) from failed request`);
    }
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
