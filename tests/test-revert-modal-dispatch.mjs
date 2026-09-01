/**
 * Dispatcher tests for js/ui/revert.js#mountRevertModal — Phase 2a of the
 * inline-handlers migration (docs/DESIGN-ui-event-dispatch.md).
 *
 * `mountRevertModal({ onClose, onRevertCurrent, onRevertAll })` installs ONE
 * document-level click listener scoped to `#revertModal` and routed by
 * `data-action`. Pure-logic test — no JSDOM, no real DOM.
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

const { mountRevertModal } = await import('../js/ui/revert.js');

const _spy = { close: 0, revertCurrent: 0, revertAll: 0 };
mountRevertModal({
    onClose: () => { _spy.close++; },
    onRevertCurrent: () => { _spy.revertCurrent++; },
    onRevertAll: () => { _spy.revertAll++; },
});

function resetSpy() {
    _spy.close = 0;
    _spy.revertCurrent = 0;
    _spy.revertAll = 0;
}

function makeBtn({ action, inScope }) {
    const btn = {
        getAttribute: (name) => (name === 'data-action' ? action : null),
    };
    btn.closest = (sel) => {
        if (sel === '[data-action]') return btn;
        if (sel === '#revertModal') return inScope ? {} : null;
        return null;
    };
    return btn;
}

function makeClick({ action, inScope }) {
    if (action === null) return { target: { closest: () => null } };
    return { target: makeBtn({ action, inScope }) };
}

test('mountRevertModal installs exactly one document click listener', () => {
    assert.equal(_clickListenerCount, 1);
    assert.equal(typeof _capturedListener, 'function');
});

test('data-action="closeRevertModal" inside #revertModal → onClose fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'closeRevertModal', inScope: true }));
    assert.equal(_spy.close, 1);
    assert.equal(_spy.revertCurrent, 0);
    assert.equal(_spy.revertAll, 0);
});

test('data-action="revertOnlyCurrentFile" inside #revertModal → onRevertCurrent fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'revertOnlyCurrentFile', inScope: true }));
    assert.equal(_spy.revertCurrent, 1);
    assert.equal(_spy.close, 0);
    assert.equal(_spy.revertAll, 0);
});

test('data-action="revertAllFiles" inside #revertModal → onRevertAll fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'revertAllFiles', inScope: true }));
    assert.equal(_spy.revertAll, 1);
    assert.equal(_spy.close, 0);
    assert.equal(_spy.revertCurrent, 0);
});

test('data-action button OUTSIDE #revertModal scope → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'closeRevertModal', inScope: false }));
    assert.equal(_spy.close, 0);
    assert.equal(_spy.revertCurrent, 0);
    assert.equal(_spy.revertAll, 0);
});

test('click with no [data-action] ancestor → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: null, inScope: true }));
    assert.equal(_spy.close, 0);
    assert.equal(_spy.revertCurrent, 0);
    assert.equal(_spy.revertAll, 0);
});

test('unknown data-action value inside #revertModal → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'someOtherAction', inScope: true }));
    assert.equal(_spy.close, 0);
    assert.equal(_spy.revertCurrent, 0);
    assert.equal(_spy.revertAll, 0);
});

test('second mountRevertModal call is a no-op — _wired guard prevents double-bind', () => {
    const before = _clickListenerCount;
    mountRevertModal({
        onClose: () => { assert.fail('second-mount onClose must not fire'); },
        onRevertCurrent: () => { assert.fail('second-mount onRevertCurrent must not fire'); },
        onRevertAll: () => { assert.fail('second-mount onRevertAll must not fire'); },
    });
    assert.equal(_clickListenerCount, before);
    resetSpy();
    _capturedListener(makeClick({ action: 'closeRevertModal', inScope: true }));
    assert.equal(_spy.close, 1);
});
