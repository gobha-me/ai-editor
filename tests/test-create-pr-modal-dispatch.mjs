/**
 * Dispatcher tests for js/project-manager.js#mountCreatePRModal — Phase 2b of
 * the inline-handlers migration (docs/DESIGN-html-inline-handlers-migration.md).
 *
 * `mountCreatePRModal({ onClose, onSubmit })` installs ONE document-level
 * click listener scoped to `#createPRModal` and routed by `data-action`.
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

const { mountCreatePRModal } = await import('../js/project-manager.js');

// Reset listener counter — project-manager.js transitive deps may register
// their own document listeners at module load.
_clickListenerCount = 0;
_capturedListener = null;

const _spy = { close: 0, submit: 0 };
mountCreatePRModal({
    onClose: () => { _spy.close++; },
    onSubmit: () => { _spy.submit++; },
});

function resetSpy() { _spy.close = 0; _spy.submit = 0; }

function makeBtn({ action, inScope }) {
    const btn = {
        getAttribute: (name) => (name === 'data-action' ? action : null),
    };
    btn.closest = (sel) => {
        if (sel === '[data-action]') return btn;
        if (sel === '#createPRModal') return inScope ? {} : null;
        return null;
    };
    return btn;
}

function makeClick({ action, inScope }) {
    if (action === null) return { target: { closest: () => null } };
    return { target: makeBtn({ action, inScope }) };
}

test('mountCreatePRModal installs exactly one document click listener', () => {
    assert.equal(_clickListenerCount, 1);
    assert.equal(typeof _capturedListener, 'function');
});

test('data-action="closeCreatePRModal" inside #createPRModal → onClose fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'closeCreatePRModal', inScope: true }));
    assert.equal(_spy.close, 1);
    assert.equal(_spy.submit, 0);
});

test('data-action="submitCreatePR" inside #createPRModal → onSubmit fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'submitCreatePR', inScope: true }));
    assert.equal(_spy.submit, 1);
    assert.equal(_spy.close, 0);
});

test('data-action button OUTSIDE #createPRModal scope → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'closeCreatePRModal', inScope: false }));
    assert.equal(_spy.close, 0);
    assert.equal(_spy.submit, 0);
});

test('click with no [data-action] ancestor → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: null, inScope: true }));
    assert.equal(_spy.close, 0);
    assert.equal(_spy.submit, 0);
});

test('unknown data-action value inside #createPRModal → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'someOtherAction', inScope: true }));
    assert.equal(_spy.close, 0);
    assert.equal(_spy.submit, 0);
});

test('second mountCreatePRModal call is a no-op — _wired guard prevents double-bind', () => {
    const before = _clickListenerCount;
    mountCreatePRModal({
        onClose: () => { assert.fail('second-mount onClose must not fire'); },
        onSubmit: () => { assert.fail('second-mount onSubmit must not fire'); },
    });
    assert.equal(_clickListenerCount, before);
    resetSpy();
    _capturedListener(makeClick({ action: 'closeCreatePRModal', inScope: true }));
    assert.equal(_spy.close, 1);
});
