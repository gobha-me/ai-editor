/**
 * Dispatcher tests for js/ui/app-shell-actions.js#mountAppShellActions —
 * UI event-dispatch contract (docs/DESIGN-ui-event-dispatch.md).
 *
 * `mountAppShellActions({ onOpenSettings, onOpenZipUpload,
 * onToggleSecondaryFullscreen, onCloseSecondaryPane, onOpenReplayModal })`
 * installs ONE document-level click listener scoped to the
 * `.editor-panel, .chat-panel` containers (the two app-shell panels that own
 * non-modal action buttons) and routed by `data-action`.
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

const { mountAppShellActions } = await import('../js/ui/app-shell-actions.js');

// Reset listener counter — guard against transitive-dep listeners.
_clickListenerCount = 0;
_capturedListener = null;

const _spy = {
    openSettings: 0, openZip: 0,
    fullscreen: 0, closeSecondary: 0, openReplay: 0,
};
mountAppShellActions({
    onOpenSettings: () => { _spy.openSettings++; },
    onOpenZipUpload: () => { _spy.openZip++; },
    onToggleSecondaryFullscreen: () => { _spy.fullscreen++; },
    onCloseSecondaryPane: () => { _spy.closeSecondary++; },
    onOpenReplayModal: () => { _spy.openReplay++; },
});

function resetSpy() {
    _spy.openSettings = 0; _spy.openZip = 0;
    _spy.fullscreen = 0; _spy.closeSecondary = 0; _spy.openReplay = 0;
}
function sumSpy() {
    return _spy.openSettings + _spy.openZip + _spy.fullscreen
        + _spy.closeSecondary + _spy.openReplay;
}

function makeBtn({ action, inScope }) {
    const btn = {
        getAttribute: (name) => (name === 'data-action' ? action : null),
    };
    btn.closest = (sel) => {
        if (sel === '[data-action]') return btn;
        if (sel === '.editor-panel, .chat-panel') return inScope ? {} : null;
        return null;
    };
    return btn;
}

function makeClick({ action, inScope }) {
    if (action === null) return { target: { closest: () => null } };
    return { target: makeBtn({ action, inScope }) };
}

test('mountAppShellActions installs exactly one document click listener', () => {
    assert.equal(_clickListenerCount, 1);
    assert.equal(typeof _capturedListener, 'function');
});

test('data-action="openSettings" inside editor-panel → onOpenSettings fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'openSettings', inScope: true }));
    assert.equal(_spy.openSettings, 1);
});

test('data-action="openZipUpload" inside editor-panel → onOpenZipUpload fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'openZipUpload', inScope: true }));
    assert.equal(_spy.openZip, 1);
});

test('data-action="toggleSecondaryFullscreen" inside editor-panel → onToggleSecondaryFullscreen fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'toggleSecondaryFullscreen', inScope: true }));
    assert.equal(_spy.fullscreen, 1);
});

test('data-action="closeSecondaryPane" inside editor-panel → onCloseSecondaryPane fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'closeSecondaryPane', inScope: true }));
    assert.equal(_spy.closeSecondary, 1);
});

test('data-action="openReplayModal" inside chat-panel → onOpenReplayModal fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'openReplayModal', inScope: true }));
    assert.equal(_spy.openReplay, 1);
});

test('data-action button OUTSIDE editor-panel / chat-panel scope → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'openSettings', inScope: false }));
    assert.equal(sumSpy(), 0);
});

test('click with no [data-action] ancestor → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: null, inScope: true }));
    assert.equal(sumSpy(), 0);
});

test('unknown data-action value inside panel scope → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'someOtherAction', inScope: true }));
    assert.equal(sumSpy(), 0);
});

test('second mountAppShellActions call is a no-op — _wired guard prevents double-bind', () => {
    const before = _clickListenerCount;
    mountAppShellActions({
        onOpenSettings: () => { assert.fail('second-mount onOpenSettings must not fire'); },
    });
    assert.equal(_clickListenerCount, before);
    resetSpy();
    _capturedListener(makeClick({ action: 'openSettings', inScope: true }));
    assert.equal(_spy.openSettings, 1);
});
