/**
 * Tests for js/ui/modal-registry.js — the 2.33.0 audit-sweep entry that
 * replaces the pre-2.33.0 hand-rolled Esc + popstate chains in
 * js/app.js with a registry-driven dispatcher.
 *
 * Pure-logic, no DOM. The registry is a flat module-scope array; we
 * exercise registration, priority ordering, the `popstate` filter, and
 * options pass-through. `_resetForTests` clears the array between cases.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
    registerOverlay,
    closeTopmostOverlay,
    listOverlays,
    _resetForTests,
} = await import('../js/ui/modal-registry.js');

function makeOverlay({ id, active = false, priority = 50, poppable = false }) {
    return {
        id,
        priority,
        poppable,
        _active: active,
        _closed: 0,
        _lastOpts: null,
        isActive() { return this._active; },
    };
}

function registerSpy(spy) {
    registerOverlay({
        id: spy.id,
        priority: spy.priority,
        poppable: spy.poppable,
        isActive: () => spy.isActive(),
        close: (opts) => { spy._closed++; spy._lastOpts = opts; },
    });
    return spy;
}

test('registerOverlay defaults priority=50 and poppable=false', () => {
    _resetForTests();
    registerOverlay({ id: 'x', isActive: () => false, close: () => {} });
    const list = listOverlays();
    assert.equal(list.length, 1);
    assert.equal(list[0].priority, 50);
    assert.equal(list[0].poppable, false);
});

test('closeTopmostOverlay picks the highest-priority active entry and returns true', () => {
    _resetForTests();
    const low = registerSpy(makeOverlay({ id: 'low', priority: 10, active: true }));
    const high = registerSpy(makeOverlay({ id: 'high', priority: 90, active: true }));
    const result = closeTopmostOverlay();
    assert.equal(result, true);
    assert.equal(high._closed, 1);
    assert.equal(low._closed, 0);
});

test('closeTopmostOverlay({popstate:true}) only considers poppable entries', () => {
    _resetForTests();
    const escOnly = registerSpy(makeOverlay({ id: 'esc', priority: 100, active: true, poppable: false }));
    const poppable = registerSpy(makeOverlay({ id: 'pop', priority: 50, active: true, poppable: true }));
    const result = closeTopmostOverlay({ popstate: true });
    assert.equal(result, true);
    assert.equal(poppable._closed, 1);
    assert.equal(escOnly._closed, 0);
});

test('closeTopmostOverlay returns false when nothing is active; no close fired', () => {
    _resetForTests();
    const a = registerSpy(makeOverlay({ id: 'a', priority: 50, active: false }));
    const b = registerSpy(makeOverlay({ id: 'b', priority: 80, active: false }));
    const result = closeTopmostOverlay();
    assert.equal(result, false);
    assert.equal(a._closed, 0);
    assert.equal(b._closed, 0);
});

test('higher priority wins even when both are active', () => {
    _resetForTests();
    const mc = registerSpy(makeOverlay({ id: 'mergeConflict', priority: 80, active: true, poppable: true }));
    const pr = registerSpy(makeOverlay({ id: 'prReview', priority: 70, active: true, poppable: true }));
    closeTopmostOverlay({ popstate: true });
    assert.equal(mc._closed, 1);
    assert.equal(pr._closed, 0);
    // Subsequent call (after merge-conflict's isActive flips false) closes pr-review.
    mc._active = false;
    closeTopmostOverlay({ popstate: true });
    assert.equal(pr._closed, 1);
});

test('close receives full opts verbatim', () => {
    _resetForTests();
    const o = registerSpy(makeOverlay({ id: 'o', priority: 50, active: true, poppable: true }));
    closeTopmostOverlay({ popstate: true });
    assert.deepEqual(o._lastOpts, { popstate: true });

    // Esc path (no opts arg) calls with the default empty object.
    o._active = true;
    closeTopmostOverlay();
    assert.deepEqual(o._lastOpts, {});
});

test('listOverlays returns a snapshot; mutating it does not affect the registry', () => {
    _resetForTests();
    registerOverlay({ id: 'a', isActive: () => false, close: () => {} });
    const snapshot = listOverlays();
    snapshot.push({ id: 'INJECTED', priority: 999, poppable: true, isActive: () => true, close: () => {} });
    const fresh = listOverlays();
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].id, 'a');
});

test('listOverlays is sorted descending by priority', () => {
    _resetForTests();
    registerOverlay({ id: 'low', priority: 10, isActive: () => false, close: () => {} });
    registerOverlay({ id: 'high', priority: 90, isActive: () => false, close: () => {} });
    registerOverlay({ id: 'mid', priority: 50, isActive: () => false, close: () => {} });
    const ids = listOverlays().map(o => o.id);
    assert.deepEqual(ids, ['high', 'mid', 'low']);
});
