/**
 * Request Handlers
 * Intent detection and specialized request handlers (edit, explain, commit, issue, general)
 */

import { State, EventBus, Storage } from '../core.js';
import { LLM, LLMTools, generateEdit, generateCommitMessage, buildSystemPrompt, stripThinkBlocks } from '../llm.js';
import { applyEdit, computeSimpleDiff } from '../editor.js';
import { 
    addMessage, 
    addStreamingMessage, 
    updateStreamingMessage, 
    finalizeStreamingMessage,
    addToolCallMessage,
    formatMessageContent,
    escapeHtml
} from './messages.js';
import { 
    getPendingEdit, 
    setPendingEdit, 
    clearPendingEdit,
    isToolLoopCancelled,
    resetToolLoopCancel 
} from './state.js';
import { executeToolCall } from './tools.js';
import { parseTextToolCalls } from './tools.js';
import { ChatSummarizer } from './summarizer.js';

/**
 * Main entry point for user input
 */
export async function handleUserInputDirect(input) {
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

/**
 * Detect user intent from input text
 */
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
 */
export async function handleGeneralRequest(input) {
    console.log(`[handleGeneralRequest] Starting with input="${input}"`);
    
    addStreamingMessage();
    resetToolLoopCancel();  // Reset cancel flag

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
            if (isToolLoopCancelled()) {
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
                
                if (isToolLoopCancelled()) break;
                
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
                    if (isToolLoopCancelled()) break;

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

                if (isToolLoopCancelled()) break;

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
