// @ts-check
/**
 * Cost storage layer.
 *
 * Three Storage keys, all read synchronously through the existing
 * `Storage` cache (`js/core.js`):
 *
 *   `cost-by-conv-{id}`  — per-conversation aggregate.
 *   `cost-daily`         — rolling 30-day calendar (single key).
 *   `cost-budget`        — daily / monthly USD caps.
 *
 * All writes are async-persisted but synchronously visible. Daily
 * records older than `DAILY_RETENTION_DAYS` are pruned on every write.
 *
 * @module intelligence/cost/cost-store
 */

import { Storage } from '../../core.js';
import { KeyMutex } from '../memory/utils.js';

/** @type {number} */
export const DAILY_RETENTION_DAYS = 30;

const CONV_KEY = (id) => `cost-by-conv-${id}`;
const DAILY_KEY = 'cost-daily';
const BUDGET_KEY = 'cost-budget';

// gitea#188 — `recordTurn` does read-modify-write on `cost-daily` and
// `cost-by-conv-{id}`. Two concurrent turns (rapid sub-rounds in a
// tool-loop, or two browser tabs both crediting cost into the daily
// rollup) can interleave: both read the same snapshot, both write a
// divergent successor, second write loses the first turn's spend.
// `KeyMutex` serializes the RMW per-key. Same disposition as the memory
// subsystem's adoption (see `js/intelligence/memory/utils.js:5-19`).
const _mutex = new KeyMutex();

// ============================================
// Date helpers — local YYYY-MM-DD
// ============================================

/**
 * Local-date stamp, format `YYYY-MM-DD`. Local because the user reads
 * this against their wall clock; tab-isolated state already segments
 * across machines.
 *
 * @param {Date|number} [when]
 * @returns {string}
 */
export function localDateKey(when) {
    const d = when == null ? new Date() : (when instanceof Date ? when : new Date(when));
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** YYYY-MM prefix from a YYYY-MM-DD key. */
export function monthKey(dateKey) {
    return dateKey.slice(0, 7);
}

/**
 * Days between two YYYY-MM-DD strings (b - a). Negative if a > b.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function daysBetween(a, b) {
    const ta = Date.parse(a + 'T00:00:00');
    const tb = Date.parse(b + 'T00:00:00');
    return Math.round((tb - ta) / 86400000);
}

// ============================================
// Per-conversation aggregate
// ============================================

/**
 * @typedef {Object} ToolSpend
 * @property {number} calls
 * @property {number} estTokens     Estimated input tokens proportional to tool-result bytes.
 */

/**
 * @typedef {Object} ModelSpend
 * @property {number} tokens
 * @property {number} cost
 */

/**
 * @typedef {Object} StrategySpend
 * @property {number} hits      Σ chunks contributed by this strategy across retrieval calls in the conversation.
 * @property {number} tokens    Σ LLM tokens this strategy spent (paraphrase chatFn so far; embed-token plumbing deferred).
 */

/**
 * @typedef {Object} ConvCost
 * @property {string}  id
 * @property {number}  inputTokens
 * @property {number}  outputTokens
 * @property {number}  cachedTokens
 * @property {number}  reasoningTokens
 * @property {number}  cost
 * @property {number}  cacheSavings
 * @property {number}  requests
 * @property {Object<string, ToolSpend>}  byTool
 * @property {Object<string, ModelSpend>} byModel
 * @property {Object<string, StrategySpend>} byStrategy   1.6.8 — Σ retrieval hits + tokens per strategy. Mirrors the byTool shape; absent on legacy on-disk records.
 * @property {number}  firstAt
 * @property {number}  lastAt
 * @property {number}  toolDefTokens     1.3.18 — Σ admitted tool-definition tokens across requests.
 * @property {number}  toolDefBaseline   1.3.18 — Σ role-filtered legacy baseline (the would-have-been cost).
 * @property {number}  toolDefUnfiltered 1.3.18 — Σ ungated whole-registry baseline.
 */

/** @returns {ConvCost} */
function emptyConvCost(id) {
    return {
        id,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        cost: 0,
        cacheSavings: 0,
        requests: 0,
        byTool: {},
        byModel: {},
        byStrategy: {},
        firstAt: 0,
        lastAt: 0,
        toolDefTokens: 0,
        toolDefBaseline: 0,
        toolDefUnfiltered: 0,
    };
}

/**
 * @param {string} id
 * @returns {ConvCost|null}
 */
export function getConvCost(id) {
    if (!id) return null;
    return Storage.get(CONV_KEY(id), null);
}

/**
 * @param {string} id
 */
export function removeConvCost(id) {
    if (!id) return;
    Storage.remove(CONV_KEY(id));
}

// ============================================
// Daily rollup
// ============================================

/**
 * @typedef {Object} DailyEntry
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cost
 * @property {number} requests
 * @property {Object<string, {tokens: number, cost: number}>} byProvider
 * @property {number} [toolDefTokens]     1.3.18 — Σ admitted tool-definition tokens for the day.
 * @property {number} [toolDefBaseline]   1.3.18 — Σ role-filtered baseline.
 * @property {number} [toolDefUnfiltered] 1.3.18 — Σ ungated registry baseline.
 */

/**
 * Zero-default for a `DailyEntry`. Used by `getDailySeries()` to back-fill
 * missing days and by `recordTurn()` when the day's first turn lands.
 *
 * @returns {DailyEntry}
 */
function emptyDailyEntry() {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        requests: 0,
        byProvider: {},
        toolDefTokens: 0,
        toolDefBaseline: 0,
        toolDefUnfiltered: 0,
    };
}

