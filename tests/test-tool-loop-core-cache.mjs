/**
 * Cross-request read-cache regression for gitea#421.
 *
 * Before this fix, `State.toolActionLog` entries held only `resultSummary`
 * (a short string like `"189 lines"`). The cross-request dup-cache branch
 * in `runToolLoop` therefore returned a useless stub envelope when a model
 * called a read-only tool with identical args across two separate requests:
 *
 *     { _cached: true, _cache_note: "[…The result was: 1: # AGENTS.md…]", error: null }
 *
 * The model was told "don't call again" but never given the data back, so
 * it pivoted — usually wasting 2-3 requests before `DUP_REFUSE_THRESHOLD`
 * fired. In a 42-request HTML-Games dogfood session (2026-05-14, qwen-3-6-plus)
 * this surface burned ~5 requests / ~100k tokens / ~$0.07.
 *
 * Fix: extend `toolActionLog` entries with an optional `result` field, gated
 * to non-write / non-stateful-read tools and capped at 64 KB per entry.
 * The read site at `tool-loop-core.js` branch 368-381 reads the new field
 * via `buildCrossRequestCacheResult` and returns the full payload when
 * present (or the legacy stub envelope as fallback).
 *
 * These tests pin the helper behavior end-to-end without mocking
 * `runToolLoop`'s executor (per the existing project decision documented in
 * `tests/test-tool-loop-core.mjs`):
 *
 *   1. `buildToolActionLogEntry` persists `result` for read-family tools.
 *   2. `buildToolActionLogEntry` SKIPS `result` for `WRITE_TOOLS` /
 *      `STATEFUL_READ_TOOLS` / oversized results / error results /
 *      non-serializable results.
 *   3. `buildCrossRequestCacheResult` returns full payload when entry has
 *      `result`, summary stub when it doesn't.
 *   4. `findMatchingCrossRequestEntry` (existing) + the new fields
 *      round-trip — args-shape variation still matches; persisted `result`
 *      survives in the returned entry.
 *   5. `invalidateCachesForPath` drops `result` along with its entry on
 *      mutation (regression guard for gitea#301 ↔ #421 interaction).
 *
 * Runs under `node --test`. No browser-shim needed — `cache-invalidation.js`
 * touches no DOM or `State`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildToolActionLogEntry,
    buildCrossRequestCacheResult,
    findMatchingCrossRequestEntry,
    invalidateCachesForPath,
    TOOL_ACTION_LOG_RESULT_CAP_BYTES,
} from '../js/chat/cache-invalidation.js';

const WRITE_TOOLS = Object.freeze([
    'replace_lines', 'insert_lines', 'delete_lines',
    'create_file', 'edit_file', 'write_file', 'delete_file',
    'update_issue', 'add_issue_comment',
]);
const STATEFUL_READ_TOOLS = Object.freeze(['read_current_file', 'ask_user']);
const MUTATING_TOOLS = Object.freeze([
    'commit_files', 'create_issue', 'create_pull_request', 'merge_pull_request',
    'add_pr_review', 'memory_remember', 'memory_revise', 'scratchpad_write',
]);

// ============================================
// buildToolActionLogEntry — gating axes
// ============================================

test('buildToolActionLogEntry persists `result` for a successful read_file call', () => {
    const toolResult = { content: '1: # AGENTS.md\n2: # conventions\n', lines: 2 };
    const entry = buildToolActionLogEntry({
        toolName: 'read_file',
        args: { path: 'AGENTS.md' },
        toolResult,
        resultSummary: '2 lines',
        WRITE_TOOLS,
        STATEFUL_READ_TOOLS,
    });
    assert.equal(entry.tool, 'read_file');
    assert.equal(entry.success, true);
    assert.equal(entry.resultSummary, '2 lines');
    assert.deepEqual(entry.result, toolResult, 'result is persisted verbatim');
});

test('buildToolActionLogEntry SKIPS `result` for WRITE_TOOLS (edit_file)', () => {
    const entry = buildToolActionLogEntry({
        toolName: 'edit_file',
        args: { path: 'a.js' },
        toolResult: { message: 'edited 1 file' },
        resultSummary: 'edited 1 file',
        WRITE_TOOLS,
        STATEFUL_READ_TOOLS,
    });
    assert.equal('result' in entry, false, 'WRITE_TOOLS never persist result — every retry must re-execute');
});

test('buildToolActionLogEntry SKIPS `result` for STATEFUL_READ_TOOLS (read_current_file)', () => {
    const entry = buildToolActionLogEntry({
        toolName: 'read_current_file',
        args: {},
        toolResult: { content: 'whatever was active' },
        resultSummary: '1 lines',
        WRITE_TOOLS,
        STATEFUL_READ_TOOLS,
    });
    assert.equal('result' in entry, false, 'stateful reads depend on hidden State; never cache cross-request');
});

test('buildToolActionLogEntry SKIPS `result` when tool returned an error', () => {
    const entry = buildToolActionLogEntry({
        toolName: 'read_file',
        args: { path: 'missing.md' },
        toolResult: { error: 'file not found' },
        resultSummary: 'Error: file not found',
        WRITE_TOOLS,
        STATEFUL_READ_TOOLS,
    });
    assert.equal(entry.success, false);
    assert.equal('result' in entry, false, 'error results must not be re-served as cached success');
});

test('buildToolActionLogEntry SKIPS `result` when serialized payload exceeds the 64 KB cap', () => {
    // Build a 65 KB content string; JSON.stringify adds wrapping bytes so the cap is comfortably tripped.
    const huge = 'x'.repeat(65 * 1024);
    const entry = buildToolActionLogEntry({
        toolName: 'read_file',
        args: { path: 'huge.txt' },
        toolResult: { content: huge },
        resultSummary: '1 lines',
        WRITE_TOOLS,
        STATEFUL_READ_TOOLS,
    });
    assert.equal('result' in entry, false, 'oversized results fall back to the summary stub');
});

test('buildToolActionLogEntry SKIPS `result` when payload is non-serializable (circular)', () => {
    const circular = { content: 'ok' };
    circular.self = circular;
    const entry = buildToolActionLogEntry({
        toolName: 'read_file',
        args: { path: 'weird' },
        toolResult: circular,
        resultSummary: 'circular',
        WRITE_TOOLS,
        STATEFUL_READ_TOOLS,
    });
    assert.equal('result' in entry, false, 'JSON.stringify throw is swallowed; entry still constructed');
    assert.equal(entry.tool, 'read_file');
    assert.equal(entry.success, true);
});

test('buildToolActionLogEntry exposes the per-entry cap constant for future tuning', () => {
    assert.equal(typeof TOOL_ACTION_LOG_RESULT_CAP_BYTES, 'number');
    assert.ok(TOOL_ACTION_LOG_RESULT_CAP_BYTES >= 32_000 && TOOL_ACTION_LOG_RESULT_CAP_BYTES <= 256_000,
        'cap stays within a sane range (32 KB-256 KB) to bound IDB save cost');
});

test('buildToolActionLogEntry accepts a maxResultBytes override (for tests / future tuning)', () => {
    const entry = buildToolActionLogEntry({
        toolName: 'read_file',
        args: { path: 'a.txt' },
        toolResult: { content: 'hello world' },
        resultSummary: '1 lines',
        WRITE_TOOLS,
        STATEFUL_READ_TOOLS,
        maxResultBytes: 5,  // smaller than the serialized result
    });
    assert.equal('result' in entry, false, 'override is honored');
});

// ============================================
// buildCrossRequestCacheResult — read site
// ============================================

test('buildCrossRequestCacheResult returns full payload when entry has `result` (the fix)', () => {
    const lastEntry = {
        tool: 'read_file',
        args: { path: 'AGENTS.md' },
        resultSummary: '2 lines',
        success: true,
        result: { content: '1: # AGENTS.md\n2: # conventions\n', lines: 2 },
    };
    const out = buildCrossRequestCacheResult({ toolName: 'read_file', lastEntry, MUTATING_TOOLS });
    assert.equal(out.content, '1: # AGENTS.md\n2: # conventions\n', 'full content surfaces');
    assert.equal(out.lines, 2, 'other result fields survive');
    assert.equal(out._cached, true, 'envelope marks _cached');
    assert.ok(out._cache_note.includes('Data above is from the prior call'), 'non-mutating cache_note phrasing');
});

test('buildCrossRequestCacheResult falls back to summary stub when entry lacks `result` (legacy entries)', () => {
    const lastEntry = {
        tool: 'read_file',
        args: { path: 'AGENTS.md' },
        resultSummary: '189 lines',
        success: true,
        // result intentionally absent — pre-2.50.0.2 entries
    };
    const out = buildCrossRequestCacheResult({ toolName: 'read_file', lastEntry, MUTATING_TOOLS });
    assert.equal(out._cached, true);
    assert.equal(out.error, null);
    assert.ok(out._cache_note.includes('189 lines'), 'summary is interpolated into the stub note');
    assert.ok(out._cache_note.includes('Do NOT call'), 'stub note still warns the model not to retry');
    assert.equal('content' in out, false, 'no fake content materialized from thin air');
});

test('buildCrossRequestCacheResult uses MUTATING_TOOLS phrasing for remote-mutation tools', () => {
    const lastEntry = {
        tool: 'create_issue',
        args: { title: 'oregon-trail' },
        resultSummary: 'Status: created',
        success: true,
        result: { issue_number: 42, url: 'https://git.gobha.me/xcaliber/HTML-Games/issues/42' },
    };
    const out = buildCrossRequestCacheResult({ toolName: 'create_issue', lastEntry, MUTATING_TOOLS });
    assert.equal(out.issue_number, 42, 'full result still surfaces for mutating tools');
    assert.ok(out._cache_note.includes('SUCCEEDED'), 'mutating-tool envelope phrasing');
    assert.ok(out._cache_note.includes('do not retry'), 'mutating-tool envelope warns not to re-attempt mutation');
});

test('buildCrossRequestCacheResult handles undefined lastEntry safely (mid-test seeding)', () => {
    const out = buildCrossRequestCacheResult({ toolName: 'read_file', lastEntry: undefined, MUTATING_TOOLS });
    assert.equal(out._cached, true);
    assert.equal(out.error, null);
    assert.ok(out._cache_note.includes('unknown'), 'unknown-summary fallback fires');
});

// ============================================
// Integration: findMatchingCrossRequestEntry + new fields round-trip
// ============================================

test('findMatchingCrossRequestEntry preserves the `result` field on the returned entry (gitea#421 wiring)', () => {
    const toolActionLog = [];
    toolActionLog.push(buildToolActionLogEntry({
        toolName: 'read_lines',
        args: { path: 'AGENTS.md', start_line: 1, end_line: 197 },
        toolResult: { content: '... 197 lines of content ...', lines: 197 },
        resultSummary: '197 lines',
        WRITE_TOOLS,
        STATEFUL_READ_TOOLS,
    }));
    // Cross-request lookup with the SAME args (different key order — must still match via canonicalArgsKey).
    const match = findMatchingCrossRequestEntry({
        toolActionLog,
        toolName: 'read_lines',
        args: { end_line: 197, path: 'AGENTS.md', start_line: 1 },
    });
    assert.ok(match, 'arg-shape variation still matches');
    assert.ok(match.result, 'result field rides through findMatchingCrossRequestEntry');
    assert.equal(match.result.lines, 197);
});

test('end-to-end shape: read → log → match → cache-result returns the real payload', () => {
    const toolActionLog = [];
    const originalResult = { content: '1: hello\n2: world\n', lines: 2 };

    // First call — would persist to the log.
    toolActionLog.push(buildToolActionLogEntry({
        toolName: 'read_file',
        args: { path: 'greet.txt' },
        toolResult: originalResult,
        resultSummary: '2 lines',
        WRITE_TOOLS,
        STATEFUL_READ_TOOLS,
    }));

    // Second request: dup detected, look up the prior entry, build the cache envelope.
    const lastEntry = findMatchingCrossRequestEntry({
        toolActionLog,
        toolName: 'read_file',
        args: { path: 'greet.txt' },
    });
    const toolResult = buildCrossRequestCacheResult({ toolName: 'read_file', lastEntry, MUTATING_TOOLS });

    assert.equal(toolResult.content, '1: hello\n2: world\n', 'second-request read returns the real content, not a stub');
    assert.equal(toolResult.lines, 2);
    assert.equal(toolResult._cached, true);
});

// ============================================
// Regression: gitea#301 mutation-eviction still works with `result` field
// ============================================

test('invalidateCachesForPath drops a log entry AND its persisted `result` together (gitea#301 ↔ #421)', () => {
    const toolCallCache = new Map();
    const toolActionLog = [];

    toolActionLog.push(buildToolActionLogEntry({
        toolName: 'read_lines',
        args: { path: 'index.html', start_line: 1, end_line: 197 },
        toolResult: { content: 'pre-edit content', lines: 197 },
        resultSummary: '197 lines',
        WRITE_TOOLS,
        STATEFUL_READ_TOOLS,
    }));
    assert.ok(toolActionLog[0].result, 'precondition: entry carries result');

    // edit_file on the same path — gitea#301 invalidation.
    const r = invalidateCachesForPath({
        toolName: 'edit_file',
        args: { path: 'index.html' },
        toolCallCache,
        toolActionLog,
        WRITE_TOOLS,
    });

    assert.equal(r.evictedLog, 1, 'log entry evicted');
    assert.equal(toolActionLog.length, 0, 'log entry (and its result payload) gone after mutation');
});

test('invalidateCachesForPath leaves UNRELATED entry (with persisted `result`) alone', () => {
    const toolCallCache = new Map();
    const toolActionLog = [];

    toolActionLog.push(buildToolActionLogEntry({
        toolName: 'read_lines',
        args: { path: 'other.js', start_line: 1, end_line: 50 },
        toolResult: { content: 'unrelated content', lines: 50 },
        resultSummary: '50 lines',
        WRITE_TOOLS,
        STATEFUL_READ_TOOLS,
    }));

    invalidateCachesForPath({
        toolName: 'edit_file',
        args: { path: 'index.html' },
        toolCallCache,
        toolActionLog,
        WRITE_TOOLS,
    });

    assert.equal(toolActionLog.length, 1, 'unrelated-path entry survives');
    assert.ok(toolActionLog[0].result, 'unrelated-path entry KEEPS its persisted result');
    assert.equal(toolActionLog[0].result.lines, 50);
});
