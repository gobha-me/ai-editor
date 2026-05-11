/**
 * Tests for `js/chat/tool-classifications.js` — the 1.14.2 hoist of the
 * tool-classification sets and the deep-stable cache-key helper.
 *
 * The module is pure data + a pure helper; runs cleanly under `node --test`
 * with no shim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    WRITE_TOOLS,
    WHOLE_FILE_WRITE_TOOLS,
    FILE_MUTATING_TOOLS,
    MUTATING_TOOLS,
    STATEFUL_READ_TOOLS,
    LONG_RUNNING_TOOLS,
    USER_PAUSE_TOOLS,
    canonicalArgsKey,
} from '../js/chat/tool-classifications.js';

// ============================================================================
// Set memberships
// ============================================================================

test('WRITE_TOOLS lists the 9 tools the dup-cache must not serve from', () => {
    assert.deepEqual([...WRITE_TOOLS].sort(), [
        'add_issue_comment',
        'create_file',
        'delete_file',
        'delete_lines',
        'edit_file',
        'insert_lines',
        'replace_lines',
        'update_issue',
        'write_file',
    ]);
});

test('FILE_MUTATING_TOOLS includes open_file but excludes update_issue / add_issue_comment', () => {
    assert.ok(FILE_MUTATING_TOOLS.includes('open_file'),
        'open_file must invalidate file caches (stales read_current_file)');
    assert.ok(!FILE_MUTATING_TOOLS.includes('update_issue'),
        'update_issue is a Git API mutation — does not invalidate file content');
    assert.ok(!FILE_MUTATING_TOOLS.includes('add_issue_comment'),
        'add_issue_comment is a Git API mutation — does not invalidate file content');
});

test('FILE_MUTATING_TOOLS lists the 8 tools that stale file caches', () => {
    assert.deepEqual([...FILE_MUTATING_TOOLS].sort(), [
        'create_file',
        'delete_file',
        'delete_lines',
        'edit_file',
        'insert_lines',
        'open_file',
        'replace_lines',
        'write_file',
    ]);
});

test('WRITE_TOOLS and FILE_MUTATING_TOOLS are frozen', () => {
    assert.ok(Object.isFrozen(WRITE_TOOLS), 'WRITE_TOOLS must be frozen');
    assert.ok(Object.isFrozen(FILE_MUTATING_TOOLS), 'FILE_MUTATING_TOOLS must be frozen');
    assert.throws(
        () => /** @type {string[]} */ (/** @type {unknown} */ (WRITE_TOOLS)).push('bogus'),
        TypeError,
    );
});

// ============================================================================
// 2.25.0 hoist — newly co-located classification sets
// ============================================================================

test('WHOLE_FILE_WRITE_TOOLS lists the 4 whole-file write tools (FileOp metadata axis)', () => {
    assert.deepEqual([...WHOLE_FILE_WRITE_TOOLS].sort(), [
        'create_file',
        'delete_file',
        'write_file',
        'write_plugin_source',
    ]);
});

test('MUTATING_TOOLS lists the 10 remote/persistent mutations (envelope axis)', () => {
    assert.deepEqual([...MUTATING_TOOLS].sort(), [
        'add_pr_review',
        'commit_files',
        'create_issue',
        'create_pull_request',
        'memory_remember',
        'memory_revise',
        'merge_pull_request',
        'scratchpad_clear',
        'scratchpad_write',
        'write_plugin_source',
    ]);
});

test('STATEFUL_READ_TOOLS lists read_current_file + ask_user (hidden-State cache axis)', () => {
    assert.deepEqual([...STATEFUL_READ_TOOLS].sort(), [
        'ask_user',
        'read_current_file',
    ]);
});

test('LONG_RUNNING_TOOLS is the single-member wait_for_ci set', () => {
    assert.deepEqual([...LONG_RUNNING_TOOLS], ['wait_for_ci']);
});

test('USER_PAUSE_TOOLS lists the 3 watchdog-floor user-pause tools', () => {
    assert.deepEqual([...USER_PAUSE_TOOLS].sort(), [
        'ask_user',
        'submit_plan_for_approval',
        'submit_script_for_approval',
    ]);
});

test('Every 2.25.0-hoisted export is frozen', () => {
    for (const [name, set] of [
        ['WHOLE_FILE_WRITE_TOOLS', WHOLE_FILE_WRITE_TOOLS],
        ['MUTATING_TOOLS', MUTATING_TOOLS],
        ['STATEFUL_READ_TOOLS', STATEFUL_READ_TOOLS],
        ['LONG_RUNNING_TOOLS', LONG_RUNNING_TOOLS],
        ['USER_PAUSE_TOOLS', USER_PAUSE_TOOLS],
    ]) {
        assert.ok(Object.isFrozen(set), `${name} must be frozen`);
        assert.throws(
            () => /** @type {string[]} */ (/** @type {unknown} */ (set)).push('bogus'),
            TypeError,
            `${name}.push must throw on frozen array`,
        );
    }
});

// ============================================================================
// Disjointness / subset asserts — the audit's "different-axis" load-bearing case
// ============================================================================

