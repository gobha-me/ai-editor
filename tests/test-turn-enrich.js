/**
 * Browser tests for js/chat/turn-enrich.js.
 *
 * Mirrors tests/test-turn-enrich.mjs (which uses node:test) using the in-page
 * T mini-framework. Both files exercise the same pure functions; this one
 * also adds a browser-only smoke for sanitizeMessages — verifying that the
 * new metadata fields do not leak to the LLM API request body.
 */
import { extractFileOps, enrichToolResultTurn } from '../js/chat/turn-enrich.js';
import { sanitizeMessages } from '../js/llm/utils.js';

const { T } = window;

T.suite('Turn enrichment — extractFileOps (edits)');

T.deepEq(
    extractFileOps('replace_lines', { start_line: 10, end_line: 20 }, { success: true, path: 'a.js' }),
    [{ path: 'a.js', op: 'edit', range: [10, 20], content_hash: null }],
    'replace_lines → edit op with range'
);

T.deepEq(
    extractFileOps('insert_lines', { after_line: 5 }, { success: true, path: 'a.js' }),
    [{ path: 'a.js', op: 'edit', range: [5, 5], content_hash: null }],
    'insert_lines → zero-width range at after_line'
);

T.deepEq(
    extractFileOps('delete_lines', { start_line: 10, end_line: 15 }, { success: true, path: 'a.js' }),
    [{ path: 'a.js', op: 'edit', range: [10, 15], content_hash: null }],
    'delete_lines → edit op with range'
);

T.deepEq(
    extractFileOps('edit_file', { path: 'b.js', operation: 'replace', start_line: 1, end_line: 5 }, { success: true, path: 'b.js' }),
    [{ path: 'b.js', op: 'edit', range: [1, 5], content_hash: null }],
    'edit_file replace operation'
);

T.deepEq(
    extractFileOps('edit_file', { path: 'b.js', operation: 'insert', after_line: 7 }, { success: true, path: 'b.js' }),
    [{ path: 'b.js', op: 'edit', range: [7, 7], content_hash: null }],
    'edit_file insert operation'
);

T.suite('Turn enrichment — extractFileOps (reads)');

T.deepEq(
    extractFileOps('read_lines', { path: 'a.js', start_line: 1, end_line: 50 }, { path: 'a.js', start_line: 1, end_line: 50 }),
    [{ path: 'a.js', op: 'read', range: [1, 50], content_hash: null }],
    'read_lines → read op with range'
);

T.deepEq(
    extractFileOps('read_current_file', {}, { path: 'a.js', content: '...', line_count: 50 }),
    [{ path: 'a.js', op: 'read', range: null, content_hash: null }],
    'read_current_file → read op, null range'
);

T.deepEq(
    extractFileOps('read_file', { path: 'a.js' }, { path: 'a.js', content: '...' }),
    [{ path: 'a.js', op: 'read', range: null, content_hash: null }],
    'read_file → read op, null range'
);

T.deepEq(
    extractFileOps('scan_file', { path: 'a.js' }, { path: 'a.js', outline: [] }),
    [{ path: 'a.js', op: 'read', range: null, content_hash: null }],
    'scan_file → read op, null range (metadata read)'
);

T.deepEq(
    extractFileOps('peek_read_lines', { path: 'src/a.js', start_line: 1, end_line: 30 }, { path: 'src/a.js', start_line: 1, end_line: 30 }),
    [{ path: 'src/a.js', op: 'read', range: [1, 30], content_hash: null }],
    'peek_read_lines → read op with range'
);

T.suite('Turn enrichment — extractFileOps (multi-path reads)');

T.deepEq(
    extractFileOps('search_in_files', { query: 'foo' }, { results: [{ path: 'a.js' }, { path: 'b.js' }, { path: 'a.js' }] }),
    [
        { path: 'a.js', op: 'read', range: null, content_hash: null },
        { path: 'b.js', op: 'read', range: null, content_hash: null },
    ],
    'search_in_files → one read per result, deduped'
);

T.deepEq(
    extractFileOps('find_references', { symbol: 'foo' }, { references: [{ path: 'a.js' }, { path: 'b.js' }] }),
    [
        { path: 'a.js', op: 'read', range: null, content_hash: null },
        { path: 'b.js', op: 'read', range: null, content_hash: null },
    ],
    'find_references → one read per reference path'
);

