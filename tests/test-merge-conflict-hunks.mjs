/**
 * Pure-helper tests for js/merge-conflict/hunks.js — Touch 3 Merge Conflict
 * Resolver slice 1 (2.18.0).
 *
 * Browser-free module — no _node-shim.mjs needed (`hunks.js` inlines its
 * own Myers diff and imports nothing from `js/core.js`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    extractHunks,
    splitLines,
    joinLines,
} from '../js/merge-conflict/hunks.js';

// ============================================
// splitLines / joinLines round-trip
// ============================================

test('splitLines + joinLines round-trips empty string', () => {
    assert.equal(joinLines(splitLines('')), '');
});

test('splitLines + joinLines round-trips single line, no terminator', () => {
    assert.equal(joinLines(splitLines('hello')), 'hello');
});

test('splitLines + joinLines round-trips trailing newline', () => {
    assert.equal(joinLines(splitLines('a\nb\n')), 'a\nb\n');
});

test('splitLines + joinLines round-trips CRLF lines', () => {
    assert.equal(joinLines(splitLines('a\r\nb\r\n')), 'a\r\nb\r\n');
});

test('splitLines tolerates null / undefined', () => {
    assert.deepEqual(splitLines(null), []);
    assert.deepEqual(splitLines(undefined), []);
});

// ============================================
// extractHunks — clean / no-conflict
// ============================================

test('extractHunks returns [] for identical files', () => {
    assert.deepEqual(extractHunks('a\nb\nc', 'a\nb\nc'), []);
});

test('extractHunks returns [] for two empty files', () => {
    assert.deepEqual(extractHunks('', ''), []);
});

// ============================================
// extractHunks — single hunk
// ============================================

test('extractHunks returns single hunk for a one-line edit', () => {
    const base = 'a\nb\nc';
    const head = 'a\nB\nc';
    const hunks = extractHunks(base, head);
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].id, 0);
    assert.equal(hunks[0].lineNo, 2);
    assert.deepEqual(hunks[0].theirs, ['b']);
    assert.deepEqual(hunks[0].ours, ['B']);
});

test('extractHunks captures multi-line hunks correctly', () => {
    const base = 'a\nb\nc\nd';
    const head = 'a\nX\nY\nd';
    const hunks = extractHunks(base, head);
    assert.equal(hunks.length, 1);
    assert.deepEqual(hunks[0].theirs, ['b', 'c']);
    assert.deepEqual(hunks[0].ours, ['X', 'Y']);
    assert.equal(hunks[0].lineNo, 2);
});

// ============================================
// extractHunks — multiple hunks + ids stable
// ============================================

test('extractHunks returns separate hunks across context lines, with stable ids', () => {
    const base = 'a\nb\nc\nd\ne\nf\ng';
    const head = 'a\nB\nc\nd\ne\nF\ng';
    const hunks = extractHunks(base, head);
    assert.equal(hunks.length, 2);
    assert.equal(hunks[0].id, 0);
    assert.equal(hunks[1].id, 1);
    assert.deepEqual(hunks[0].theirs, ['b']);
    assert.deepEqual(hunks[0].ours, ['B']);
    assert.deepEqual(hunks[1].theirs, ['f']);
    assert.deepEqual(hunks[1].ours, ['F']);
});

// ============================================
// extractHunks — pure-insert and pure-delete
// ============================================

test('extractHunks handles pure-insert (theirs empty)', () => {
    const base = 'a\nb';
    const head = 'a\nb\nNEW';
    const hunks = extractHunks(base, head);
    assert.equal(hunks.length, 1);
    assert.deepEqual(hunks[0].theirs, []);
    assert.deepEqual(hunks[0].ours, ['NEW']);
    // Anchor: 1-based line *after* the last equal — base has 2 equal lines,
    // so anchor = 3 (the position where the insert would go).
    assert.equal(hunks[0].lineNo, 3);
});

test('extractHunks handles pure-delete (ours empty)', () => {
    const base = 'a\nDEL\nb';
    const head = 'a\nb';
    const hunks = extractHunks(base, head);
    assert.equal(hunks.length, 1);
    assert.deepEqual(hunks[0].theirs, ['DEL']);
    assert.deepEqual(hunks[0].ours, []);
    assert.equal(hunks[0].lineNo, 2);
});

test('extractHunks handles insert at file start (no preceding equal)', () => {
    const base = 'b';
    const head = 'a\nb';
    const hunks = extractHunks(base, head);
    assert.equal(hunks.length, 1);
    assert.deepEqual(hunks[0].theirs, []);
    assert.deepEqual(hunks[0].ours, ['a']);
    assert.equal(hunks[0].lineNo, 1);
});

// ============================================
// extractHunks — CRLF preservation
// ============================================

test('extractHunks preserves CRLF in line content', () => {
    const base = 'a\r\nb\r\nc';
    const head = 'a\r\nB\r\nc';
    const hunks = extractHunks(base, head);
    assert.equal(hunks.length, 1);
    assert.deepEqual(hunks[0].theirs, ['b\r']);
    assert.deepEqual(hunks[0].ours, ['B\r']);
});
