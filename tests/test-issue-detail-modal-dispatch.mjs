/**
 * Dispatcher tests for js/issue-detail.js#mountIssueDetailModal — Phase 2a of
 * the UI event-dispatch contract (docs/DESIGN-ui-event-dispatch.md).
 *
 * The issue-detail modal only has `closeIssueDetailModal` to migrate; the
 * Start Work button is wired directly via `btnIssueStartWork.onclick` inside
 * `openIssueDetailModal()`, and the legacy `onclick="event.stopPropagation()"`
 * on the Expand-All button was removed — the JS click handler set in the
 * comments-render path already calls `e.stopPropagation()`.
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

const { mountIssueDetailModal } = await import('../js/issue-detail.js');

// `js/issue-detail.js` pulls in transitive deps that register their own
// document click listeners at module load (e.g. dialogs). Reset the
// counter so the "exactly one listener" assertion measures only the
// listener mountIssueDetailModal installs.
_clickListenerCount = 0;
_capturedListener = null;

const _spy = { close: 0 };
mountIssueDetailModal({
    onClose: () => { _spy.close++; },
});

function resetSpy() { _spy.close = 0; }

function makeBtn({ action, inScope }) {
    const btn = {
        getAttribute: (name) => (name === 'data-action' ? action : null),
    };
    btn.closest = (sel) => {
        if (sel === '[data-action]') return btn;
        if (sel === '#issueDetailModal') return inScope ? {} : null;
        return null;
    };
    return btn;
}

function makeClick({ action, inScope }) {
    if (action === null) return { target: { closest: () => null } };
    return { target: makeBtn({ action, inScope }) };
}

test('mountIssueDetailModal installs exactly one document click listener', () => {
    assert.equal(_clickListenerCount, 1);
});

test('data-action="closeIssueDetailModal" inside #issueDetailModal → onClose fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'closeIssueDetailModal', inScope: true }));
    assert.equal(_spy.close, 1);
});

test('data-action button OUTSIDE #issueDetailModal scope → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'closeIssueDetailModal', inScope: false }));
    assert.equal(_spy.close, 0);
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
});

test('second mountIssueDetailModal call is a no-op', () => {
    const before = _clickListenerCount;
    mountIssueDetailModal({
        onClose: () => { assert.fail('second-mount onClose must not fire'); },
    });
    assert.equal(_clickListenerCount, before);
});
