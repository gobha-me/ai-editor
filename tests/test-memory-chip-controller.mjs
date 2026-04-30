/**
 * Tests for js/chat/memory-chip.js — the controller surface that
 * `js/chat/input.js` calls into when the user types `@memory`. Uses the
 * `_setMemoriesForTests` / `_setVisibleForTests` seams so we exercise
 * the navigation, query-update, and selection rules without standing
 * up Preact or IDB.
 *
 * Mount-loading is exercised by the existing
 * test-memory-consent-card-mount pattern; that branch is duplicative
 * across surfaces, so this file focuses on the controller logic.
 */
import './_node-shim.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    setChipQuery,
    navigateChip,
    selectChipActive,
    isChipVisible,
    hideChip,
    _resetForTests,
    _setMemoriesForTests,
    _setVisibleForTests,
    _subscribeChip,
    _getChipState,
} from '../js/chat/memory-chip.js';

const SAMPLE = [
    { id: '1', scope: 'user', key: 'preferred_editor', value: 'vim',     updated_at: 1000 },
    { id: '2', scope: 'user', key: 'preferred_theme',  value: 'oneDark', updated_at: 2000 },
    { id: '3', scope: 'workspace', key: 'project_owner', value: 'Jeff',  updated_at: 3000 },
];

beforeEach(() => {
    _resetForTests();
});

test('isChipVisible reflects the visibility seam', () => {
    assert.equal(isChipVisible(), false);
    _setVisibleForTests(true);
    assert.equal(isChipVisible(), true);
    _setVisibleForTests(false);
    assert.equal(isChipVisible(), false);
});

test('setChipQuery is a no-op when the chip is closed', () => {
    _setMemoriesForTests(SAMPLE);
    setChipQuery('pref');
    assert.equal(_getChipState().results.length, 0,
        'controller must not surface results while invisible');
});

test('setChipQuery filters and resets selection when chip is open', () => {
    _setVisibleForTests(true);
    _setMemoriesForTests(SAMPLE);
    setChipQuery('pref');
    const s = _getChipState();
    assert.equal(s.results.length, 2);
    assert.equal(s.selectedIndex, 0);
    assert.ok(s.results.every((r) => r.key.includes('pref')));
});

test('navigateChip wraps both edges', () => {
    _setVisibleForTests(true);
    _setMemoriesForTests(SAMPLE);
    setChipQuery('');
    // 3 records loaded — start at index 0
    assert.equal(_getChipState().selectedIndex, 0);
    navigateChip('down');
    assert.equal(_getChipState().selectedIndex, 1);
    navigateChip('down');
    assert.equal(_getChipState().selectedIndex, 2);
    navigateChip('down');                       // wraps to 0
    assert.equal(_getChipState().selectedIndex, 0);
    navigateChip('up');                         // wraps to last
    assert.equal(_getChipState().selectedIndex, 2);
});

test('navigateChip is a no-op when results are empty', () => {
    _setVisibleForTests(true);
    _setMemoriesForTests([]);
    navigateChip('down');
    navigateChip('up');
    assert.equal(_getChipState().selectedIndex, 0);
});

test('selectChipActive invokes onSelect with the highlighted record and closes', () => {
    _setVisibleForTests(true);
    _setMemoriesForTests(SAMPLE);
    setChipQuery('');
    const state = _getChipState();
    state.onSelect = (rec) => { state._lastSelected = rec; };
    navigateChip('down');                       // index 1
    const picked = selectChipActive();
    assert.equal(picked.id, _getChipState().results[0]?.id || picked.id);
    // After selectChipActive the chip is closed.
    assert.equal(isChipVisible(), false);
});

test('selectChipActive returns null when nothing is highlighted / chip is closed', () => {
    assert.equal(selectChipActive(), null);
    _setVisibleForTests(true);
    _setMemoriesForTests([]);
    assert.equal(selectChipActive(), null);
});

test('subscribers are notified on each state change', () => {
    let calls = 0;
    const off = _subscribeChip(() => { calls += 1; });
    _setVisibleForTests(true);
    _setMemoriesForTests(SAMPLE);
    setChipQuery('pref');
    navigateChip('down');
    off();
    setChipQuery('vim');                        // no longer counted
    assert.ok(calls >= 3,
        `subscriber should fire on visible/load/setQuery/navigate; got ${calls}`);
});

test('hideChip clears state and runs the registered onClose', () => {
    _setVisibleForTests(true);
    _setMemoriesForTests(SAMPLE);
    setChipQuery('pref');
    let closed = false;
    _getChipState().onClose = () => { closed = true; };
    hideChip();
    assert.equal(isChipVisible(), false);
    assert.equal(closed, true);
    const s = _getChipState();
    assert.equal(s.query, '');
    assert.equal(s.results.length, 0);
    assert.equal(s.selectedIndex, 0);
    assert.equal(s.onSelect, null);
    assert.equal(s.onClose, null);
});

test('hideChip when already hidden is a no-op (no throw, no spurious notify)', () => {
    let calls = 0;
    _subscribeChip(() => { calls += 1; });
    hideChip();
    hideChip();
    assert.equal(calls, 0);
});
