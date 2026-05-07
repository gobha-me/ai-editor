// @ts-check
/**
 * Cost recorder — translates `cost:updated` LLM events into persisted
 * per-conversation + daily aggregates with estimated per-tool spend.
 *
 * Race resolution: the active conversation can change mid-stream
 * (user opens a different conversation while a turn is in flight).
 * The recorder snapshots the conversation ID on `llm:generating: true`
 * and attributes the next `cost:updated` to that snapshot — never to
 * the conversation active at the moment usage arrives.
 *
 * Per-tool attribution is a Phase-1 estimate: tool-result byte counts
 * are scaled proportionally against `prompt_tokens` to credit each
 * tool with its share of input cost. The 1.4.0 admission ledger
 * replaces this with measured numbers.
 *
 * @module intelligence/cost/cost-recorder
 */

import { State, EventBus } from '../../core.js';
import { ConversationManager } from '../../chat/conversations.js';
import {
    recordTurn,
    getBudget,
    getTodaySpend,
    getMonthSpend,
    localDateKey,
} from './cost-store.js';
import { extractUsage } from './usage-shape.js';
import { checkThresholds, pickWorse } from './budget.js';

let _initialized = false;

/**
 * Snapshot of the conversation that was active when generation began.
 * Cleared after the corresponding `cost:updated` lands.
 * @type {string|null}
 */
let _inFlightConvId = null;

/**
 * 1.6.8 — pending per-strategy stats keyed by `conversationId`. Populated
 * by `retrieval:turn-stats` events emitted from
 * [`js/intelligence/retrieval/manager.js`](../retrieval/manager.js); drained
 * into the next `cost:updated`'s `recordTurn` payload so retrieval and LLM
 * usage land as a single per-turn write (one mutex acquisition, no double-
 * counted `requests`).
 *
 * Last-write-wins per conv: a second retrieval call before the matching
 * `cost:updated` fires (rare — would need a tool to call `find_relevant_files`
 * twice in the same turn) overwrites the prior pending entry. TTL drops
 * stale entries when the LLM call fails and `cost:updated` never lands.
 *
 * @type {Map<string, {byStrategy: Object<string, {hits: number, tokens: number}>, ts: number}>}
 */
const _pendingByStrategy = new Map();

/** Pending-buffer TTL in milliseconds. Beyond this, an unmatched entry is dropped. */
const PENDING_TTL_MS = 60_000;

/**
 * Attach event listeners. Idempotent.
 */
export function init() {
    if (_initialized) return;
    _initialized = true;

    EventBus.on('llm:generating', (active) => {
        if (active === true) {
            _inFlightConvId = ConversationManager.getActiveId() || null;
        }
    });

    EventBus.on('cost:updated', _onCostUpdated);
    EventBus.on('retrieval:turn-stats', _onRetrievalTurnStats);
}

/**
 * Stash a retrieval call's per-strategy stats for the next `cost:updated`
 * landing on the same conversation. The conv id is supplied by the
 * retrieval manager (read from the active conversation when the call
 * fires); we don't infer it here so we don't have to coordinate with
 * `_inFlightConvId`.
 *
 * @param {{conversationId: string|null, strategyStats: Object<string, {hits: number, tokens: number}>}} payload
 */
function _onRetrievalTurnStats(payload) {
    if (!payload || !payload.conversationId || !payload.strategyStats) return;
    const stats = payload.strategyStats;
    if (typeof stats !== 'object' || Object.keys(stats).length === 0) return;
    _pendingByStrategy.set(payload.conversationId, {
        byStrategy: stats,
        ts: Date.now(),
    });
}

/**
 * Returns the `recordTurn` promise so tests can `await` the per-conv +
 * daily writes (1.6.7 — `recordTurn` is async and serializes its
 * read-modify-write through `KeyMutex`). Production listeners still
 * fire-and-forget; the EventBus does not await handler return values.
 *
 * @param {{usage: any, sessionCost: any, messages?: any[], toolCalls?: any[]|null, modelId?: string, toolDefTokens?: number, toolDefBaseline?: number, toolDefUnfiltered?: number}} payload
 * @returns {Promise<void>|void}
 */
