/**
 * Tests for invalidateCachesForPath — the 1.7.1 fix for the
 * edit_file ↔ read-cache cross-request deadlock (gitea#301).
 *
 * The helper has zero dependencies on browser globals, so it tests
 * cleanly under node --test with no shim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invalidateCachesForPath } from '../js/chat/cache-invalidation.js';

const WRITE_TOOLS = [
    'replace_lines', 'insert_lines', 'delete_lines', 'create_file',
    'edit_file', 'write_file', 'delete_file',
    'update_issue', 'add_issue_comment',
];

function keyFor(tool, args) {
    return tool + '|' + JSON.stringify(args, Object.keys(args).sort());
}

test('edit_file on path P evicts read_lines({path:P}) from BOTH caches (gitea#301 repro)', () => {
    const toolCallCache = new Map();
    const toolActionLog = [];

    // Pre-edit: model read the file.
    toolCallCache.set(keyFor('read_lines', { path: 'index.html', start_line: 1, end_line: 197 }), { content: 'pre-edit content' });
    toolActionLog.push({
        tool: 'read_lines',
        args: { path: 'index.html', start_line: 1, end_line: 197 },
        resultSummary: '197 lines',
        success: true,
    });

    // Post-edit invalidation for the same path.
    const r = invalidateCachesForPath({
        toolName: 'edit_file',
        args: { path: 'index.html' },
        toolCallCache,
        toolActionLog,
        WRITE_TOOLS,
    });

    assert.equal(r.evictedCache, 1, 'one same-request cache entry evicted');
    assert.equal(r.evictedLog, 1, 'one cross-request log entry evicted');
    assert.equal(toolCallCache.size, 0, 'toolCallCache is empty');
    assert.equal(toolActionLog.length, 0, 'toolActionLog is empty');
});

test('edit_file on path P leaves read_lines({path:Q}) entries alone', () => {
    const toolCallCache = new Map();
    const toolActionLog = [];

    toolCallCache.set(keyFor('read_lines', { path: 'other.js', start_line: 1, end_line: 50 }), { content: 'unrelated' });
    toolActionLog.push({
        tool: 'read_lines',
        args: { path: 'other.js', start_line: 1, end_line: 50 },
        resultSummary: '50 lines',
        success: true,
    });

    const r = invalidateCachesForPath({
        toolName: 'edit_file',
        args: { path: 'index.html' },
        toolCallCache,
        toolActionLog,
        WRITE_TOOLS,
    });

    assert.equal(r.evictedCache, 0);
    assert.equal(r.evictedLog, 0);
    assert.equal(toolCallCache.size, 1, 'unrelated-path cache survives');
    assert.equal(toolActionLog.length, 1, 'unrelated-path log entry survives');
});

test('open_file evicts read_current_file from BOTH caches', () => {
    const toolCallCache = new Map();
    const toolActionLog = [];

    toolCallCache.set('read_current_file|{}', { content: 'previously-active file' });
    toolActionLog.push({
        tool: 'read_current_file',
        args: {},
        resultSummary: 'old active',
        success: true,
    });

    const r = invalidateCachesForPath({
        toolName: 'open_file',
        args: { path: 'newly-active.js' },
        toolCallCache,
        toolActionLog,
        WRITE_TOOLS,
    });

    assert.equal(r.evictedCache, 1);
    assert.equal(r.evictedLog, 1);
    assert.equal(toolCallCache.size, 0);
    assert.equal(toolActionLog.length, 0);
});

test('WRITE_TOOLS log entries are preserved across invalidation (informational history)', () => {
    const toolCallCache = new Map();
    const toolActionLog = [
        { tool: 'edit_file', args: { path: 'index.html' }, resultSummary: 'replaced 8-9', success: true },
        { tool: 'read_lines', args: { path: 'index.html', start_line: 1, end_line: 50 }, resultSummary: '50 lines', success: true },
        { tool: 'write_file', args: { path: 'index.html' }, resultSummary: 'wrote', success: true },
    ];

    const r = invalidateCachesForPath({
        toolName: 'edit_file',
        args: { path: 'index.html' },
        toolCallCache,
        toolActionLog,
        WRITE_TOOLS,
    });

    assert.equal(r.evictedLog, 1, 'only the read_lines entry is evicted');
    assert.equal(toolActionLog.length, 2, 'both write entries survive');
    assert.deepEqual(toolActionLog.map(e => e.tool), ['edit_file', 'write_file']);
});

test('args.file_path (alternate field) matches just like args.path', () => {
    const toolCallCache = new Map();
    const toolActionLog = [
        { tool: 'read_lines', args: { file_path: 'index.html', start_line: 1, end_line: 10 }, success: true },
        { tool: 'scan_file',   args: { file_path: 'index.html' },                              success: true },
        { tool: 'read_lines', args: { file_path: 'other.js',  start_line: 1, end_line: 10 }, success: true },
    ];

    const r = invalidateCachesForPath({
        toolName: 'edit_file',
        args: { file_path: 'index.html' },
        toolCallCache,
        toolActionLog,
        WRITE_TOOLS,
    });

    assert.equal(r.evictedLog, 2, 'both index.html entries evicted, other.js survives');
    assert.equal(toolActionLog.length, 1);
    assert.equal(toolActionLog[0].args.file_path, 'other.js');
});

test('non-mutating tool is a no-op (no path resolution attempted)', () => {
    const toolCallCache = new Map();
    toolCallCache.set(keyFor('read_lines', { path: 'index.html', start_line: 1, end_line: 5 }), {});
    const toolActionLog = [{ tool: 'read_lines', args: { path: 'index.html' }, success: true }];

    const r = invalidateCachesForPath({
        toolName: 'find_relevant_files',
        args: { query: 'whatever' },
        toolCallCache,
        toolActionLog,
        WRITE_TOOLS,
    });

    assert.equal(r.evictedCache, 0);
    assert.equal(r.evictedLog, 0);
    assert.equal(toolCallCache.size, 1);
    assert.equal(toolActionLog.length, 1);
});

test('mutation with no path/file_path/currentFilePath is a no-op (does not throw)', () => {
    const toolCallCache = new Map();
    toolCallCache.set(keyFor('read_lines', { path: 'index.html', start_line: 1, end_line: 5 }), {});
    const toolActionLog = [{ tool: 'read_lines', args: { path: 'index.html' }, success: true }];

    const r = invalidateCachesForPath({
        toolName: 'edit_file',
        args: {}, // pathological: no path
        currentFilePath: null,
        toolCallCache,
        toolActionLog,
        WRITE_TOOLS,
    });

    assert.equal(r.evictedCache, 0);
    assert.equal(r.evictedLog, 0);
    assert.equal(toolCallCache.size, 1);
    assert.equal(toolActionLog.length, 1);
});

test('toolActionLog reference is preserved (in-place mutation, not replacement)', () => {
    const toolCallCache = new Map();
    const toolActionLog = [
        { tool: 'read_lines', args: { path: 'index.html', start_line: 1, end_line: 10 }, success: true },
    ];
    const ref = toolActionLog;

    invalidateCachesForPath({
        toolName: 'edit_file',
        args: { path: 'index.html' },
        toolCallCache,
        toolActionLog,
        WRITE_TOOLS,
    });

    // State.toolActionLog is held by reference all over handlers.js;
    // the helper must mutate in place rather than replace the array,
    // otherwise other readers see the stale snapshot.
    assert.strictEqual(toolActionLog, ref, 'array identity preserved');
    assert.equal(toolActionLog.length, 0, 'array contents updated');
});
