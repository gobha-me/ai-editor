/**
 * Dispatcher tests for js/release-manager.js#mountReleaseModal — Phase 2a of
 * the inline-handlers migration (docs/DESIGN-ui-event-dispatch.md).
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

const { mountReleaseModal } = await import('../js/release-manager.js');

const _spy = { close: 0, generate: 0, create: 0 };
mountReleaseModal({
    onClose: () => { _spy.close++; },
    onGenerate: () => { _spy.generate++; },
    onCreate: () => { _spy.create++; },
});

function resetSpy() { _spy.close = 0; _spy.generate = 0; _spy.create = 0; }

function makeBtn({ action, inScope }) {
    const btn = {
        getAttribute: (name) => (name === 'data-action' ? action : null),
    };
    btn.closest = (sel) => {
        if (sel === '[data-action]') return btn;
        if (sel === '#releaseModal') return inScope ? {} : null;
        return null;
    };
    return btn;
}

function makeClick({ action, inScope }) {
    if (action === null) return { target: { closest: () => null } };
    return { target: makeBtn({ action, inScope }) };
}

test('mountReleaseModal installs exactly one document click listener', () => {
    assert.equal(_clickListenerCount, 1);
});

test('data-action="closeReleaseModal" inside #releaseModal → onClose fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'closeReleaseModal', inScope: true }));
    assert.equal(_spy.close, 1);
});

test('data-action="generateReleaseNotes" inside #releaseModal → onGenerate fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'generateReleaseNotes', inScope: true }));
    assert.equal(_spy.generate, 1);
});

test('data-action="createRelease" inside #releaseModal → onCreate fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'createRelease', inScope: true }));
    assert.equal(_spy.create, 1);
});

test('data-action button OUTSIDE #releaseModal scope → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'closeReleaseModal', inScope: false }));
    assert.equal(_spy.close, 0);
    assert.equal(_spy.generate, 0);
    assert.equal(_spy.create, 0);
});

test('click with no [data-action] ancestor → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: null, inScope: true }));
    assert.equal(_spy.close, 0);
});

test('unknown data-action value → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'someOtherAction', inScope: true }));
    assert.equal(_spy.close, 0);
    assert.equal(_spy.create, 0);
});

test('second mountReleaseModal call is a no-op', () => {
    const before = _clickListenerCount;
    mountReleaseModal({
        onClose: () => { assert.fail('second-mount onClose must not fire'); },
        onGenerate: () => { assert.fail('second-mount onGenerate must not fire'); },
        onCreate: () => { assert.fail('second-mount onCreate must not fire'); },
    });
    assert.equal(_clickListenerCount, before);
});
