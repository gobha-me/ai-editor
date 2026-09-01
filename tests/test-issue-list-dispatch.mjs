/**
 * Dispatcher tests for js/ui/issue-list.js#mountIssueList — Phase 3a of the
 * UI event-dispatch contract (docs/DESIGN-ui-event-dispatch.md).
 *
 * Scoped to `#issuesPanel`. Three actions:
 *   - `sendDepMessage` reads `data-issue` (coerced to Number) → dep-link chat trigger
 *   - `startWorkOnIssueFromList` reads `data-issue` → inline Start button
 *   - `openIssueTab` reads `data-issue` → row click
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

const { mountIssueList } = await import('../js/ui/issue-list.js');

_clickListenerCount = 0;
_capturedListener = null;

const _spy = { dep: [], start: [], open: [] };
mountIssueList({
    onSendDepMessage: (n) => { _spy.dep.push(n); },
    onStartWork: (n) => { _spy.start.push(n); },
    onOpenIssueTab: (n) => { _spy.open.push(n); },
});

function resetSpy() { _spy.dep = []; _spy.start = []; _spy.open = []; }

function makeBtn({ action, issue, inScope }) {
    const btn = {
        getAttribute: (name) => {
            if (name === 'data-action') return action;
            if (name === 'data-issue') return issue == null ? null : String(issue);
            return null;
        },
    };
    btn.closest = (sel) => {
        if (sel === '[data-action]') return btn;
        if (sel === '#issuesPanel') return inScope ? {} : null;
        return null;
    };
    return btn;
}

function makeClick(opts) {
    if (opts.action === null) return { target: { closest: () => null } };
    return { target: makeBtn(opts) };
}

test('mountIssueList installs exactly one document click listener', () => {
    assert.equal(_clickListenerCount, 1);
});

test('data-action="sendDepMessage" data-issue="42" → onSendDepMessage(42)', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'sendDepMessage', issue: 42, inScope: true }));
    assert.deepEqual(_spy.dep, [42]);
});

test('data-action="startWorkOnIssueFromList" data-issue="7" → onStartWork(7)', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'startWorkOnIssueFromList', issue: 7, inScope: true }));
    assert.deepEqual(_spy.start, [7]);
});

test('data-action="openIssueTab" data-issue="9" → onOpenIssueTab(9)', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'openIssueTab', issue: 9, inScope: true }));
    assert.deepEqual(_spy.open, [9]);
});

test('issue payload arrives as Number, not string', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'openIssueTab', issue: 123, inScope: true }));
    assert.strictEqual(_spy.open[0], 123);
    assert.equal(typeof _spy.open[0], 'number');
});

test('data-action OUTSIDE #issuesPanel scope → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'openIssueTab', issue: 1, inScope: false }));
    assert.equal(_spy.open.length, 0);
});

test('click with no [data-action] ancestor → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: null, inScope: true }));
    assert.equal(_spy.open.length, 0);
});

test('unknown data-action value → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'someOtherAction', inScope: true }));
    assert.equal(_spy.open.length, 0);
});

test('second mountIssueList call is a no-op', () => {
    const before = _clickListenerCount;
    mountIssueList({
        onSendDepMessage: () => { assert.fail('second-mount onSendDepMessage must not fire'); },
    });
    assert.equal(_clickListenerCount, before);
});
