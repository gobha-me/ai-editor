/**
 * Test-loop settings tab tests (1.4.5).
 *
 * Pure-data assertions: defaults, persistence shape, workspace-settings
 * safelist coverage. The tab's HTML rendering is browser-only and not
 * exercised here.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { State, EventBus } from '../js/core.js';
import { __test__ as tab } from '../js/settings/test-loop-tab.js';
import { isSafelisted } from '../js/intelligence/workspace-settings/safelist.js';

const { _read, _persist, TEST_LOOP_DEFAULTS } = tab;

/* ---------------- Defaults ---------------- */

test('TEST_LOOP_DEFAULTS is frozen', () => {
    assert.equal(Object.isFrozen(TEST_LOOP_DEFAULTS), true);
});

test('TEST_LOOP_DEFAULTS has the expected shape', () => {
    assert.deepEqual(TEST_LOOP_DEFAULTS, {
        enabled: false,
        maxIterations: 10,
        maxWallClockMinutes: 30,
        maxTokensPerIteration: 8000,
        ciPollTimeoutMinutes: 5,
    });
});

test('_read returns defaults when settings.testLoop missing', () => {
    const prev = State.settings.testLoop;
    State.settings.testLoop = undefined;
    try {
        const r = _read();
        assert.deepEqual(r, TEST_LOOP_DEFAULTS);
    } finally { State.settings.testLoop = prev; }
});

test('_read merges configured values over defaults', () => {
    const prev = State.settings.testLoop;
    State.settings.testLoop = { enabled: true, maxIterations: 3 };
    try {
        const r = _read();
        assert.equal(r.enabled, true);
        assert.equal(r.maxIterations, 3);
        assert.equal(r.maxWallClockMinutes, TEST_LOOP_DEFAULTS.maxWallClockMinutes);
    } finally { State.settings.testLoop = prev; }
});

/* ---------------- Persistence ---------------- */

test('_persist creates settings.testLoop if absent + emits settings:changed', () => {
    const prev = State.settings.testLoop;
    State.settings.testLoop = undefined;
    let emitted = null;
    const off = EventBus.on('settings:changed', (e) => { emitted = e; });
    try {
        _persist({ enabled: true });
        assert.deepEqual(State.settings.testLoop, { enabled: true });
        assert.ok(emitted);
        assert.equal(emitted.section, 'testLoop');
    } finally {
        State.settings.testLoop = prev;
        if (typeof off === 'function') off();
    }
});

test('_persist preserves untouched keys', () => {
    const prev = State.settings.testLoop;
    State.settings.testLoop = { enabled: true, maxIterations: 5 };
    try {
        _persist({ maxIterations: 9 });
        assert.equal(State.settings.testLoop.enabled, true);
        assert.equal(State.settings.testLoop.maxIterations, 9);
    } finally { State.settings.testLoop = prev; }
});

/* ---------------- Workspace-settings safelist coverage ---------------- */

test('testLoop key is on the workspace-settings safelist', () => {
    assert.equal(isSafelisted('testLoop'), true);
});

test('testLoop key is NOT on the denylist (no credential overlap)', () => {
    // sanity check via isSafelisted negation — denylist always wins.
    assert.equal(isSafelisted('testLoop'), true);
});
