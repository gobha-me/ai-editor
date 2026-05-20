/**
 * Tool-Loop Core
 *
 * The pure-ish iterative tool loop extracted from `handleGeneralRequest`
 * at 2.48.0 (github#24 Phase 0). Takes an injected `context` (no `State.*`
 * reach-back), a `hooks` bag of opt-in callbacks for DOM / chat-history
 * side effects, and a `transport` with `chat` + `stop` methods.
 *
 * The parent-chat wrapper in `handlers.js` supplies real hooks bound to
 * the streaming UI, the `ChatHistoryStore`, the `TaskLedger`, and the
 * user-input queue. Phase 1 (2.49.0) sub-agents will supply a different
 * hooks bag whose `onStreamToken` is a no-op, whose `onAssistantTurn`
 * writes to the sub-agent's own messages array, and whose
 * `onUserInputDrain` always returns `{drained:[], anyDrained:false}`.
 *
 * Per `DESIGN-sub-agents.md` §"Gap 2", the loop body's coupling to the
 * user chat surface (streaming DOM, queue drain, compactor read, ledger
 * gate on `coder.v1`) is the load-bearing thing being decoupled. The
 * core is allowed to import other near-pure modules (`executeToolCall`,
 * `parseTextToolCalls`, `enrichToolResultTurn`, `getContextScale`,
 * `canonicalArgsKey`, `buildRefusalPayload`, `Catalog.listAll`, the
 * cache-invalidation helpers, `validateAndCleanHistory`) directly — none
 * touch DOM or `State.*` in a way that breaks the sub-agent caller.
 */

import { executeToolCall, parseTextToolCalls } from './tools.js';
import { enrichToolResultTurn } from './turn-enrich.js';
import { validateAndCleanHistory } from './history-validator.js';
import {
    invalidateCachesForPath,
    invalidateCachesForPreviewMutation,
    findMatchingCrossRequestEntry,
    buildToolActionLogEntry,
    buildCrossRequestCacheResult,
} from './cache-invalidation.js';
import {
    WRITE_TOOLS,
    MUTATING_TOOLS,
    STATEFUL_READ_TOOLS,
    LONG_RUNNING_TOOLS,
    USER_PAUSE_TOOLS,
    canonicalArgsKey,
} from './tool-classifications.js';
import { isStatefulRead, getStatefulReadToolsLive } from './cache-policy.js';
import { buildRefusalPayload } from './refusal-hints.js';
import { Catalog } from '../intelligence/tools/index.js';
import { getContextScale } from '../llm.js';

const NO_PROGRESS_LIMIT = 3;
const HARD_CAP = 100;
const DUP_REFUSE_THRESHOLD = 3;

const _NOOP = () => {};
// Default round-commit preserves the round's text in `lastRoundContent`
// and never claims a mid-loop DOM commit. The wrapper supplies a DOM-aware
// hook that returns `{lastRoundContent: '', textCommittedMidLoop: true}`
// when it has actually written the round's text into the streaming
// placeholder; sub-agents and tests use this default unchanged.
const _DEFAULT_ROUND_COMMIT = ({ content }) => ({
    lastRoundContent: content,
    textCommittedMidLoop: false,
});
const _DEFAULT_DRAIN = () => ({ drained: [], anyDrained: false });

/**
 * Summarize a tool result into a short description for the persistent action log.
 * Used so the AI remembers what it did even after tool results are evicted (Issue #17).
 */
