/**
 * Dispatcher tests for js/plugin-modal.js#mountPluginModal — Phase 2b of the
 * inline-handlers migration (docs/DESIGN-ui-event-dispatch.md).
 *
 * `mountPluginModal({ onClose })` installs ONE document-level click listener
 * scoped to `#pluginModal` and routed by `data-action`. The module was
 * extracted from js/app.js in 2.29.0; only the close button needs delegation —
 * the modal body is rendered from plugin-supplied `render()` callbacks, not
 * from static HTML, so this is the only inline handler the surface owns.
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

const { mountPluginModal } = await import('../js/plugin-modal.js');

// Reset listener counter — plugin-modal.js transitive deps (core.js) may
// register their own document listeners at module load.
_clickListenerCount = 0;
_capturedListener = null;

const _spy = { close: 0 };
mountPluginModal({
    onClose: () => { _spy.close++; },
});

function resetSpy() { _spy.close = 0; }

function makeBtn({ action, inScope }) {
    const btn = {
        getAttribute: (name) => (name === 'data-action' ? action : null),
    };
    btn.closest = (sel) => {
        if (sel === '[data-action]') return btn;
        if (sel === '#pluginModal') return inScope ? {} : null;
        return null;
    };
    return btn;
}

function makeClick({ action, inScope }) {
    if (action === null) return { target: { closest: () => null } };
    return { target: makeBtn({ action, inScope }) };
}

test('mountPluginModal installs exactly one document click listener', () => {
    assert.equal(_clickListenerCount, 1);
    assert.equal(typeof _capturedListener, 'function');
});

test('data-action="closePluginModal" inside #pluginModal → onClose fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'closePluginModal', inScope: true }));
    assert.equal(_spy.close, 1);
});

test('data-action button OUTSIDE #pluginModal scope → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'closePluginModal', inScope: false }));
    assert.equal(_spy.close, 0);
});

test('click with no [data-action] ancestor → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: null, inScope: true }));
    assert.equal(_spy.close, 0);
});

test('unknown data-action value inside #pluginModal → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'someOtherAction', inScope: true }));
    assert.equal(_spy.close, 0);
});

test('second mountPluginModal call is a no-op — _wired guard prevents double-bind', () => {
    const before = _clickListenerCount;
    mountPluginModal({
        onClose: () => { assert.fail('second-mount onClose must not fire'); },
    });
    assert.equal(_clickListenerCount, before);
    resetSpy();
    _capturedListener(makeClick({ action: 'closePluginModal', inScope: true }));
    assert.equal(_spy.close, 1);
});
