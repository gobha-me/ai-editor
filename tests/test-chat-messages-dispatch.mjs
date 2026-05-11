/**
 * Dispatcher tests for js/chat/messages.js#mountChatMessages — Phase 3b
 * of the inline-handlers migration
 * (docs/DESIGN-html-inline-handlers-migration.md), the final HTML-side
 * slice. Scoped to `#chatMessages`.
 *
 * Routes 9 callback actions + an internal DOM-only `toggleExpanded`:
 *   - simple (no arg):  applyPendingEdit, rejectPendingEdit,
 *                       continueResponse, retryLastMessage
 *   - this-passing:     copyMessage, editMessage, commitEdit, cancelEdit
 *                       (callback receives the matched button element)
 *   - data-src string:  previewImage (reads `data-src`)
 *   - DOM-only:         toggleExpanded (reads `data-target`, calls
 *                                       getElementById(target)
 *                                       ?.classList.toggle('expanded')
 *                                       per Decision 5)
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Capture the document-level click listener installed by mountChatMessages.
let _capturedListener = null;
let _clickListenerCount = 0;
globalThis.document.addEventListener = (type, handler) => {
    if (type === 'click') {
        _clickListenerCount++;
        _capturedListener = handler;
    }
};

// `toggleExpanded` calls document.getElementById(target)?.classList.toggle —
// stub it so we can assert the call shape without needing real DOM.
let _toggleCalls = [];
let _toggleTargetReturn = null;
globalThis.document.getElementById = (id) => {
    if (id === _toggleTargetReturn?.id) {
        return _toggleTargetReturn;
    }
    return null;
};

const { mountChatMessages } = await import('../js/chat/messages.js');

_clickListenerCount = 0;
_capturedListener = null;

const _spy = {
    applyPendingEdit: 0,
    rejectPendingEdit: 0,
    continueResponse: 0,
    retryLastMessage: 0,
    copyMessage: [],
    editMessage: [],
    commitEdit: [],
    cancelEdit: [],
    previewImage: [],
};

mountChatMessages({
    onApplyPendingEdit: () => { _spy.applyPendingEdit++; },
    onRejectPendingEdit: () => { _spy.rejectPendingEdit++; },
    onContinueResponse: () => { _spy.continueResponse++; },
    onRetryLastMessage: () => { _spy.retryLastMessage++; },
    onCopyMessage: (btn) => { _spy.copyMessage.push(btn); },
    onEditMessage: (btn) => { _spy.editMessage.push(btn); },
    onCommitEdit: (btn) => { _spy.commitEdit.push(btn); },
    onCancelEdit: (btn) => { _spy.cancelEdit.push(btn); },
    onPreviewImage: (url) => { _spy.previewImage.push(url); },
});

function resetSpy() {
    _spy.applyPendingEdit = 0;
    _spy.rejectPendingEdit = 0;
    _spy.continueResponse = 0;
    _spy.retryLastMessage = 0;
    _spy.copyMessage = [];
    _spy.editMessage = [];
    _spy.commitEdit = [];
    _spy.cancelEdit = [];
    _spy.previewImage = [];
    _toggleCalls = [];
    _toggleTargetReturn = null;
}

function makeBtn({ action, src, target, inScope }) {
    const btn = {
        getAttribute: (name) => {
            if (name === 'data-action') return action;
            if (name === 'data-src') return src == null ? null : String(src);
            if (name === 'data-target') return target == null ? null : String(target);
            return null;
        },
    };
    btn.closest = (sel) => {
        if (sel === '[data-action]') return btn;
        if (sel === '#chatMessages') return inScope ? {} : null;
        return null;
    };
    return btn;
}

function makeClick(opts) {
    if (opts.action === null) return { target: { closest: () => null } };
    return { target: makeBtn(opts) };
}

test('mountChatMessages installs exactly one document click listener', () => {
    assert.equal(_clickListenerCount, 1);
});

test('data-action="applyPendingEdit" → onApplyPendingEdit()', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'applyPendingEdit', inScope: true }));
    assert.equal(_spy.applyPendingEdit, 1);
});

test('data-action="rejectPendingEdit" → onRejectPendingEdit()', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'rejectPendingEdit', inScope: true }));
    assert.equal(_spy.rejectPendingEdit, 1);
});

test('data-action="continueResponse" → onContinueResponse()', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'continueResponse', inScope: true }));
    assert.equal(_spy.continueResponse, 1);
});

test('data-action="retryLastMessage" → onRetryLastMessage()', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'retryLastMessage', inScope: true }));
    assert.equal(_spy.retryLastMessage, 1);
});

test('data-action="copyMessage" → onCopyMessage(btn) receives the matched button', () => {
    resetSpy();
    const btn = makeBtn({ action: 'copyMessage', inScope: true });
    _capturedListener({ target: btn });
    assert.equal(_spy.copyMessage.length, 1);
    assert.strictEqual(_spy.copyMessage[0], btn);
});

test('data-action="editMessage" → onEditMessage(btn) receives the matched button', () => {
    resetSpy();
    const btn = makeBtn({ action: 'editMessage', inScope: true });
    _capturedListener({ target: btn });
    assert.equal(_spy.editMessage.length, 1);
    assert.strictEqual(_spy.editMessage[0], btn);
});

test('data-action="commitEdit" → onCommitEdit(btn) receives the matched button', () => {
    resetSpy();
    const btn = makeBtn({ action: 'commitEdit', inScope: true });
    _capturedListener({ target: btn });
    assert.equal(_spy.commitEdit.length, 1);
    assert.strictEqual(_spy.commitEdit[0], btn);
});

test('data-action="cancelEdit" → onCancelEdit(btn) receives the matched button', () => {
    resetSpy();
    const btn = makeBtn({ action: 'cancelEdit', inScope: true });
    _capturedListener({ target: btn });
    assert.equal(_spy.cancelEdit.length, 1);
    assert.strictEqual(_spy.cancelEdit[0], btn);
});

test('data-action="previewImage" → onPreviewImage reads data-src as a string', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'previewImage', src: 'https://example.com/cat.png', inScope: true }));
    assert.deepEqual(_spy.previewImage, ['https://example.com/cat.png']);
    assert.equal(typeof _spy.previewImage[0], 'string');
});

test('data-action="toggleExpanded" → calls getElementById(target).classList.toggle("expanded")', () => {
    resetSpy();
    const fakeEl = {
        id: 'summary-123',
        classList: {
            toggle: (cls) => { _toggleCalls.push(cls); },
        },
    };
    _toggleTargetReturn = fakeEl;
    _capturedListener(makeClick({ action: 'toggleExpanded', target: 'summary-123', inScope: true }));
    assert.deepEqual(_toggleCalls, ['expanded']);
});

test('data-action="toggleExpanded" with missing target is a safe no-op', () => {
    resetSpy();
    // No fakeEl registered → getElementById returns null → optional-chain skips toggle.
    _capturedListener(makeClick({ action: 'toggleExpanded', target: 'does-not-exist', inScope: true }));
    assert.deepEqual(_toggleCalls, []);
});

test('data-action OUTSIDE #chatMessages scope → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'copyMessage', inScope: false }));
    _capturedListener(makeClick({ action: 'applyPendingEdit', inScope: false }));
    _capturedListener(makeClick({ action: 'previewImage', src: 'x', inScope: false }));
    assert.equal(_spy.copyMessage.length, 0);
    assert.equal(_spy.applyPendingEdit, 0);
    assert.equal(_spy.previewImage.length, 0);
});

test('click with no [data-action] ancestor → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: null, inScope: true }));
    assert.equal(_spy.applyPendingEdit, 0);
    assert.equal(_spy.copyMessage.length, 0);
});

test('unknown data-action value → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'someOtherAction', inScope: true }));
    assert.equal(_spy.applyPendingEdit, 0);
    assert.equal(_spy.copyMessage.length, 0);
});

test('second mountChatMessages call is a no-op (idempotent _wired guard)', () => {
    const before = _clickListenerCount;
    mountChatMessages({
        onCopyMessage: () => { assert.fail('second-mount onCopyMessage must not fire'); },
    });
    assert.equal(_clickListenerCount, before);
});
