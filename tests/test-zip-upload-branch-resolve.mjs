/**
 * Tests for the destination-branch resolution helpers in js/zip-upload.js
 * — the segmented control's pure-function contract (Touch 3 zip-flow, 2.20.0).
 *
 * Covers:
 *   - sanitizeBranchSegment — input → safe git-branch segment
 *   - defaultNewBranchName  — zip filename + date → `import/...-YYYY-MM-DD`
 *   - resolveTargetBranch   — segment + state → { branch, mustCreate }
 *
 * No DOM, no Git API — pure functions only.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    sanitizeBranchSegment,
    defaultNewBranchName,
    resolveTargetBranch,
} from '../js/zip-upload.js';

// ============================================
// sanitizeBranchSegment
// ============================================

test('sanitizeBranchSegment leaves safe input untouched', () => {
    assert.equal(sanitizeBranchSegment('feat/foo'), 'feat/foo');
    assert.equal(sanitizeBranchSegment('release-1.2.3'), 'release-1.2.3');
});

test('sanitizeBranchSegment collapses unsafe chars to hyphens', () => {
    assert.equal(sanitizeBranchSegment('feat foo bar'), 'feat-foo-bar');
    assert.equal(sanitizeBranchSegment('weird@!@#name'), 'weird-name');
});

test('sanitizeBranchSegment collapses runs of hyphens from unsafe chars', () => {
    // Spaces become hyphens, then runs of hyphens collapse to one.
    assert.equal(sanitizeBranchSegment('a   b'), 'a-b');
    assert.equal(sanitizeBranchSegment('a@@@b'), 'a-b');
    // Underscores are safe and pass through verbatim.
    assert.equal(sanitizeBranchSegment('foo___bar'), 'foo___bar');
});

test('sanitizeBranchSegment strips leading/trailing hyphens', () => {
    assert.equal(sanitizeBranchSegment('---foo---'), 'foo');
});

test('sanitizeBranchSegment returns empty string for null/undefined/empty', () => {
    assert.equal(sanitizeBranchSegment(null), '');
    assert.equal(sanitizeBranchSegment(undefined), '');
    assert.equal(sanitizeBranchSegment(''), '');
});

// ============================================
// defaultNewBranchName
// ============================================

test('defaultNewBranchName composes import/<sanitized>-YYYY-MM-DD', () => {
    const date = new Date(Date.UTC(2026, 4, 10));
    assert.equal(defaultNewBranchName('ai-editor-main.zip', date), 'import/ai-editor-main-2026-05-10');
});

test('defaultNewBranchName strips .zip case-insensitively', () => {
    const date = new Date(Date.UTC(2026, 0, 1));
    assert.equal(defaultNewBranchName('FOO.ZIP', date), 'import/FOO-2026-01-01');
});

test('defaultNewBranchName falls back to "upload-..." when input empty', () => {
    const date = new Date(Date.UTC(2026, 4, 10));
    assert.equal(defaultNewBranchName('', date), 'import/upload-2026-05-10');
    assert.equal(defaultNewBranchName(null, date), 'import/upload-2026-05-10');
});

test('defaultNewBranchName sanitizes unsafe filename characters', () => {
    const date = new Date(Date.UTC(2026, 4, 10));
    assert.equal(defaultNewBranchName('weird name@!.zip', date), 'import/weird-name-2026-05-10');
});

// ============================================
// resolveTargetBranch
// ============================================

test('resolveTargetBranch segment="current" returns current branch, mustCreate false', () => {
    const out = resolveTargetBranch({ segment: 'current', currentBranch: 'feature-x' });
    assert.deepEqual(out, { branch: 'feature-x', mustCreate: false });
});

test('resolveTargetBranch segment="current" throws when currentBranch missing', () => {
    assert.throws(
        () => resolveTargetBranch({ segment: 'current', currentBranch: '' }),
        /No current branch set/
    );
});

test('resolveTargetBranch segment="newBranch" returns the sanitized name, mustCreate true', () => {
    const out = resolveTargetBranch({
        segment: 'newBranch',
        currentBranch: 'main',
        newBranchName: 'import/my-upload-2026-05-10'
    });
    assert.deepEqual(out, { branch: 'import/my-upload-2026-05-10', mustCreate: true });
});

test('resolveTargetBranch segment="newBranch" sanitizes unsafe input', () => {
    const out = resolveTargetBranch({
        segment: 'newBranch',
        currentBranch: 'main',
        newBranchName: 'has spaces and !@#'
    });
    assert.deepEqual(out, { branch: 'has-spaces-and', mustCreate: true });
});

test('resolveTargetBranch segment="newBranch" throws when newBranchName empty', () => {
    assert.throws(
        () => resolveTargetBranch({ segment: 'newBranch', currentBranch: 'main', newBranchName: '' }),
        /New branch name is required/
    );
});

test('resolveTargetBranch segment="newBranch" throws when sanitization collapses to empty', () => {
    assert.throws(
        () => resolveTargetBranch({ segment: 'newBranch', currentBranch: 'main', newBranchName: '---' }),
        /New branch name is required/
    );
});

test('resolveTargetBranch segment="newSession" throws (Sessions ships later)', () => {
    assert.throws(
        () => resolveTargetBranch({ segment: 'newSession', currentBranch: 'main' }),
        /not available yet/
    );
});

test('resolveTargetBranch throws on unknown segment', () => {
    assert.throws(
        () => resolveTargetBranch({ segment: 'bogus', currentBranch: 'main' }),
        /Unknown destination segment: bogus/
    );
});
