/**
 * Pure-helper tests for js/merge-conflict/resolve.js — Touch 3 Merge
 * Conflict Resolver slice 1 (2.18.0).
 *
 * Browser-free — no _node-shim.mjs needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractHunks } from '../js/merge-conflict/hunks.js';
import { applyResolutions, uniformResolutions } from '../js/merge-conflict/resolve.js';

// ============================================
// applyResolutions — basic round-trips
// ============================================

test('applyResolutions returns input unchanged when both files match', () => {
    assert.equal(applyResolutions('a\nb\nc', 'a\nb\nc', {}), 'a\nb\nc');
});

test('applyResolutions take-theirs reproduces the base file when every hunk picks theirs', () => {
    const base = 'a\nb\nc';
    const head = 'a\nB\nc';
    const hunks = extractHunks(base, head);
    const resolutions = uniformResolutions(hunks, 'theirs');
    assert.equal(applyResolutions(base, head, resolutions), base);
});

test('applyResolutions take-ours reproduces the head file when every hunk picks ours', () => {
    const base = 'a\nb\nc';
    const head = 'a\nB\nc';
    const hunks = extractHunks(base, head);
    const resolutions = uniformResolutions(hunks, 'ours');
    assert.equal(applyResolutions(base, head, resolutions), head);
});

// ============================================
// applyResolutions — mixed picks
// ============================================

test('applyResolutions respects per-hunk choice (mix theirs and ours)', () => {
    const base = 'a\nb\nc\nd\ne\nf\ng';
    const head = 'a\nB\nc\nd\ne\nF\ng';
    const hunks = extractHunks(base, head);
    assert.equal(hunks.length, 2);
    // Hunk 0 → theirs (keep b), hunk 1 → ours (take F)
    const resolutions = { 0: 'theirs', 1: 'ours' };
    assert.equal(
        applyResolutions(base, head, resolutions),
        'a\nb\nc\nd\ne\nF\ng',
    );
});

// ============================================
// applyResolutions — pure-insert / pure-delete
// ============================================

test('applyResolutions take-theirs on a pure-insert hunk drops the inserted lines', () => {
    const base = 'a\nb';
    const head = 'a\nb\nNEW';
    const hunks = extractHunks(base, head);
    const r = uniformResolutions(hunks, 'theirs');
    assert.equal(applyResolutions(base, head, r), 'a\nb');
});

test('applyResolutions take-ours on a pure-delete hunk drops the deleted lines', () => {
    const base = 'a\nDEL\nb';
    const head = 'a\nb';
    const hunks = extractHunks(base, head);
    const r = uniformResolutions(hunks, 'ours');
    assert.equal(applyResolutions(base, head, r), 'a\nb');
});

// ============================================
// applyResolutions — CRLF preservation
// ============================================

test('applyResolutions preserves CRLF terminators', () => {
    const base = 'a\r\nb\r\nc';
    const head = 'a\r\nB\r\nc';
    const hunks = extractHunks(base, head);
    const r = uniformResolutions(hunks, 'ours');
    assert.equal(applyResolutions(base, head, r), head);
});

// ============================================
// applyResolutions — idempotence
// ============================================

test('applyResolutions is idempotent: applying once vs reapplying after re-extracting on the result', () => {
    const base = 'a\nb\nc\nd\ne';
    const head = 'a\nB\nc\nD\ne';
    const hunks1 = extractHunks(base, head);
    const r1 = { 0: 'theirs', 1: 'ours' };
    const resolved = applyResolutions(base, head, r1);
    // Resolved vs head — re-extracting should yield only hunks where the
    // original chose theirs, and re-applying take-theirs reproduces the
    // resolved file unchanged.
    const hunks2 = extractHunks(resolved, head);
    const r2 = uniformResolutions(hunks2, 'theirs');
    assert.equal(applyResolutions(resolved, head, r2), resolved);
});

// ============================================
// applyResolutions — error paths
// ============================================

test('applyResolutions throws on missing resolution for a hunk', () => {
    const base = 'a\nb';
    const head = 'a\nB';
    assert.throws(
        () => applyResolutions(base, head, {}),
        /Incomplete resolutions/,
    );
});

test('applyResolutions throws on unknown choice value', () => {
    const base = 'a\nb';
    const head = 'a\nB';
    assert.throws(
        // @ts-expect-error invalid choice for the test
        () => applyResolutions(base, head, { 0: 'mine' }),
        /Unknown resolution choice/,
    );
});

// ============================================
// uniformResolutions
// ============================================

test('uniformResolutions covers every hunk id', () => {
    const hunks = [
        { id: 0, lineNo: 1, theirs: ['x'], ours: ['y'] },
        { id: 1, lineNo: 5, theirs: ['p'], ours: ['q'] },
        { id: 2, lineNo: 9, theirs: ['m'], ours: ['n'] },
    ];
    const r = uniformResolutions(hunks, 'theirs');
    assert.deepEqual(r, { 0: 'theirs', 1: 'theirs', 2: 'theirs' });
});

test('uniformResolutions returns empty map for empty hunks', () => {
    assert.deepEqual(uniformResolutions([], 'ours'), {});
});
