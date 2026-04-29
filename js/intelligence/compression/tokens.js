// @ts-check
/**
 * Cheap token estimation for compression budget math.
 *
 * Per `docs/DESIGN-compression.md` §"Core Contracts" the canonical Turn
 * carries a precomputed `tokens` field "for the target tokenizer family."
 * Phase 1 uses a `chars / 3.5` heuristic — same denominator the existing
 * `js/chat/summarizer.js` uses for `maxTokens` math, so the two layers
 * agree on cost without precomputation infrastructure.
 *
 * Precomputation at turn ingest is a Phase-2 optimization: profile this
 * first against real session data via the 1.2.1 cost dashboard before
 * adding the plumbing.
 *
 * @module intelligence/compression/tokens
 */

/**
 * Heuristic divisor. Conservative — leans high so the budget check
 * triggers on the safe side. Documented constant; not a tunable.
 */
export const CHARS_PER_TOKEN = 3.5;

/**
 * Estimate token count for arbitrary content. Strings are measured
 * directly; objects are JSON-stringified first; null/undefined return 0.
 *
 * @param {*} content
 * @returns {number}
 */
export function estimateTokens(content) {
    if (content == null) return 0;
    if (typeof content === 'string') {
        return Math.ceil(content.length / CHARS_PER_TOKEN);
    }
    // Numbers, bigints, booleans — convert to string.
    if (typeof content !== 'object') {
        return Math.ceil(String(content).length / CHARS_PER_TOKEN);
    }
    // Objects/arrays — stringify. Defensive against circular refs.
    let serialized;
    try {
        serialized = JSON.stringify(content);
    } catch {
        // Circular or non-serializable. Use Object.keys as a rough fallback.
        try {
            serialized = Object.keys(content).join(',');
        } catch {
            return 0;
        }
    }
    return Math.ceil((serialized?.length || 0) / CHARS_PER_TOKEN);
}

/**
 * Sum the `tokens` field across a Turn array. Used by Compactor budget
 * checks. Skips entries with non-numeric `tokens` (caller bug, not a
 * runtime crash).
 *
 * @param {Array<{tokens?: number}>} turns
 * @returns {number}
 */
export function sumTokens(turns) {
    if (!Array.isArray(turns)) return 0;
    let total = 0;
    for (const t of turns) {
        if (t && typeof t.tokens === 'number' && Number.isFinite(t.tokens)) {
            total += t.tokens;
        }
    }
    return total;
}
