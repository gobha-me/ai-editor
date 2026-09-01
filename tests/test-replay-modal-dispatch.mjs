/**
 * Dispatcher tests for js/chat/replay.js#mountReplayModal — Phase 2a of the
 * inline-handlers migration (docs/DESIGN-ui-event-dispatch.md).
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

const { mountReplayModal } = await import('../js/chat/replay.js');

const _spy = { close: 0, prev: 0, next: 0 };
mountReplayModal({
    onClose: () => { _spy.close++; },
    onPrev: () => { _spy.prev++; },
    onNext: () => { _spy.next++; },
});

function resetSpy() { _spy.close = 0; _spy.prev = 0; _spy.next = 0; }

function makeBtn({ action, inScope }) {
    const btn = {
        getAttribute: (name) => (name === 'data-action' ? action : null),
    };
    btn.closest = (sel) => {
        if (sel === '[data-action]') return btn;
        if (sel === '#replayModal') return inScope ? {} : null;
        return null;
    };
    return btn;
}

function makeClick({ action, inScope }) {
    if (action === null) return { target: { closest: () => null } };
    return { target: makeBtn({ action, inScope }) };
}

test('mountReplayModal installs exactly one document click listener', () => {
    assert.equal(_clickListenerCount, 1);
});

test('data-action="closeReplayModal" inside #replayModal → onClose fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'closeReplayModal', inScope: true }));
    assert.equal(_spy.close, 1);
});

test('data-action="replayPrev" inside #replayModal → onPrev fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'replayPrev', inScope: true }));
    assert.equal(_spy.prev, 1);
});

test('data-action="replayNext" inside #replayModal → onNext fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'replayNext', inScope: true }));
    assert.equal(_spy.next, 1);
});

test('data-action button OUTSIDE #replayModal scope → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'closeReplayModal', inScope: false }));
    assert.equal(_spy.close, 0);
    assert.equal(_spy.prev, 0);
    assert.equal(_spy.next, 0);
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
    assert.equal(_spy.next, 0);
});

test('second mountReplayModal call is a no-op', () => {
    const before = _clickListenerCount;
    mountReplayModal({
        onClose: () => { assert.fail('second-mount onClose must not fire'); },
        onPrev: () => { assert.fail('second-mount onPrev must not fire'); },
        onNext: () => { assert.fail('second-mount onNext must not fire'); },
    });
    assert.equal(_clickListenerCount, before);
});
