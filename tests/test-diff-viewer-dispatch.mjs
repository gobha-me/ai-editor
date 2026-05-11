/**
 * Dispatcher tests for js/diff-viewer.js#mountDiffViewer — Phase 3a of the
 * inline-handlers migration (docs/DESIGN-html-inline-handlers-migration.md).
 *
 * Scoped to `.diff-controls`. Three actions:
 *   - `setViewMode` reads `data-mode` ("unified" | "side-by-side")
 *   - `previousChange` and `nextChange` are zero-arg
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

const { mountDiffViewer } = await import('../js/diff-viewer.js');

// diff-viewer.js may register transitive listeners at module load — reset.
_clickListenerCount = 0;
_capturedListener = null;

const _spy = { setMode: [], prev: 0, next: 0 };
mountDiffViewer({
    onSetViewMode: (mode) => { _spy.setMode.push(mode); },
    onPreviousChange: () => { _spy.prev++; },
    onNextChange: () => { _spy.next++; },
});

function resetSpy() { _spy.setMode = []; _spy.prev = 0; _spy.next = 0; }

function makeBtn({ action, mode, inScope }) {
    const btn = {
        getAttribute: (name) => {
            if (name === 'data-action') return action;
            if (name === 'data-mode') return mode ?? null;
            return null;
        },
    };
    btn.closest = (sel) => {
        if (sel === '[data-action]') return btn;
        if (sel === '.diff-controls') return inScope ? {} : null;
        return null;
    };
    return btn;
}

function makeClick({ action, mode, inScope }) {
    if (action === null) return { target: { closest: () => null } };
    return { target: makeBtn({ action, mode, inScope }) };
}

test('mountDiffViewer installs exactly one document click listener', () => {
    assert.equal(_clickListenerCount, 1);
});

test('data-action="setViewMode" data-mode="unified" → onSetViewMode("unified")', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'setViewMode', mode: 'unified', inScope: true }));
    assert.deepEqual(_spy.setMode, ['unified']);
});

test('data-action="setViewMode" data-mode="side-by-side" → onSetViewMode("side-by-side")', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'setViewMode', mode: 'side-by-side', inScope: true }));
    assert.deepEqual(_spy.setMode, ['side-by-side']);
});

test('data-action="previousChange" → onPreviousChange fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'previousChange', inScope: true }));
    assert.equal(_spy.prev, 1);
});

test('data-action="nextChange" → onNextChange fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'nextChange', inScope: true }));
    assert.equal(_spy.next, 1);
});

test('data-action OUTSIDE .diff-controls scope → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'nextChange', inScope: false }));
    assert.equal(_spy.next, 0);
});

test('click with no [data-action] ancestor → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: null, inScope: true }));
    assert.equal(_spy.next, 0);
    assert.equal(_spy.prev, 0);
    assert.deepEqual(_spy.setMode, []);
});

test('unknown data-action value → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'someOtherAction', inScope: true }));
    assert.equal(_spy.next, 0);
});

test('second mountDiffViewer call is a no-op', () => {
    const before = _clickListenerCount;
    mountDiffViewer({
        onSetViewMode: () => { assert.fail('second-mount onSetViewMode must not fire'); },
        onPreviousChange: () => { assert.fail('second-mount onPreviousChange must not fire'); },
        onNextChange: () => { assert.fail('second-mount onNextChange must not fire'); },
    });
    assert.equal(_clickListenerCount, before);
});
