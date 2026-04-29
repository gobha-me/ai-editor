// @ts-check
/**
 * Rule 2 — Invalidation.
 *
 * **Trigger:** A later turn modifies bytes that an earlier turn read.
 *
 * **Decision:** `Drop` the earlier read with reason
 * `"invalidated_by:{B.id}"`.
 *
 * **Cost:** Free (range-overlap check).
 *
 * **Applicability:** Requires `file_ops` metadata. Most useful in coder
 * profiles. Per `docs/DESIGN-compression.md` §"Rule 2: Invalidation".
 *
 * **Algorithm:**
 *   For each candidate turn A with `FileOp(read, P, R_A)`, scan forward
 *   for a turn B with `FileOp(write|edit, P, R_B)` such that
 *   `R_A ∩ R_B ≠ ∅`. On match: `Drop(A)`. Otherwise: `Keep(A)`.
 *
 * **Edge cases (per DESIGN):**
 *   - A *failed* write does not invalidate prior reads. The 1.1.0 turn-
 *     enrich layer (`js/chat/turn-enrich.js`) returns `file_ops: []` for
 *     errored tool results, so the rule never sees them. No special
 *     handling needed here.
 *   - A read of file `Q` is unaffected by writes to file `P` — path
 *     equality is required.
 *   - A read of `P` *after* the write of `P` is the new authoritative
 *     view; this rule scans forward only, so post-write reads survive.
 *
 * **Range overlap semantics:**
 *   - Either side `null` (full file) → overlaps anything on the same path.
 *     A `write_file` produces `range: null` (whole-file rewrite),
 *     correctly invalidating any read of that path.
 *   - Both `[a, b]`: overlap iff `max(a1, b1) ≤ min(a2, b2)`.
 *
 * **Phase-1 conservative scope:** mirrors Rule 1 — only single-op file
 * reads are evaluated as candidates. Multi-path search results pass
 * through.
 *
 * @module intelligence/compression/rules/invalidation
 */

import { Keep, Drop } from '../decisions.js';

/**
 * @typedef {import('../contracts.js').Turn}            Turn
 * @typedef {import('../contracts.js').Decision}        Decision
 * @typedef {import('../contracts.js').CompressionRule} CompressionRule
 * @typedef {import('../contracts.js').FileOp}          FileOp
 */

/**
 * Rule priority — Invalidation runs after Subsumption (Rule 1, priority
 * 10). When both rules would drop the same turn, Subsumption's reason
 * wins per DESIGN-compression.md §"Pipeline Algorithm" ("first non-Keep
 * decision wins").
 */
export const INVALIDATION_PRIORITY = 20;

/**
 * Do `r1` and `r2` overlap? Either being `null` (full file) overlaps
 * anything on the same path. Both must be 2-element numeric tuples
 * otherwise.
 *
 * @param {[number, number]|null} r1
 * @param {[number, number]|null} r2
 * @returns {boolean}
 */
export function rangesOverlap(r1, r2) {
    if (r1 === null || r1 === undefined) return true;
    if (r2 === null || r2 === undefined) return true;
    if (!Array.isArray(r1) || r1.length !== 2) return false;
    if (!Array.isArray(r2) || r2.length !== 2) return false;
    const [a1, a2] = r1;
    const [b1, b2] = r2;
    if (typeof a1 !== 'number' || typeof a2 !== 'number') return false;
    if (typeof b1 !== 'number' || typeof b2 !== 'number') return false;
    return Math.max(a1, b1) <= Math.min(a2, b2);
}

/**
 * Phase-1 applicability gate — same as Rule 1: tool-result with exactly
 * one `read` file-op.
 *
 * @param {Turn} turn
 * @returns {FileOp|null}
 */
function singleReadOp(turn) {
    if (!turn || turn.role !== 'tool_result') return null;
    const ops = turn.metadata && turn.metadata.file_ops;
    if (!Array.isArray(ops) || ops.length !== 1) return null;
    const op = ops[0];
    if (!op || op.op !== 'read' || typeof op.path !== 'string') return null;
    return op;
}

/**
 * Evaluate a single turn against the rest of history.
 *
 * @param {Turn}   turn
 * @param {Turn[]} history
 * @returns {Decision}
 */
export function evaluate(turn, history) {
    const a_op = singleReadOp(turn);
    if (!a_op) return Keep();

    if (!Array.isArray(history) || history.length === 0) return Keep();

    const aIdx = history.indexOf(turn);
    if (aIdx === -1) return Keep();

    const a_path = a_op.path;
    const a_range = a_op.range;

    for (let bIdx = aIdx + 1; bIdx < history.length; bIdx++) {
        const b = history[bIdx];
        const b_ops = b && b.metadata && b.metadata.file_ops;
        if (!Array.isArray(b_ops) || b_ops.length === 0) continue;

        for (const op of b_ops) {
            if (!op || op.path !== a_path) continue;
            if ((op.op === 'write' || op.op === 'edit') &&
                rangesOverlap(a_range, op.range)) {
                return Drop(`invalidated_by:${b.id}`);
            }
        }
    }

    return Keep();
}

/** @type {CompressionRule} */
export const INVALIDATION_RULE = {
    name: 'invalidation',
    priority: INVALIDATION_PRIORITY,
    evaluate,
};
