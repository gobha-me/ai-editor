/**
 * Tests for invalidateCachesForPath — the 1.7.1 fix for the
 * edit_file ↔ read-cache cross-request deadlock (gitea#301).
 *
 * The helper has zero dependencies on browser globals, so it tests
 * cleanly under node --test with no shim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    invalidateCachesForPath,
    invalidateCachesForPreviewMutation,
} from '../js/chat/cache-invalidation.js';

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

// ============================================================================
// invalidateCachesForPreviewMutation — github#39 (the deadlock repro)
//
// Same recurring cache-invalidation-on-mutation pattern as gitea#301 above,
// but session-keyed instead of path-keyed: preview_stop({serverId}) doesn't
// carry the original preview_start({path}) arg, so we evict by tool prefix
// rather than args match. The active server set is bounded by ~1 in
// practice, so coarse-grained eviction is fine.
// ============================================================================

test('preview_stop invalidates preview_start cache for any args (github#39 deadlock repro)', () => {
    const toolCallCache = new Map();
    const toolActionLog = [];

    // Pre-stop: model started a preview.
    toolCallCache.set(keyFor('preview_start', { path: 'tetris/index.html' }), {
        serverId: 'srv_dead', url: 'http://localhost:1234', reused: false,
    });
    toolActionLog.push({
        tool: 'preview_start',
        args: { path: 'tetris/index.html' },
        resultSummary: 'srv_dead started',
        success: true,
    });

    // Now stop: must invalidate so the next preview_start doesn't hit a
    // cached envelope pointing at the now-dead serverId.
    const r = invalidateCachesForPreviewMutation({
        toolName: 'preview_stop',
        toolCallCache,
        toolActionLog,
    });

    assert.equal(r.evictedCache, 1, 'one same-request cache entry evicted');
    assert.equal(r.evictedLog, 1, 'one cross-request log entry evicted');
    assert.equal(toolCallCache.size, 0, 'toolCallCache is empty');
    assert.equal(toolActionLog.length, 0, 'toolActionLog is empty');
});

test('preview_stop also invalidates preview_list cache (server set just changed)', () => {
    const toolCallCache = new Map();
    const toolActionLog = [
        { tool: 'preview_list', args: {}, resultSummary: '1 server', success: true },
    ];
    toolCallCache.set(keyFor('preview_list', {}), { servers: [{ serverId: 'srv_X' }] });

    const r = invalidateCachesForPreviewMutation({
        toolName: 'preview_stop',
        toolCallCache,
        toolActionLog,
    });

    assert.equal(r.evictedCache, 1);
    assert.equal(r.evictedLog, 1);
    assert.equal(toolCallCache.size, 0);
    assert.equal(toolActionLog.length, 0);
});

test('preview_stop leaves unrelated tool entries alone', () => {
    const toolCallCache = new Map();
    const toolActionLog = [
        { tool: 'read_lines', args: { path: 'foo.js', start_line: 1, end_line: 10 }, success: true },
        { tool: 'preview_start', args: { path: 'foo.html' }, success: true },
    ];
    toolCallCache.set(keyFor('read_lines', { path: 'foo.js', start_line: 1, end_line: 10 }), {});
    toolCallCache.set(keyFor('preview_start', { path: 'foo.html' }), {});

    const r = invalidateCachesForPreviewMutation({
        toolName: 'preview_stop',
        toolCallCache,
        toolActionLog,
    });

    assert.equal(r.evictedCache, 1, 'only preview_start evicted, read_lines kept');
    assert.equal(r.evictedLog, 1);
    assert.equal(toolActionLog.length, 1);
    assert.equal(toolActionLog[0].tool, 'read_lines');
    assert.ok(toolCallCache.has(keyFor('read_lines', { path: 'foo.js', start_line: 1, end_line: 10 })));
});

test('non-preview-mutator is a no-op for the preview helper', () => {
    const toolCallCache = new Map();
    toolCallCache.set(keyFor('preview_start', { path: 'foo.html' }), { serverId: 'X' });
    const toolActionLog = [
        { tool: 'preview_start', args: { path: 'foo.html' }, success: true },
    ];

    const r = invalidateCachesForPreviewMutation({
        toolName: 'edit_file',  // file mutator, not a preview mutator
        toolCallCache,
        toolActionLog,
    });

    assert.equal(r.evictedCache, 0);
    assert.equal(r.evictedLog, 0);
    assert.equal(toolCallCache.size, 1);
    assert.equal(toolActionLog.length, 1);
});

test('preview helper preserves toolActionLog reference (in-place mutation)', () => {
    const toolCallCache = new Map();
    const toolActionLog = [
        { tool: 'preview_start', args: { path: 'foo.html' }, success: true },
    ];
    const ref = toolActionLog;

    invalidateCachesForPreviewMutation({
        toolName: 'preview_stop',
        toolCallCache,
        toolActionLog,
    });

    // Mirror the path-helper invariant: State.toolActionLog is held by
    // reference all over handlers.js; the helper must mutate in place.
    assert.strictEqual(toolActionLog, ref, 'array identity preserved');
    assert.equal(toolActionLog.length, 0, 'array contents updated');
});
