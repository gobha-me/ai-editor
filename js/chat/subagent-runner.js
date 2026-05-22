// @ts-check
/**
 * Sub-agent runner — wraps `tool-loop-core.runToolLoop` with a
 * sub-agent-shaped context + hooks bag + transport, threading cost
 * attribution and enforcing per-call ceilings (DESIGN-sub-agents.md
 * §Decision §6/§7, §Risks lines 528–536 — triple-bound termination).
 *
 * Lives separately from the approval card so the card stays purely
 * presentational. The card invokes `runSubAgent(pending, callbacks)`
 * inside its Approve path, holds the returned handle for Stop, and
 * surfaces progress via `onProgress`/`onComplete`.
 *
 * Ceilings: token cap + dollar cap + wall-clock timeout are each
 * checked independently (per DESIGN §Risks "triple-bound") inside the
 * transport wrapper between rounds. Hitting any one terminates the
 * loop with `status: 'partial'`.
 *
 * @since 2.49.0 (github#24 Phase 1 slice 2)
 * @module chat/subagent-runner
 */

import { State, EventBus } from '../core.js';
import { LLM } from '../llm.js';
import { Profiles } from '../profiles/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { resolveSubAgentConfig } from '../profiles/resolve.js';
import { extractUsage } from '../intelligence/cost/usage-shape.js';
import { runToolLoop } from './tool-loop-core.js';
import { buildSubAgentSystemPrompt } from '../prompts.js';

const SUBAGENT_PROFILE = 'subagent.v1';

/** Tools that would make the sub-agent "writeable". Used by the card's
 *  capability-summary computation, exposed here so the handler can pre-compute.
 *  Kept in sync with `SubAgentApprovalCard.js#WRITE_TOOL_NAMES`. */
export const WRITE_TOOLS = new Set([
    'edit_file', 'commit_files', 'write_file', 'replace_lines',
    'insert_lines', 'delete_lines',
]);

/** Tools that would let the sub-agent mutate user memory. */
export const MEMORY_WRITE_TOOLS = new Set([
    'memory_remember', 'memory_forget', 'memory_update',
]);

/**
 * Compute the dollar cost of a single LLM usage envelope against the
 * model's pricing — same shape as `LLM._trackUsage` so the sub-agent's
 * per-call accounting matches the cost dashboard's roll-up.
 *
 * @param {string} modelId
 * @param {object|null|undefined} usage
 * @returns {number}
 */
function _costForUsage(modelId, usage) {
    if (!usage) return 0;
    const { inputTokens, outputTokens, cachedTokens } = extractUsage(usage);
    const model = (State.models || []).find(m => m.id === modelId);
    if (!model?.pricing) return 0;
    const inputPrice = model.pricing.input || 0;
    const outputPrice = model.pricing.output || 0;
    const cachePrice = model.pricing.cacheInput ?? null;
    const uncachedInput = Math.max(0, inputTokens - cachedTokens);
    const inputCost = (uncachedInput / 1_000_000) * inputPrice;
    const cacheCost = cachePrice !== null
        ? (cachedTokens / 1_000_000) * cachePrice
        : 0;
    const outputCost = (outputTokens / 1_000_000) * outputPrice;
    return inputCost + cacheCost + outputCost;
}

/**
 * Compute the per-call narrow intersection of the sub-agent's profile
 * tool set with a parent-supplied list. The parent may not raise above
 * the profile; it may only narrow further.
 *
 * @param {string[]} profileToolNames
 * @param {string[]|null|undefined} requested
 * @returns {string[]|null}  null when no narrow was requested
 */
function _intersectNarrow(profileToolNames, requested) {
    if (!Array.isArray(requested) || requested.length === 0) return null;
    const allowed = new Set(profileToolNames);
    return requested.filter(name => allowed.has(name));
}

/**
 * Build the `roleTools` array the sub-agent loop will pass to the LLM.
 * Filters the registry definitions against the *resolved* sub-agent
 * profile (default `subagent.v1`; parent may override at call site —
 * the override flips `Write access` to ✓ on the approval card) + the
 * optional per-call narrow.
 *
 * @param {string} profileName
 * @param {string[]|null} perCallNarrow
 * @returns {Array<any>}
 */
