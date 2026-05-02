// @ts-check
/**
 * Strategy router — picks which retrieval strategies fire for a given
 * `RetrievalRequest` and how chunk-quota is allocated across them.
 * Implements [DESIGN-retrieval.md](../../../docs/DESIGN-retrieval.md)
 * §"Strategy Router":
 *
 *   1. Ask each strategy how well it fits via `applies_to(req)`.
 *   2. Filter to viable strategies (applicability score ≥ 0.3).
 *   3. If none viable, fall back to Semantic at score 0.5 (when present).
 *   4. Otherwise, allocate quotas proportional to applicability score,
 *      summing to `DEFAULT_TOTAL_QUOTA`.
 *
 * The router lives next to the [Composer](./composer.js) (1.4.17) and is
 * its only collaborator outside the strategies themselves. Pure function
 * — no I/O, no async, no shared state.
 *
 * @module intelligence/retrieval/router
 */

/**
 * @typedef {import('./contracts.js').Strategy} Strategy
 * @typedef {import('./contracts.js').RetrievalRequest} RetrievalRequest
 * @typedef {import('./contracts.js').Applicability} Applicability
 * @typedef {import('./contracts.js').StrategyName} StrategyName
 */

/**
 * Default total chunk quota distributed across viable strategies. With
 * two strategies firing each gets ~6 chunks; mirrors the typical
 * `k = quota * 3` headroom Semantic uses internally so candidate volume
 * stays in the same order of magnitude.
 */
export const DEFAULT_TOTAL_QUOTA = 12;

/**
 * Quota when only the fallback Semantic strategy fires (no viable
 * strategies). Half the all-strategies budget — fewer-but-higher-quality
 * candidates from a single strategy.
 */
export const DEFAULT_FALLBACK_QUOTA = 6;

/**
 * Minimum applicability score for a strategy to be considered viable.
 * Per design pseudocode: `viable = [(s, a) for s, a in applicability if a.score >= 0.3]`.
 */
export const VIABILITY_THRESHOLD = 0.3;

/**
 * One entry in the router's output — the tuple-of-three from the design's
 * pseudocode flattened into a record so callers don't index by position.
 *
 * @typedef {Object} RouterSelection
 * @property {Strategy}      strategy
 * @property {number}        quota
 * @property {Applicability} applicability
 */

/**
 * One entry in the router's `skipped` output — strategies that ran
 * `applies_to` but failed the viability threshold. Surfaces in
 * `Diagnostics.strategies_skipped` so the caller can see *why* a
 * strategy didn't fire.
 *
 * @typedef {Object} RouterSkip
 * @property {StrategyName} name
 * @property {number}       score
 * @property {string}       reason
 */

/**
 * @typedef {Object} RouterResult
 * @property {RouterSelection[]} viable     Selected strategies with quota.
 * @property {RouterSkip[]}      skipped    Below-threshold strategies with their reasons.
 * @property {boolean}           usedFallback True when the fallback Semantic path was taken.
 */

/**
 * Defensive: pull a finite numeric score from an `Applicability`, or 0
 * if absent / non-finite. Lets a misbehaving strategy degrade to
 * "skipped" instead of throwing.
 *
 * @param {Applicability|null|undefined} a
 * @returns {number}
 */
function safeScore(a) {
    if (!a) return 0;
    const n = Number(a.score);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Defensive reason extraction — empty string if absent.
 *
 * @param {Applicability|null|undefined} a
 * @returns {string}
 */
function safeReason(a) {
    if (!a) return '';
    return typeof a.reason === 'string' ? a.reason : '';
}

/**
 * Select strategies and their quotas for the given request. Pure: same
 * `(strategies, req)` produces the same `RouterResult` modulo whatever
 * randomness lives inside the strategies' `applies_to` (none today).
 *
 * @param {Strategy[]} strategies
 * @param {RetrievalRequest} req
 * @param {Object} [opts]
 * @param {number} [opts.totalQuota]    Override `DEFAULT_TOTAL_QUOTA` (tests).
 * @param {number} [opts.fallbackQuota] Override `DEFAULT_FALLBACK_QUOTA` (tests).
 * @returns {RouterResult}
 */
export function selectStrategies(strategies, req, opts = {}) {
    const totalQuota = Number.isFinite(opts.totalQuota) && /** @type {number} */ (opts.totalQuota) > 0
        ? /** @type {number} */ (opts.totalQuota)
        : DEFAULT_TOTAL_QUOTA;
    const fallbackQuota = Number.isFinite(opts.fallbackQuota) && /** @type {number} */ (opts.fallbackQuota) > 0
        ? /** @type {number} */ (opts.fallbackQuota)
        : DEFAULT_FALLBACK_QUOTA;

    if (!Array.isArray(strategies) || strategies.length === 0) {
        return { viable: [], skipped: [], usedFallback: false };
    }

    /** @type {Array<{strategy: Strategy, applicability: Applicability}>} */
    const probed = [];
    for (const s of strategies) {
        if (!s || typeof s.applies_to !== 'function') continue;
        let a;
        try {
            a = s.applies_to(req);
        } catch {
            a = { score: 0, reason: 'applies_to threw' };
        }
        if (!a) a = { score: 0, reason: 'applies_to returned null' };
        probed.push({ strategy: s, applicability: a });
    }

    /** @type {RouterSkip[]} */
    const skipped = [];
    /** @type {Array<{strategy: Strategy, applicability: Applicability}>} */
    const viableProbes = [];

    for (const p of probed) {
        const score = safeScore(p.applicability);
        if (score >= VIABILITY_THRESHOLD) {
            viableProbes.push(p);
        } else {
            skipped.push({ name: p.strategy.name, score, reason: safeReason(p.applicability) || 'below viability threshold' });
        }
    }

    if (viableProbes.length === 0) {
        const sem = strategies.find((s) => s && s.name === 'semantic');
        if (sem) {
            return {
                viable: [{
                    strategy: sem,
                    quota: fallbackQuota,
                    applicability: { score: 0.5, reason: 'fallback' },
                }],
                skipped,
                usedFallback: true,
            };
        }
        return { viable: [], skipped, usedFallback: false };
    }

    const totalScore = viableProbes.reduce((acc, p) => acc + safeScore(p.applicability), 0);
    /** @type {RouterSelection[]} */
    const viable = [];
    for (const p of viableProbes) {
        const share = safeScore(p.applicability) / totalScore;
        const quota = Math.max(1, Math.floor(totalQuota * share));
        viable.push({ strategy: p.strategy, quota, applicability: p.applicability });
    }
    return { viable, skipped, usedFallback: false };
}
