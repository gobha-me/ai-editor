// @ts-check
/**
 * Budget threshold helpers — pure, no IO.
 *
 * Soft warnings only. Per ROADMAP §1.2.1 (Decision §8 measurement-
 * before-scale), 1.2.1 surfaces budget pressure but never blocks a
 * request. Hard halts can revisit if the dashboard data shows demand.
 *
 * @module intelligence/cost/budget
 */

/** @typedef {'ok'|'warn'|'over'} BudgetLevel */

export const WARN_THRESHOLD = 0.80;
export const OVER_THRESHOLD = 1.00;

/**
 * @typedef {Object} ThresholdResult
 * @property {BudgetLevel} level
 * @property {number}      percent     0..1+ (over 1 means past cap).
 * @property {number|null} cap         Echoed back; null if no cap configured.
 * @property {number}      spend       Echoed back.
 */

/**
 * @param {number}       spend
 * @param {number|null}  cap
 * @returns {ThresholdResult}
 */
export function checkThresholds(spend, cap) {
    if (cap == null || cap <= 0) {
        return { level: 'ok', percent: 0, cap: null, spend };
    }
    const percent = spend / cap;
    /** @type {BudgetLevel} */
    let level = 'ok';
    if (percent >= OVER_THRESHOLD) level = 'over';
    else if (percent >= WARN_THRESHOLD) level = 'warn';
    return { level, percent, cap, spend };
}

/**
 * Returns the most-pressing level when both daily and monthly caps are
 * checked. `over` beats `warn` beats `ok`. The reason string identifies
 * which window tripped, for the banner copy.
 *
 * @param {{daily: ThresholdResult, monthly: ThresholdResult}} checks
 * @returns {{level: BudgetLevel, reason: 'daily'|'monthly'|null, percent: number, cap: number|null, spend: number}}
 */
export function pickWorse(checks) {
    const order = { ok: 0, warn: 1, over: 2 };
    const d = checks.daily;
    const m = checks.monthly;
    const winner = order[m.level] > order[d.level] ? { which: 'monthly', r: m } : { which: 'daily', r: d };
    return {
        level: winner.r.level,
        reason: winner.r.level === 'ok' ? null : /** @type {'daily'|'monthly'} */ (winner.which),
        percent: winner.r.percent,
        cap: winner.r.cap,
        spend: winner.r.spend,
    };
}
