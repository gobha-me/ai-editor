// @ts-check
/**
 * Tests for js/pr-review/review-state.js — draft queue + viewed + resolved-local
 * + the pure helpers (`groupDraftsByThread`, `draftAnchorKey`).
 *
 * @since 2.13.0 (Touch 3 PR Review surface — slice 2)
 */

import './_node-shim.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    addDraft,
    getDrafts,
    removeDraft,
    clearDrafts,
    getViewed,
    isFileViewed,
    toggleViewed,
    getResolvedLocal,
    isThreadResolvedLocal,
    markResolvedLocal,
    unmarkResolvedLocal,
    draftAnchorKey,
    groupDraftsByThread,
    _resetForTests,
} from '../js/pr-review/review-state.js';

beforeEach(() => {
    _resetForTests();
    if (typeof globalThis.localStorage?.clear === 'function') {
        globalThis.localStorage.clear();
    }
});

// ============================================
// Pure helpers
// ============================================

test('draftAnchorKey: matches the slice-1 commentsByAnchor key shape', () => {
    assert.equal(
        draftAnchorKey({ path: 'src/app.js', side: 'RIGHT', line: 42 }),
        'src/app.js::RIGHT::42'
    );
    assert.equal(
        draftAnchorKey({ path: 'a.txt', side: 'LEFT', line: 1 }),
        'a.txt::LEFT::1'
    );
});

test('groupDraftsByThread: empty list returns empty Map', () => {
    const m = groupDraftsByThread([]);
    assert.equal(m.size, 0);
});

test('groupDraftsByThread: groups multiple drafts on same anchor', () => {
    const drafts = [
        { id: '1', path: 'a.js', side: 'RIGHT', line: 10, body: 'x', createdAt: 0 },
        { id: '2', path: 'a.js', side: 'RIGHT', line: 10, body: 'y', createdAt: 0 },
        { id: '3', path: 'b.js', side: 'LEFT', line: 5, body: 'z', createdAt: 0 },
    ];
    const m = groupDraftsByThread(drafts);
    assert.equal(m.size, 2);
    assert.equal(m.get('a.js::RIGHT::10').length, 2);
    assert.equal(m.get('b.js::LEFT::5').length, 1);
});

// ============================================
// Drafts CRUD
// ============================================

test('addDraft: appends a draft with auto id + createdAt', () => {
    const d = addDraft(7, { path: 'a.js', line: 1, side: 'RIGHT', body: 'hello' });
    assert.equal(typeof d.id, 'string');
    assert.ok(d.id.length > 0);
    assert.equal(typeof d.createdAt, 'number');
    assert.equal(d.path, 'a.js');
    assert.equal(getDrafts(7).length, 1);
});

test('addDraft: invalid shape throws', () => {
    assert.throws(() => addDraft(8, { path: 'a.js', line: 1, side: 'WRONG', body: 'x' }));
    assert.throws(() => addDraft(8, { path: 'a.js', side: 'RIGHT', body: 'x' }));
});

test('removeDraft: drops by id, no-op when absent', () => {
    const d1 = addDraft(9, { path: 'a.js', line: 1, side: 'RIGHT', body: 'x' });
    const d2 = addDraft(9, { path: 'a.js', line: 2, side: 'RIGHT', body: 'y' });
    removeDraft(9, d1.id);
    const remaining = getDrafts(9);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, d2.id);
    removeDraft(9, 'nonexistent');
    assert.equal(getDrafts(9).length, 1);
});

test('clearDrafts: empties for the PR but keeps other PRs intact', () => {
    addDraft(10, { path: 'a.js', line: 1, side: 'RIGHT', body: 'x' });
    addDraft(11, { path: 'b.js', line: 2, side: 'LEFT', body: 'y' });
    clearDrafts(10);
    assert.equal(getDrafts(10).length, 0);
    assert.equal(getDrafts(11).length, 1);
});

// ============================================
// localStorage round-trip — drafts persist across module re-init
// ============================================

test('drafts persist via localStorage round-trip', () => {
    addDraft(12, { path: 'a.js', line: 5, side: 'RIGHT', body: 'persist me' });
    // Drop in-memory state but leave localStorage intact — simulates reload.
    _resetForTests();
    const restored = getDrafts(12);
    assert.equal(restored.length, 1);
    assert.equal(restored[0].body, 'persist me');
    assert.equal(restored[0].line, 5);
});

test('drafts persistence is per-PR (no cross-pollination)', () => {
    addDraft(13, { path: 'a.js', line: 1, side: 'RIGHT', body: 'pr-13' });
    addDraft(14, { path: 'a.js', line: 1, side: 'RIGHT', body: 'pr-14' });
    _resetForTests();
    assert.equal(getDrafts(13)[0].body, 'pr-13');
    assert.equal(getDrafts(14)[0].body, 'pr-14');
});

// ============================================
// Viewed-set
// ============================================

test('toggleViewed flips and reports new state', () => {
    assert.equal(isFileViewed(15, 'a.js'), false);
    assert.equal(toggleViewed(15, 'a.js'), true);
    assert.equal(isFileViewed(15, 'a.js'), true);
    assert.equal(toggleViewed(15, 'a.js'), false);
    assert.equal(isFileViewed(15, 'a.js'), false);
});

test('viewed set persists via localStorage round-trip', () => {
    toggleViewed(16, 'a.js');
    toggleViewed(16, 'b.js');
    _resetForTests();
    const restored = getViewed(16);
    assert.equal(restored.size, 2);
    assert.equal(restored.has('a.js'), true);
    assert.equal(restored.has('b.js'), true);
});

// ============================================
// Resolved-local (in-memory only)
// ============================================

test('markResolvedLocal + isThreadResolvedLocal flow', () => {
    assert.equal(isThreadResolvedLocal(17, 'thread-1'), false);
    markResolvedLocal(17, 'thread-1');
    assert.equal(isThreadResolvedLocal(17, 'thread-1'), true);
    unmarkResolvedLocal(17, 'thread-1');
    assert.equal(isThreadResolvedLocal(17, 'thread-1'), false);
});

test('resolvedLocal does NOT persist across reset (in-memory only)', () => {
    markResolvedLocal(18, 'thread-A');
    assert.equal(isThreadResolvedLocal(18, 'thread-A'), true);
    _resetForTests();
    assert.equal(isThreadResolvedLocal(18, 'thread-A'), false);
    assert.equal(getResolvedLocal(18).size, 0);
});
