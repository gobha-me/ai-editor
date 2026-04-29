/**
 * Pure-data tests for js/intelligence/compression/ contracts surface
 * (decisions, tokens, turn-store).
 *
 * Runs under `node --test`. The compression module imports nothing
 * side-effecting — no DOM, no Storage, no fetch — so this file does not
 * need a browser shim.
 *
 * Rule-pipeline tests live in tests/test-compression.mjs (Commits 2-4).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    Keep, Drop, Replace, Summarize,
    isKeep, isDrop, isReplace, isSummarize, isDecision,
    estimateTokens, sumTokens, CHARS_PER_TOKEN,
    makeTurnId, chatMessageToTurn, chatHistoryToTurns,
    turnsToChatMessages, makeSynthesizedTurn,
} from '../js/intelligence/compression/index.js';

// ============================================
// Decision factories + type guards
// ============================================

test('Keep returns a singleton with kind="keep"', () => {
    const a = Keep();
    const b = Keep();
    assert.equal(a.kind, 'keep');
    assert.equal(a, b, 'Keep should return the same frozen instance');
});

test('Drop carries a reason; rejects empty/non-string', () => {
    const d = Drop('subsumed_by:T7');
    assert.equal(d.kind, 'drop');
    assert.equal(d.reason, 'subsumed_by:T7');
    assert.throws(() => Drop(''), /reason must be a non-empty string/);
    assert.throws(() => Drop(null), /reason must be a non-empty string/);
});

test('Replace carries a marker and reason', () => {
    const r = Replace('[Compactor: 4 turns fixing X]', 'resolution:bug-fix');
    assert.equal(r.kind, 'replace');
    assert.equal(r.marker, '[Compactor: 4 turns fixing X]');
    assert.equal(r.reason, 'resolution:bug-fix');
    assert.throws(() => Replace('', 'r'), /marker must be a non-empty string/);
    assert.throws(() => Replace('m', ''), /reason must be a non-empty string/);
});

test('Summarize carries a reason hint', () => {
    const s = Summarize('over_budget:oldest_block');
    assert.equal(s.kind, 'summarize');
    assert.equal(s.reason, 'over_budget:oldest_block');
});

test('isKeep / isDrop / isReplace / isSummarize discriminate correctly', () => {
    assert.ok(isKeep(Keep()));
    assert.ok(isDrop(Drop('r')));
    assert.ok(isReplace(Replace('m', 'r')));
    assert.ok(isSummarize(Summarize('r')));

    assert.ok(!isKeep(Drop('r')));
    assert.ok(!isDrop(Keep()));
    assert.ok(!isReplace(Summarize('r')));
    assert.ok(!isSummarize(Replace('m', 'r')));

    // Garbage inputs return false rather than throwing.
    assert.ok(!isKeep(null));
    assert.ok(!isDrop(undefined));
    assert.ok(!isReplace('keep'));
    assert.ok(!isSummarize(42));
});

test('isDecision accepts all four; rejects garbage', () => {
    assert.ok(isDecision(Keep()));
    assert.ok(isDecision(Drop('r')));
    assert.ok(isDecision(Replace('m', 'r')));
    assert.ok(isDecision(Summarize('r')));
    assert.ok(!isDecision(null));
    assert.ok(!isDecision({ kind: 'made-up' }));
    assert.ok(!isDecision('keep'));
});

// ============================================
// Token estimation
// ============================================

test('CHARS_PER_TOKEN is the expected heuristic divisor', () => {
    assert.equal(CHARS_PER_TOKEN, 3.5);
});

test('estimateTokens — null/undefined return 0', () => {
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens(undefined), 0);
});

test('estimateTokens — string measures chars/3.5 ceiling', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('hello'), Math.ceil(5 / 3.5));        // 2
    assert.equal(estimateTokens('a'.repeat(35)), Math.ceil(35 / 3.5)); // 10
});

test('estimateTokens — object stringifies', () => {
    const obj = { a: 1, b: 'hi' };
    const expected = Math.ceil(JSON.stringify(obj).length / 3.5);
    assert.equal(estimateTokens(obj), expected);
});

test('estimateTokens — circular objects fall back to keys, not throw', () => {
    const o = { a: 1 };
    o.self = o;
    // Should not throw; should return a finite number.
    const t = estimateTokens(o);
    assert.ok(Number.isFinite(t));
    assert.ok(t > 0);
});

test('estimateTokens — number/boolean coerce via String()', () => {
    assert.equal(estimateTokens(42), Math.ceil(2 / 3.5));   // "42" → 1
    assert.equal(estimateTokens(true), Math.ceil(4 / 3.5)); // "true" → 2
});

test('sumTokens — sums numeric .tokens, skips bad entries', () => {
    assert.equal(sumTokens([{ tokens: 10 }, { tokens: 5 }, { tokens: 3 }]), 18);
    assert.equal(sumTokens([{ tokens: 10 }, {}, { tokens: 'oops' }, { tokens: 5 }]), 15);
    assert.equal(sumTokens([]), 0);
    assert.equal(sumTokens(null), 0);
});

// ============================================
// Turn store — TurnID + role mapping
// ============================================

test('makeTurnId — sequence-only Phase-1 form', () => {
    assert.equal(makeTurnId(0), 'T0');
    assert.equal(makeTurnId(7), 'T7');
    assert.equal(makeTurnId(1234), 'T1234');
});

test('chatMessageToTurn — user message round-trips with computed tokens', () => {
    const t = chatMessageToTurn(
        { role: 'user', content: 'hello world', timestamp: 1700000000000 },
        0
    );
    assert.equal(t.id, 'T0');
    assert.equal(t.role, 'user');
    assert.equal(t.content, 'hello world');
    assert.equal(t.tokens, Math.ceil('hello world'.length / 3.5));
    assert.equal(t.timestamp, 1700000000000);
    assert.equal(t.metadata.source_index, 0);
    assert.equal(t.metadata.has_tool_calls, false);
    assert.deepEqual(t.metadata.file_ops, []);
});

test('chatMessageToTurn — assistant with tool_calls flags has_tool_calls', () => {
    const t = chatMessageToTurn(
        {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{}' } }],
        },
        3
    );
    assert.equal(t.role, 'assistant');
    assert.equal(t.metadata.has_tool_calls, true);
});

test('chatMessageToTurn — tool message becomes tool_result with file_ops preserved', () => {
    const t = chatMessageToTurn(
        {
            role: 'tool',
            tool_call_id: 'c1',
            content: '{"path":"a.js","content":"..."}',
            tool_name: 'read_file',
            tool_args: { path: 'a.js' },
            tool_result_for: 'c1',
            file_ops: [{ path: 'a.js', op: 'read', range: null, content_hash: null }],
        },
        4
    );
    assert.equal(t.role, 'tool_result');
    assert.equal(t.metadata.tool_name, 'read_file');
    assert.deepEqual(t.metadata.tool_args, { path: 'a.js' });
    assert.equal(t.metadata.tool_result_for, 'c1');
    assert.equal(t.metadata.tool_call_id, 'c1');
    assert.equal(t.metadata.file_ops.length, 1);
    assert.equal(t.metadata.file_ops[0].path, 'a.js');
});

test('chatMessageToTurn — error role maps to system (UI-only role)', () => {
    const t = chatMessageToTurn({ role: 'error', content: 'oh no' }, 2);
    assert.equal(t.role, 'system');
});

test('chatMessageToTurn — unknown role defaults to system, never throws', () => {
    const t = chatMessageToTurn({ role: 'made-up', content: 'x' }, 1);
    assert.equal(t.role, 'system');
});

test('chatMessageToTurn — null/garbage input does not throw', () => {
    const a = chatMessageToTurn(null, 0);
    assert.equal(a.id, 'T0');
    assert.equal(a.role, 'system');
    assert.equal(a.content, '');

    const b = chatMessageToTurn(undefined, 1);
    assert.equal(b.id, 'T1');
});

test('chatMessageToTurn — missing timestamp falls back to sequence number', () => {
    const t = chatMessageToTurn({ role: 'user', content: 'hi' }, 5);
    assert.equal(t.timestamp, 5);
});

test('chatHistoryToTurns — preserves order and indexes', () => {
    const history = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'bye' },
    ];
    const turns = chatHistoryToTurns(history);
    assert.equal(turns.length, 3);
    assert.equal(turns[0].id, 'T0');
    assert.equal(turns[1].id, 'T1');
    assert.equal(turns[2].id, 'T2');
    assert.equal(turns[0].metadata.source_index, 0);
    assert.equal(turns[2].metadata.source_index, 2);
});

test('chatHistoryToTurns — non-array input returns []', () => {
    assert.deepEqual(chatHistoryToTurns(null), []);
    assert.deepEqual(chatHistoryToTurns({}), []);
});

// ============================================
// Round-trip
// ============================================

test('turnsToChatMessages — reconstructs original references via source_index', () => {
    const orig = [
        { role: 'user', content: 'a', _id: 'A' },
        { role: 'assistant', content: 'b', _id: 'B' },
        { role: 'user', content: 'c', _id: 'C' },
    ];
    const turns = chatHistoryToTurns(orig);

    // Drop the middle turn — survivors are 0 and 2.
    const survivors = [turns[0], turns[2]];
    const out = turnsToChatMessages(survivors, orig);

    assert.equal(out.length, 2);
    assert.equal(out[0]._id, 'A', 'should be the original reference, not a copy');
    assert.equal(out[1]._id, 'C');
    assert.equal(out[0], orig[0], 'must be the same object reference');
});

test('turnsToChatMessages — synthesized turn (source_index=-1) emits a fresh system message', () => {
    const orig = [{ role: 'user', content: 'hi' }];
    const turns = chatHistoryToTurns(orig);
    const synthetic = makeSynthesizedTurn(
        '[Compactor: 3 turns about brace fix in map.js — resolved]',
        'resolution:brace-fix',
        1700000000000
    );
    const out = turnsToChatMessages([turns[0], synthetic], orig);
    assert.equal(out.length, 2);
    assert.equal(out[0], orig[0]);
    assert.equal(out[1].role, 'system');
    assert.equal(out[1].content, '[Compactor: 3 turns about brace fix in map.js — resolved]');
    assert.equal(out[1]._synthesized, true);
    assert.equal(out[1]._compressionReason, 'resolution:brace-fix');
});

test('makeSynthesizedTurn — system role, source_index=-1, content tokenized', () => {
    const t = makeSynthesizedTurn('hello marker', 'rule_4', 12345);
    assert.equal(t.role, 'system');
    assert.equal(t.content, 'hello marker');
    assert.equal(t.timestamp, 12345);
    assert.equal(t.metadata.source_index, -1);
    assert.equal(t.metadata.custom.reason, 'rule_4');
    assert.equal(t.tokens, Math.ceil('hello marker'.length / 3.5));
});
