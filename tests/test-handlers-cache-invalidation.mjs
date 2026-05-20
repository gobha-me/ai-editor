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
    findMatchingCrossRequestEntry,
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

// ============================================================================
// Tier 3a (2.10.0) — driving tools mutate iframe state; subsequent
// snapshot/inspect reads become stale. Same github#39 pattern as
// preview_stop above. Surfaced by 2026-05-10 qwen-3-6-plus dogfood on
// HTML-Games: snapshot → click → snapshot returned the cached pre-click
// snapshot, breaking the canonical drive-then-verify workflow.
// ============================================================================

test('preview_click invalidates cached preview_snapshot (Tier 3a — drive-then-verify workflow)', () => {
    const toolCallCache = new Map();
    const toolActionLog = [];

    // Pre-click: model snapshotted the page.
    toolCallCache.set(keyFor('preview_snapshot', { serverId: 'srv_X' }), {
        ok: true, elements: [{ uid: 'u_5', tag: 'button', text: '0' }],
    });
    toolActionLog.push({
        tool: 'preview_snapshot',
        args: { serverId: 'srv_X' },
        resultSummary: '74 elements',
        success: true,
    });

    // Click — the dogfood-surfaced workflow. After this, a re-call to
    // preview_snapshot must NOT return the cached pre-click result.
    const r = invalidateCachesForPreviewMutation({
        toolName: 'preview_click',
        toolCallCache,
        toolActionLog,
    });

    assert.equal(r.evictedCache, 1, 'pre-click snapshot evicted from same-request cache');
    assert.equal(r.evictedLog, 1, 'pre-click snapshot evicted from cross-request log');
    assert.equal(toolCallCache.size, 0);
    assert.equal(toolActionLog.length, 0);
});

test('preview_fill invalidates cached preview_snapshot + preview_inspect', () => {
    const toolCallCache = new Map();
    const toolActionLog = [
        { tool: 'preview_snapshot', args: { serverId: 'srv_F' }, success: true },
        { tool: 'preview_inspect',  args: { serverId: 'srv_F', selector: '#name' }, success: true },
    ];
    toolCallCache.set(keyFor('preview_snapshot', { serverId: 'srv_F' }), { elements: [] });
    toolCallCache.set(keyFor('preview_inspect', { serverId: 'srv_F', selector: '#name' }), { textContent: 'old' });

    const r = invalidateCachesForPreviewMutation({
        toolName: 'preview_fill',
        toolCallCache,
        toolActionLog,
    });

    assert.equal(r.evictedCache, 2);
    assert.equal(r.evictedLog, 2);
    assert.equal(toolCallCache.size, 0);
    assert.equal(toolActionLog.length, 0);
});

test('preview_resize invalidates cached preview_snapshot (bbox values change with iframe size)', () => {
    const toolCallCache = new Map();
    const toolActionLog = [
        { tool: 'preview_snapshot', args: { serverId: 'srv_R' }, success: true },
    ];
    toolCallCache.set(keyFor('preview_snapshot', { serverId: 'srv_R' }), { elements: [{ bbox: { w: 1280 } }] });

    const r = invalidateCachesForPreviewMutation({
        toolName: 'preview_resize',
        toolCallCache,
        toolActionLog,
    });

    assert.equal(r.evictedCache, 1);
    assert.equal(r.evictedLog, 1);
});

test('preview_inspect is NOT a mutator — does not invalidate cached snapshots', () => {
    const toolCallCache = new Map();
    const toolActionLog = [
        { tool: 'preview_snapshot', args: { serverId: 'srv_I' }, success: true },
    ];
    toolCallCache.set(keyFor('preview_snapshot', { serverId: 'srv_I' }), { elements: [] });

    const r = invalidateCachesForPreviewMutation({
        toolName: 'preview_inspect',
        toolCallCache,
        toolActionLog,
    });

    assert.equal(r.evictedCache, 0, 'inspect is a pure read');
    assert.equal(r.evictedLog, 0);
    assert.equal(toolCallCache.size, 1);
    assert.equal(toolActionLog.length, 1);
});