/** @returns {Object<string, DailyEntry>} */
export function getDailyMap() {
    return Storage.get(DAILY_KEY, {});
}

/**
 * Return the last `days` daily entries in ascending date order. Missing
 * days are filled with zero entries so the chart has a stable x-axis.
 *
 * @param {number} [days=30]
 * @param {Date|number} [endDate]
 * @returns {Array<{date: string, entry: DailyEntry}>}
 */
export function getDailySeries(days = 30, endDate) {
    const map = getDailyMap();
    const end = endDate == null ? new Date() : (endDate instanceof Date ? endDate : new Date(endDate));
    /** @type {Array<{date: string, entry: DailyEntry}>} */
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(end);
        d.setDate(d.getDate() - i);
        const key = localDateKey(d);
        out.push({
            date: key,
            entry: map[key] || emptyDailyEntry(),
        });
    }
    return out;
}

/**
 * Sum cost for the month containing `date`.
 *
 * @param {Date|number} [date]
 * @returns {number}
 */
export function getMonthSpend(date) {
    const map = getDailyMap();
    const target = monthKey(localDateKey(date));
    let sum = 0;
    for (const k of Object.keys(map)) {
        if (monthKey(k) === target) sum += map[k].cost || 0;
    }
    return sum;
}

/** @returns {number} */
export function getTodaySpend() {
    const map = getDailyMap();
    return map[localDateKey()]?.cost || 0;
}

// ============================================
// Budget
// ============================================

/**
 * @typedef {Object} Budget
 * @property {number|null} daily
 * @property {number|null} monthly
 */

/** @returns {Budget} */
export function getBudget() {
    return Storage.get(BUDGET_KEY, { daily: null, monthly: null });
}

/** @param {Budget} budget */
export function setBudget(budget) {
    const clean = {
        daily: typeof budget.daily === 'number' && budget.daily > 0 ? budget.daily : null,
        monthly: typeof budget.monthly === 'number' && budget.monthly > 0 ? budget.monthly : null,
    };
    Storage.set(BUDGET_KEY, clean);
}

// ============================================
// Recording
// ============================================

/**
 * @typedef {Object} TurnRecord
 * @property {string|null} conversationId
 * @property {string}      modelId
 * @property {string|null} provider
 * @property {number}      inputTokens
 * @property {number}      outputTokens
 * @property {number}      cachedTokens
 * @property {number}      reasoningTokens
 * @property {number}      cost
 * @property {number}      cacheSavings
 * @property {Object<string, ToolSpend>} byTool
 * @property {Object<string, StrategySpend>} [byStrategy]   1.6.8 — retrieval-strategy hits + tokens collected during this turn (drained from cost-recorder's pending buffer).
 * @property {number}      [toolDefTokens]     1.3.18 — admitted tool-definition tokens this turn.
 * @property {number}      [toolDefBaseline]   1.3.18 — role-filtered legacy baseline this turn.
 * @property {number}      [toolDefUnfiltered] 1.3.18 — ungated registry baseline this turn.
 * @property {number}      [timestamp]
 */

/**
 * Persist a turn into the per-conversation aggregate AND the daily
 * rollup. Daily entries older than `DAILY_RETENTION_DAYS` are pruned
 * from the rollup on every write.
 *
 * Returns a promise that resolves once both writes have been issued
 * through their respective `KeyMutex` regions. Callers in the
 * production path (`js/intelligence/cost/cost-recorder.js`) fire-and-
 * forget, but tests must `await` so the post-write reads observe the
 * effect.
 *
 * @param {TurnRecord} rec
 * @returns {Promise<void>}
 */
