// @ts-check
/**
 * Pure cadence math for the PR Review CI polling effect.
 *
 * Extracted as a separate module so node tests can exercise the math
 * without pulling in `PrReviewSurface.js` (which uses top-level
 * `await getPreact()` and is browser-only).
 *
 * @since 2.13.2
 * @module pr-review/poll-cadence
 */

/** First-burst window (ms) at the fast cadence. */
export const POLL_FAST_WINDOW_MS = 120_000;

/** Fast cadence — used during the first window after the surface mounts. */
export const POLL_FAST_INTERVAL_MS = 10_000;

/** Slow cadence — used after the fast window elapses. */
export const POLL_SLOW_INTERVAL_MS = 30_000;

/**
 * Compute the delay (ms) until the next poll given how long we've
 * already been polling. 10s for the first 2 minutes, 30s after.
 *
 * @param {number} elapsedMs — ms since the surface started polling
 * @returns {number}
 */
export function nextPollDelay(elapsedMs) {
    if (typeof elapsedMs !== 'number' || elapsedMs < 0 || !Number.isFinite(elapsedMs)) {
        return POLL_FAST_INTERVAL_MS;
    }
    return elapsedMs < POLL_FAST_WINDOW_MS ? POLL_FAST_INTERVAL_MS : POLL_SLOW_INTERVAL_MS;
}

/**
 * Whether the surface should be polling CI for the given PR + CI state.
 * Pulled out so tests can pin the trigger contract.
 *
 * @param {{state?:string, merged?:boolean}|null|undefined} pr
 * @param {{state?:string}|null|undefined} ci
 * @returns {boolean}
 */
export function shouldPoll(pr, ci) {
    if (!pr || !ci) return false;
    if (pr.state !== 'open') return false;
    if (pr.merged) return false;
    return ci.state === 'pending';
}

/**
 * Whether a CI state is terminal — i.e. polling should stop.
 *
 * @param {string|undefined|null} state
 * @returns {boolean}
 */
export function isTerminal(state) {
    return state === 'success' || state === 'failure' || state === 'error';
}