test('preview_snapshot is NOT a mutator — does not invalidate its own cache (would defeat dup-refusal)', () => {
    const toolCallCache = new Map();
    toolCallCache.set(keyFor('preview_snapshot', { serverId: 'srv_S' }), { elements: [] });
    const toolActionLog = [
        { tool: 'preview_snapshot', args: { serverId: 'srv_S' }, success: true },
    ];

    const r = invalidateCachesForPreviewMutation({
        toolName: 'preview_snapshot',
        toolCallCache,
        toolActionLog,
    });

    assert.equal(r.evictedCache, 0);
    assert.equal(r.evictedLog, 0);
    assert.equal(toolCallCache.size, 1);
});

// ============================================================================
// findMatchingCrossRequestEntry — fix for the dogfood-surfaced
// cache_note-shows-wrong-previous-result bug. Same tool, different args
// across the conversation; the synth must point at the matching-args
// entry, not the latest-by-name.
// ============================================================================

test('findMatchingCrossRequestEntry returns the matching-args entry (not latest-by-name)', () => {
    const toolActionLog = [
        { tool: 'preview_start', args: { path: 'index.html' },         resultSummary: 'srv_A started', success: true },
        { tool: 'preview_start', args: { path: 'sokoban/index.html' }, resultSummary: 'srv_B started', success: true },
        { tool: 'preview_start', args: { path: 'tetris/index.html' },  resultSummary: 'srv_C started', success: true },
    ];
    const e = findMatchingCrossRequestEntry({
        toolActionLog,
        toolName: 'preview_start',
        args: { path: 'index.html' },
    });
    assert.ok(e, 'matching entry found');
    assert.equal(e.resultSummary, 'srv_A started', 'returns the matching-args entry, not the latest');
});

test('findMatchingCrossRequestEntry returns the most-recent matching entry when args repeat', () => {
    const toolActionLog = [
        { tool: 'preview_snapshot', args: { serverId: 'srv_X' }, resultSummary: 'first call',  success: true },
        { tool: 'preview_click',    args: { serverId: 'srv_X', selector: '#a' }, success: true },
        { tool: 'preview_snapshot', args: { serverId: 'srv_X' }, resultSummary: 'second call', success: true },
    ];
    const e = findMatchingCrossRequestEntry({
        toolActionLog,
        toolName: 'preview_snapshot',
        args: { serverId: 'srv_X' },
    });
    assert.equal(e.resultSummary, 'second call', 'most-recent matching entry wins');
});

test('findMatchingCrossRequestEntry skips failed entries', () => {
    const toolActionLog = [
        { tool: 'preview_start', args: { path: 'index.html' }, resultSummary: 'failed',    success: false },
        { tool: 'preview_start', args: { path: 'index.html' }, resultSummary: 'succeeded', success: true },
    ];
    const e = findMatchingCrossRequestEntry({
        toolActionLog,
        toolName: 'preview_start',
        args: { path: 'index.html' },
    });
    assert.equal(e.resultSummary, 'succeeded');
});

test('findMatchingCrossRequestEntry returns undefined when no match exists', () => {
    const toolActionLog = [
        { tool: 'preview_start', args: { path: 'index.html' }, success: true },
    ];
    const e = findMatchingCrossRequestEntry({
        toolActionLog,
        toolName: 'preview_start',
        args: { path: 'sokoban/index.html' },
    });
    assert.equal(e, undefined);
});

test('findMatchingCrossRequestEntry handles empty / non-array toolActionLog', () => {
    assert.equal(findMatchingCrossRequestEntry({ toolActionLog: [], toolName: 'x', args: {} }), undefined);
    assert.equal(findMatchingCrossRequestEntry({ toolActionLog: null, toolName: 'x', args: {} }), undefined);
    assert.equal(findMatchingCrossRequestEntry({ toolName: 'x', args: {} }), undefined);
});

