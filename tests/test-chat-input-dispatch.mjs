/**
 * Dispatcher tests for js/chat/input.js#mountChatInput — Phase 3a of the
 * inline-handlers migration (docs/DESIGN-ui-event-dispatch.md).
 *
 * Scoped to `#imagePreviewStrip`. One action:
 *   - `removeImage` reads `data-index` (coerced to Number)
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

const { mountChatInput } = await import('../js/chat/input.js');

_clickListenerCount = 0;
_capturedListener = null;

const _spy = { remove: [] };
mountChatInput({
    onRemoveImage: (i) => { _spy.remove.push(i); },
});

function resetSpy() { _spy.remove = []; }

function makeBtn({ action, index, inScope }) {
    const btn = {
        getAttribute: (name) => {
            if (name === 'data-action') return action;
            if (name === 'data-index') return index == null ? null : String(index);
            return null;
        },
    };
    btn.closest = (sel) => {
        if (sel === '[data-action]') return btn;
        if (sel === '#imagePreviewStrip') return inScope ? {} : null;
        return null;
    };
    return btn;
}

function makeClick(opts) {
    if (opts.action === null) return { target: { closest: () => null } };
    return { target: makeBtn(opts) };
}

test('mountChatInput installs exactly one document click listener', () => {
    assert.equal(_clickListenerCount, 1);
});

test('data-action="removeImage" data-index="1" → onRemoveImage(1)', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'removeImage', index: 1, inScope: true }));
    assert.deepEqual(_spy.remove, [1]);
});

test('index payload arrives as Number, not string', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'removeImage', index: 0, inScope: true }));
    assert.strictEqual(_spy.remove[0], 0);
    assert.equal(typeof _spy.remove[0], 'number');
});

test('data-action OUTSIDE #imagePreviewStrip scope → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'removeImage', index: 0, inScope: false }));
    assert.equal(_spy.remove.length, 0);
});

test('click with no [data-action] ancestor → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: null, inScope: true }));
    assert.equal(_spy.remove.length, 0);
});

test('unknown data-action value → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'someOtherAction', inScope: true }));
    assert.equal(_spy.remove.length, 0);
});

test('second mountChatInput call is a no-op', () => {
    const before = _clickListenerCount;
    mountChatInput({
        onRemoveImage: () => { assert.fail('second-mount onRemoveImage must not fire'); },
    });
    assert.equal(_clickListenerCount, before);
});
