/**
 * Dispatcher tests for js/ui/file-create.js#mountNewFileModal — Phase 2a of the
 * inline-handlers migration (docs/DESIGN-html-inline-handlers-migration.md).
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

const { mountNewFileModal } = await import('../js/ui/file-create.js');

const _spy = { close: 0, create: 0 };
mountNewFileModal({
    onClose: () => { _spy.close++; },
    onCreate: () => { _spy.create++; },
});

function resetSpy() { _spy.close = 0; _spy.create = 0; }

function makeBtn({ action, inScope }) {
    const btn = {
        getAttribute: (name) => (name === 'data-action' ? action : null),
    };
    btn.closest = (sel) => {
        if (sel === '[data-action]') return btn;
        if (sel === '#newFileModal') return inScope ? {} : null;
        return null;
    };
    return btn;
}

function makeClick({ action, inScope }) {
    if (action === null) return { target: { closest: () => null } };
    return { target: makeBtn({ action, inScope }) };
}

test('mountNewFileModal installs exactly one document click listener', () => {
    assert.equal(_clickListenerCount, 1);
});

test('data-action="closeNewFileModal" inside #newFileModal → onClose fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'closeNewFileModal', inScope: true }));
    assert.equal(_spy.close, 1);
    assert.equal(_spy.create, 0);
});

test('data-action="createNewFile" inside #newFileModal → onCreate fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'createNewFile', inScope: true }));
    assert.equal(_spy.create, 1);
    assert.equal(_spy.close, 0);
});

test('data-action button OUTSIDE #newFileModal scope → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'closeNewFileModal', inScope: false }));
    assert.equal(_spy.close, 0);
    assert.equal(_spy.create, 0);
});

test('click with no [data-action] ancestor → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: null, inScope: true }));
    assert.equal(_spy.close, 0);
    assert.equal(_spy.create, 0);
});

test('unknown data-action value → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'someOtherAction', inScope: true }));
    assert.equal(_spy.close, 0);
    assert.equal(_spy.create, 0);
});

test('second mountNewFileModal call is a no-op', () => {
    const before = _clickListenerCount;
    mountNewFileModal({
        onClose: () => { assert.fail('second-mount onClose must not fire'); },
        onCreate: () => { assert.fail('second-mount onCreate must not fire'); },
    });
    assert.equal(_clickListenerCount, before);
});
