// @ts-check
/**
 * Rule 1 — Subsumption.
 *
 * **Trigger:** A later turn's payload strictly contains an earlier turn's
 * payload (file-read case in Phase 1).
 *
 * **Decision:** `Drop` the earlier turn with reason `"subsumed_by:{B.id}"`.
 *
 * **Cost:** Free (range comparison).
 *
 * **Applicability:** Requires `file_ops` metadata. A pure-prose
 * conversation passes through with no decisions. Per
 * `docs/DESIGN-compression.md` §"Rule 1: Subsumption".
 *
 * **Algorithm (file-read case):**
 *   For a candidate turn A with a single `FileOp(read, P, R_A)`, scan
 *   forward in history for a turn B such that:
 *     - B has `FileOp(read, P, R_B)` and `R_B ⊇ R_A`, **and**
 *     - No turn between A and B has `FileOp(write|edit, P)` (intervening
 *       writes invalidate the subsumption — defer to Rule 2).
 *   On match: `Drop(A)`. Otherwise: `Keep(A)`.
 *
 * **Phase-1 conservative scope:** the rule only fires for turns whose
 * `file_ops` is exactly one read op. Multi-path search results
 * (`find_references`, `search_in_files`) emit N file-ops with `range:
 * null`; subsuming those would require result-content identity, not just
 * path equality. Pass through for now; revisit when 1.2.x measurement
 * data shows real demand.
 *
 * **Range semantics:**
 *   - `range: null` = full file. A null outer range contains anything;
 *     a null inner range cannot be contained by a partial outer.
 *   - `[a, b]` ranges contain `[c, d]` iff `a ≤ c` AND `b ≥ d`. Equality
 *     counts as containment per the strict superset reading of "⊇".
 *
 * @module intelligence/compression/rules/subsumption
 */

import { Keep, Drop } from '../decisions.js';

/**
 * @typedef {import('../contracts.js').Turn}            Turn
 * @typedef {import('../contracts.js').Decision}        Decision
 * @typedef {import('../contracts.js').CompressionRule} CompressionRule
 * @typedef {import('../contracts.js').FileOp}          FileOp
 */

/**
 * Rule priority — Subsumption runs first (lowest priority value).
 * Invalidation registers at 20, Resolution at 30, Summarization at 50.
 */
export const SUBSUMPTION_PRIORITY = 10;

/**
 * Does `outer` contain `inner`?
 * - null outer: full file → contains anything (returns true).
 * - null inner with non-null outer: full-file read cannot fit inside a
 *   partial-range read (returns false).
 * - Both ranges: true iff `outer[0] ≤ inner[0]` AND `outer[1] ≥ inner[1]`.
 *
 * @param {[number, number]|null} outer
 * @param {[number, number]|null} inner
 * @returns {boolean}
 */
export function rangeContains(outer, inner) {
    if (outer === null || outer === undefined) return true;
    if (inner === null || inner === undefined) return false;
    if (!Array.isArray(outer) || outer.length !== 2) return false;
    if (!Array.isArray(inner) || inner.length !== 2) return false;
    const [o1, o2] = outer;
    const [i1, i2] = inner;
    if (typeof o1 !== 'number' || typeof o2 !== 'number') return false;
    if (typeof i1 !== 'number' || typeof i2 !== 'number') return false;
    return o1 <= i1 && o2 >= i2;
}

/**
 * Phase-1 applicability gate: tool-result turn with exactly one `read`
 * file-op. Returns the lone read op or `null`.
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
 * Evaluate a single turn against the rest of history. Pure: same
 * `(turn, history)` always returns the same decision.
 *
 * @param {Turn}   turn
 * @param {Turn[]} history
 * @returns {Decision}
 */
export function evaluate(turn, history) {
    const a_op = singleReadOp(turn);
    if (!a_op) return Keep();

    if (!Array.isArray(history) || history.length === 0) return Keep();

    // Locate A's position. We use identity comparison — Compactor passes
    // the same Turn references it built once at entry.
    const aIdx = history.indexOf(turn);
    if (aIdx === -1) return Keep();

    const a_path = a_op.path;
    const a_range = a_op.range;

    // Scan forward. For each later turn B:
    //   - If B has any write/edit on `a_path` → intervening write,
    //     subsumption no longer applies; defer to Rule 2.
    //   - If B has a read on `a_path` whose range contains A's range
    //     (and no intervening write happened) → drop A.
    // Both checks evaluate within the SAME later turn before declaring
    // a verdict, so a hypothetical multi-op turn that both edits and
    // re-reads is handled conservatively (the edit wins).
    for (let bIdx = aIdx + 1; bIdx < history.length; bIdx++) {
        const b = history[bIdx];
        const b_ops = b && b.metadata && b.metadata.file_ops;
        if (!Array.isArray(b_ops) || b_ops.length === 0) continue;

        let hasInterveningWrite = false;
        let subsumingReadId = null;

        for (const op of b_ops) {
            if (!op || op.path !== a_path) continue;
            if (op.op === 'write' || op.op === 'edit') {
                hasInterveningWrite = true;
            } else if (op.op === 'read' && rangeContains(op.range, a_range)) {
                subsumingReadId = b.id;
            }
        }

        if (hasInterveningWrite) return Keep();
        if (subsumingReadId) return Drop(`subsumed_by:${subsumingReadId}`);
    }

    return Keep();
}

/** @type {CompressionRule} */
export const SUBSUMPTION_RULE = {
    name: 'subsumption',
    priority: SUBSUMPTION_PRIORITY,
    evaluate,
};
