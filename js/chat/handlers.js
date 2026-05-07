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
    clearPendingImages,
    addPendingImage,
    getUserMessageQueueLength,
    drainUserMessageQueue,
    enqueueUserMessage
} from './state.js';
import { renderImagePreview } from './input.js';
import { executeToolCall } from './tools.js';
import { parseTextToolCalls } from './tools.js';
import { ChatSummarizer } from './summarizer.js';
import { enrichToolResultTurn } from './turn-enrich.js';
import { getCompressedContextMessages } from './compactor-integration.js';
import { validateAndCleanHistory } from './history-validator.js';
import { withRetry } from '../retry.js';
import { ConversationManager } from './conversations.js';
import { recordInvocation as recordToolInvocation, recordDiscoveryAdmissions } from './task-state.js';
import { invalidateCachesForPath } from './cache-invalidation.js';
import { getRefusalHint } from './refusal-hints.js';
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
 * Summarize a tool result into a short description for the persistent action log.
 * Used so the AI remembers what it did even after tool results are evicted (Issue #17).
 */
function _summarizeToolResult(toolName, result) {
    if (!result) return 'no result';
    if (result.error) return `Error: ${result.error}`;
    if (result.message) return result.message;
    if (result.status) return `Status: ${result.status}`;
    if (result.content) {
        const c = result.content;
        return typeof c === 'string'
            ? (c.length > 200 ? c.slice(0, 200) + '…' : c)
            : JSON.stringify(c).slice(0, 200);
    }
    if (result.files) return `${result.files.length} file(s)`;
    if (result.matches) return `${result.matches.length} match(es)`;
    const str = JSON.stringify(result);
    return str.length > 200 ? str.slice(0, 200) + '…' : str;
}

/**
 * Summarize tool args into a compact form for the persistent action log.
 */
function _summarizeArgs(args) {
    if (!args) return {};
    const summary = {};
    for (const [key, value] of Object.entries(args)) {
        if (key === 'content' || key === 'body' || key === 'text') {
            // Truncate large content fields
            const s = String(value);
            summary[key] = s.length > 100 ? s.slice(0, 100) + '…' : s;
        } else {
            summary[key] = value;
        }
    }
    return summary;
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

    // Iterative tool call loop. No fixed round cap — instead we break on
    // a no-forward-progress streak so genuine multi-step investigations
    // can run as long as the model is still making progress (executing
    // fresh tools or producing visible text). HARD_CAP is a last-resort
    // safety net for pathological infinite loops.
    const NO_PROGRESS_LIMIT = 3;    // Consecutive stall rounds before break
    const HARD_CAP = 100;           // Absolute safety net
    let noProgressStreak = 0;
    let finalContent = '';          // Accumulated across rounds (used for error fallback)
    let lastRoundContent = '';      // Only the current round's text (used for DOM + history)
    let lastRoundReasoning = null;  // Reasoning captured by _handleStream for the last round
    let textCommittedMidLoop = false; // Track if text was already rendered in DOM mid-loop
    const toolActions = []; // Track all tool executions for fallback summary
    
    // === DUPLICATE TOOL CALL DETECTION ===
    // Track tool+args combinations to prevent re-fetching the same data
    const toolCallCache = new Map(); // key: "toolName|canonicalArgs" → result
    const duplicateStreak = new Map(); // key: cacheKey → consecutive-duplicate count
    const DUP_REFUSE_THRESHOLD = 3; // Refuse on 3rd consecutive identical dup call
    let _hasRetried = false;  // One transient-error retry per request

    // Keep isGenerating true for the entire tool loop
    State.isGenerating = true;
    EventBus.emit('llm:generating', true);

    try {
        for (let round = 0; round < HARD_CAP; round++) {
            // Check cancellation before each round
            if (isToolLoopCancelled()) {
                console.log('[TOOL-LOOP] Cancelled by user');
                break;
            }

            // Reset per-round progress flag. Set to true downstream when the
            // round (a) produces visible text, (b) executes a fresh tool, or
            // (c) recovers from a length-truncation. Anything else counts as
            // a stall round and increments noProgressStreak.
            let madeProgressThisRound = false;

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

                // Defense-in-depth (1.6.2 PR 2): drop any orphan `tool` messages
                // before the request leaves the boundary. Same reference returned
                // when nothing is dropped (clean histories pay no copy cost).
                const _validated = validateAndCleanHistory(messages);
                result = await LLM.chat(_validated.messages, chatOptions);

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

                // Length-recovery is legitimate forward motion — reset streak.
                if (round < HARD_CAP - 1) {
                    noProgressStreak = 0;
                    continue;
                }
            }

            // === LAYER 1: Structured tool_calls from API (primary path) ===
            let toolCalls = result.toolCalls ? [...result.toolCalls] : [];
            // Streaming layer (1.3.1) splits <think>/<thinking> off into result.reasoning,
            let cleanContent = result.content || '';
            let toolCallSource = toolCalls.length > 0 ? 'structured' : 'none';

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
                madeProgressThisRound = true;
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
                    
                    // === CROSS-REQUEST DUPLICATE DETECTION (Issue #17) ===
                    // Check if this exact tool+args was already executed in a previous request
                    // (before summarization evicted the results from context)
                    const WRITE_TOOLS = ['replace_lines', 'insert_lines', 'delete_lines', 'create_file',
                                          'edit_file', 'write_file', 'delete_file',
                                          'update_issue', 'add_issue_comment'];

                    // Tools whose duplicate-call cache hit means "your prior mutation
                    // already succeeded" — not "wait, did it actually go through?".
                    // The qwen-3-6-plus PR #289 trace showed the model panicking on a
                    // generic don't-retry note for commit_files and entering a 3-turn
                    // confirmation loop. These tools stay OUT of WRITE_TOOLS on purpose
                    // (so the cache prevents accidental double-commits / double-comments),
                    // but get reassuring "prior call succeeded" messaging instead of the
                    // generic don't-retry warning. Keep this in sync as new mutating
                    // tools land. github#35
                    const MUTATING_TOOLS = new Set([
                        'commit_files',
                        'create_issue',
                        'create_pull_request',
                        'merge_pull_request',
                        'add_pr_review',
                        'memory_remember',
                        'memory_revise',
                        'scratchpad_write',
                        'scratchpad_clear',
                        'write_plugin_source',
                    ]);

                    // Tools whose result depends on implicit State (not on args alone).
                    // The dup-detection key is `(toolName, sortedArgs)`, so a stateful
                    // read like read_current_file collides across calls when the active
                    // file changes between them — the second call gets a stale-cache
                    // hit pointing at the previous file's content. Bypass both the
                    // cross-request and same-request caches for these. Found while
                    // testing PR #293 against issue #23 (qwen-3-6-plus, 2026-05-06).
                    const STATEFUL_READ_TOOLS = new Set([
                        'read_current_file',
                        // ask_user — the cross-request log would otherwise
                        // synth a "you already asked this; here was the
                        // answer" hit on identical args. The model may
                        // legitimately want to re-ask after the conversation
                        // moves on.
                        'ask_user',
                    ]);
                    const skipCache = STATEFUL_READ_TOOLS.has(toolName);

                    let crossRequestDuplicate = false;
                    if (!skipCache && !WRITE_TOOLS.includes(toolName) && State.toolActionLog && State.toolActionLog.length > 0) {
                        const recentLog = State.toolActionLog.slice(-30);
                        const argsStr = JSON.stringify(args, Object.keys(args).sort());
                        for (const entry of recentLog) {
                            if (entry.tool === toolName && entry.success) {
                                const loggedArgsStr = JSON.stringify(entry.args, Object.keys(entry.args || {}).sort());
                                if (argsStr === loggedArgsStr) {
                                    crossRequestDuplicate = true;
                                    console.log(`[TOOL-LOOP] Cross-request duplicate detected: ${toolName}`);
                                    break;
                                }
                            }
                        }
                    }
                    
                    // === DUPLICATE STREAK ENFORCEMENT ===
                    // Track consecutive identical (tool, args) calls. After
                    // DUP_REFUSE_THRESHOLD strikes we refuse to execute and
                    // hand the model a hard error so it stops spiraling.
                    // Non-dup attempts reset the streak for that key. Writes
                    // never hit either dup signal, so they bypass refusal.
                    const isDup = !!cachedResult || crossRequestDuplicate;
                    const streak = isDup ? (duplicateStreak.get(cacheKey) || 0) + 1 : 0;
                    duplicateStreak.set(cacheKey, streak);

                    let toolResult;
                    if (isDup && streak >= DUP_REFUSE_THRESHOLD) {
                        console.warn(`[TOOL-LOOP] Refusing duplicate ${toolName} (streak=${streak})`);
                        const hint = getRefusalHint(toolName);
                        toolResult = {
                            error: `REFUSED: ${toolName} called ${streak} consecutive times with identical args. ${hint}`,
                            _refused: true
                        };
                    } else if (crossRequestDuplicate) {
                        // Return a synthetic result telling the AI it already did this
                        const lastEntry = State.toolActionLog.slice(-30).reverse().find(e => e.tool === toolName && e.success);
                        const summary = lastEntry?.resultSummary || 'unknown';
                        toolResult = {
                            _cached: true,
                            _cache_note: MUTATING_TOOLS.has(toolName)
                                ? `[Your prior ${toolName} call already SUCCEEDED earlier in this conversation. Outcome: ${summary}. The mutation has happened — treat the prior result as authoritative and continue. Do not retry to confirm; that would re-attempt the mutation or loop on this same cache.]`
                                : `[You already called ${toolName} with these arguments earlier in this conversation. The result was: ${summary}. Do NOT call this tool again with the same args.]`,
                            error: null
                        };
                    } else if (cachedResult && !skipCache && !WRITE_TOOLS.includes(toolName)) {
                        // Return cached result for read-only tools (and same-session
                        // mutating tools — cache prevents double-commits) with a note
                        toolResult = {
                            ...cachedResult,
                            _cached: true,
                            _cache_note: MUTATING_TOOLS.has(toolName)
                                ? `[Your prior ${toolName} call already SUCCEEDED — the result above is from that call. The mutation has happened; do not retry to confirm.]`
                                : `[Cached from earlier in this conversation — same ${toolName} call with identical arguments. Data is still current.]`
                        };
                        console.log(`[TOOL-LOOP] Cache hit for ${toolName}(${JSON.stringify(args).slice(0, 80)})`);
                    } else {
                        // A real execution path — counts as forward progress
                        // even if the tool errors. The model gets new info to
                        // react to either way.
                        madeProgressThisRound = true;
                        // Execute with configurable timeout — long-running tools (wait_for_ci, etc.)
                        // get a separate timeout to avoid being killed by the standard tool timeout.
                        const LONG_RUNNING_TOOLS = new Set(['wait_for_ci']);
                        // ask_user (github#33) blocks on the user's response via an inline
                        // Preact card; the chat loop's `isToolLoopCancelled` cancel path
                        // calls `cancelUserResponse()` to release the awaited Promise.
                        // Bypassing the timer entirely is correct here — the user can
                        // sit with a question for as long as they want.
                        const USER_PAUSE_TOOLS = new Set(['ask_user']);
                        const isUserPause = USER_PAUSE_TOOLS.has(toolName);
                        const isLongRunning = LONG_RUNNING_TOOLS.has(toolName);
                        const toolTimeout = isLongRunning
                            ? (State.settings.longRunningToolTimeout || 300000)
                            : (State.settings.toolTimeout || 30000);
                        try {
                            if (isUserPause) {
                                toolResult = await executeToolCall(toolCall);
                            } else {
                                toolResult = await Promise.race([
                                    executeToolCall(toolCall),
                                    new Promise((_, reject) =>
                                        setTimeout(() => reject(new Error(`Tool execution timeout (${toolTimeout/1000}s)`)), toolTimeout)
                                    )
                                ]);
                            }
                        } catch (e) {
                            toolResult = { error: e.message };
                        }
                        
                        // Invalidate cached reads when a write tool modifies a file
                        // or when open_file changes the active file (stales read_current_file).
                        // Walks both the same-request `toolCallCache` AND the cross-request
                        // `State.toolActionLog`. Pre-1.7.1 only the former was invalidated,
                        // which caused a deadlock with the 1.6.11 staleness guard: a stale
                        // read_lines envelope from the log would refuse the re-read the guard
                        // demanded after a successful edit_file (gitea#301).
                        const _inv = invalidateCachesForPath({
                            toolName,
                            args,
                            currentFilePath: State.currentFile?.path || null,
                            toolCallCache,
                            toolActionLog: State.toolActionLog,
                            WRITE_TOOLS,
                        });
                        if (_inv.evictedCache > 0 || _inv.evictedLog > 0) {
                            console.log(`[TOOL-LOOP] Cache invalidated for ${toolName}(${args.path || args.file_path || State.currentFile?.path || '?'}) — ${_inv.evictedCache} same-req, ${_inv.evictedLog} cross-req`);
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

                    // === PERSISTENT TOOL ACTION LOG (Issue #17) ===
                    // Log to State.toolActionLog so AI remembers actions even after
                    // tool results are evicted from context by summarization.
                    const resultSummary = _summarizeToolResult(toolName, toolResult);
                    State.toolActionLog.push({
                        tool: toolName,
                        args: _summarizeArgs(args),
                        resultSummary,
                        timestamp: Date.now(),
                        success: !toolResult?.error
                    });
                    // Keep log bounded — retain last 50 entries
                    if (State.toolActionLog.length > 50) {
                        State.toolActionLog = State.toolActionLog.slice(-50);
                    }

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
                Storage.set('chatHistory', State.chatHistory);

                // Save tool results to State.chatHistory for context continuity
                if (toolCallSource === 'structured') {
                    for (const tr of structuredResults) {
                        State.chatHistory.push({
                            ...tr,
                            timestamp: Date.now()
                        });
                    }
                    Storage.set('chatHistory', State.chatHistory);
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

                // === QUEUED USER INPUT DRAIN (github#33 Phase 2) ===
                // If the user typed messages while the loop was running,
                // they're delivered here — between rounds, never mid-round.
                // Each queued payload becomes a user turn appended to both
                // chat history (for replay/persistence) and the messages[]
                // array that feeds the next LLM call. Ordered FIFO.
                if (getUserMessageQueueLength() > 0) {
                    const drained = drainUserMessageQueue();
                    for (const msg of drained) {
                        const content = buildUserContent(msg.text, msg.images);
                        addMessage('user', content);
                        messages.push({ role: 'user', content });
                    }
                    // User input counts as forward progress — don't let a
                    // mid-stall queue drain trip the no-progress break.
                    madeProgressThisRound = true;
                }

                // === FORWARD-PROGRESS CHECK ===
                // If the round produced no fresh tool execution and no
                // visible text, it's a stall round. After NO_PROGRESS_LIMIT
                // consecutive stalls, break out of the loop. Placing this
                // BEFORE the partialEl/addStreamingMessage block keeps the
                // existing streaming placeholder around so finalizeStreamingMessage
                // can render the stop notice in-place.
                if (madeProgressThisRound) {
                    noProgressStreak = 0;
                } else {
                    noProgressStreak++;
                    if (noProgressStreak >= NO_PROGRESS_LIMIT) {
                        console.warn(`[TOOL-LOOP] No forward progress for ${noProgressStreak} rounds — breaking`);
                        if (!finalContent.trim()) {
                            finalContent = `*(Stopped after ${noProgressStreak} consecutive rounds with no new tool calls or visible text. The model may need a clearer prompt or different approach.)*`;
                        }
                        break;
                    }
                }

                // Prepare UI for next round — commit THIS round's text only
                const partialEl = document.getElementById('streaming-message');
                if (partialEl) {
                    if (cleanContent.trim()) {
                        partialEl.querySelector('.message-content').innerHTML = formatMessageContent(stripThinkBlocks(cleanContent));
                        partialEl.classList.remove('streaming');
                        // Text already committed to DOM — clear so finalizeStreamingMessage
                        // doesn't re-emit it at the end of the tool loop
                        lastRoundContent = '';
                        textCommittedMidLoop = true;
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
            // Re-queue the rest (FIFO preserved) so they drain inside
            // the new run rather than all dispatching as separate runs.
            for (const m of rest) enqueueUserMessage(m);
            // Restore images onto the live picker so handleUserInputDirect
            // picks them up via getPendingImages().
            for (const img of first.images) addPendingImage(img);
            queueMicrotask(() => {
                try { handleUserInputDirect(first.text); } catch (e) {
                    console.error('[queue] kick-new-run failed:', e);
                }
            });
        }
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

    // If text was already committed mid-loop AND the final round produced no
    // new text, just clean up the placeholder and skip re-rendering.
    // But if the final round HAS new text (e.g. a summary after tool calls),
    // we still need to render it.
    if (textCommittedMidLoop && !lastRoundContent.trim()) {
        const placeholder = document.getElementById('streaming-message');
        if (placeholder) placeholder.remove();
        return;
    }

    // Use last round's content for the final DOM element.
    // lastRoundReasoning carries the reasoning captured by _handleStream
    // for the round whose content we're rendering; older rounds' reasoning
    // is already attached to the assistant turns pushed during the loop.
    const finalText = lastRoundContent.trim() ? lastRoundContent : finalContent;
    finalizeStreamingMessage(
        finalText,
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
        Storage.set('chatHistory', State.chatHistory);
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
