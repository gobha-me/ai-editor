/**
 * Pure-function tests for js/chat/turn-enrich.js.
 *
 * Runs under `node --test`. The module under test has no DOM/Storage imports,
 * so this file does not need a browser shim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFileOps, enrichToolResultTurn } from '../js/chat/turn-enrich.js';

// ============================================
// extractFileOps — edits
// ============================================

test('replace_lines → edit op with [start_line, end_line]', () => {
    assert.deepEqual(
        extractFileOps('replace_lines',
            { start_line: 10, end_line: 20, new_content: 'foo' },
            { success: true, path: 'a.js', total_lines: 50 }),
        [{ path: 'a.js', op: 'edit', range: [10, 20], content_hash: null }]
    );
});

test('insert_lines → edit op with zero-width range at after_line', () => {
    assert.deepEqual(
        extractFileOps('insert_lines',
            { after_line: 5, content: 'foo' },
            { success: true, path: 'a.js' }),
        [{ path: 'a.js', op: 'edit', range: [5, 5], content_hash: null }]
    );
});

test('delete_lines → edit op with range', () => {
    assert.deepEqual(
        extractFileOps('delete_lines',
            { start_line: 10, end_line: 15 },
            { success: true, path: 'a.js' }),
        [{ path: 'a.js', op: 'edit', range: [10, 15], content_hash: null }]
    );
});

test('edit_file replace operation → edit op with range', () => {
    assert.deepEqual(
        extractFileOps('edit_file',
            { path: 'b.js', operation: 'replace', start_line: 1, end_line: 5, new_content: 'x' },
            { success: true, path: 'b.js' }),
        [{ path: 'b.js', op: 'edit', range: [1, 5], content_hash: null }]
    );
});

test('edit_file insert operation → zero-width range at after_line', () => {
    assert.deepEqual(
        extractFileOps('edit_file',
            { path: 'b.js', operation: 'insert', after_line: 7 },
            { success: true, path: 'b.js' }),
        [{ path: 'b.js', op: 'edit', range: [7, 7], content_hash: null }]
    );
});

// ============================================
// extractFileOps — reads
// ============================================

test('read_lines → read op with range from result', () => {
    assert.deepEqual(
        extractFileOps('read_lines',
            { path: 'a.js', start_line: 1, end_line: 50 },
            { path: 'a.js', start_line: 1, end_line: 50, content: '...' }),
        [{ path: 'a.js', op: 'read', range: [1, 50], content_hash: null }]
    );
});

test('read_current_file → read op with null range (whole file)', () => {
    assert.deepEqual(
        extractFileOps('read_current_file',
            {},
            { path: 'a.js', content: '...', line_count: 50 }),
        [{ path: 'a.js', op: 'read', range: null, content_hash: null }]
    );
});

test('read_file → read op with null range', () => {
    assert.deepEqual(
        extractFileOps('read_file',
            { path: 'a.js' },
            { path: 'a.js', content: '...' }),
        [{ path: 'a.js', op: 'read', range: null, content_hash: null }]
    );
});

test('scan_file → read op with null range (metadata read)', () => {
    assert.deepEqual(
        extractFileOps('scan_file',
            { path: 'a.js' },
            { path: 'a.js', outline: [] }),
        [{ path: 'a.js', op: 'read', range: null, content_hash: null }]
    );
});

test('open_file → read op with null range', () => {
    assert.deepEqual(
        extractFileOps('open_file',
            { path: 'a.js' },
            { path: 'a.js', success: true }),
        [{ path: 'a.js', op: 'read', range: null, content_hash: null }]
    );
});

test('peek_read_lines → read op with range (cross-repo path)', () => {
    assert.deepEqual(
        extractFileOps('peek_read_lines',
            { connectionId: 'gh', owner: 'o', repo: 'r', path: 'src/a.js', start_line: 1, end_line: 30 },
            { path: 'src/a.js', start_line: 1, end_line: 30, content: '...' }),
        [{ path: 'src/a.js', op: 'read', range: [1, 30], content_hash: null }]
    );
});

// ============================================
// extractFileOps — multi-path reads
// ============================================

test('search_in_files → one read op per result path, deduped', () => {
    assert.deepEqual(
        extractFileOps('search_in_files',
            { query: 'foo' },
            { results: [{ path: 'a.js', matches: [] }, { path: 'b.js', matches: [] }, { path: 'a.js', matches: [] }] }),
        [
            { path: 'a.js', op: 'read', range: null, content_hash: null },
            { path: 'b.js', op: 'read', range: null, content_hash: null },
        ]
    );
});

test('find_references → one read op per reference path', () => {
    assert.deepEqual(
        extractFileOps('find_references',
            { symbol: 'foo' },
            { references: [{ path: 'a.js' }, { path: 'b.js' }] }),
        [
            { path: 'a.js', op: 'read', range: null, content_hash: null },
            { path: 'b.js', op: 'read', range: null, content_hash: null },
        ]
    );
});

// ============================================
// extractFileOps — writes
// ============================================

test('write_file → write op with null range', () => {
    assert.deepEqual(
        extractFileOps('write_file',
            { path: 'a.js', content: '...' },
            { success: true, path: 'a.js' }),
        [{ path: 'a.js', op: 'write', range: null, content_hash: null }]
    );
});

test('create_file → write op', () => {
    assert.deepEqual(
        extractFileOps('create_file',
            { path: 'new.js', content: '' },
            { path: 'new.js' }),
        [{ path: 'new.js', op: 'write', range: null, content_hash: null }]
    );
});

test('delete_file → write op (file delete is a write of nothing)', () => {
    assert.deepEqual(
        extractFileOps('delete_file',
            { path: 'old.js' },
            { success: true, path: 'old.js' }),
        [{ path: 'old.js', op: 'write', range: null, content_hash: null }]
    );
});

// ============================================
// extractFileOps — graceful no-ops
// ============================================

test('errored result → empty file_ops (rule defaults to Keep)', () => {
    assert.deepEqual(
        extractFileOps('replace_lines',
            { start_line: 1, end_line: 5 },
            { error: 'STALE LINE NUMBERS DETECTED' }),
        []
    );
});

test('errored write → empty file_ops (no Invalidation per DESIGN-compression §Rule 2)', () => {
    assert.deepEqual(
        extractFileOps('write_file',
            { path: 'a.js' },
            { error: 'permission denied' }),
        []
    );
});

test('unknown tool name → empty file_ops', () => {
    assert.deepEqual(extractFileOps('made_up_tool', { x: 1 }, { ok: true }), []);
});

test('non-file tool (list_open_tabs) → empty file_ops', () => {
    assert.deepEqual(extractFileOps('list_open_tabs', {}, { tabs: [] }), []);
});

test('non-file tool (scratchpad_write) → empty file_ops', () => {
    assert.deepEqual(extractFileOps('scratchpad_write', { key: 'k', content: 'v' }, { success: true }), []);
});

test('null result → empty file_ops', () => {
    assert.deepEqual(extractFileOps('read_file', { path: 'a.js' }, null), []);
});

test('missing toolName → empty file_ops', () => {
    assert.deepEqual(extractFileOps('', {}, {}), []);
    assert.deepEqual(extractFileOps(null, {}, {}), []);
});

test('read tool without resolvable path → empty file_ops', () => {
    assert.deepEqual(extractFileOps('read_file', {}, {}), []);
});

test('invalid range numbers → null range, op still recorded', () => {
    assert.deepEqual(
        extractFileOps('read_lines',
            { path: 'a.js', start_line: 0, end_line: -1 },
            { path: 'a.js' }),
        [{ path: 'a.js', op: 'read', range: null, content_hash: null }]
    );
});

// ============================================
// enrichToolResultTurn
// ============================================

test('enrichToolResultTurn populates all four metadata fields', () => {
    const enriched = enrichToolResultTurn(
        { tool_call_id: 'call_123', role: 'tool', content: '{}', _display: {} },
        'replace_lines',
        { start_line: 1, end_line: 5 },
        { success: true, path: 'a.js' }
    );

    assert.equal(enriched.tool_call_id, 'call_123');
    assert.equal(enriched.tool_result_for, 'call_123');
    assert.equal(enriched.tool_name, 'replace_lines');
    assert.deepEqual(enriched.tool_args, { start_line: 1, end_line: 5 });
    assert.deepEqual(enriched.file_ops, [
        { path: 'a.js', op: 'edit', range: [1, 5], content_hash: null }
    ]);
    assert.equal(enriched.role, 'tool');
});

test('enrichToolResultTurn preserves _display untouched', () => {
    const display = { toolName: 'replace_lines', args: { x: 1 }, result: { y: 2 } };
    const enriched = enrichToolResultTurn(
        { tool_call_id: 'c', role: 'tool', content: '{}', _display: display },
        'replace_lines', { start_line: 1, end_line: 5 }, { path: 'a.js' }
    );
    assert.equal(enriched._display, display);
});

test('enrichToolResultTurn is idempotent — re-enriching produces equivalent output', () => {
    const once = enrichToolResultTurn(
        { tool_call_id: 'c', role: 'tool', content: '{}' },
        'replace_lines', { start_line: 1, end_line: 5 }, { path: 'a.js' }
    );
    const twice = enrichToolResultTurn(once, 'replace_lines', { start_line: 1, end_line: 5 }, { path: 'a.js' });
    assert.deepEqual(twice.file_ops, once.file_ops);
    assert.deepEqual(twice.tool_args, once.tool_args);
    assert.equal(twice.tool_result_for, once.tool_result_for);
});

test('enrichToolResultTurn — non-file tool produces file_ops:[] (not undefined)', () => {
    const enriched = enrichToolResultTurn(
        { tool_call_id: 'c', role: 'tool', content: '{}' },
        'list_open_tabs', {}, { tabs: [] }
    );
    assert.deepEqual(enriched.file_ops, []);
    assert.equal(enriched.tool_name, 'list_open_tabs');
});

test('enrichToolResultTurn — null tool_call_id → tool_result_for is null', () => {
    const enriched = enrichToolResultTurn(
        { role: 'tool', content: '{}' },
        'read_file', { path: 'a.js' }, { path: 'a.js' }
    );
    assert.equal(enriched.tool_result_for, null);
});
