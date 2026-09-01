/**
 * Dispatcher tests for js/ui/pr-list.js#mountPrList — Phase 3a of the
 * inline-handlers migration (docs/DESIGN-ui-event-dispatch.md).
 *
 * Scoped to `#prsPanel`. One action:
 *   - `openPrReview` reads `data-number` (coerced to Number)
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

let _capturedListener = null;
let _clickListenerCount = 0;
globalThis.document.addEventListener = (type, handler) => {
    if (type === 'click') {
        _clickListenerCount++;
        _capturedListener = handler;
    }
};

const { mountPrList } = await import('../js/ui/pr-list.js');

_clickListenerCount = 0;
_capturedListener = null;

const _spy = { open: [] };
mountPrList({
    onOpenPrReview: (n) => { _spy.open.push(n); },
});

function resetSpy() { _spy.open = []; }

function makeBtn({ action, number, inScope }) {
    const btn = {
        getAttribute: (name) => {
            if (name === 'data-action') return action;
            if (name === 'data-number') return number == null ? null : String(number);
            return null;
        },
    };
    btn.closest = (sel) => {
        if (sel === '[data-action]') return btn;
        if (sel === '#prsPanel') return inScope ? {} : null;
        return null;
    };
    return btn;
}

function makeClick(opts) {
    if (opts.action === null) return { target: { closest: () => null } };
    return { target: makeBtn(opts) };
}

test('mountPrList installs exactly one document click listener', () => {
    assert.equal(_clickListenerCount, 1);
});

test('data-action="openPrReview" data-number="42" → onOpenPrReview(42)', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'openPrReview', number: 42, inScope: true }));
    assert.deepEqual(_spy.open, [42]);
});

test('number payload arrives as Number, not string', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'openPrReview', number: 7, inScope: true }));
    assert.strictEqual(_spy.open[0], 7);
    assert.equal(typeof _spy.open[0], 'number');
});

test('data-action OUTSIDE #prsPanel scope → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'openPrReview', number: 1, inScope: false }));
    assert.equal(_spy.open.length, 0);
});

test('click with no [data-action] ancestor → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: null, inScope: true }));
    assert.equal(_spy.open.length, 0);
});

test('unknown data-action value → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'someOtherAction', inScope: true }));
    assert.equal(_spy.open.length, 0);
});

test('second mountPrList call is a no-op', () => {
    const before = _clickListenerCount;
    mountPrList({
        onOpenPrReview: () => { assert.fail('second-mount onOpenPrReview must not fire'); },
    });
    assert.equal(_clickListenerCount, before);
});