function _onCostUpdated(payload) {
    if (!payload || !payload.usage) return;

    const convId = _inFlightConvId || ConversationManager.getActiveId() || null;
    _inFlightConvId = null;

    // 1.8.5 — `extractUsage` is the single shape-tolerant extractor; it
    // handles OpenAI (`prompt_tokens`/`completion_tokens` + `_details`) and
    // Anthropic (`input_tokens`/`output_tokens` + `cache_*_input_tokens`)
    // and falls back from one to the other field-by-field. Same helper
    // wired into `LLM._trackUsage()` so the live `State.sessionCost` and
    // the persisted ConvCost can't drift on field coverage.
    //
    // Reasoning tokens (1.3.1): provider-reported under
    // completion_tokens_details.reasoning_tokens. They are NOT re-added
    // to inputTokens here — the provider has already counted the
    // reasoning portion of the *next* request's prompt under
    // prompt_tokens when history is replayed. Double-counting would
    // require extracting reasoning from our captured text and adding it
    // again; we do not.
    const {
        inputTokens,
        outputTokens,
        cachedTokens,
        reasoningTokens,
        cacheReadTokens,
        cacheCreationTokens,
    } = extractUsage(payload.usage);

    const modelId = payload.modelId || State.settings.llmModel || '';
    const provider = State.settings.apiProvider || null;

    const { cost, cacheSavings } = _computeCost({
        modelId, inputTokens, outputTokens, cachedTokens,
    });

    const byTool = _attributeTools(payload.messages || [], inputTokens);

    // 1.6.8 — drain any pending retrieval stats for this conversation so
    // strategy hits/tokens land on the same `recordTurn` write as the LLM
    // usage. Stale entries (TTL exceeded) are dropped without merging.
    const byStrategy = _drainPendingStrategy(convId);

    const turnPromise = recordTurn({
        conversationId: convId,
        modelId,
        provider,
        inputTokens,
        outputTokens,
        cachedTokens,
        reasoningTokens,
        cacheReadTokens,
        cacheCreationTokens,
        cost,
        cacheSavings,
        byTool,
        byStrategy,
        // 1.3.18 — tool-definition token metrics from the Composer.
        // `admitted == baseline` (and 0% reduction) when the kill-switch is
        // engaged or no profile static-set is configured.
        toolDefTokens:     payload.toolDefTokens     || 0,
        toolDefBaseline:   payload.toolDefBaseline   || 0,
        toolDefUnfiltered: payload.toolDefUnfiltered || 0,
        timestamp: Date.now(),
    });

    _emitBudgetWarningIfNeeded();
    return turnPromise;
}

/**
 * @param {{modelId: string, inputTokens: number, outputTokens: number, cachedTokens: number}} args
 * @returns {{cost: number, cacheSavings: number}}
 */
function _computeCost({ modelId, inputTokens, outputTokens, cachedTokens }) {
    const model = (State.models || []).find((m) => m.id === modelId);
    if (!model || !model.pricing) return { cost: 0, cacheSavings: 0 };

    const inputPrice  = model.pricing.input  || 0;
    const outputPrice = model.pricing.output || 0;
    const cachePrice  = model.pricing.cacheInput ?? null;

    const uncachedInput = Math.max(inputTokens - cachedTokens, 0);
    const inputCost  = (uncachedInput / 1_000_000) * inputPrice;
    const cacheCost  = cachePrice !== null ? (cachedTokens / 1_000_000) * cachePrice : 0;
    const outputCost = (outputTokens / 1_000_000) * outputPrice;
    const cost = inputCost + cacheCost + outputCost;

    let cacheSavings = 0;
    if (cachedTokens > 0) {
        const saved = inputPrice - (cachePrice || 0);
        cacheSavings = (cachedTokens / 1_000_000) * saved;
    }

    return { cost, cacheSavings };
}

/**
 * Attribute prompt tokens to tools proportionally by tool-result byte
 * length. Result-less tools (model called the tool but no result yet
 * in the input) get `calls: 1, estTokens: 0`.
 *
 * @param {any[]} messages
 * @param {number} promptTokens
 * @returns {Object<string, {calls: number, estTokens: number}>}
 */
