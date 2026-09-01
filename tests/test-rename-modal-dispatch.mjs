/**
 * Dispatcher tests for js/ui/file-rename.js#mountRenameModal — Phase 2a of the
 * UI event-dispatch contract (docs/DESIGN-ui-event-dispatch.md).
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

const { mountRenameModal } = await import('../js/ui/file-rename.js');

const _spy = { close: 0, submit: 0 };
mountRenameModal({
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
        if (sel === '#renameFileModal') return inScope ? {} : null;
        return null;
    };
    return btn;
}

function makeClick({ action, inScope }) {
    if (action === null) return { target: { closest: () => null } };
    return { target: makeBtn({ action, inScope }) };
}

test('mountRenameModal installs exactly one document click listener', () => {
    assert.equal(_clickListenerCount, 1);
});

test('data-action="closeRenameModal" inside #renameFileModal → onClose fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'closeRenameModal', inScope: true }));
    assert.equal(_spy.close, 1);
    assert.equal(_spy.submit, 0);
});

test('data-action="submitRename" inside #renameFileModal → onSubmit fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'submitRename', inScope: true }));
    assert.equal(_spy.submit, 1);
    assert.equal(_spy.close, 0);
});

test('data-action button OUTSIDE #renameFileModal scope → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'closeRenameModal', inScope: false }));
    assert.equal(_spy.close, 0);
    assert.equal(_spy.submit, 0);
});

test('click with no [data-action] ancestor → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: null, inScope: true }));
    assert.equal(_spy.close, 0);
    assert.equal(_spy.submit, 0);
});

test('unknown data-action value → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'someOtherAction', inScope: true }));
    assert.equal(_spy.close, 0);
    assert.equal(_spy.submit, 0);
});

test('second mountRenameModal call is a no-op', () => {
    const before = _clickListenerCount;
    mountRenameModal({
        onClose: () => { assert.fail('second-mount onClose must not fire'); },
        onSubmit: () => { assert.fail('second-mount onSubmit must not fire'); },
    });
    assert.equal(_clickListenerCount, before);
});
