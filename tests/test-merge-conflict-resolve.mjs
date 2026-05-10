/**
 * Pure-helper tests for js/merge-conflict/resolve.js — Touch 3 Merge
 * Conflict Resolver slice 1 (2.18.0); extended with `'both'` cases in
 * slice 2 (2.19.0).
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

test('applyResolutions preserves CRLF on equal-line runs around an AI-choice hunk', () => {
    // Slice-3 supplementary: the AI emit branch must compose with the
    // existing CRLF-preserving equal-line copy so a single AI hunk inside
    // a CRLF file does not mangle untouched CRLF terminators above/below.
    const base = 'a\r\nb\r\nc\r\nd';
    const head = 'a\r\nb\r\nC\r\nd';
    const hunks = extractHunks(base, head);
    assert.equal(hunks.length, 1);
    const r = { 0: { choice: 'ai', content: ['MERGED'] } };
    assert.equal(applyResolutions(base, head, r), 'a\r\nb\r\nMERGED\r\nd');
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

test('applyResolutions idempotence with mixed string + AI choices', () => {
    // Slice-3 supplementary: re-extracting the resolved file vs head
    // and re-applying take-theirs must round-trip even when one hunk
    // chose AI content that diverges from both sides.
    const base = 'a\nb\nc\nd\ne\nf\ng';
    const head = 'a\nB\nc\nD\ne\nF\ng';
    const hunks = extractHunks(base, head);
    assert.equal(hunks.length, 3);
    const r = {
        0: 'theirs',
        1: { choice: 'ai', content: ['AI-D'] },
        2: 'ours',
    };
    const resolved = applyResolutions(base, head, r);
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
// applyResolutions — 'both' (slice 2 / 2.19.0)
// ============================================

test('applyResolutions take-both on a single edited hunk emits theirs then ours', () => {
    const base = 'a\nb\nc';
    const head = 'a\nB\nc';
    const r = { 0: 'both' };
    assert.equal(applyResolutions(base, head, r), 'a\nb\nB\nc');
});

test('applyResolutions take-both on a multi-line edited hunk concatenates without separator', () => {
    const base = 'a\nb\nc\nd';
    const head = 'a\nX\nY\nd';
    const hunks = extractHunks(base, head);
    const r = uniformResolutions(hunks, 'both');
    assert.equal(applyResolutions(base, head, r), 'a\nb\nc\nX\nY\nd');
});

test('applyResolutions take-both on a pure-insert hunk emits only the inserted ours lines', () => {
    const base = 'a\nb';
    const head = 'a\nb\nNEW1\nNEW2';
    const r = { 0: 'both' };
    assert.equal(applyResolutions(base, head, r), 'a\nb\nNEW1\nNEW2');
});

test('applyResolutions take-both on a pure-delete hunk emits only the deleted theirs lines', () => {
    const base = 'a\nDEL1\nDEL2\nb';
    const head = 'a\nb';
    const r = { 0: 'both' };
    assert.equal(applyResolutions(base, head, r), 'a\nDEL1\nDEL2\nb');
});

test('applyResolutions respects mixed theirs / ours / both across hunks in one file', () => {
    // Three hunks: keep first as theirs, take ours on second, both on third.
    const base = 'a\nb\nc\nd\ne\nf\ng\nh\ni';
    const head = 'a\nB\nc\nD\ne\nF\ng\nH\ni';
    const hunks = extractHunks(base, head);
    assert.equal(hunks.length, 4);
    // h0 → theirs (keep b), h1 → ours (take D), h2 → both (f then F), h3 → both (h then H)
    const r = { 0: 'theirs', 1: 'ours', 2: 'both', 3: 'both' };
    assert.equal(
        applyResolutions(base, head, r),
        'a\nb\nc\nD\ne\nf\nF\ng\nh\nH\ni',
    );
});

test('applyResolutions take-both is a superset: result re-extracted vs head yields only the theirs lines as new hunks', () => {
    const base = 'a\nb\nc';
    const head = 'a\nB\nc';
    const resolved = applyResolutions(base, head, { 0: 'both' });
    assert.equal(resolved, 'a\nb\nB\nc');
    // The resolved file vs head differs only by the extra `b` line — confirms
    // both-mode preserved the theirs content rather than dropping it.
    const followup = extractHunks(resolved, head);
    assert.equal(followup.length, 1);
    assert.deepEqual(followup[0].theirs, ['b']);
    assert.deepEqual(followup[0].ours, []);
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
