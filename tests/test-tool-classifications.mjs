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
    FILE_MUTATING_TOOLS,
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