test('Every WHOLE_FILE_WRITE_TOOLS member is classified for cache (WRITE_TOOLS xor MUTATING_TOOLS)', () => {
    // FileOp axis is independent of cache axis — a whole-file writer can
    // either skip the cache (WRITE_TOOLS) or stay-with-envelope (MUTATING_TOOLS).
    // It must do ONE of the two: every file-writer must have decided cache
    // behavior or the dup-detection layer treats it as a default cached read.
    // `write_plugin_source` is the off-diagonal case (whole-file write that
    // gets the envelope, not skip-cache) and is intentional — plugin source
    // is bulky enough that swallowing a re-call would be a real loss, but
    // the model panics on the generic don't-retry warning per github#35.
    for (const t of WHOLE_FILE_WRITE_TOOLS) {
        const inWrite = WRITE_TOOLS.includes(t);
        const inMutating = MUTATING_TOOLS.includes(t);
        assert.ok(inWrite !== inMutating,
            `${t} must be in exactly one of {WRITE_TOOLS, MUTATING_TOOLS} (in-write=${inWrite} in-mutating=${inMutating})`);
    }
});

test('WRITE_TOOLS and MUTATING_TOOLS are disjoint (the audit\'s "different axis" point)', () => {
    // The whole point of the 2.25.0 hoist is making these adjacent so a
    // maintainer scanning the matrix sees they answer different questions:
    // WRITE_TOOLS = "skip the dup-cache entirely"; MUTATING_TOOLS = "stay in
    // cache, but rephrase the envelope". A tool in both is a contradiction.
    for (const t of MUTATING_TOOLS) {
        assert.ok(!WRITE_TOOLS.includes(t),
            `${t} cannot be in both WRITE_TOOLS (skip-cache) and MUTATING_TOOLS (envelope-rephrase) — the axes contradict`);
    }
});

test('STATEFUL_READ_TOOLS and WRITE_TOOLS are disjoint (different cache axes)', () => {
    // STATEFUL_READ_TOOLS bypasses the cache entirely (hidden-state collisions).
    // WRITE_TOOLS also bypasses the cache (fresh-mutation semantics). A tool
    // in both is fine in principle but suggests confused classification —
    // currently the sets don't overlap, and the assertion documents that.
    for (const t of STATEFUL_READ_TOOLS) {
        assert.ok(!WRITE_TOOLS.includes(t),
            `${t} is in STATEFUL_READ_TOOLS — should not also be in WRITE_TOOLS`);
    }
});

// ============================================================================
// canonicalArgsKey — the latent-bug fix
// ============================================================================

test('canonicalArgsKey produces the same string for nested objects with reordered keys', () => {
    const a = { q: { a: 1, b: 2 } };
    const b = { q: { b: 2, a: 1 } };
    assert.equal(canonicalArgsKey(a), canonicalArgsKey(b),
        'nested key order must not affect the cache key');
});

test('canonicalArgsKey handles the latent shape that bites — top-level reorder also matches', () => {
    const a = { path: 'index.html', start_line: 1, end_line: 100 };
    const b = { end_line: 100, path: 'index.html', start_line: 1 };
    assert.equal(canonicalArgsKey(a), canonicalArgsKey(b));
});

test('canonicalArgsKey preserves array order (semantically meaningful)', () => {
    const k1 = canonicalArgsKey({ paths: ['a', 'b', 'c'] });
    const k2 = canonicalArgsKey({ paths: ['c', 'b', 'a'] });
    assert.notEqual(k1, k2, 'array order must matter — paths is a sequence, not a set');
});

test('canonicalArgsKey recurses through arrays of objects', () => {
    const a = { hits: [{ score: 0.9, id: 'x' }, { id: 'y', score: 0.8 }] };
    const b = { hits: [{ id: 'x', score: 0.9 }, { score: 0.8, id: 'y' }] };
    assert.equal(canonicalArgsKey(a), canonicalArgsKey(b),
        'each object inside the array gets canonicalized');
});

test('canonicalArgsKey handles primitives and null', () => {
    assert.equal(canonicalArgsKey(null), 'null');
    assert.equal(canonicalArgsKey(42), '42');
    assert.equal(canonicalArgsKey('hello'), '"hello"');
    assert.equal(canonicalArgsKey(true), 'true');
});

test('canonicalArgsKey handles deeply nested mixed shapes', () => {
    const a = { a: 1, b: { c: { d: { e: 5, f: [{ z: 1, y: 2 }] } } } };
    const b = { b: { c: { d: { f: [{ y: 2, z: 1 }], e: 5 } } }, a: 1 };
    assert.equal(canonicalArgsKey(a), canonicalArgsKey(b));
});

test('canonicalArgsKey on an empty object is the empty-object literal', () => {
    assert.equal(canonicalArgsKey({}), '{}');
});

// ============================================================================
// Regression: the WRITE_TOOLS membership the cross-request dup check relies on
// ============================================================================

test('WRITE_TOOLS includes the issue-tracker write tools (cross-request dup detection — github#17)', () => {
    // Pre-1.14.2 the inline anonymous array at handlers.js:753 (cache-write)
    // matched the named WRITE_TOOLS at :586 (dup-skip) literal-for-literal.
    // The 1.14.2 hoist must not drop those entries — issue-tracker writes
    // would then be cached, and a re-call would silently swallow the new
    // mutation.
    assert.ok(WRITE_TOOLS.includes('update_issue'),
        'update_issue must be in WRITE_TOOLS so its results never cache');
    assert.ok(WRITE_TOOLS.includes('add_issue_comment'),
        'add_issue_comment must be in WRITE_TOOLS so its results never cache');
});
