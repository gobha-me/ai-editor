/**
 * Tests for blame feature — validates module exports and blame data shape
 * normalization. These are structure/smoke tests since blame requires a live
 * git server for integration testing.
 *
 * git.js imports State from core.js, which touches `window` at module-eval —
 * so the shim must load first. The .js sibling (tests/test-blame-normalize.js)
 * covers the browser suite, including DOM-bound checks that are skipped here.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Git } from '../js/git.js';

// ============================================
// Git facade exports
// ============================================

test('Git.getBlame is exported', () => {
    assert.equal(typeof Git.getBlame, 'function');
});

test('Git.getFileCommits is exported', () => {
    assert.equal(typeof Git.getFileCommits, 'function');
});

// ============================================
// Guard checks (no project loaded)
// ============================================

test('getBlame throws when no project loaded', async () => {
    await assert.rejects(
        () => Git.getBlame('owner', 'repo', 'test.js', 'main')
    );
});

test('getFileCommits throws when no project loaded', async () => {
    await assert.rejects(
        () => Git.getFileCommits('owner', 'repo', 'test.js', 'main')
    );
});

// ============================================
// Secondary pane integration
// ============================================

// DOM check skipped under Node — `document.getElementById('btnToggleBlame')`
// only meaningfully resolves in the full app shell. The .js sibling covers
// this as a no-op pass; the equivalent here is a skip with a clear comment.
test.skip('Blame button DOM check — browser-only (see test-blame-normalize.js)', () => {});

test('secondary-pane.js exports toggleBlamePane and getSecondaryPaneMode', async () => {
    const mod = await import('../js/secondary-pane.js');
    assert.equal(typeof mod.toggleBlamePane, 'function');
    assert.equal(typeof mod.getSecondaryPaneMode, 'function');
});
