/**
 * Tests for isZipDrop in js/zip-upload.js — the window-wide drop event
 * discriminator (Touch 3 zip-flow, 2.20.0).
 *
 * Covers both 'strict' (drop) and 'permissive' (dragover) modes, plus the
 * Firefox quirk where `dataTransfer.items` is empty during dragover.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isZipDrop } from '../js/zip-upload.js';

function makeDt({ types = [], items = [], files = [] } = {}) {
    return { types, items, files };
}

// ============================================
// Negative cases
// ============================================

test('isZipDrop returns false for null/undefined DataTransfer', () => {
    assert.equal(isZipDrop(null), false);
    assert.equal(isZipDrop(undefined), false);
});

test('isZipDrop returns false when types does not include "Files"', () => {
    const dt = makeDt({ types: ['text/plain'], files: [{ name: 'foo.zip' }] });
    assert.equal(isZipDrop(dt), false);
});

test('isZipDrop returns false when files present but no .zip suffix', () => {
    const dt = makeDt({ types: ['Files'], files: [{ name: 'foo.png' }] });
    assert.equal(isZipDrop(dt), false);
});

test('isZipDrop strict mode: returns false without files (no filename available)', () => {
    const dt = makeDt({ types: ['Files'], items: [{ kind: 'file', type: 'application/zip' }] });
    assert.equal(isZipDrop(dt), false);
});

// ============================================
// Positive cases — strict
// ============================================

test('isZipDrop returns true for single .zip file in `files`', () => {
    const dt = makeDt({ types: ['Files'], files: [{ name: 'project.zip' }] });
    assert.equal(isZipDrop(dt), true);
});

test('isZipDrop is case-insensitive on .zip suffix', () => {
    const dt = makeDt({ types: ['Files'], files: [{ name: 'PROJECT.ZIP' }] });
    assert.equal(isZipDrop(dt), true);
});

test('isZipDrop returns true if any file in a multi-drop is a .zip', () => {
    const dt = makeDt({ types: ['Files'], files: [{ name: 'a.txt' }, { name: 'b.zip' }] });
    assert.equal(isZipDrop(dt), true);
});

// ============================================
// Permissive mode (dragover) cases
// ============================================

test('isZipDrop permissive: matches when items has application/zip MIME', () => {
    const dt = makeDt({
        types: ['Files'],
        items: [{ kind: 'file', type: 'application/zip' }]
    });
    assert.equal(isZipDrop(dt, { mode: 'permissive' }), true);
});

test('isZipDrop permissive: matches application/x-zip-compressed (Windows)', () => {
    const dt = makeDt({
        types: ['Files'],
        items: [{ kind: 'file', type: 'application/x-zip-compressed' }]
    });
    assert.equal(isZipDrop(dt, { mode: 'permissive' }), true);
});

test('isZipDrop permissive: matches when items lack MIME (Firefox dragover quirk)', () => {
    const dt = makeDt({
        types: ['Files'],
        items: [{ kind: 'file', type: '' }]
    });
    assert.equal(isZipDrop(dt, { mode: 'permissive' }), true);
});

test('isZipDrop permissive: rejects when items has only non-zip MIME', () => {
    const dt = makeDt({
        types: ['Files'],
        items: [{ kind: 'file', type: 'image/png' }]
    });
    assert.equal(isZipDrop(dt, { mode: 'permissive' }), false);
});

test('isZipDrop permissive: rejects when items has no file kinds', () => {
    const dt = makeDt({
        types: ['Files'],
        items: [{ kind: 'string', type: 'text/plain' }]
    });
    assert.equal(isZipDrop(dt, { mode: 'permissive' }), false);
});

test('isZipDrop permissive: allows overlay when items array is empty (Firefox)', () => {
    const dt = makeDt({ types: ['Files'], items: [] });
    assert.equal(isZipDrop(dt, { mode: 'permissive' }), true);
});

test('isZipDrop permissive: still respects strict filename check when files present', () => {
    const dt = makeDt({
        types: ['Files'],
        items: [{ kind: 'file', type: 'application/zip' }],
        files: [{ name: 'foo.png' }]
    });
    // files present and not .zip → reject (the drop is no longer ambiguous)
    assert.equal(isZipDrop(dt, { mode: 'permissive' }), false);
});