T.suite('Turn enrichment — extractFileOps (writes + graceful no-ops)');

T.deepEq(
    extractFileOps('write_file', { path: 'a.js', content: '...' }, { success: true, path: 'a.js' }),
    [{ path: 'a.js', op: 'write', range: null, content_hash: null }],
    'write_file → write op'
);

T.deepEq(
    extractFileOps('create_file', { path: 'new.js' }, { path: 'new.js' }),
    [{ path: 'new.js', op: 'write', range: null, content_hash: null }],
    'create_file → write op'
);

T.deepEq(
    extractFileOps('delete_file', { path: 'old.js' }, { success: true, path: 'old.js' }),
    [{ path: 'old.js', op: 'write', range: null, content_hash: null }],
    'delete_file → write op'
);

T.deepEq(
    extractFileOps('replace_lines', { start_line: 1, end_line: 5 }, { error: 'STALE LINE NUMBERS' }),
    [],
    'errored result → empty file_ops (rule defaults to Keep)'
);

T.deepEq(extractFileOps('made_up_tool', { x: 1 }, { ok: true }), [], 'unknown tool → empty file_ops');
T.deepEq(extractFileOps('list_open_tabs', {}, { tabs: [] }), [], 'list_open_tabs → empty file_ops');
T.deepEq(extractFileOps('scratchpad_write', { key: 'k', content: 'v' }, { success: true }), [], 'scratchpad_write → empty file_ops');
T.deepEq(extractFileOps('read_file', { path: 'a.js' }, null), [], 'null result → empty file_ops');

T.suite('Turn enrichment — enrichToolResultTurn');

const enriched = enrichToolResultTurn(
    { tool_call_id: 'call_123', role: 'tool', content: '{}', _display: { foo: 'bar' } },
    'replace_lines',
    { start_line: 1, end_line: 5 },
    { success: true, path: 'a.js' }
);

T.eq(enriched.tool_call_id, 'call_123', 'tool_call_id preserved');
T.eq(enriched.tool_result_for, 'call_123', 'tool_result_for echoes tool_call_id');
T.eq(enriched.tool_name, 'replace_lines', 'tool_name set');
T.deepEq(enriched.tool_args, { start_line: 1, end_line: 5 }, 'tool_args set');
T.deepEq(enriched.file_ops, [{ path: 'a.js', op: 'edit', range: [1, 5], content_hash: null }], 'file_ops populated');
T.eq(enriched.role, 'tool', 'role preserved');
T.deepEq(enriched._display, { foo: 'bar' }, '_display preserved untouched');

const reenriched = enrichToolResultTurn(enriched, 'replace_lines', { start_line: 1, end_line: 5 }, { success: true, path: 'a.js' });
T.deepEq(reenriched.file_ops, enriched.file_ops, 'idempotent — re-enriching produces equivalent file_ops');

const e2 = enrichToolResultTurn(
    { tool_call_id: 'c', role: 'tool', content: '{}' },
    'list_open_tabs', {}, { tabs: [] }
);
T.deepEq(e2.file_ops, [], 'non-file tool → file_ops:[] (not undefined)');

T.suite('Turn enrichment — sanitizeMessages strips new fields at API boundary');

const turn = enrichToolResultTurn(
    { tool_call_id: 'call_1', role: 'tool', content: '{"path":"a.js"}' },
    'read_file',
    { path: 'a.js' },
    { path: 'a.js', content: '...' }
);

const [sanitized] = sanitizeMessages([turn]);
T.eq(sanitized.role, 'tool', 'sanitized role preserved');
T.eq(sanitized.tool_call_id, 'call_1', 'sanitized tool_call_id preserved');
T.eq(sanitized.content, '{"path":"a.js"}', 'sanitized content preserved');
T.eq(sanitized.tool_name, undefined, 'sanitized excludes tool_name');
T.eq(sanitized.tool_args, undefined, 'sanitized excludes tool_args');
T.eq(sanitized.tool_result_for, undefined, 'sanitized excludes tool_result_for');
T.eq(sanitized.file_ops, undefined, 'sanitized excludes file_ops');
T.eq(sanitized._display, undefined, 'sanitized excludes _display');