function _buildSubAgentTools(profileName, perCallNarrow) {
    const defs = ToolRegistry.getDefinitions();
    const filtered = Profiles.filterTools(defs, profileName || SUBAGENT_PROFILE);
    if (!perCallNarrow) return filtered;
    const allow = new Set(perCallNarrow);
    return filtered.filter(t => allow.has(t?.function?.name));
}

/**
 * Resolve the model id a sub-agent should run on. Five-step chain
 * (gitea#505 / 2.89.0):
 *
 *   1. Per-call override from `delegate_task({ model })`
 *   2. Profile-side default — `profile.subagent.model` (e.g.
 *      `subagent.v1.subagent.model`, surfaced by `resolveSubAgentConfig`)
 *   3. Workspace cheap-tier overlay — `State.settings.retrieval.subagentModelId`
 *   4. Workspace paraphrase utility model — `State.settings.retrieval.paraphraseModelId`
 *   5. Primary chat model — `State.settings.llmModel`
 *
 * Empty strings and non-string values are treated as "not set" and fall
 * through. Returns the resolved id plus the source step for telemetry +
 * the approval-card display path ("(primary model)" vs the named id).
 *
 * Provider stays locked to primary across the entire chain — same
 * constraint as the existing utility-model fields in retrieval-tab.js.
 *
 * @param {{ perCallModel?: string|null, profileModel?: string|null }} args
 * @returns {{ id: string, source: 'per_call'|'profile'|'workspace_subagent'|'workspace_paraphrase'|'primary' }}
 */
export function resolveSubAgentModel({ perCallModel = null, profileModel = null } = {}) {
    const _isSet = (v) => typeof v === 'string' && v.trim().length > 0;
    if (_isSet(perCallModel)) return { id: perCallModel.trim(), source: 'per_call' };
    if (_isSet(profileModel)) return { id: profileModel.trim(), source: 'profile' };
    const r = State.settings?.retrieval || {};
    if (_isSet(r.subagentModelId)) return { id: r.subagentModelId.trim(), source: 'workspace_subagent' };
    if (_isSet(r.paraphraseModelId)) return { id: r.paraphraseModelId.trim(), source: 'workspace_paraphrase' };
    return { id: State.settings?.llmModel || '', source: 'primary' };
}

/**
 * Build a capability-summary object the approval card renders. This is
 * the security-load-bearing view per DESIGN §"Approval-card capability
 * summary". The handler in `js/tools/subagent-tools.js` calls this and
 * passes the result into `setPendingSubAgentApproval`.
 *
 * 2.89.0 (gitea#505) — surfaces the resolved `childModel` (id + source)
 * so the approval card can display "(primary model — `<id>`)" vs the
 * named cheap-tier id. The user sees the cost-tier choice before
 * approving.
 *
 * @param {{profileName?: string, perCallNarrow?: string[]|null, ceilings?: object, modelOverride?: string|null}} args
 * @returns {{
 *   profile: string,
 *   profileRegistered: boolean,
 *   admittedTools: string[],
 *   perCallNarrow: string[]|null,
 *   ceilings: {max_tokens: number, max_dollars: number, run_timeout_ms: number, recursion_depth: number},
 *   memoryWriteTools: string[],
 *   writeTools: string[],
 *   childModel: { id: string, source: string },
 * }}
 */
