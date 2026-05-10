// @ts-check
/**
 * Tests for the PR Review "Diagnose & fix" pending state module.
 *
 * The state lives outside `review-state.js` because it's transient
 * in-flight UI state, not per-PR persisted UI state. Tests pin
 * isolation across PR numbers and the test-only reset escape hatch.
 *
 * @since 2.14.0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    getPending,
    setPending,
    clearPending,
    _resetForTests,
} from '../js/pr-review/diagnose-state.js';

function fixture(over = {}) {
    return {
        path: 'src/main.js',
        newContent: 'console.log("hi");\n',
        originalContent: 'console.log("ho");\n',
        rationale: 'fixes the assertion',
        jobNames: ['unit'],
        createdAt: 1234,
        ...over,
    };
}

test('getPending returns null when nothing set for the PR number', () => {
    _resetForTests();
    assert.equal(getPending(1), null);
});

test('setPending then getPending returns the stored payload', () => {
    _resetForTests();
    const p = fixture();
    setPending(7, p);
    assert.deepEqual(getPending(7), p);
});

test('isolation across PR numbers — clearing one does not affect another', () => {
    _resetForTests();
    setPending(11, fixture({ path: 'a.js' }));
    setPending(12, fixture({ path: 'b.js' }));
    clearPending(11);
    assert.equal(getPending(11), null);
    assert.equal(getPending(12)?.path, 'b.js');
});

test('clearPending on a PR with no pending state is a no-op', () => {
    _resetForTests();
    clearPending(99);
    assert.equal(getPending(99), null);
});

test('_resetForTests zeros the map', () => {
    setPending(1, fixture());
    setPending(2, fixture());
    _resetForTests();
    assert.equal(getPending(1), null);
    assert.equal(getPending(2), null);
});

test('defensive — non-number PR number is a no-op for set/get/clear', () => {
    _resetForTests();
    // @ts-expect-error — defensive call
    setPending('1', fixture());
    // @ts-expect-error — defensive call
    assert.equal(getPending('1'), null);
    // @ts-expect-error — defensive call
    clearPending('1');
    // Sanity: nothing stored under string-or-number coerced key.
    assert.equal(getPending(1), null);
});

test('setPending overwrites an existing payload for the same PR number', () => {
    _resetForTests();
    setPending(5, fixture({ path: 'old.js' }));
    setPending(5, fixture({ path: 'new.js' }));
    assert.equal(getPending(5)?.path, 'new.js');
});