// ============================================================================
// gitea#472 (2.71.0) — `list_dirty_files` is a no-arg aggregating read.
// The path-keyed `invalidateCachesForPath` invalidator can't match
// no-arg entries; pre-2.71.0 the dup-cache held a stale `{files: []}`
// envelope across intervening `edit_file` calls. The 2.71.0 fix moves
// classification onto the tool descriptor (`cache: 'never'`) so the
// dup-check at `tool-loop-core.js:336` short-circuits before the
// helper ever runs.
//
// The cache-invalidation helper itself is unchanged; the fix is
// upstream of it. These tests assert that the helper's behavior is
// still correct for the *path-aware* case — list_dirty_files entries
// land in `toolActionLog` (without `result`, because the registration
// declares `cache: 'never'` which `buildToolActionLogEntry` honors),
// but they survive path-keyed invalidation because they have no args.
// The bypass happens earlier, at `isStatefulRead(toolName)`, which the
// `test-tool-cache-classifications.mjs` lint covers.
// ============================================================================

test('list_dirty_files entry survives same-path edit_file invalidation (no-args, path-keyed walk misses it)', () => {
    // Demonstrates the gitea#472 pre-fix state: invalidateCachesForPath
    // does NOT evict the entry because args.path is undefined. The fix
    // lives upstream (registry-driven `cache: 'never'` → skipCache=true
    // at the tool-loop call site), NOT in this helper.
    const toolCallCache = new Map();
    const toolActionLog = [
        { tool: 'list_dirty_files', args: {}, resultSummary: '0 dirty files', success: true },
    ];

    const r = invalidateCachesForPath({
        toolName: 'edit_file',
        args: { path: 'js/somewhere.js' },
        toolCallCache,
        toolActionLog,
        WRITE_TOOLS,
    });

    // The path-keyed walk legitimately misses the no-arg list_dirty_files entry.
    assert.equal(r.evictedLog, 0, 'path-keyed invalidation cannot match a no-arg entry');
    assert.equal(toolActionLog.length, 1, 'entry survives — the fix is the upstream cache bypass, not the invalidator');
    assert.equal(toolActionLog[0].tool, 'list_dirty_files');
});

test('list_dirty_files entry can still be evicted via WRITE_TOOLS preservation rule (history)', () => {
    // Just to confirm we haven't accidentally broken the existing
    // "WRITE_TOOLS entries are preserved" property — list_dirty_files
    // is not a WRITE tool, so it follows the same survival/eviction
    // rules as any other read tool.
    const toolCallCache = new Map();
    const toolActionLog = [
        { tool: 'list_dirty_files', args: {}, resultSummary: '0 files', success: true },
        { tool: 'edit_file', args: { path: 'a.js' }, resultSummary: 'replaced 1-2', success: true },
    ];

    const r = invalidateCachesForPath({
        toolName: 'edit_file',
        args: { path: 'a.js' },
        toolCallCache,
        toolActionLog,
        WRITE_TOOLS,
    });

    // edit_file (a WRITE_TOOL) is preserved as informational history;
    // list_dirty_files has no path-match so it survives too. Both stay.
    assert.equal(r.evictedLog, 0);
    assert.equal(toolActionLog.length, 2);
});

test('findMatchingCrossRequestEntry honors the lookback window', () => {
    const toolActionLog = [];
    // 35 entries with the matching args; only the most-recent 30 should be searched
    for (let i = 0; i < 35; i++) {
        toolActionLog.push({ tool: 'preview_start', args: { path: 'a.html', n: i }, resultSummary: 'r' + i, success: true });
    }
    // Entry index 4 has args {n:4}; with lookback=30, the slice is entries 5..34, so n:4 is OUT
    const e = findMatchingCrossRequestEntry({
        toolActionLog,
        toolName: 'preview_start',
        args: { path: 'a.html', n: 4 },
        lookback: 30,
    });
    assert.equal(e, undefined, 'entry outside lookback window not returned');
    // Entry at the edge of the window (n:5) should be found
    const e2 = findMatchingCrossRequestEntry({
        toolActionLog,
        toolName: 'preview_start',
        args: { path: 'a.html', n: 5 },
        lookback: 30,
    });
    assert.equal(e2.resultSummary, 'r5');
});
