/**
 * Dispatcher tests for js/ui/commit.js#mountCommitModal — Phase 1 of the
 * inline-handlers migration (docs/DESIGN-html-inline-handlers-migration.md).
 *
 * `mountCommitModal({ onClose, onCommit, onGenerate })` installs ONE
 * document-level click listener that routes to the typed callback when:
 *   1. `e.target.closest('[data-action]')` finds an action button
 *   2. that button's `closest('#commitModal')` is non-null (scoped to the modal)
 *   3. the button's `data-action` matches a known action name
 *
 * These tests intercept `document.addEventListener('click', ...)` to capture
 * the handler, then drive it with synthetic event objects whose `closest()`
 * + `getAttribute()` behave like the real DOM contract.
 *
 * Pure-logic test — no JSDOM, no real DOM, no event-dispatch infrastructure.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Override BEFORE importing commit.js so the listener install lands in our spy.
let _capturedListener = null;
let _clickListenerCount = 0;
globalThis.document.addEventListener = (type, handler) => {
    if (type === 'click') {
        _clickListenerCount++;
        _capturedListener = handler;
    }
};

const { mountCommitModal } = await import('../js/ui/commit.js');

// Mount once at module scope (registration order: this runs before any test
// callback). `_wired` guard inside mountCommitModal means subsequent calls
// are no-ops.
const _spy = { close: 0, commit: 0, generate: 0 };
mountCommitModal({
    onClose: () => { _spy.close++; },
    onCommit: () => { _spy.commit++; },
    onGenerate: () => { _spy.generate++; },
});

function resetSpy() {
    _spy.close = 0;
    _spy.commit = 0;
    _spy.generate = 0;
}

/**
 * Build a synthetic button object whose `getAttribute('data-action')` returns
 * the given action, and whose `closest()` answers the two queries the
 * dispatcher makes: `[data-action]` → self, `#commitModal` → in/out of scope.
 */
function makeBtn({ action, inScope }) {
    const btn = {
        getAttribute: (name) => (name === 'data-action' ? action : null),
    };
    btn.closest = (sel) => {
        if (sel === '[data-action]') return btn;
        if (sel === '#commitModal') return inScope ? {} : null;
        return null;
    };
    return btn;
}

function makeClick({ action, inScope }) {
    if (action === null) {
        // No `[data-action]` ancestor — `e.target.closest()` returns null.
        return { target: { closest: () => null } };
    }
    return { target: makeBtn({ action, inScope }) };
}

// ============================================
// Wire-up
// ============================================

test('mountCommitModal installs exactly one document click listener', () => {
    assert.equal(_clickListenerCount, 1);
    assert.equal(typeof _capturedListener, 'function');
});

// ============================================
// Routing (in-scope, known actions)
// ============================================

test('data-action="closeCommitModal" inside #commitModal → onClose fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'closeCommitModal', inScope: true }));
    assert.equal(_spy.close, 1);
    assert.equal(_spy.commit, 0);
    assert.equal(_spy.generate, 0);
});

test('data-action="commitAndPush" inside #commitModal → onCommit fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'commitAndPush', inScope: true }));
    assert.equal(_spy.commit, 1);
    assert.equal(_spy.close, 0);
    assert.equal(_spy.generate, 0);
});

test('data-action="generateCommitMsg" inside #commitModal → onGenerate fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'generateCommitMsg', inScope: true }));
    assert.equal(_spy.generate, 1);
    assert.equal(_spy.close, 0);
    assert.equal(_spy.commit, 0);
});

// ============================================
// Filtering (scope + ancestor + unknown-action)
// ============================================

test('data-action button OUTSIDE #commitModal scope → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'closeCommitModal', inScope: false }));
    assert.equal(_spy.close, 0);
    assert.equal(_spy.commit, 0);
    assert.equal(_spy.generate, 0);
});

test('click with no [data-action] ancestor → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: null, inScope: true }));
    assert.equal(_spy.close, 0);
    assert.equal(_spy.commit, 0);
    assert.equal(_spy.generate, 0);
});

test('unknown data-action value inside #commitModal → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'someOtherAction', inScope: true }));
    assert.equal(_spy.close, 0);
    assert.equal(_spy.commit, 0);
    assert.equal(_spy.generate, 0);
});

// ============================================
// Idempotence (_wired guard)
// ============================================

test('second mountCommitModal call is a no-op — _wired guard prevents double-bind', () => {
    const before = _clickListenerCount;
    mountCommitModal({
        onClose: () => { assert.fail('second-mount onClose must not fire'); },
        onCommit: () => { assert.fail('second-mount onCommit must not fire'); },
        onGenerate: () => { assert.fail('second-mount onGenerate must not fire'); },
    });
    assert.equal(_clickListenerCount, before);
    // Original handler still routes to the original spy callbacks.
    resetSpy();
    _capturedListener(makeClick({ action: 'closeCommitModal', inScope: true }));
    assert.equal(_spy.close, 1);
});