export function _attributeTools(messages, promptTokens) {
    /** @type {Object<string, {calls: number, estTokens: number, bytes: number}>} */
    const tally = {};

    if (!Array.isArray(messages) || messages.length === 0) return {};

    /** @type {Map<string, string>} tool_call_id -> tool name */
    const callIdToName = new Map();
    for (const m of messages) {
        if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) {
                const id = tc?.id;
                const name = tc?.function?.name || tc?.name || 'unknown';
                if (id) callIdToName.set(id, name);
            }
        }
    }

    let totalToolBytes = 0;
    for (const m of messages) {
        if (m && m.role === 'tool') {
            const name = (m.tool_call_id && callIdToName.get(m.tool_call_id)) || m.name || 'unknown';
            const bytes = _byteLen(m.content);
            const slot = tally[name] || { calls: 0, estTokens: 0, bytes: 0 };
            slot.calls += 1;
            slot.bytes += bytes;
            totalToolBytes += bytes;
            tally[name] = slot;
        }
    }

    if (totalToolBytes > 0 && promptTokens > 0) {
        // Estimate: tool results are some fraction of total input. Rather
        // than assume 100% of `promptTokens` came from tool bytes (which
        // would overcount when system prompts and history dominate), we
        // use an upper bound — `promptTokens * (toolBytes / max(totalInputBytes, toolBytes))`.
        // For Phase 1 we approximate `totalInputBytes` by summing every
        // message's content length so the ratio stays sane.
        let totalInputBytes = 0;
        for (const m of messages) {
            totalInputBytes += _byteLen(m && m.content);
        }
        const denom = Math.max(totalInputBytes, totalToolBytes, 1);
        for (const name of Object.keys(tally)) {
            const slot = tally[name];
            slot.estTokens = Math.round(promptTokens * (slot.bytes / denom));
        }
    }

    /** @type {Object<string, {calls: number, estTokens: number}>} */
    const out = {};
    for (const [name, slot] of Object.entries(tally)) {
        out[name] = { calls: slot.calls, estTokens: slot.estTokens };
    }
    return out;
}

/**
 * Char-count proxy for byte length. `_attributeTools` only uses the
 * ratio between values so the absolute scale doesn't matter — what
 * matters is consistent normalization across messages.
 * @param {any} content
 * @returns {number}
 */
function _byteLen(content) {
    if (content == null) return 0;
    if (typeof content === 'string') return content.length;
    try {
        return JSON.stringify(content).length;
    } catch {
        return 0;
    }
}

/**
 * Compare today's + this-month's spend against the configured budget
 * and emit `cost:budget-warning` when the worse of the two crosses
 * the warn or over threshold. Idempotent at the ok level — listeners
 * dismiss banners on `cost:budget-ok`.
 */
function _emitBudgetWarningIfNeeded() {
    const budget = getBudget();
    if (budget.daily == null && budget.monthly == null) {
        EventBus.emit('cost:budget-ok', { reason: 'no-cap' });
        return;
    }

    const dailyCheck = checkThresholds(getTodaySpend(), budget.daily);
    const monthlyCheck = checkThresholds(getMonthSpend(), budget.monthly);
    const worst = pickWorse({ daily: dailyCheck, monthly: monthlyCheck });

    if (worst.level === 'ok') {
        EventBus.emit('cost:budget-ok', { dailyCheck, monthlyCheck });
    } else {
        EventBus.emit('cost:budget-warning', { ...worst, dailyCheck, monthlyCheck, today: localDateKey() });
    }
}

/**
 * Drain (and remove) the pending retrieval stats for `convId`. Returns
 * an empty object when nothing pending or the entry has aged out.
 *
 * @param {string|null} convId
 * @returns {Object<string, {hits: number, tokens: number}>}
 */
function _drainPendingStrategy(convId) {
    if (!convId) return {};
    const entry = _pendingByStrategy.get(convId);
    if (!entry) return {};
    _pendingByStrategy.delete(convId);
    if (Date.now() - entry.ts > PENDING_TTL_MS) return {};
    return entry.byStrategy;
}

// Expose for tests.
export const __test = {
    _attributeTools,
    _onCostUpdated,
    _onRetrievalTurnStats,
    _drainPendingStrategy,
    _pendingByStrategy,
};
