// @ts-check
/**
 * In-flight state for the PR Review "Diagnose & fix" action.
 *
 * Keyed by PR number — multiple PRs in the same session can each have
 * their own pending diagnose proposal independently. Lives outside
 * `review-state.js` because that module's charter is per-PR persisted
 * UI state (drafts, viewed-set, resolvedLocal) — diagnose proposals
 * are transient in-flight values that don't survive a reload.
 *
 * Pure module — browser-free, node-test friendly.
 *
 * @since 2.14.0
 * @module pr-review/diagnose-state
 */

/**
 * @typedef {{
 *   path: string,
 *   newContent: string,
 *   originalContent: string|null,
 *   rationale: string,
 *   jobNames: string[],
 *   createdAt: number
 * }} DiagnosePending
 */

/** @type {Map<number, DiagnosePending>} */
const pendingByPr = new Map();

/**
 * @param {number} prNumber
 * @returns {DiagnosePending|null}
 */
export function getPending(prNumber) {
    if (typeof prNumber !== 'number') return null;
    return pendingByPr.get(prNumber) || null;
}

/**
 * @param {number} prNumber
 * @param {DiagnosePending} payload
 */
export function setPending(prNumber, payload) {
    if (typeof prNumber !== 'number') return;
    pendingByPr.set(prNumber, payload);
}

/**
 * @param {number} prNumber
 */
export function clearPending(prNumber) {
    if (typeof prNumber !== 'number') return;
    pendingByPr.delete(prNumber);
}

/** Test-only: zero the map. */
export function _resetForTests() {
    pendingByPr.clear();
}
