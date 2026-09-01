/**
 * Dispatcher tests for js/settings-manager.js#mountSettingsModal — Phase 2b
 * of the inline-handlers migration (docs/DESIGN-ui-event-dispatch.md).
 *
 * `mountSettingsModal({ onClose, onSave, onExport, onImport, onFetchModels,
 * onFetchEmbedModels })` installs ONE document-level click listener scoped to
 * `#settingsModal` (which wraps both the footer buttons and the per-tab fetch
 * buttons inside #settingsTabsContainer) and routed by `data-action`.
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

const { mountSettingsModal } = await import('../js/settings-manager.js');

// Reset listener counter — settings-manager.js transitive deps may register
// their own document listeners at module load (matches the issue-detail test
// pattern). We only measure the listener mountSettingsModal installs.
_clickListenerCount = 0;
_capturedListener = null;

const _spy = {
    close: 0, save: 0, exp: 0, imp: 0, fetchModels: 0, fetchEmbed: 0,
};
mountSettingsModal({
    onClose: () => { _spy.close++; },
    onSave: () => { _spy.save++; },
    onExport: () => { _spy.exp++; },
    onImport: () => { _spy.imp++; },
    onFetchModels: () => { _spy.fetchModels++; },
    onFetchEmbedModels: () => { _spy.fetchEmbed++; },
});

function resetSpy() {
    _spy.close = 0; _spy.save = 0; _spy.exp = 0; _spy.imp = 0;
    _spy.fetchModels = 0; _spy.fetchEmbed = 0;
}

function makeBtn({ action, inScope }) {
    const btn = {
        getAttribute: (name) => (name === 'data-action' ? action : null),
    };
    btn.closest = (sel) => {
        if (sel === '[data-action]') return btn;
        if (sel === '#settingsModal') return inScope ? {} : null;
        return null;
    };
    return btn;
}

function makeClick({ action, inScope }) {
    if (action === null) return { target: { closest: () => null } };
    return { target: makeBtn({ action, inScope }) };
}

test('mountSettingsModal installs exactly one document click listener', () => {
    assert.equal(_clickListenerCount, 1);
    assert.equal(typeof _capturedListener, 'function');
});

test('data-action="closeSettings" inside #settingsModal → onClose fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'closeSettings', inScope: true }));
    assert.equal(_spy.close, 1);
});

test('data-action="saveSettings" inside #settingsModal → onSave fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'saveSettings', inScope: true }));
    assert.equal(_spy.save, 1);
});

test('data-action="exportSettings" inside #settingsModal → onExport fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'exportSettings', inScope: true }));
    assert.equal(_spy.exp, 1);
});

test('data-action="importSettings" inside #settingsModal → onImport fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'importSettings', inScope: true }));
    assert.equal(_spy.imp, 1);
});

test('data-action="fetchModelsForSettings" inside #settingsModal → onFetchModels fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'fetchModelsForSettings', inScope: true }));
    assert.equal(_spy.fetchModels, 1);
});

test('data-action="fetchEmbeddingModelsForSettings" inside #settingsModal → onFetchEmbedModels fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'fetchEmbeddingModelsForSettings', inScope: true }));
    assert.equal(_spy.fetchEmbed, 1);
});

test('data-action button OUTSIDE #settingsModal scope → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'closeSettings', inScope: false }));
    assert.equal(_spy.close, 0);
});

test('click with no [data-action] ancestor → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: null, inScope: true }));
    assert.equal(_spy.close + _spy.save + _spy.exp + _spy.imp + _spy.fetchModels + _spy.fetchEmbed, 0);
});

test('unknown data-action value inside #settingsModal → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'someOtherAction', inScope: true }));
    assert.equal(_spy.close + _spy.save + _spy.exp + _spy.imp + _spy.fetchModels + _spy.fetchEmbed, 0);
});

test('second mountSettingsModal call is a no-op — _wired guard prevents double-bind', () => {
    const before = _clickListenerCount;
    mountSettingsModal({
        onClose: () => { assert.fail('second-mount onClose must not fire'); },
    });
    assert.equal(_clickListenerCount, before);
    resetSpy();
    _capturedListener(makeClick({ action: 'closeSettings', inScope: true }));
    assert.equal(_spy.close, 1);
});
