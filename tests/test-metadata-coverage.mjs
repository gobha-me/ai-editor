/**
 * Pure-function tests for js/chat/metadata-probe.js.
 *
 * Runs under `node --test`. The probe imports nothing side-effecting,
 * so this file does not need a browser shim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeMetadataCoverage, summarizeCoverage } from '../js/chat/metadata-probe.js';

// ============================================
// Empty / degenerate inputs
// ============================================

test('empty history → zero counts, zero coverage', () => {
    const r = probeMetadataCoverage([]);
    assert.equal(r.total_turns, 0);
    assert.equal(r.tool_result_turns, 0);
    assert.deepEqual(r.present, { tool_name: 0, tool_args: 0, tool_result_for: 0, file_ops: 0 });
    assert.deepEqual(r.missing, { tool_name: 0, tool_args: 0, tool_result_for: 0, file_ops: 0 });
    assert.deepEqual(r.coverage_pct, { tool_name: 0, tool_args: 0, tool_result_for: 0, file_ops: 0 });
    assert.deepEqual(r.samples, []);
});

test('null / non-array input → empty report (no throw)', () => {
    const r1 = probeMetadataCoverage(null);
    const r2 = probeMetadataCoverage(undefined);
    const r3 = probeMetadataCoverage('not-an-array');
    for (const r of [r1, r2, r3]) {
        assert.equal(r.total_turns, 0);
        assert.equal(r.tool_result_turns, 0);
    }
});

test('history with no tool turns → 0% coverage but non-zero total_turns', () => {
    const r = probeMetadataCoverage([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'system', content: 'sys' },
    ]);
    assert.equal(r.total_turns, 3);
    assert.equal(r.tool_result_turns, 0);
    assert.deepEqual(r.by_role, { user: 1, assistant: 1, tool: 0, system: 1, other: 0 });
    assert.deepEqual(r.coverage_pct, { tool_name: 0, tool_args: 0, tool_result_for: 0, file_ops: 0 });
});

// ============================================
// Fully enriched history (post-#170 turns)
// ============================================

test('all-enriched tool turns → 100% coverage on every field', () => {
    const r = probeMetadataCoverage([
        { role: 'user', content: 'read foo.js' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] },
        {
            role: 'tool',
            tool_call_id: 'c1',
            content: '{}',
            tool_name: 'read_file',
            tool_args: { path: 'foo.js' },
            tool_result_for: 'c1',
            file_ops: [{ path: 'foo.js', op: 'read', range: null, content_hash: null }],
        },
    ]);
    assert.equal(r.tool_result_turns, 1);
    assert.deepEqual(r.present, { tool_name: 1, tool_args: 1, tool_result_for: 1, file_ops: 1 });
    assert.deepEqual(r.missing, { tool_name: 0, tool_args: 0, tool_result_for: 0, file_ops: 0 });
    assert.deepEqual(r.coverage_pct, { tool_name: 100, tool_args: 100, tool_result_for: 100, file_ops: 100 });
});

test('empty tool_args ({}) and empty file_ops ([]) count as present', () => {
    const r = probeMetadataCoverage([
        {
            role: 'tool',
            tool_call_id: 'c1',
            content: '{}',
            tool_name: 'list_open_tabs',
            tool_args: {},
            tool_result_for: 'c1',
            file_ops: [],
        },
    ]);
    assert.equal(r.tool_result_turns, 1);
    assert.deepEqual(r.coverage_pct, { tool_name: 100, tool_args: 100, tool_result_for: 100, file_ops: 100 });
});

// ============================================
// Legacy / partially enriched history
// ============================================

test('all-legacy tool turns (pre-#170) → 0% coverage', () => {
    const r = probeMetadataCoverage([
        { role: 'tool', tool_call_id: 'c1', content: '{}' },
        { role: 'tool', tool_call_id: 'c2', content: '{}' },
    ]);
    assert.equal(r.tool_result_turns, 2);
    assert.deepEqual(r.present, { tool_name: 0, tool_args: 0, tool_result_for: 0, file_ops: 0 });
    assert.deepEqual(r.missing, { tool_name: 2, tool_args: 2, tool_result_for: 2, file_ops: 2 });
    assert.deepEqual(r.coverage_pct, { tool_name: 0, tool_args: 0, tool_result_for: 0, file_ops: 0 });
});

test('mixed legacy + enriched → 50% coverage on every field', () => {
    const r = probeMetadataCoverage([
        { role: 'tool', tool_call_id: 'c1', content: '{}' },
        {
            role: 'tool', tool_call_id: 'c2', content: '{}',
            tool_name: 'read_file', tool_args: { path: 'a.js' },
            tool_result_for: 'c2', file_ops: [],
        },
    ]);
    assert.equal(r.tool_result_turns, 2);
    assert.deepEqual(r.coverage_pct, { tool_name: 50, tool_args: 50, tool_result_for: 50, file_ops: 50 });
});

test('partial enrichment (some fields present, others missing) is counted per-field', () => {
    const r = probeMetadataCoverage([
        {
            role: 'tool', tool_call_id: 'c1', content: '{}',
            tool_name: 'read_file',
            // tool_args missing
            tool_result_for: 'c1',
            // file_ops missing
        },
    ]);
    assert.equal(r.tool_result_turns, 1);
    assert.deepEqual(r.present, { tool_name: 1, tool_args: 0, tool_result_for: 1, file_ops: 0 });
    assert.deepEqual(r.missing, { tool_name: 0, tool_args: 1, tool_result_for: 0, file_ops: 1 });
});

test('null field values count as missing (not present)', () => {
    const r = probeMetadataCoverage([
        {
            role: 'tool', tool_call_id: 'c1', content: '{}',
            tool_name: null, tool_args: null, tool_result_for: null, file_ops: null,
        },
    ]);
    assert.equal(r.tool_result_turns, 1);
    assert.deepEqual(r.present, { tool_name: 0, tool_args: 0, tool_result_for: 0, file_ops: 0 });
});

// ============================================
// by_role accounting + samples
// ============================================

test('by_role counts every role; unknown role goes to "other"', () => {
    const r = probeMetadataCoverage([
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
        { role: 'assistant', content: 'c' },
        { role: 'tool', tool_call_id: 'c1', content: '{}' },
        { role: 'system', content: 's' },
        { role: 'function', content: 'legacy' },
        { content: 'no role' },
    ]);
    assert.deepEqual(r.by_role, { user: 2, assistant: 1, tool: 1, system: 1, other: 2 });
});

test('samples capped at default sampleLimit (20) and capture original index', () => {
    const turns = [];
    // Stuff 5 user turns at the head so tool indices don't start at 0
    for (let i = 0; i < 5; i++) turns.push({ role: 'user', content: String(i) });
    for (let i = 0; i < 25; i++) {
        turns.push({
            role: 'tool', tool_call_id: 'c' + i, content: '{}',
            tool_name: 'read_file', tool_args: {}, tool_result_for: 'c' + i, file_ops: [],
        });
    }
    const r = probeMetadataCoverage(turns);
    assert.equal(r.tool_result_turns, 25);
    assert.equal(r.samples.length, 20);
    assert.equal(r.samples[0].index, 5);  // first tool turn is at history index 5
    assert.equal(r.samples[0].tool_call_id, 'c0');
    assert.equal(r.samples[19].index, 24);
});

test('sampleLimit can be overridden via opts', () => {
    const turns = [];
    for (let i = 0; i < 10; i++) {
        turns.push({ role: 'tool', tool_call_id: 'c' + i, content: '{}' });
    }
    const r = probeMetadataCoverage(turns, { sampleLimit: 3 });
    assert.equal(r.samples.length, 3);
});

test('sample rows have boolean flags per field', () => {
    const r = probeMetadataCoverage([
        { role: 'tool', tool_call_id: 'c1', content: '{}', tool_name: 'x' },
    ]);
    assert.deepEqual(r.samples[0], {
        index: 0,
        tool_call_id: 'c1',
        has_tool_name: true,
        has_tool_args: false,
        has_tool_result_for: false,
        has_file_ops: false,
    });
});

// ============================================
// summarizeCoverage()
// ============================================

test('summarizeCoverage on empty report → "nothing to measure"', () => {
    const r = probeMetadataCoverage([]);
    assert.match(summarizeCoverage(r), /nothing to measure/);
});

test('summarizeCoverage includes every field percentage', () => {
    const r = probeMetadataCoverage([
        {
            role: 'tool', tool_call_id: 'c1', content: '{}',
            tool_name: 'read_file', tool_args: {}, tool_result_for: 'c1', file_ops: [],
        },
    ]);
    const s = summarizeCoverage(r);
    assert.match(s, /tool_name=100%/);
    assert.match(s, /tool_args=100%/);
    assert.match(s, /tool_result_for=100%/);
    assert.match(s, /file_ops=100%/);
});

test('summarizeCoverage handles null report defensively', () => {
    assert.match(summarizeCoverage(null), /nothing to measure/);
    assert.match(summarizeCoverage(undefined), /nothing to measure/);
});

// ============================================
// Read-only discipline
// ============================================

test('probe does not mutate the history array or its turns', () => {
    const turns = [
        { role: 'user', content: 'hi' },
        { role: 'tool', tool_call_id: 'c1', content: '{}' },
    ];
    const snapshot = JSON.parse(JSON.stringify(turns));
    probeMetadataCoverage(turns);
    assert.deepEqual(turns, snapshot);
});