export function buildCapabilitySummary({ profileName, perCallNarrow, ceilings, modelOverride } = {}) {
    const profile = profileName || SUBAGENT_PROFILE;
    const profileRegistered = Profiles.has(profile);
    const profileToolsRaw = _buildSubAgentTools(profile, null);
    const profileTools = profileToolsRaw.map(t => t?.function?.name).filter(Boolean);
    const narrow = _intersectNarrow(profileTools, perCallNarrow);
    const admittedTools = narrow || profileTools;
    // Resolve the child's model so the card shows the cost-tier choice.
    // Falls back to `null` profileModel when the profile isn't registered;
    // the runner will hit the same chain and resolve to primary then too.
    const profileModel = profileRegistered ? resolveSubAgentConfig(profile).model : null;
    const childModel = resolveSubAgentModel({
        perCallModel: modelOverride ?? null,
        profileModel,
    });
    return {
        profile,
        profileRegistered,
        admittedTools,
        perCallNarrow: narrow,
        ceilings: {
            max_tokens: Number.isFinite(ceilings?.max_tokens) ? ceilings.max_tokens : 50000,
            max_dollars: Number.isFinite(ceilings?.max_dollars) ? ceilings.max_dollars : 0.5,
            run_timeout_ms: Number.isFinite(ceilings?.run_timeout_ms) ? ceilings.run_timeout_ms : 300000,
            recursion_depth: Number.isFinite(ceilings?.recursion_depth) ? ceilings.recursion_depth : 0,
        },
        memoryWriteTools: admittedTools.filter(t => MEMORY_WRITE_TOOLS.has(t)),
        writeTools: admittedTools.filter(t => WRITE_TOOLS.has(t)),
        childModel,
    };
}

/**
 * Run the sub-agent loop. Returns a handle exposing `cancel()`. Calls
 * `callbacks.onProgress` after each round-end (when usage is reported)
 * and `callbacks.onComplete(envelope)` exactly once when the loop ends
 * (natural stop, ceiling hit, error, or cancel).
 *
 * @param {{
 *   transcriptId: string,
 *   task: string,
 *   contextHint?: string,
 *   profileName?: string,
 *   perCallNarrow?: string[]|null,
 *   ceilings?: {max_tokens?: number, max_dollars?: number, run_timeout_ms?: number, recursion_depth?: number},
 * }} pending
 * @param {{
 *   onProgress?: (s: {rounds: number, tokens: number, dollars: number, status: string}) => void,
 *   onComplete: (envelope: object) => void,
 * }} callbacks
 * @returns {{ cancel: (reason?: string) => void }}
 */
