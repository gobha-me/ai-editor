// @ts-check
/**
 * `retrieval:turn-stats` payload shape contract (ICD #5 finding (b2)).
 *
 * Single source of truth for the EventBus payload emitted by the retrieval
 * manager and consumed by the cost recorder. Pure module — no `core.js`,
 * `git.js`, or DOM imports — so `node --test` can pin the shape directly,
 * mirroring the 2.50.0 `tests/test-provider-capabilities-shape.mjs` pattern.
 *
 * The producer-side seam at [`manager.js`](manager.js) `_emitTurnStats`
 * routes both dispatch call sites through `validateTurnStatsPayload` and
 * warns loudly on divergence (still dispatching, to avoid dropping
 * attribution on a shape bug). The consumer-side listener at
 * [`../cost/cost-recorder.js`](../cost/cost-recorder.js) `_onRetrievalTurnStats`
 * silently early-returns on `!ok` — the producer is the warn site.
 *
 * Rename either side and the validator complains.
 *
 * @module intelligence/retrieval/turn-stats-shape
 */

/** Required keys on every `retrieval:turn-stats` payload. */
export const TURN_STATS_REQUIRED_KEYS = Object.freeze([
    'conversationId',
    'strategyStats',
]);

/** Optional keys that may appear on cache-hit payloads. */
export const TURN_STATS_OPTIONAL_KEYS = Object.freeze([
    'cache_hit',
]);

/** Required keys inside every `strategyStats[name]` slot. */
export const TURN_STATS_STRATEGY_SLOT_KEYS = Object.freeze([
    'hits',
    'tokens',
]);

/**
 * @typedef {Object} TurnStatsStrategySlot
 * @property {number} hits
 * @property {number} tokens
 */

/**
 * @typedef {Object} TurnStatsPayload
 * @property {string|null} conversationId
 * @property {Object<string, TurnStatsStrategySlot>} strategyStats
 * @property {boolean} [cache_hit]
 */

/**
 * @typedef {{ok: true} | {ok: false, reason: string}} ValidationResult
 */

/**
 * Validate a `retrieval:turn-stats` payload against the documented contract.
 * Pure function; returns a discriminated result so both producer (warn +
 * dispatch) and consumer (early-return) can branch without duplicate logic.
 *
 * @param {unknown} payload
 * @returns {ValidationResult}
 */
export function validateTurnStatsPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { ok: false, reason: 'payload must be a non-null object' };
    }
    const obj = /** @type {Record<string, unknown>} */ (payload);

    for (const key of TURN_STATS_REQUIRED_KEYS) {
        if (!(key in obj)) {
            return { ok: false, reason: `missing required key: ${key}` };
        }
    }

    const allowed = new Set([...TURN_STATS_REQUIRED_KEYS, ...TURN_STATS_OPTIONAL_KEYS]);
    const extras = Object.keys(obj).filter((k) => !allowed.has(k));
    if (extras.length > 0) {
        return { ok: false, reason: `unexpected key(s): ${extras.join(', ')}` };
    }

    if (obj.conversationId !== null && typeof obj.conversationId !== 'string') {
        return { ok: false, reason: `conversationId must be string or null (got ${typeof obj.conversationId})` };
    }

    if (!obj.strategyStats || typeof obj.strategyStats !== 'object' || Array.isArray(obj.strategyStats)) {
        return { ok: false, reason: 'strategyStats must be a non-null object' };
    }
    const stats = /** @type {Record<string, unknown>} */ (obj.strategyStats);
    const slotNames = Object.keys(stats);
    if (slotNames.length === 0) {
        return { ok: false, reason: 'strategyStats must be non-empty' };
    }
    for (const name of slotNames) {
        const slot = stats[name];
        if (!slot || typeof slot !== 'object' || Array.isArray(slot)) {
            return { ok: false, reason: `strategyStats.${name} must be a non-null object` };
        }
        const slotObj = /** @type {Record<string, unknown>} */ (slot);
        for (const slotKey of TURN_STATS_STRATEGY_SLOT_KEYS) {
            if (!(slotKey in slotObj)) {
                return { ok: false, reason: `strategyStats.${name} missing key: ${slotKey}` };
            }
            if (typeof slotObj[slotKey] !== 'number' || !Number.isFinite(slotObj[slotKey])) {
                return {
                    ok: false,
                    reason: `strategyStats.${name}.${slotKey} must be a finite number (got ${typeof slotObj[slotKey]})`,
                };
            }
        }
    }

    if ('cache_hit' in obj && typeof obj.cache_hit !== 'boolean') {
        return { ok: false, reason: `cache_hit must be boolean when present (got ${typeof obj.cache_hit})` };
    }

    return { ok: true };
}
