/**
 * Pipeline tests for js/intelligence/compression/compactor.js — the full
 * Phase 1 path with Rules 1, 2, 5 wired in, plus preserve_recent and
 * failure-mode coverage.
 *
 * Runs under `node --test`. Pure: no DOM, no Storage, no network. The
 * Rule 5 summarizer is injected as an in-test stub.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    compress,
    Compactor,
    SUBSUMPTION_RULE,
    INVALIDATION_RULE,
    SUMMARIZATION_RULE,
    Keep, Drop,
    makeSynthesizedTurn,
    chatHistoryToTurns,
    estimateTokens,
} from '../js/intelligence/compression/index.js';

// ============================================
// Test fixture helpers
// ============================================

let _seq = 0;
function resetSeq() { _seq = 0; }

function mkTurn(role, content, metadata, tokens) {
    const id = `T${_seq++}`;
    const t = tokens != null ? tokens : Math.max(1, Math.ceil(((content || '').length) / 3.5));
    return { id, role, content: content || '', tokens: t, timestamp: _seq, metadata: metadata || {} };
}
function mkRead(path, range, tokens) {
    return mkTurn('tool_result', `read ${path}`, {
        tool_name: 'read_lines',
        file_ops: [{ path, op: 'read', range, content_hash: null }],
    }, tokens);
}
function mkEdit(path, range, tokens) {
    return mkTurn('tool_result', `edit ${path}`, {
        tool_name: 'edit_file',
        file_ops: [{ path, op: 'edit', range, content_hash: null }],
    }, tokens);
}
function mkUser(text, tokens) { return mkTurn('user', text, {}, tokens); }
function mkAsst(text, tokens) { return mkTurn('assistant', text, {}, tokens); }

// ============================================
// Empty / trivial inputs
// ============================================

test('compress — empty history returns empty result', async () => {
    const r = await compress({
        history: [], rules: [SUBSUMPTION_RULE, INVALIDATION_RULE],
        preserve_recent: 0, budget_tokens: 1000,
    });
    assert.deepEqual(r.history, []);
    assert.deepEqual(r.evicted_ids, []);
    assert.equal(r.diagnostics.tokens_in, 0);
    assert.equal(r.diagnostics.tokens_out, 0);
    assert.equal(r.diagnostics.compression_ratio, 1);
});

test('compress — throws on bad input', async () => {
    await assert.rejects(() => compress(null), /req must be an object/);
    await assert.rejects(() => compress({}), /history must be an array/);
});

test('Compactor object form delegates to compress()', async () => {
    resetSeq();
    const r = await Compactor.compress({
        history: [mkUser('hi')], rules: [], preserve_recent: 0, budget_tokens: 1000,
    });
    assert.equal(r.history.length, 1);
});

// ============================================
// preserve_recent invariant
// ============================================

test('preserve_recent — last N turns NEVER evicted, even when rules would drop them', async () => {
    resetSeq();
    // 3 reads of style.css, all subsumed by the wider 4th read.
    // With preserve_recent=4, ALL turns are protected → nothing is evicted.
    const t1 = mkRead('a.js', [10, 20]);
    const t2 = mkRead('a.js', [10, 20]);
    const t3 = mkRead('a.js', [10, 20]);
    const t4 = mkRead('a.js', [1, 100]);

    const r = await compress({
        history: [t1, t2, t3, t4],
        rules: [SUBSUMPTION_RULE],
        preserve_recent: 4,
        budget_tokens: 100000,
    });
    assert.equal(r.history.length, 4, 'all 4 turns protected by preserve_recent');
    assert.equal(r.evicted_ids.length, 0);
});

test('preserve_recent — only the oldest turn is in the eviction window', async () => {
    resetSeq();
    const t1 = mkRead('a.js', [10, 20]); // candidate
    const t2 = mkRead('a.js', [1, 100]); // subsumes t1
    const t3 = mkUser('latest');
    const t4 = mkAsst('reply');

    const r = await compress({
        history: [t1, t2, t3, t4],
        rules: [SUBSUMPTION_RULE],
        preserve_recent: 3, // protects t2, t3, t4
        budget_tokens: 100000,
    });
    // t1 is OUTSIDE the preserve window and IS subsumed by t2 → dropped.
    assert.equal(r.history.length, 3);
    assert.deepEqual(r.evicted_ids, [t1.id]);
    assert.equal(r.surviving_ids[0], t2.id);
});

test('preserve_recent — defaults to 0 when omitted (no protection)', async () => {
    resetSeq();
    const t1 = mkRead('a.js', [10, 20]);
    const t2 = mkRead('a.js', [1, 100]);
    const r = await compress({
        history: [t1, t2],
        rules: [SUBSUMPTION_RULE],
        // preserve_recent omitted
        budget_tokens: 100000,
    });
    assert.deepEqual(r.evicted_ids, [t1.id]);
});

// ============================================
// Per-turn rule evaluation + decision tally
// ============================================

test('compress — drops subsumed read; diagnostics record rule + reason', async () => {
    resetSeq();
    const t1 = mkRead('a.js', [10, 20]);
    const t2 = mkRead('a.js', [1, 100]);
    const t3 = mkUser('done');

    const r = await compress({
        history: [t1, t2, t3],
        rules: [SUBSUMPTION_RULE, INVALIDATION_RULE],
        preserve_recent: 1,
        budget_tokens: 100000,
    });
    assert.deepEqual(r.evicted_ids, [t1.id]);
    assert.equal(r.diagnostics.evicted_ids[0].rule, 'subsumption');
    assert.equal(r.diagnostics.evicted_ids[0].reason, `subsumed_by:${t2.id}`);
    assert.equal(r.diagnostics.decisions_by_rule.subsumption.drop, 1);
});

test('compress — first non-Keep wins (Rule 1 reason wins over Rule 2)', async () => {
    resetSeq();
    const t1 = mkRead('a.js', [10, 20]);
    const t2 = mkRead('a.js', [5, 30]);   // subsumes t1 (Rule 1)
    const t3 = mkEdit('a.js', [12, 18]);  // would invalidate t1 (Rule 2)

    const r = await compress({
        history: [t1, t2, t3],
        rules: [INVALIDATION_RULE, SUBSUMPTION_RULE], // out-of-order; Compactor sorts
        preserve_recent: 0,
        budget_tokens: 100000,
    });
    assert.equal(r.diagnostics.evicted_ids.find(e => e.id === t1.id).rule, 'subsumption');
});

test('compress — Rule 1 + Rule 2 both fire (subsumed + invalidated)', async () => {
    resetSeq();
    const t1 = mkRead('a.js', [10, 20]);
    const t2 = mkRead('a.js', [5, 30]);
    const t3 = mkEdit('a.js', [12, 18]);

    const r = await compress({
        history: [t1, t2, t3],
        rules: [SUBSUMPTION_RULE, INVALIDATION_RULE],
        preserve_recent: 0,
        budget_tokens: 100000,
    });
    // t1 dropped (subsumed); t2 dropped (invalidated); t3 kept.
    assert.equal(r.history.length, 1);
    assert.equal(r.surviving_ids[0], t3.id);
    const reasons = Object.fromEntries(
        r.diagnostics.evicted_ids.map(e => [e.id, e.reason])
    );
    assert.equal(reasons[t1.id], `subsumed_by:${t2.id}`);
    assert.equal(reasons[t2.id], `invalidated_by:${t3.id}`);
});

test('compress — diagnostics.rules_run reflects sorted rule names', async () => {
    resetSeq();
    const t = mkUser('hi');
    const r = await compress({
        history: [t],
        rules: [INVALIDATION_RULE, SUBSUMPTION_RULE], // unordered input
        preserve_recent: 0,
        budget_tokens: 1000,
    });
    assert.deepEqual(r.diagnostics.rules_run, ['subsumption', 'invalidation']);
});

// ============================================
// rules_skipped diagnostic — the load-bearing field
// ============================================

test('rules_skipped — file-ops rules report tool_result turns lacking file_ops', async () => {
    resetSeq();
    // Two tool_result turns: one with file_ops, one without.
    const enriched = mkRead('a.js', [10, 20]);
    const orphan = mkTurn('tool_result', 'pre-1.1.0 turn', {}); // no file_ops
    const r = await compress({
        history: [enriched, orphan, mkUser('done')],
        rules: [SUBSUMPTION_RULE, INVALIDATION_RULE],
        preserve_recent: 1,
        budget_tokens: 100000,
    });

    // Both Subsumption and Invalidation should report skipped on the orphan.
    const skipped = r.diagnostics.rules_skipped;
    const subSkip = skipped.find(s => s.rule === 'subsumption');
    const invSkip = skipped.find(s => s.rule === 'invalidation');
    assert.ok(subSkip,  'subsumption skipped reason recorded');
    assert.ok(invSkip,  'invalidation skipped reason recorded');
    assert.equal(subSkip.reason, 'file_ops_empty');
    assert.equal(subSkip.count, 1);
    assert.equal(invSkip.count, 1);
});

test('rules_skipped — empty when all tool_result turns carry file_ops', async () => {
    resetSeq();
    const r = await compress({
        history: [mkRead('a.js', [10, 20]), mkRead('a.js', [1, 100])],
        rules: [SUBSUMPTION_RULE, INVALIDATION_RULE],
        preserve_recent: 0,
        budget_tokens: 100000,
    });
    assert.deepEqual(r.diagnostics.rules_skipped, []);
});

// ============================================
// Failure modes
// ============================================

test('failure — rule that throws is recorded; turn defaults to Keep', async () => {
    resetSeq();
    const buggy = {
        name: 'buggy', priority: 5,
        evaluate: () => { throw new Error('oops'); },
    };
    const t = mkRead('a.js', [10, 20]);
    const r = await compress({
        history: [t, mkUser('hi')],
        rules: [buggy, SUBSUMPTION_RULE],
        preserve_recent: 0,
        budget_tokens: 100000,
    });
    // Buggy rule throws on every turn it evaluates (2 turns → 2 errors).
    assert.equal(r.diagnostics.rule_errors.length, 2);
    assert.ok(r.diagnostics.rule_errors.every(e => e.rule === 'buggy'));
    assert.ok(r.diagnostics.rule_errors.every(e => /oops/.test(e.error)));
    // Turns kept because the buggy rule defaulted to Keep on throw and
    // Subsumption found no match (only one read, no later wider read).
    assert.equal(r.history.length, 2);
});

test('failure — summarizer that throws falls back gracefully', async () => {
    resetSeq();
    // Build a history that exceeds budget.
    const turns = [];
    for (let i = 0; i < 5; i++) turns.push(mkUser(`user message ${i}`, 100));
    const r = await compress({
        history: turns,
        rules: [SUBSUMPTION_RULE, SUMMARIZATION_RULE],
        preserve_recent: 0,
        budget_tokens: 50,
        summarizer: async () => { throw new Error('LLM down'); },
    });
    assert.ok(
        r.diagnostics.warnings.some(w => w.startsWith('summarizer_failed:')),
        'summarizer_failed warning emitted'
    );
});

test('failure — summarizer returning malformed output is recorded', async () => {
    resetSeq();
    const turns = [];
    for (let i = 0; i < 5; i++) turns.push(mkUser(`m${i}`, 100));
    const r = await compress({
        history: turns,
        rules: [SUMMARIZATION_RULE],
        preserve_recent: 0,
        budget_tokens: 50,
        summarizer: async () => null,
    });
    assert.ok(r.diagnostics.warnings.some(w => w === 'summarizer_malformed_output'));
});

// ============================================
// Rule 5 — summarization fallback
// ============================================

test('Rule 5 — wires the injected summarizer to compress over budget', async () => {
    resetSeq();
    const turns = [];
    for (let i = 0; i < 12; i++) turns.push(mkUser(`message ${i}`, 50));
    const totalTokens = turns.reduce((s, t) => s + t.tokens, 0);
    assert.ok(totalTokens > 200);

    let summarizerCalls = 0;
    const summarizer = async (span) => {
        summarizerCalls++;
        return makeSynthesizedTurn(
            `[stub summary covering ${span.length} turns]`,
            'test_stub',
            Date.now()
        );
    };

    const r = await compress({
        history: turns,
        rules: [SUMMARIZATION_RULE],
        preserve_recent: 2,
        budget_tokens: 200,
        summarizer,
    });

    assert.ok(summarizerCalls >= 1, 'summarizer was invoked at least once');
    assert.ok(r.diagnostics.summarized_spans.length >= 1);
    assert.ok(r.diagnostics.tokens_out <= r.diagnostics.tokens_in);
});

test('Rule 5 — summarizer SKIPPED when no summarizer is provided', async () => {
    resetSeq();
    const turns = [];
    for (let i = 0; i < 5; i++) turns.push(mkUser(`m${i}`, 100));
    const r = await compress({
        history: turns,
        rules: [SUMMARIZATION_RULE],
        preserve_recent: 0,
        budget_tokens: 50,
        // no summarizer
    });
    // Should drop oldest in step 6 final fallback.
    assert.ok(r.diagnostics.warnings.includes('budget_exceeded_no_summarizer'));
    assert.ok(r.diagnostics.tokens_out <= 50);
});

test('Rule 5 — preserve_recent floor halts oldest-drop when reached', async () => {
    resetSeq();
    const turns = [];
    for (let i = 0; i < 4; i++) turns.push(mkUser(`m${i}`, 100));
    const r = await compress({
        history: turns,
        rules: [],
        preserve_recent: 4, // protect everything
        budget_tokens: 50,  // unreachable while preserving 4×100
    });
    assert.equal(r.history.length, 4, 'preserve_recent floor honored');
    assert.ok(r.diagnostics.warnings.includes('preserve_recent_exceeds_budget'));
});

// ============================================
// Compression ratio + tokens accounting
// ============================================

test('diagnostics — tokens_in / tokens_out / compression_ratio computed', async () => {
    resetSeq();
    const t1 = mkRead('a.js', [10, 20], 50);
    const t2 = mkRead('a.js', [1, 100], 50);
    const t3 = mkUser('end', 10);
    const r = await compress({
        history: [t1, t2, t3],
        rules: [SUBSUMPTION_RULE],
        preserve_recent: 1,
        budget_tokens: 100000,
    });
    assert.equal(r.diagnostics.tokens_in, 110);
    assert.equal(r.diagnostics.tokens_out, 60); // t1 dropped
    assert.equal(r.diagnostics.compression_ratio, 60 / 110);
});

test('diagnostics — compression_ratio is 1.0 when nothing evicted', async () => {
    resetSeq();
    const r = await compress({
        history: [mkUser('hi', 5), mkAsst('hello', 5)],
        rules: [SUBSUMPTION_RULE, INVALIDATION_RULE],
        preserve_recent: 0,
        budget_tokens: 100000,
    });
    assert.equal(r.diagnostics.compression_ratio, 1);
    assert.equal(r.evicted_ids.length, 0);
});

// ============================================
// Integration with chatHistoryToTurns
// ============================================

// ============================================
// Tool-pair coherence
// ============================================

function mkAsstWithToolCalls(text, callIds, tokens) {
    const m = mkTurn('assistant', text, {
        has_tool_calls: true,
        tool_call_ids: callIds,
    }, tokens);
    return m;
}

function mkToolResult(callId, path, range, tokens) {
    return mkTurn('tool_result', `result for ${callId}`, {
        tool_name: 'read_lines',
        tool_call_id: callId,
        tool_result_for: callId,
        file_ops: [{ path, op: 'read', range, content_hash: null }],
    }, tokens);
}

test('coherence — single tool_call/tool_result pair: dropping the result also drops the caller', async () => {
    resetSeq();
    // Old, evictable sequence: assistant calls read [10,20], result, then later wider read.
    const a1 = mkAsstWithToolCalls('Let me read', ['c1']);
    const r1 = mkToolResult('c1', 'a.js', [10, 20]);
    const a2 = mkAsstWithToolCalls('Wider read', ['c2']);
    const r2 = mkToolResult('c2', 'a.js', [1, 100]); // subsumes r1
    const u  = mkUser('done');

    const r = await compress({
        history: [a1, r1, a2, r2, u],
        rules: [SUBSUMPTION_RULE],
        preserve_recent: 1, // protect only the user msg
        budget_tokens: 100000,
    });

    const survivingIds = new Set(r.surviving_ids);
    assert.ok(!survivingIds.has(r1.id), 'r1 (subsumed) is dropped');
    assert.ok(!survivingIds.has(a1.id), 'a1 (caller of r1) is dropped — coherence');
    assert.ok(survivingIds.has(a2.id),  'a2 (whose result survives) is kept');
    assert.ok(survivingIds.has(r2.id),  'r2 is kept');
    assert.ok(survivingIds.has(u.id),   'user msg kept (preserve_recent)');

    // Diagnostics record the coherence eviction.
    const a1Evict = r.diagnostics.evicted_ids.find(e => e.id === a1.id);
    assert.ok(a1Evict, 'a1 in evicted_ids');
    assert.equal(a1Evict.rule, 'tool_pair_coherence');
    assert.match(a1Evict.reason, /^orphan:all_1_tool_results_evicted$/);
});

test('coherence — multi tool_call assistant: partial drops REVERT to keep the pair', async () => {
    resetSeq();
    // Assistant calls TWO reads in parallel; only one is later subsumed.
    const a1 = mkAsstWithToolCalls('Read both', ['c1', 'c2']);
    const r_c1 = mkToolResult('c1', 'a.js', [10, 20]);
    const r_c2 = mkToolResult('c2', 'b.js', [1, 50]);
    // Later wider read of a.js — subsumes c1's result.
    const a2 = mkAsstWithToolCalls('Wider read of a', ['c3']);
    const r_c3 = mkToolResult('c3', 'a.js', [1, 100]);
    const u = mkUser('done');

    const r = await compress({
        history: [a1, r_c1, r_c2, a2, r_c3, u],
        rules: [SUBSUMPTION_RULE],
        preserve_recent: 1,
        budget_tokens: 100000,
    });

    const survivingIds = new Set(r.surviving_ids);
    // c1's result would be dropped, but c2's result is kept — partial.
    // Coherence reverts the c1 drop; both results stay.
    assert.ok(survivingIds.has(r_c1.id), 'r_c1 reverted to keep — coherence');
    assert.ok(survivingIds.has(r_c2.id), 'r_c2 was always kept');
    assert.ok(survivingIds.has(a1.id),   'a1 kept (its results survive)');

    // The revert is recorded in warnings.
    assert.ok(
        r.diagnostics.warnings.some(w => /^tool_pair_coherence_revert:.*_uncovered_of_/.test(w)),
        'tool_pair_coherence_revert warning emitted'
    );
});

test('coherence — duplicate call_ids: covered by any kept result, no caller drop', async () => {
    resetSeq();
    // Degenerate but possible: two tool_results share a call_id.
    // Coherence treats a call_id as covered if ANY tool_result with
    // that id survives, so the caller stays.
    const a1 = mkAsstWithToolCalls('call', ['c1']);
    const r1 = mkToolResult('c1', 'a.js', [10, 20]);
    const r2 = mkToolResult('c1', 'a.js', [1, 100]);
    const r = await compress({
        history: [a1, r1, r2],
        rules: [SUBSUMPTION_RULE],
        preserve_recent: 0,
        budget_tokens: 100000,
    });
    const survivingIds = new Set(r.surviving_ids);
    assert.ok(survivingIds.has(a1.id), 'a1 covered — c1 has a kept result (r2)');
    assert.ok(survivingIds.has(r2.id), 'r2 kept');
    // r1 may or may not be dropped depending on rule semantics; the
    // load-bearing assertion is that a1 is not orphan-dropped.
});

test('coherence — orphaned tool_result with no kept caller drops cleanly', async () => {
    resetSeq();
    // Tool_result whose call_id doesn't match any assistant turn.
    const r1 = mkToolResult('lonely', 'a.js', [10, 20]);
    const r2 = mkToolResult('lonely2', 'a.js', [1, 100]);
    const r = await compress({
        history: [r1, r2],
        rules: [SUBSUMPTION_RULE],
        preserve_recent: 0,
        budget_tokens: 100000,
    });
    const survivingIds = new Set(r.surviving_ids);
    assert.ok(!survivingIds.has(r1.id), 'r1 dropped (subsumed; no caller to coordinate with)');
    assert.ok(survivingIds.has(r2.id));
});

test('integration — chatHistoryToTurns + compress wires end-to-end', async () => {
    // Simulate enriched chat history (post-1.1.0).
    const chatHistory = [
        { role: 'tool', content: '{"path":"a.js"}', tool_name: 'read_lines',
          file_ops: [{ path: 'a.js', op: 'read', range: [10, 20], content_hash: null }] },
        { role: 'tool', content: '{"path":"a.js"}', tool_name: 'read_lines',
          file_ops: [{ path: 'a.js', op: 'read', range: [1, 100], content_hash: null }] },
        { role: 'user', content: 'looks good' },
    ];
    const turns = chatHistoryToTurns(chatHistory);
    const r = await compress({
        history: turns,
        rules: [SUBSUMPTION_RULE, INVALIDATION_RULE],
        preserve_recent: 1,
        budget_tokens: 100000,
    });
    assert.equal(r.history.length, 2, 'first read dropped (subsumed)');
    assert.equal(r.evicted_ids.length, 1);
});