export function runSubAgent(pending, callbacks) {
    const profileName = pending.profileName || SUBAGENT_PROFILE;
    const cfg = resolveSubAgentConfig(profileName);
    const ceilings = {
        max_tokens: pending.ceilings?.max_tokens ?? cfg.max_tokens,
        max_dollars: pending.ceilings?.max_dollars ?? cfg.max_dollars,
        run_timeout_ms: pending.ceilings?.run_timeout_ms ?? cfg.run_timeout_ms,
        recursion_depth: pending.ceilings?.recursion_depth ?? cfg.recursion_depth,
    };

    // 2.89.0 (gitea#505) — resolve the child's model via the 5-step chain.
    // The approval card already computed and displayed this; recompute
    // here so the runner doesn't depend on the capability-summary object
    // being threaded through (the card may be bypassed in test paths).
    const resolvedChild = resolveSubAgentModel({
        perCallModel: pending.modelOverride ?? null,
        profileModel: cfg.model,
    });
    const childModelId = resolvedChild.id;

    const subagentTools = _buildSubAgentTools(profileName, pending.perCallNarrow || null);
    const admittedToolNames = subagentTools.map(t => t?.function?.name).filter(Boolean);
    const systemPrompt = buildSubAgentSystemPrompt({
        task: pending.task,
        contextHint: pending.contextHint || '',
        admittedToolNames,
        profileName,
        ceilings,
    });

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: pending.task + (pending.contextHint ? `\n\nContext hint:\n${pending.contextHint}` : '') },
    ];

    // Cumulative accounting for ceiling enforcement + UI progress.
    let cumulativeRounds = 0;
    let cumulativeTokens = 0;
    let cumulativeDollars = 0;
    let cancelled = false;
    let cancelReason = '';
    let completed = false;

    // Initialize transcript slot in State.subagents.transcripts. Slice 1's
    // State.subagents = {tree, transcripts, session_cost} slot is the
    // home; this fills `transcripts[transcriptId]` with a live view so the
    // transcript panel (slice 2, step 6) can read it as the loop runs.
    if (!State.subagents) {
        State.subagents = { tree: {}, transcripts: {}, session_cost: { dollars: 0, tokens: 0, byModel: {} } };
    }
    State.subagents.transcripts[pending.transcriptId] = {
        id: pending.transcriptId,
        task: pending.task,
        contextHint: pending.contextHint || '',
        profileName,
        startedAt: Date.now(),
        finishedAt: null,
        status: 'running',
        messages: messages.slice(),
        admittedTools: admittedToolNames,
        toolActions: [],
        ceilings,
        cost: { tokens: 0, dollars: 0, rounds: 0 },
    };

    // Wall-clock timeout — DESIGN §Risks triple-bound mitigation. Fires
    // independently of token/dollar caps; even an idle sub-agent gets
    // killed at the deadline.
    const timeoutHandle = setTimeout(() => {
        if (!completed) {
            cancelled = true;
            cancelReason = cancelReason || 'timeout';
        }
    }, Math.max(1000, ceilings.run_timeout_ms));

    const transport = {
        chat: async (msgs, options = {}) => {
            // 2.89.0 (gitea#505) — was `State.settings.llmModel` (parent's
            // primary). Now resolved via the 5-step chain so the child can
            // run on a cheap-tier utility model by default — delivers the
            // *spend* half of DESIGN-sub-agents.md's bounded-trust +
            // bounded-spend pair.
            const model = childModelId || State.settings.llmModel;
            const result = await LLM.chat(msgs, {
                ...options,
                model,
                costAttribution: 'delegate_task',
                // Sub-agent doesn't stream tokens to a UI; suppress UI flicker.
                // The hooks bag's onStreamToken is a no-op anyway.
                stream: options.stream !== false,
            });
            cumulativeRounds += 1;
            if (result?.usage) {
                const u = extractUsage(result.usage);
                cumulativeTokens += (u.inputTokens || 0) + (u.outputTokens || 0);
                cumulativeDollars += _costForUsage(model, result.usage);
            }
            // Persist live cost to the transcript slot.
            const slot = State.subagents.transcripts[pending.transcriptId];
            if (slot) {
                slot.cost = {
                    tokens: cumulativeTokens,
                    dollars: cumulativeDollars,
                    rounds: cumulativeRounds,
                };
            }
            try {
                callbacks.onProgress?.({
                    rounds: cumulativeRounds,
                    tokens: cumulativeTokens,
                    dollars: cumulativeDollars,
                    status: 'running',
                });
            } catch { /* best-effort */ }
            // Independent ceiling checks — DESIGN §Risks triple-bound.
            if (cumulativeTokens >= ceilings.max_tokens) {
                cancelled = true;
                cancelReason = cancelReason || 'budget_tokens';
            } else if (cumulativeDollars >= ceilings.max_dollars) {
                cancelled = true;
                cancelReason = cancelReason || 'budget_dollars';
            }
            return result;
        },
        stop: () => {
            // Aborts the in-flight `LLM.chat` if any. Safe to call when
            // there's no in-flight call (LLM.stop is a no-op then).
            try { LLM.stop(); } catch { /* best-effort */ }
        },
    };

    const context = {
        messages,
        historySnapshot: messages.length,
        roleTools: subagentTools,
        toolActionLog: [],
        // 2.49.0 — explicit tool dispatch profile (slice 1's
        // `ToolRegistry.executeWithProfile` entry-point). Sub-agent
        // tool dispatch consults `subagent.v1`'s admitted tool set,
        // not the parent conversation's profile.
        toolProfile: profileName,
        settings: {
            // Sub-agent inherits the parent's tool timeouts (per-call
            // timeouts unrelated to the wall-clock run_timeout_ms above).
            toolTimeout: State.settings.toolTimeout,
            longRunningToolTimeout: State.settings.longRunningToolTimeout,
            userPauseTimeout: State.settings.userPauseTimeout,
        },
        currentFilePath: null,        // Sub-agent has no editor context
        profileNameForLedger: null,   // No ledger participation
        conversationId: null,         // Transcripts persist via State.subagents.transcripts
        cancelSignal: () => cancelled,
        setHistoryLength: (n) => {
            messages.length = n;
        },
    };

    const hooks = {
        // Sub-agent streams nothing to a chat surface. UI updates ride on
        // the runner's `onProgress` callback, not on token streams.
        onAssistantTurn: (msg) => {
            messages.push(msg);
            const slot = State.subagents.transcripts[pending.transcriptId];
            if (slot) slot.messages = messages.slice();
        },
        onToolResultTurn: (tr) => {
            messages.push(tr);
            const slot = State.subagents.transcripts[pending.transcriptId];
            if (slot) slot.messages = messages.slice();
        },
        onToolCall: ({ toolName, args, toolResult }) => {
            const slot = State.subagents.transcripts[pending.transcriptId];
            if (slot) {
                slot.toolActions.push({
                    toolName,
                    args,
                    error: !!toolResult?.error,
                    ts: Date.now(),
                });
            }
        },
        // No streaming UI, no input queue, no ledger record, no consent card.
    };

    // Kick the loop in a microtask so the caller has the handle before
    // anything happens.
    (async () => {
        let loopResult = null;
        let error = null;
        try {
            loopResult = await runToolLoop(context, hooks, transport);
        } catch (err) {
            error = err;
        } finally {
            clearTimeout(timeoutHandle);
            completed = true;
        }

        // Derive the result envelope per DESIGN §Decision §6.
        const slot = State.subagents.transcripts[pending.transcriptId];
        const summary = (loopResult && loopResult.finalContent && String(loopResult.finalContent).trim())
            || (slot?.messages?.findLast?.(m => m.role === 'assistant')?.content)
            || '';
        const cost = {
            tokens: cumulativeTokens,
            dollars: cumulativeDollars,
            rounds: cumulativeRounds,
        };

        let envelope;
        if (error && !summary) {
            envelope = {
                status: 'errored',
                error: error.message || String(error),
                cost,
                transcript_id: pending.transcriptId,
            };
        } else if (cancelled) {
            envelope = {
                status: cancelReason === 'user_cancel' ? 'cancelled' : 'partial',
                summary: String(summary || ''),
                cost,
                transcript_id: pending.transcriptId,
                partial: true,
                ...(cancelReason ? { reason: cancelReason } : {}),
            };
        } else {
            envelope = {
                status: 'completed',
                summary: String(summary || ''),
                artifacts: [],
                cost,
                transcript_id: pending.transcriptId,
            };
        }

        // Finalize transcript metadata.
        if (slot) {
            slot.finishedAt = Date.now();
            slot.status = envelope.status;
            slot.cost = cost;
        }

        // Roll session_cost so a future per-conversation budget warning has
        // the running aggregate. Re-initialize defensively in case slice 1's
        // single-pass init never ran (test environment).
        // 2.89.0 (gitea#505) — `byModel` extends the shape so cost split
        // by resolved-child-model surfaces honestly to the dashboard.
        // Cap check at `subagent-tools.js:107-116` stays model-agnostic on
        // the scalar total (safe overpredict).
        if (!State.subagents.session_cost) {
            State.subagents.session_cost = { dollars: 0, tokens: 0, byModel: {} };
        }
        if (!State.subagents.session_cost.byModel) {
            State.subagents.session_cost.byModel = {};
        }
        State.subagents.session_cost.dollars += cumulativeDollars;
        State.subagents.session_cost.tokens += cumulativeTokens;
        if (childModelId) {
            const byModelSlot = State.subagents.session_cost.byModel[childModelId]
                || (State.subagents.session_cost.byModel[childModelId] = { dollars: 0, tokens: 0 });
            byModelSlot.dollars += cumulativeDollars;
            byModelSlot.tokens += cumulativeTokens;
        }

        try {
            EventBus.emit('subagent:finished', { transcriptId: pending.transcriptId, envelope });
        } catch { /* best-effort */ }

        try { callbacks.onComplete(envelope); } catch (err) {
            console.error('[subagent-runner] onComplete threw:', err);
        }
    })();

    return {
        cancel: (reason) => {
            cancelled = true;
            cancelReason = reason || 'user_cancel';
            try { LLM.stop(); } catch { /* best-effort */ }
        },
    };
}
