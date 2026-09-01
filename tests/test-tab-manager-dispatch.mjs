/**
 * Dispatcher tests for js/tab-manager.js#mountTabManager — Phase 3a of the
 * inline-handlers migration (docs/DESIGN-ui-event-dispatch.md).
 *
 * Scoped to `#editorTabs`. Two actions:
 *   - `switchToTab` reads `data-index` (coerced to Number)
 *   - `closeTab` reads `data-index` and is invoked with the click event so the
 *     existing closeTab(index, event) signature stays intact.
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

const { mountTabManager } = await import('../js/tab-manager.js');

_clickListenerCount = 0;
_capturedListener = null;

const _spy = { switch: [], close: [] };
mountTabManager({
    onSwitchTab: (i) => { _spy.switch.push(i); },
    onCloseTab: (i, ev) => { _spy.close.push({ i, ev }); },
});

function resetSpy() { _spy.switch = []; _spy.close = []; }

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
        if (sel === '#editorTabs') return inScope ? {} : null;
        return null;
    };
    return btn;
}

function makeClick(opts) {
    if (opts.action === null) return { target: { closest: () => null } };
    return { target: makeBtn(opts) };
}

test('mountTabManager installs exactly one document click listener', () => {
    assert.equal(_clickListenerCount, 1);
});

test('data-action="switchToTab" data-index="2" → onSwitchTab(2)', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'switchToTab', index: 2, inScope: true }));
    assert.deepEqual(_spy.switch, [2]);
});

test('data-action="closeTab" data-index="3" → onCloseTab(3, event)', () => {
    resetSpy();
    const ev = makeClick({ action: 'closeTab', index: 3, inScope: true });
    _capturedListener(ev);
    assert.equal(_spy.close.length, 1);
    assert.equal(_spy.close[0].i, 3);
    assert.strictEqual(_spy.close[0].ev, ev);
});

test('index payload arrives as Number, not string', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'switchToTab', index: 0, inScope: true }));
    assert.strictEqual(_spy.switch[0], 0);
    assert.equal(typeof _spy.switch[0], 'number');
});

test('data-action OUTSIDE #editorTabs scope → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'switchToTab', index: 0, inScope: false }));
    assert.equal(_spy.switch.length, 0);
});

test('click with no [data-action] ancestor → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: null, inScope: true }));
    assert.equal(_spy.switch.length, 0);
});

test('unknown data-action value → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'someOtherAction', inScope: true }));
    assert.equal(_spy.switch.length, 0);
});

test('second mountTabManager call is a no-op', () => {
    const before = _clickListenerCount;
    mountTabManager({
        onSwitchTab: () => { assert.fail('second-mount onSwitchTab must not fire'); },
    });
    assert.equal(_clickListenerCount, before);
});