export function summarizeToolResult(toolName, result) {
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
export function summarizeArgs(args) {
    if (!args) return {};
    const summary = {};
    for (const [key, value] of Object.entries(args)) {
        if (key === 'content' || key === 'body' || key === 'text') {
            const s = String(value);
            summary[key] = s.length > 100 ? s.slice(0, 100) + '…' : s;
        } else {
            summary[key] = value;
        }
    }
    return summary;
}

/**
 * Roll back the conversation's message store to a previous length.
 *
 * Pre-2.48.0 this lived in `handlers.js` as `_rollbackHistory(n)` and
 * called `ChatHistoryStore.setLength` directly. The core now routes
 * through `context.setHistoryLength` so a sub-agent caller can supply
 * its own truncation (`subagentCtx.messages.length = n`) without
 * touching `State.chatHistory`.
 */
function rollbackHistory(context) {
    const snapshotLength = context.historySnapshot;
    // The core can't easily count "removed" — the wrapper-side hook
    // implementations log if useful. Just call the truncation.
    context.setHistoryLength(snapshotLength);
}

/**
 * Build a default hooks bag merged with user-supplied overrides. Every
 * site that calls a hook can rely on the callback being a function.
 */
function _normalizeHooks(hooks) {
    const provided = hooks || {};
    return {
        onStreamStart: provided.onStreamStart || _NOOP,
        onStreamToken: provided.onStreamToken || _NOOP,
        onRoundCommit: provided.onRoundCommit || _DEFAULT_ROUND_COMMIT,
        onStreamFinalize: provided.onStreamFinalize || _NOOP,
        onToolCall: provided.onToolCall || _NOOP,
        onConsentCard: provided.onConsentCard || _NOOP,
        onSystemMessage: provided.onSystemMessage || _NOOP,
        onAssistantTurn: provided.onAssistantTurn || _NOOP,
        onToolResultTurn: provided.onToolResultTurn || _NOOP,
        onUserInputDrain: provided.onUserInputDrain || _DEFAULT_DRAIN,
        onLedgerRecord: provided.onLedgerRecord || _NOOP,
        onDiscoveryAdmissions: provided.onDiscoveryAdmissions || _NOOP,
        onPlanModeApproved: provided.onPlanModeApproved || _NOOP,
        // Fires after each successful `transport.chat` resolves. Pre-2.48.0
        // the wrapper re-asserted `State.isGenerating = true` here because
        // `LLM.chat`'s internal finally clears the flag per-call. Sub-agents
        // pass a no-op.
        onChatComplete: provided.onChatComplete || _NOOP,
        // Fires once at the end of the loop (after the for-loop exits and
        // before the `return`), regardless of how it exited. Receives the
        // structured stop context so the wrapper can tag debug exchanges,
        // emit telemetry, etc. Sub-agents pass a no-op. (gitea#425)
        onLoopComplete: provided.onLoopComplete || _NOOP,
    };
}

/**
 * Run the iterative tool-call loop.
 *
 * @param {object} context     — injected per-loop state; see header.
 * @param {object} [hooks]     — opt-in callbacks for side effects.
 * @param {object} transport   — `{ chat, stop }` LLM adapter.
 * @returns {Promise<{
 *     finalContent: string,
 *     lastRoundContent: string,
 *     lastRoundReasoning: object | null,
 *     textCommittedMidLoop: boolean,
 *     toolActions: Array,
 *     breakReason: string,
 *     fallbackContent: string | null
 * }>}
 *
 * Re-throws (rather than returning a rethrown-error envelope) when a
 * catastrophic failure leaves no recovered content AND no tool progress
 * — the wrapper's outer `withRetry` boundary still needs to see the
 * error to schedule its retry policy.
 */
export async function runToolLoop(context, hooks, transport) {
    const h = _normalizeHooks(hooks);
    const messages = context.messages;
    const roleTools = context.roleTools;

    let noProgressStreak = 0;
    let finalContent = '';
    let lastRoundContent = '';
    // TODO(reasoning-capture): pre-2.48.0 this was wired through to receive
    // streaming reasoning from `LLM._handleStream`, but the streaming layer
    // never assigned it. Preserved as `null` so the assistantMsg.reasoning
    // path stays compilable; remove the local when reasoning capture lands.
    let lastRoundReasoning = null;
    let textCommittedMidLoop = false;
    const toolActions = [];
    let breakReason = 'natural_stop';
    // gitea#425 — capture last provider finish/error so the loop's stop
    // context can carry them out for telemetry + debug-pane tagging.
    let lastFinishReason = null;
    let lastError = null;
    let roundsExecuted = 0;

    const toolCallCache = new Map();
    const duplicateStreak = new Map();
    let _hasRetried = false;  // request-scoped one-shot; do not hoist.

    // The caller mounts the initial stream placeholder (parent wrapper:
    // `addStreamingMessage()` before invoking; sub-agents: no-op). Inside
    // the loop, `h.onStreamStart()` fires after each round-end commit to
    // prepare the next round's placeholder.

    for (let round = 0; round < HARD_CAP; round++) {
        if (context.cancelSignal()) {
            console.log('[TOOL-LOOP] Cancelled by user');
            breakReason = 'cancelled';
            break;
        }

        let madeProgressThisRound = false;
        let content = '';
        let result;

        try {
            const chatOptions = {
                stream: true,
                tools: roleTools,
                onToken: (_token, fullContent) => {
                    content = fullContent;
                    h.onStreamToken(fullContent);
                }
            };

            if (round > 0) {
                h.onStreamToken('*(processing tool results…)*');
            }

            const _validated = validateAndCleanHistory(messages);
            result = await transport.chat(_validated.messages, chatOptions);

            content = content || result.content || '';
            roundsExecuted = round + 1;
            lastFinishReason = result?.finishReason || null;
            h.onChatComplete();
        } catch (err) {
            transport.stop();
            lastRoundContent = '';
            lastError = err.message || String(err);
            roundsExecuted = round + 1;

            if (context.cancelSignal()) {
                breakReason = 'cancelled';
                break;
            }

            const isTransient = round === 0 && toolActions.length === 0 && !content &&
                (err.message.includes('zero-length') || err.message.includes('empty document') ||
                 err.message.includes('ConnectionError') || err.message.includes('502') ||
                 err.message.includes('503') || err.message.includes('504') ||
                 err.message.includes('timeout'));

            if (isTransient && !_hasRetried) {
                _hasRetried = true;
                console.warn(`[TOOL-LOOP] Transient error on round 0, retrying after 1.5s: ${err.message}`);
                h.onStreamToken('*(API error — retrying…)*');
                await new Promise(r => setTimeout(r, 1500));
                round--;
                continue;
            }

            if (toolActions.length > 0) {
                rollbackHistory(context);
                const summaryLines = toolActions.map(a => {
                    const status = a.error ? '❌' : '✅';
                    const detail = a.result?.message || a.result?.error || '';
                    return `${status} **${a.tool}**${a.args?.path ? ` \`${a.args.path}\`` : ''}${detail ? ` — ${detail}` : ''}`;
                });
                lastRoundContent = `⚠️ Follow-up failed (${err.message}). Tool results:\n\n${summaryLines.join('\n')}`;
                finalContent = lastRoundContent;
                breakReason = 'transient_failure';
            } else if (content) {
                finalContent = content;
                breakReason = 'transient_failure';
            } else {
                rollbackHistory(context);
                throw err;
            }
            break;
        }

        if (result.finishReason === 'length') {
            console.warn('[TOOL-LOOP] Response truncated due to token limit');
            const guidanceText = '⚠️ Your previous response was truncated due to token limit. Please continue with:\n' +
                '1. If you were calling tools, make the calls with complete parameters now\n' +
                '2. If generating code, break it into smaller sections\n' +
                '3. Focus on completing the current task in smaller steps';
            const guidanceMsg = { role: 'system', content: guidanceText };
            messages.push(guidanceMsg);
            h.onSystemMessage(guidanceText);

            if (round < HARD_CAP - 1) {
                noProgressStreak = 0;
                continue;
            }
        }

        let toolCalls = result.toolCalls ? [...result.toolCalls] : [];
        let cleanContent = result.content || '';
        let toolCallSource = toolCalls.length > 0 ? 'structured' : 'none';

        if (toolCalls.length === 0 && cleanContent) {
            const parsed = parseTextToolCalls(cleanContent);
            if (parsed.toolCalls.length > 0) {
                toolCalls = parsed.toolCalls;
                cleanContent = parsed.cleanContent;
                toolCallSource = 'text';
                console.log(`[TOOL-LOOP] Text-parsed ${toolCalls.length} tool calls:`,
                    toolCalls.map(tc => tc.function?.name));
                h.onStreamToken(cleanContent || finalContent || '');
            }
        }

        lastRoundContent = cleanContent;
        if (cleanContent.trim()) {
            finalContent = finalContent ? finalContent + '\n\n' + cleanContent : cleanContent;
            madeProgressThisRound = true;
        }

        if (toolCalls.length > 0) {
            const structuredResults = [];
            const textResults = [];

            for (const toolCall of toolCalls) {
                if (context.cancelSignal()) break;
                if (!toolCall?.function) continue;

                const toolName = toolCall.function?.name || 'unknown';
                let args = {};
                try {
                    args = JSON.parse(toolCall.function?.arguments || '{}');
                } catch (e) { /* malformed args */ }

                const cacheKey = toolName + '|' + canonicalArgsKey(args);
                const cachedResult = toolCallCache.get(cacheKey);

                // 2.71.0 (gitea#472) — `isStatefulRead` unions the legacy
                // `STATEFUL_READ_TOOLS` const with the registry-driven
                // `cache: 'never'` set. New tools that bypass dup-cache
                // declare it at their `ToolRegistry.register()` call site.
                const skipCache = isStatefulRead(toolName);

                let crossRequestDuplicate = false;
                if (!skipCache && !WRITE_TOOLS.includes(toolName) && context.toolActionLog && context.toolActionLog.length > 0) {
                    const recentLog = context.toolActionLog.slice(-30);
                    const argsStr = canonicalArgsKey(args);
                    for (const entry of recentLog) {
                        if (entry.tool === toolName && entry.success) {
                            const loggedArgsStr = canonicalArgsKey(entry.args || {});
                            if (argsStr === loggedArgsStr) {
                                crossRequestDuplicate = true;
                                console.log(`[TOOL-LOOP] Cross-request duplicate detected: ${toolName}`);
                                break;
                            }
                        }
                    }
                }

                const isDup = !!cachedResult || crossRequestDuplicate;
                const streak = isDup ? (duplicateStreak.get(cacheKey) || 0) + 1 : 0;
                duplicateStreak.set(cacheKey, streak);

                let toolResult;
                if (isDup && streak >= DUP_REFUSE_THRESHOLD) {
                    console.warn(`[TOOL-LOOP] Refusing duplicate ${toolName} (streak=${streak})`);
                    const _catalogList = (() => {
                        try {
                            return Catalog.listAll().map(td => ({
                                name: td.name,
                                category: td.category,
                            }));
                        } catch (_) {
                            return [];
                        }
                    })();
                    const _lastUserMsg = (() => {
                        for (let i = messages.length - 1; i >= 0; i--) {
                            const m = messages[i];
                            if (!m || m.role !== 'user') continue;
                            if (typeof m.content === 'string') return m.content;
                            if (Array.isArray(m.content)) {
                                const part = m.content.find(p => p && p.type === 'text' && typeof p.text === 'string');
                                if (part) return part.text;
                            }
                            return '';
                        }
                        return '';
                    })();
                    toolResult = buildRefusalPayload(toolName, streak, {
                        catalog: _catalogList,
                        lastUserMessage: _lastUserMsg,
                    });
                } else if (crossRequestDuplicate) {
                    const lastEntry = findMatchingCrossRequestEntry({
                        toolActionLog: context.toolActionLog,
                        toolName,
                        args,
                    });
                    toolResult = buildCrossRequestCacheResult({ toolName, lastEntry, MUTATING_TOOLS });
                    if (lastEntry?.result) {
                        console.log(`[TOOL-LOOP] Cross-request cache hit (full payload) for ${toolName}`);
                    }
                } else if (cachedResult && !skipCache && !WRITE_TOOLS.includes(toolName)) {
                    toolResult = {
                        ...cachedResult,
                        _cached: true,
                        _cache_note: MUTATING_TOOLS.includes(toolName)
                            ? `[Your prior ${toolName} call already SUCCEEDED — the result above is from that call. The mutation has happened; do not retry to confirm.]`
                            : `[Cached from earlier in this conversation — same ${toolName} call with identical arguments. Data is still current.]`
                    };
                    console.log(`[TOOL-LOOP] Cache hit for ${toolName}(${JSON.stringify(args).slice(0, 80)})`);
                } else {
                    madeProgressThisRound = true;
                    const isUserPause = USER_PAUSE_TOOLS.includes(toolName);
                    const isLongRunning = LONG_RUNNING_TOOLS.includes(toolName);
                    const toolTimeout = isLongRunning
                        ? (context.settings.longRunningToolTimeout || 300000)
                        : (context.settings.toolTimeout || 30000);
                    const userPauseTimeout = context.settings.userPauseTimeout ?? (24 * 60 * 60 * 1000);
                    const effectiveTimeout = isUserPause ? userPauseTimeout : toolTimeout;
                    const timeoutError = isUserPause
                        ? `User-pause tool ${toolName} exceeded max-pause watchdog (${effectiveTimeout/1000}s) — likely a UI mount failure`
                        : `Tool execution timeout (${effectiveTimeout/1000}s)`;
                    try {
                        toolResult = await Promise.race([
                            executeToolCall(toolCall, context.toolProfile || null),
                            new Promise((_, reject) =>
                                setTimeout(() => reject(new Error(timeoutError)), effectiveTimeout)
                            )
                        ]);
                    } catch (e) {
                        toolResult = { error: e.message };
                    }

                    if (toolName === 'submit_plan_for_approval' && toolResult && toolResult.status === 'approved') {
                        await h.onPlanModeApproved();
                        console.log('[TOOL-LOOP] Plan approved — Plan Mode lifted; LLM regains full tool catalog next round.');
                    }

                    const _inv = invalidateCachesForPath({
                        toolName,
                        args,
                        currentFilePath: context.currentFilePath,
                        toolCallCache,
                        toolActionLog: context.toolActionLog,
                        WRITE_TOOLS,
                    });
                    if (_inv.evictedCache > 0 || _inv.evictedLog > 0) {
                        console.log(`[TOOL-LOOP] Cache invalidated for ${toolName}(${args.path || args.file_path || context.currentFilePath || '?'}) — ${_inv.evictedCache} same-req, ${_inv.evictedLog} cross-req`);
                    }

                    const _invPrev = invalidateCachesForPreviewMutation({
                        toolName,
                        toolCallCache,
                        toolActionLog: context.toolActionLog,
                    });
                    if (_invPrev.evictedCache > 0 || _invPrev.evictedLog > 0) {
                        console.log(`[TOOL-LOOP] Preview cache invalidated for ${toolName} — ${_invPrev.evictedCache} same-req, ${_invPrev.evictedLog} cross-req`);
                    }

                    if (!toolResult?.error && !WRITE_TOOLS.includes(toolName)) {
                        toolCallCache.set(cacheKey, toolResult);
                    }
                }

                h.onToolCall({ toolName, args, toolResult, toolCallId: toolCall.id || null });

                if (context.profileNameForLedger === 'coder.v1') {
                    h.onLedgerRecord({
                        conversationId: context.conversationId,
                        toolName,
                        args,
                        toolResult,
                        turnId: toolCall.id || null,
                    });

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
                        h.onDiscoveryAdmissions({
                            conversationId: context.conversationId,
                            candidates,
                        });
                    }
                }

                if (toolName === 'memory_remember'
                    && toolResult
                    && toolResult.status === 'pending_consent'
                    && typeof toolResult.candidate_id === 'string') {
                    h.onConsentCard(toolResult.candidate_id);
                }

                toolActions.push({
                    tool: toolName,
                    args: args,
                    result: toolResult,
                    error: !!toolResult?.error
                });

                const resultSummary = summarizeToolResult(toolName, toolResult);
                context.toolActionLog.push(buildToolActionLogEntry({
                    toolName,
                    args: summarizeArgs(args),
                    toolResult,
                    resultSummary,
                    WRITE_TOOLS,
                    // 2.71.0 (gitea#472) — pass the live union so tools
                    // declaring `cache: 'never'` at registration are also
                    // excluded from cross-request `result` persistence.
                    STATEFUL_READ_TOOLS: getStatefulReadToolsLive(),
                }));
                // Bound the log to 50 entries. Splice in place so the
                // injected reference (wrapper: `State.toolActionLog`)
                // keeps pointing at the same array.
                if (context.toolActionLog.length > 50) {
                    context.toolActionLog.splice(0, context.toolActionLog.length - 50);
                }

                if (toolCallSource === 'structured') {
                    let toolContent = JSON.stringify(toolResult);

                    if (!toolContent || toolContent === 'null' || toolContent === 'undefined' || toolContent === '""') {
                        toolContent = JSON.stringify({ error: `Tool '${toolName}' returned empty result. Try a different approach.` });
                    }

                    const { scale } = getContextScale();
                    const TOOL_RESULT_LIMIT = 12000 * scale;

                    if (toolContent.length > TOOL_RESULT_LIMIT) {
                        try {
                            const truncated = JSON.parse(toolContent);
                            if (truncated.content && truncated.content.length > TOOL_RESULT_LIMIT) {
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

            if (context.cancelSignal()) {
                breakReason = 'cancelled';
                break;
            }

            const recentToolMsgCount = structuredResults.length;
            const compressUpTo = messages.length - recentToolMsgCount;

            for (let i = 0; i < compressUpTo; i++) {
                const msg = messages[i];
                if (msg.role === 'tool' && msg.content) {
                    try {
                        const parsed = JSON.parse(msg.content);
                        let compressed = false;

                        if (parsed.content && parsed.content.length > 4000) {
                            const lines = parsed.content.split('\n');
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
                        if (parsed.results && Array.isArray(parsed.results) && parsed.results.length > 0) {
                            const matchCount = parsed.results.reduce((sum, r) => sum + (r.matches?.length || 0), 0);
                            const filePaths = parsed.results.map(r => r.path || r.file).filter(Boolean).slice(0, 8);
                            parsed.results = `[${matchCount} matches in ${parsed.results.length} files: ${filePaths.join(', ')}${parsed.results.length > 8 ? '...' : ''}. Use read_lines to examine specific matches.]`;
                            compressed = true;
                        }
                        if (parsed.files && Array.isArray(parsed.files) && parsed.files.length > 20) {
                            const dirs = [...new Set(parsed.files.map(f => {
                                const p = (f.path || f);
                                return p.includes('/') ? p.split('/').slice(0, 2).join('/') : p;
                            }))].slice(0, 15);
                            parsed.files = `[${parsed.files.length} files in dirs: ${dirs.join(', ')}. Tree already known — use search_in_files or read_lines for specifics.]`;
                            compressed = true;
                        }
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

            const assistantMsg = {
                role: 'assistant',
                timestamp: Date.now()
            };
            if (lastRoundReasoning && lastRoundReasoning.content && lastRoundReasoning.content.length > 0) {
                assistantMsg.reasoning = lastRoundReasoning;
            }

            if (toolCallSource === 'structured') {
                assistantMsg.content = cleanContent.trim() ? cleanContent : null;
                assistantMsg.tool_calls = toolCalls;
            } else {
                assistantMsg.content = cleanContent || '';
            }

            h.onAssistantTurn(assistantMsg);

            if (toolCallSource === 'structured') {
                for (const tr of structuredResults) {
                    h.onToolResultTurn({
                        ...tr,
                        timestamp: Date.now()
                    });
                }
            }

            if (toolCallSource === 'structured') {
                messages.push(assistantMsg);
                for (const tr of structuredResults) {
                    messages.push(tr);
                }
            } else {
                messages.push({ role: 'assistant', content: cleanContent || '' });
                const summary = textResults.map(tr => {
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

            const drainResult = h.onUserInputDrain() || _DEFAULT_DRAIN();
            if (drainResult.anyDrained) {
                for (const drainedMsg of drainResult.drained) {
                    messages.push({ role: 'user', content: drainedMsg.content });
                }
                madeProgressThisRound = true;
            }

            if (madeProgressThisRound) {
                noProgressStreak = 0;
            } else {
                noProgressStreak++;
                if (noProgressStreak >= NO_PROGRESS_LIMIT) {
                    console.warn(`[TOOL-LOOP] No forward progress for ${noProgressStreak} rounds — breaking`);
                    if (!finalContent.trim()) {
                        finalContent = `*(Stopped after ${noProgressStreak} consecutive rounds with no new tool calls or visible text. The model may need a clearer prompt or different approach.)*`;
                    }
                    breakReason = 'no_progress';
                    break;
                }
            }

            const commitResult = h.onRoundCommit({
                content: cleanContent,
                hasNewText: !!cleanContent.trim(),
            }) || _DEFAULT_ROUND_COMMIT({ content: cleanContent, hasNewText: !!cleanContent.trim() });
            lastRoundContent = commitResult.lastRoundContent;
            textCommittedMidLoop = textCommittedMidLoop || commitResult.textCommittedMidLoop;
            h.onStreamStart();
            continue;
        }

        if (result.finishReason === 'tool_calls') {
            console.warn('Model signaled tool_calls but none were parsed — ending loop');
            breakReason = 'tool_call_signal_no_calls';
        }

        break;
    }

    // Empty-response fallback. Pre-2.48.0 this lived in the wrapper; moved
    // into the core so a Phase 1 sub-agent's result envelope inherits the
    // same synthesized summary when the model returned no text but did
    // execute tools (per DESIGN-sub-agents.md Decision §1).
    let fallbackContent = null;
    if (!finalContent.trim()) {
        if (toolActions.length > 0) {
            const summaryLines = toolActions.map(a => {
                const status = a.error ? '❌' : '✅';
                const detail = a.result?.message || a.result?.error || '';
                return `${status} **${a.tool}**${a.args?.path ? ` \`${a.args.path}\`` : ''}${detail ? ` — ${detail}` : ''}`;
            });
            fallbackContent = `Completed ${toolActions.length} tool call${toolActions.length > 1 ? 's' : ''} but the model did not provide a summary:\n\n${summaryLines.join('\n')}`;
        } else {
            fallbackContent = '*The model returned an empty response. Try rephrasing or switching models.*';
        }
        finalContent = fallbackContent;
    }

    // gitea#425 — emit one structured stop line per loop completion and
    // fire the wrapper hook so the debug pane can tag the last exchange.
    // The `breakReason` codes are the existing tool-loop vocabulary
    // (natural_stop / cancelled / transient_failure / no_progress /
    // tool_call_signal_no_calls); the wrapper maps to user-facing words.
    const loopOutcome = {
        breakReason,
        finishReason: lastFinishReason,
        error: lastError,
        rounds: roundsExecuted,
        toolActions: toolActions.length,
    };
    const _stopParts = [`rounds=${loopOutcome.rounds}`, `tools=${loopOutcome.toolActions}`];
    if (breakReason === 'natural_stop' && loopOutcome.finishReason) {
        _stopParts.push(`finish_reason=${loopOutcome.finishReason}`);
    }
    if (breakReason === 'transient_failure' && loopOutcome.error) {
        _stopParts.push(`error=${String(loopOutcome.error).slice(0, 80)}`);
    }
    console.info(`[Session] Stopped: reason=${breakReason} (${_stopParts.join(', ')})`);
    h.onLoopComplete(loopOutcome);

    return {
        finalContent,
        lastRoundContent,
        lastRoundReasoning,
        textCommittedMidLoop,
        toolActions,
        breakReason,
        fallbackContent,
    };
}