export async function recordTurn(rec) {
    const ts = rec.timestamp || Date.now();

    // ── Per-conversation aggregate ──
    // gitea#188 — read-modify-write must run inside the lock so two
    // concurrent turns on the same conversation can't both observe the
    // pre-mutation snapshot.
    if (rec.conversationId) {
        await _mutex.withLock(CONV_KEY(rec.conversationId), () => {
            const prev = getConvCost(rec.conversationId) || emptyConvCost(rec.conversationId);
            prev.inputTokens     += rec.inputTokens || 0;
            prev.outputTokens    += rec.outputTokens || 0;
            prev.cachedTokens    += rec.cachedTokens || 0;
            prev.reasoningTokens += rec.reasoningTokens || 0;
            prev.cost            += rec.cost || 0;
            prev.cacheSavings    += rec.cacheSavings || 0;
            prev.requests        += 1;
            prev.firstAt = prev.firstAt || ts;
            prev.lastAt  = ts;
            // 1.3.18 — `|| 0` defensive reads protect against legacy on-disk
            // ConvCost records that were written before these fields existed
            // (without the fallback, `undefined + N === NaN` poisons the sum).
            prev.toolDefTokens     = (prev.toolDefTokens     || 0) + (rec.toolDefTokens     || 0);
            prev.toolDefBaseline   = (prev.toolDefBaseline   || 0) + (rec.toolDefBaseline   || 0);
            prev.toolDefUnfiltered = (prev.toolDefUnfiltered || 0) + (rec.toolDefUnfiltered || 0);

            if (rec.byTool) {
                for (const [name, spend] of Object.entries(rec.byTool)) {
                    const slot = prev.byTool[name] || { calls: 0, estTokens: 0 };
                    slot.calls     += spend.calls || 0;
                    slot.estTokens += spend.estTokens || 0;
                    prev.byTool[name] = slot;
                }
            }

            // 1.6.8 — `|| {}` defensive read so legacy ConvCost records
            // (written before byStrategy existed) don't crash when a turn
            // arrives with strategy stats. Mirrors the same pattern used
            // for byTool/byModel.
            if (rec.byStrategy) {
                if (!prev.byStrategy) prev.byStrategy = {};
                for (const [name, spend] of Object.entries(rec.byStrategy)) {
                    const slot = prev.byStrategy[name] || { hits: 0, tokens: 0 };
                    slot.hits   += spend.hits   || 0;
                    slot.tokens += spend.tokens || 0;
                    prev.byStrategy[name] = slot;
                }
            }

            if (rec.modelId) {
                const m = prev.byModel[rec.modelId] || { tokens: 0, cost: 0 };
                m.tokens += (rec.inputTokens || 0) + (rec.outputTokens || 0);
                m.cost   += rec.cost || 0;
                prev.byModel[rec.modelId] = m;
            }

            Storage.set(CONV_KEY(rec.conversationId), prev);
        });
    }

    // ── Daily rollup ──
    await _mutex.withLock(DAILY_KEY, () => {
        const dailyMap = getDailyMap();
        const today = localDateKey(ts);
        const dayEntry = dailyMap[today] || emptyDailyEntry();
        dayEntry.inputTokens  += rec.inputTokens || 0;
        dayEntry.outputTokens += rec.outputTokens || 0;
        dayEntry.cost         += rec.cost || 0;
        dayEntry.requests     += 1;
        // 1.3.18 — same `|| 0` defensive read pattern as the per-conv aggregate.
        dayEntry.toolDefTokens     = (dayEntry.toolDefTokens     || 0) + (rec.toolDefTokens     || 0);
        dayEntry.toolDefBaseline   = (dayEntry.toolDefBaseline   || 0) + (rec.toolDefBaseline   || 0);
        dayEntry.toolDefUnfiltered = (dayEntry.toolDefUnfiltered || 0) + (rec.toolDefUnfiltered || 0);

        const provider = rec.provider || 'unknown';
        const provSlot = dayEntry.byProvider[provider] || { tokens: 0, cost: 0 };
        provSlot.tokens += (rec.inputTokens || 0) + (rec.outputTokens || 0);
        provSlot.cost   += rec.cost || 0;
        dayEntry.byProvider[provider] = provSlot;

        dailyMap[today] = dayEntry;

        // Prune old days.
        for (const k of Object.keys(dailyMap)) {
            if (daysBetween(k, today) >= DAILY_RETENTION_DAYS) {
                delete dailyMap[k];
            }
        }
        Storage.set(DAILY_KEY, dailyMap);
    });
}

/** Test/dev only — clears the daily rollup. Per-conv records survive. */
export function _resetDaily() {
    Storage.remove(DAILY_KEY);
}

/**
 * Test seam — reset the mutex's internal state between tests so a queue
 * carried over from a prior test doesn't bleed into the next.
 * Production code should never call this.
 */
export function _resetMutexForTests() {
    _mutex._resetForTests();
}
