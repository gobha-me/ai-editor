/**
 * Tests for compression rules — pure-function, file-ops-driven.
 *
 * Runs under `node --test`. Rules consume Turn[] (from
 * js/intelligence/compression/turn-store.js) and return Decisions; no
 * Storage/DOM/network access.
 *
 * Phase 1 coverage:
 *   - Rule 1 (Subsumption) — single-op file-read containment
 *   - Rule 2 (Invalidation) — added in Commit 3
 *   - Combined Rule 1 + 2 fixtures — added in Commit 3
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    SUBSUMPTION_RULE,
    SUBSUMPTION_PRIORITY,
    rangeContains,
    evaluate as subsumptionEvaluate,
} from '../js/intelligence/compression/rules/subsumption.js';
import {
    INVALIDATION_RULE,
    INVALIDATION_PRIORITY,
    rangesOverlap,
    evaluate as invalidationEvaluate,
} from '../js/intelligence/compression/rules/invalidation.js';
import { isKeep, isDrop } from '../js/intelligence/compression/index.js';

// ============================================
// Test fixture helpers
// ============================================

let _seq = 0;
function mkTurn(role, content, metadata) {
    const id = `T${_seq++}`;
    return { id, role, content: content || '', tokens: 1, timestamp: _seq, metadata: metadata || {} };
}

function mkRead(path, range) {
    _seq = _seq; // hold seq stable in caller
    return mkTurn('tool_result', `read ${path}`, {
        tool_name: 'read_lines',
        file_ops: [{ path, op: 'read', range, content_hash: null }],
    });
}

function mkEdit(path, range) {
    return mkTurn('tool_result', `edit ${path}`, {
        tool_name: 'edit_file',
        file_ops: [{ path, op: 'edit', range, content_hash: null }],
    });
}

function mkWrite(path) {
    return mkTurn('tool_result', `write ${path}`, {
        tool_name: 'write_file',
        file_ops: [{ path, op: 'write', range: null, content_hash: null }],
    });
}

function mkUser(text) {
    return mkTurn('user', text, {});
}

// Reset sequence between independent fixture builds.
function resetSeq() { _seq = 0; }

// ============================================
// rangeContains — primitive
// ============================================

test('rangeContains — null outer covers anything', () => {
    assert.equal(rangeContains(null, [10, 20]), true);
    assert.equal(rangeContains(null, null), true);
});

test('rangeContains — null inner with non-null outer is false', () => {
    assert.equal(rangeContains([1, 100], null), false);
});

test('rangeContains — strict superset including equality', () => {
    assert.equal(rangeContains([10, 20], [10, 20]), true,  'equality counts');
    assert.equal(rangeContains([5, 30],  [10, 20]), true,  'strict superset');
    assert.equal(rangeContains([10, 19], [10, 20]), false, 'short by one');
    assert.equal(rangeContains([11, 20], [10, 20]), false, 'starts late');
    assert.equal(rangeContains([1, 5],   [10, 20]), false, 'no overlap');
});

test('rangeContains — malformed input returns false, never throws', () => {
    assert.equal(rangeContains([1], [2, 3]), false);
    assert.equal(rangeContains(['a', 'b'], [1, 2]), false);
    assert.equal(rangeContains({}, []), false);
});

// ============================================
// Rule 1 — basic subsumption
// ============================================

test('Rule 1 priority is the lowest (runs first)', () => {
    assert.equal(SUBSUMPTION_PRIORITY, 10);
    assert.equal(SUBSUMPTION_RULE.name, 'subsumption');
    assert.equal(SUBSUMPTION_RULE.priority, 10);
});

test('Rule 1 — A=[10,20] subsumed by B=[5,30] same path → Drop', () => {
    resetSeq();
    const a = mkRead('style.css', [10, 20]);
    const b = mkRead('style.css', [5, 30]);
    const history = [a, b];

    const decA = subsumptionEvaluate(a, history);
    assert.ok(isDrop(decA), 'A should be dropped');
    assert.equal(decA.reason, `subsumed_by:${b.id}`);

    const decB = subsumptionEvaluate(b, history);
    assert.ok(isKeep(decB), 'B should be kept (no later turn subsumes it)');
});

test('Rule 1 — equal ranges count as subsumption (same bytes)', () => {
    resetSeq();
    const a = mkRead('style.css', [10, 20]);
    const b = mkRead('style.css', [10, 20]);
    const dec = subsumptionEvaluate(a, [a, b]);
    assert.ok(isDrop(dec));
    assert.equal(dec.reason, `subsumed_by:${b.id}`);
});

test('Rule 1 — non-overlapping reads pass through (Keep)', () => {
    resetSeq();
    const a = mkRead('map.js', [10, 20]);
    const b = mkRead('map.js', [100, 200]);
    assert.ok(isKeep(subsumptionEvaluate(a, [a, b])), 'A keeps — B is unrelated region');
    assert.ok(isKeep(subsumptionEvaluate(b, [a, b])), 'B keeps — nothing later');
});

test('Rule 1 — different paths never subsume', () => {
    resetSeq();
    const a = mkRead('a.js', [10, 20]);
    const b = mkRead('b.js', [5, 30]);
    assert.ok(isKeep(subsumptionEvaluate(a, [a, b])));
});

// ============================================
// Rule 1 — intervening writes block subsumption
// ============================================

test('Rule 1 — intervening write on same path blocks subsumption (defer to Rule 2)', () => {
    resetSeq();
    const a = mkRead('style.css', [10, 20]);
    const w = mkWrite('style.css');
    const b = mkRead('style.css', [5, 30]);
    assert.ok(
        isKeep(subsumptionEvaluate(a, [a, w, b])),
        'intervening write means B describes different content than A read'
    );
});

test('Rule 1 — intervening edit on same path also blocks subsumption', () => {
    resetSeq();
    const a = mkRead('style.css', [10, 20]);
    const e = mkEdit('style.css', [12, 18]);
    const b = mkRead('style.css', [5, 30]);
    assert.ok(isKeep(subsumptionEvaluate(a, [a, e, b])));
});

test('Rule 1 — write on a different path does NOT block subsumption', () => {
    resetSeq();
    const a = mkRead('style.css', [10, 20]);
    const w = mkWrite('other.js');
    const b = mkRead('style.css', [5, 30]);
    const dec = subsumptionEvaluate(a, [a, w, b]);
    assert.ok(isDrop(dec));
    assert.equal(dec.reason, `subsumed_by:${b.id}`);
});

// ============================================
// Rule 1 — null-range (full file) cases
// ============================================

test('Rule 1 — full-file read subsumes a partial range read on same path', () => {
    resetSeq();
    const a = mkRead('config.js', [10, 20]);
    const b = mkRead('config.js', null); // scan_file or read_file
    const dec = subsumptionEvaluate(a, [a, b]);
    assert.ok(isDrop(dec));
    assert.equal(dec.reason, `subsumed_by:${b.id}`);
});

test('Rule 1 — partial range read does NOT subsume a full-file read', () => {
    resetSeq();
    const a = mkRead('config.js', null);
    const b = mkRead('config.js', [10, 20]);
    assert.ok(isKeep(subsumptionEvaluate(a, [a, b])));
});

test('Rule 1 — full-file read subsumes another full-file read on same path', () => {
    resetSeq();
    const a = mkRead('config.js', null);
    const b = mkRead('config.js', null);
    const dec = subsumptionEvaluate(a, [a, b]);
    assert.ok(isDrop(dec));
    assert.equal(dec.reason, `subsumed_by:${b.id}`);
});

// ============================================
// Rule 1 — Phase 1 conservative scope
// ============================================

test('Rule 1 — multi-path search results pass through (Phase 1 scope)', () => {
    resetSeq();
    const search = mkTurn('tool_result', 'search results', {
        tool_name: 'search_in_files',
        file_ops: [
            { path: 'a.js', op: 'read', range: null, content_hash: null },
            { path: 'b.js', op: 'read', range: null, content_hash: null },
            { path: 'c.js', op: 'read', range: null, content_hash: null },
        ],
    });
    const fullA = mkRead('a.js', null);
    assert.ok(isKeep(subsumptionEvaluate(search, [search, fullA])));
});

test('Rule 1 — non-tool_result turns pass through (user/assistant/system)', () => {
    resetSeq();
    const u = mkUser('hello');
    const a = mkTurn('assistant', 'hi', {});
    const s = mkTurn('system', 'sys', {});
    assert.ok(isKeep(subsumptionEvaluate(u, [u, a, s])));
    assert.ok(isKeep(subsumptionEvaluate(a, [u, a, s])));
    assert.ok(isKeep(subsumptionEvaluate(s, [u, a, s])));
});

test('Rule 1 — turn missing file_ops metadata returns Keep (no error)', () => {
    resetSeq();
    const t = mkTurn('tool_result', 'orphan', {}); // no file_ops at all
    assert.ok(isKeep(subsumptionEvaluate(t, [t])));
});

test('Rule 1 — turn with empty file_ops array returns Keep', () => {
    resetSeq();
    const t = mkTurn('tool_result', 'empty', { file_ops: [] });
    assert.ok(isKeep(subsumptionEvaluate(t, [t])));
});

test('Rule 1 — edit op (not read) is not a subsumption candidate', () => {
    resetSeq();
    const e = mkEdit('a.js', [10, 20]);
    const r = mkRead('a.js', null);
    // Edits are never subsumed by reads — they describe different actions.
    assert.ok(isKeep(subsumptionEvaluate(e, [e, r])));
});

test('Rule 1 — turn not in history returns Keep', () => {
    resetSeq();
    const orphan = mkRead('x.js', [1, 5]);
    const inHistory = mkRead('x.js', [1, 100]);
    assert.ok(isKeep(subsumptionEvaluate(orphan, [inHistory])));
});

// ============================================
// Rule 1 — DESIGN-compression.md §"Worked Example" anchor
// ============================================

test('Rule 1 — worked example T1 ⊂ T2 (style.css L150-165 ⊂ L150-290)', () => {
    resetSeq();
    const t1 = mkRead('style.css', [150, 165]);
    const t2 = mkRead('style.css', [150, 290]);
    const dec = subsumptionEvaluate(t1, [t1, t2]);
    assert.ok(isDrop(dec));
    assert.equal(dec.reason, `subsumed_by:${t2.id}`);
});

// ============================================
// rangesOverlap — primitive
// ============================================

test('rangesOverlap — null on either side overlaps anything', () => {
    assert.equal(rangesOverlap(null, [10, 20]), true);
    assert.equal(rangesOverlap([10, 20], null), true);
    assert.equal(rangesOverlap(null, null), true);
});

test('rangesOverlap — disjoint ranges do not overlap', () => {
    assert.equal(rangesOverlap([1, 5], [10, 20]), false);
    assert.equal(rangesOverlap([100, 200], [50, 99]), false);
});

test('rangesOverlap — touching at endpoint counts as overlap', () => {
    // [1,10] and [10,20] share point 10.
    assert.equal(rangesOverlap([1, 10], [10, 20]), true);
});

test('rangesOverlap — strict containment overlaps', () => {
    assert.equal(rangesOverlap([5, 30], [10, 20]), true);
    assert.equal(rangesOverlap([10, 20], [10, 20]), true);
});

test('rangesOverlap — partial overlap', () => {
    assert.equal(rangesOverlap([10, 20], [15, 30]), true);
    assert.equal(rangesOverlap([15, 30], [10, 20]), true);
});

test('rangesOverlap — malformed input returns false, never throws', () => {
    assert.equal(rangesOverlap([1], [10, 20]), false);
    assert.equal(rangesOverlap('foo', 'bar'), false);
    assert.equal(rangesOverlap({}, [10, 20]), false);
});

// ============================================
// Rule 2 — basic invalidation
// ============================================

test('Rule 2 priority is higher than Rule 1 (runs second)', () => {
    assert.equal(INVALIDATION_PRIORITY, 20);
    assert.ok(INVALIDATION_PRIORITY > SUBSUMPTION_PRIORITY);
    assert.equal(INVALIDATION_RULE.name, 'invalidation');
});

test('Rule 2 — A=read[10,20] invalidated by B=edit[15,30] same path → Drop', () => {
    resetSeq();
    const a = mkRead('a.js', [10, 20]);
    const b = mkEdit('a.js', [15, 30]);
    const dec = invalidationEvaluate(a, [a, b]);
    assert.ok(isDrop(dec));
    assert.equal(dec.reason, `invalidated_by:${b.id}`);
});

test('Rule 2 — non-overlapping read and edit on same path → Keep', () => {
    resetSeq();
    const a = mkRead('a.js', [10, 20]);
    const b = mkEdit('a.js', [100, 200]);
    assert.ok(isKeep(invalidationEvaluate(a, [a, b])));
});

test('Rule 2 — write (full file) invalidates any read on same path', () => {
    resetSeq();
    const a = mkRead('a.js', [10, 20]);
    const w = mkWrite('a.js'); // range: null
    const dec = invalidationEvaluate(a, [a, w]);
    assert.ok(isDrop(dec));
    assert.equal(dec.reason, `invalidated_by:${w.id}`);
});

test('Rule 2 — full-file read invalidated by any edit on same path', () => {
    resetSeq();
    const a = mkRead('a.js', null); // scan_file
    const b = mkEdit('a.js', [50, 60]);
    const dec = invalidationEvaluate(a, [a, b]);
    assert.ok(isDrop(dec));
});

test('Rule 2 — different paths never invalidate', () => {
    resetSeq();
    const a = mkRead('a.js', [10, 20]);
    const b = mkEdit('b.js', [10, 20]);
    assert.ok(isKeep(invalidationEvaluate(a, [a, b])));
});

test('Rule 2 — read AFTER write survives (rule scans forward only)', () => {
    resetSeq();
    const w = mkEdit('a.js', [10, 20]);
    const a = mkRead('a.js', [5, 30]);
    // Only later writes invalidate. A is post-W; nothing after A → Keep.
    assert.ok(isKeep(invalidationEvaluate(a, [w, a])));
});

test('Rule 2 — failed write produces no file_ops, so cannot invalidate', () => {
    resetSeq();
    const a = mkRead('a.js', [10, 20]);
    // Simulate a tool result with no file_ops (matches turn-enrich behavior on errors).
    const failed = mkTurn('tool_result', 'edit failed', { file_ops: [] });
    assert.ok(isKeep(invalidationEvaluate(a, [a, failed])));
});

test('Rule 2 — non-tool_result turns / missing metadata pass through', () => {
    resetSeq();
    const u = mkUser('hi');
    const a = mkTurn('assistant', 'sure', {});
    assert.ok(isKeep(invalidationEvaluate(u, [u, a])));
    assert.ok(isKeep(invalidationEvaluate(a, [u, a])));
});

test('Rule 2 — endpoint-touching range counts as invalidating overlap', () => {
    resetSeq();
    // Read [1,10], edit [10,20] — they share line 10, so the read sees stale data.
    const a = mkRead('a.js', [1, 10]);
    const b = mkEdit('a.js', [10, 20]);
    assert.ok(isDrop(invalidationEvaluate(a, [a, b])));
});

// ============================================
// Combined Rule 1 + Rule 2 fixtures
// ============================================

test('Combined — Rule 1 (Subsumption) and Rule 2 (Invalidation) can both fire on the same turn', () => {
    resetSeq();
    // T1 read [10,20], T2 read [5,30] (subsumes T1), T3 edit [12,18] (invalidates T1 AND T2)
    const t1 = mkRead('a.js', [10, 20]);
    const t2 = mkRead('a.js', [5, 30]);
    const t3 = mkEdit('a.js', [12, 18]);
    const history = [t1, t2, t3];

    // Rule 1 alone on T1: hits intervening writes? No — t2 is also a read, so subsumption fires.
    // BUT: t3 is later than t2 and writes/edits. The Rule-1 algorithm scans forward and aborts
    // if it encounters a write/edit on the path BEFORE finding a subsuming read. Here t2 (read,
    // wider) appears first, so Rule 1 returns Drop(subsumed_by:t2).
    const dec1_t1 = subsumptionEvaluate(t1, history);
    assert.ok(isDrop(dec1_t1));
    assert.equal(dec1_t1.reason, `subsumed_by:${t2.id}`);

    // Rule 2 on T1: edit at [12,18] overlaps T1's [10,20] → Drop.
    const dec2_t1 = invalidationEvaluate(t1, history);
    assert.ok(isDrop(dec2_t1));
    assert.equal(dec2_t1.reason, `invalidated_by:${t3.id}`);

    // Compactor's "first non-Keep wins" gives Rule 1's reason for T1 (priority 10 < 20).
    // Both rules independently agree on dropping; only the reason differs.

    // T2 on Rule 1: no later read subsumes → Keep.
    assert.ok(isKeep(subsumptionEvaluate(t2, history)));
    // T2 on Rule 2: edit [12,18] overlaps T2's [5,30] → Drop.
    const dec2_t2 = invalidationEvaluate(t2, history);
    assert.ok(isDrop(dec2_t2));
    assert.equal(dec2_t2.reason, `invalidated_by:${t3.id}`);
});

test('Combined — DESIGN §"Worked Example" Pass 1+2 partial trace', () => {
    resetSeq();
    // From DESIGN-compression.md §"Worked Example":
    //   T1 read style.css [150,165]
    //   T2 read style.css [150,290]   (T1 ⊂ T2)
    //   T3 edit style.css [153,289]   (overlaps T1 and T2)
    const t1 = mkRead('style.css', [150, 165]);
    const t2 = mkRead('style.css', [150, 290]);
    const t3 = mkEdit('style.css', [153, 289]);
    const history = [t1, t2, t3];

    // Rule 1 says T1 subsumed by T2 (no intervening write between T1 and T2).
    const r1_t1 = subsumptionEvaluate(t1, history);
    assert.ok(isDrop(r1_t1));
    assert.equal(r1_t1.reason, `subsumed_by:${t2.id}`);

    // Rule 2 says T2 invalidated by T3 (edit overlaps).
    const r2_t2 = invalidationEvaluate(t2, history);
    assert.ok(isDrop(r2_t2));
    assert.equal(r2_t2.reason, `invalidated_by:${t3.id}`);

    // T3 (the edit) is kept by both rules — it's not a read.
    assert.ok(isKeep(subsumptionEvaluate(t3, history)));
    assert.ok(isKeep(invalidationEvaluate(t3, history)));
});

test('Combined — read survives if write happens BEFORE it (post-write reads are authoritative)', () => {
    resetSeq();
    const w = mkEdit('a.js', [10, 20]);
    const a = mkRead('a.js', [5, 30]); // post-write read of the new content
    const history = [w, a];

    assert.ok(isKeep(subsumptionEvaluate(a, history)),  'no later read subsumes A');
    assert.ok(isKeep(invalidationEvaluate(a, history)), 'no later write invalidates A');
});
