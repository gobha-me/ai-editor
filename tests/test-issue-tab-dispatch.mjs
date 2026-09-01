/**
 * Dispatcher tests for js/issue-detail.js#mountIssueTab — Phase 3a of the
 * UI event-dispatch contract (docs/DESIGN-ui-event-dispatch.md).
 *
 * Scoped to `.issue-tab-content` (the issue-tab body, distinct from the
 * `#issueDetailModal` covered by mountIssueDetailModal). One action:
 *   - `openIssueTab` reads `data-issue-number` (coerced to Number) — the
 *     error-fallback Retry button.
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

const { mountIssueTab } = await import('../js/issue-detail.js');

// `js/issue-detail.js` transitively imports tab-manager.js and dialogs which
// register their own document click listeners at module load. Reset so the
// "exactly one listener" assertion measures only mountIssueTab's install.
_clickListenerCount = 0;
_capturedListener = null;

const _spy = { open: [] };
mountIssueTab({
    onOpenIssueTab: (n) => { _spy.open.push(n); },
});

function resetSpy() { _spy.open = []; }

function makeBtn({ action, issueNumber, inScope }) {
    const btn = {
        getAttribute: (name) => {
            if (name === 'data-action') return action;
            if (name === 'data-issue-number') return issueNumber == null ? null : String(issueNumber);
            return null;
        },
    };
    btn.closest = (sel) => {
        if (sel === '[data-action]') return btn;
        if (sel === '.issue-tab-content') return inScope ? {} : null;
        return null;
    };
    return btn;
}

function makeClick(opts) {
    if (opts.action === null) return { target: { closest: () => null } };
    return { target: makeBtn(opts) };
}

test('mountIssueTab installs exactly one document click listener', () => {
    assert.equal(_clickListenerCount, 1);
});

test('data-action="openIssueTab" data-issue-number="33" → onOpenIssueTab(33)', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'openIssueTab', issueNumber: 33, inScope: true }));
    assert.deepEqual(_spy.open, [33]);
});

test('issue-number payload arrives as Number, not string', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'openIssueTab', issueNumber: 5, inScope: true }));
    assert.strictEqual(_spy.open[0], 5);
    assert.equal(typeof _spy.open[0], 'number');
});

test('data-action OUTSIDE .issue-tab-content scope → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'openIssueTab', issueNumber: 1, inScope: false }));
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

test('second mountIssueTab call is a no-op', () => {
    const before = _clickListenerCount;
    mountIssueTab({
        onOpenIssueTab: () => { assert.fail('second-mount onOpenIssueTab must not fire'); },
    });
    assert.equal(_clickListenerCount, before);
});
