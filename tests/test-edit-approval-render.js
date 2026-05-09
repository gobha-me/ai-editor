/**
 * Tests for the edit-proposal approval-card rendering (github#38).
 *
 * Pre-fix: when the legacy `handleEditRequest` path produced a fenced code
 * block with no surrounding prose, `finalizeStreamingMessage('', {hasCode:true})`
 * rendered just two buttons (Apply / Reject) over an empty body. The user
 * couldn't tell what was being approved, defaulted to Reject, and the model
 * looped silently.
 *
 * Post-fix expectation: the rendered turn carries an inline "edit-proposal"
 * card mirroring the tool-call chrome — path summary + unified diff against
 * the file the user is currently looking at — so the user can see what
 * they're approving.
 */
import { State } from '../js/core.js';
import {
    initChatState,
    setPendingEdit,
    clearPendingEdit,
} from '../js/chat/state.js';
import {
    addStreamingMessage,
    finalizeStreamingMessage,
} from '../js/chat/messages.js';

const { T } = window;

// ===== container setup (mirrors test-message-virtualizer.js) =====
function setupContainer() {
    let container = document.getElementById('test-edit-approval-messages');
    if (container) {
        container.innerHTML = '';
        return container;
    }
    container = document.createElement('div');
    container.id = 'test-edit-approval-messages';
    container.className = 'chat-messages';
    container.style.height = '400px';
    container.style.overflowY = 'auto';
    container.style.position = 'relative';
    document.body.appendChild(container);

    const input = document.createElement('textarea');
    input.style.display = 'none';
    document.body.appendChild(input);

    initChatState(container, input);
    return container;
}

function finalizeAsHasCode(container) {
    addStreamingMessage();
    finalizeStreamingMessage('', { hasCode: true });
    return container.querySelector('.chat-message.assistant:not(.streaming)');
}

// ============================================================================
// 1. Full path — pendingEdit carries path + originalContent + code → diff
// ============================================================================

T.suite('Edit-approval card — full path renders unified diff (github#38)');

(() => {
    const container = setupContainer();
    const startLen = State.chatHistory.length;

    setPendingEdit({
        code: 'const x = 1;\nconst y = 2;\n',
        raw: '',
        path: 'src/foo.js',
        originalContent: 'const x = 1;\n',
    });

    finalizeAsHasCode(container);

    const card = container.querySelector('.edit-proposal');
    T.assert(card, 'edit-proposal card present');

    const name = card?.querySelector('.tool-call-name');
    T.assert(name && /edit_file \(proposed\)/.test(name.textContent || ''),
        'header shows edit_file (proposed)');

    const summary = card?.querySelector('.tool-call-args-summary');
    T.assert(summary && (summary.textContent || '').includes('src/foo.js'),
        'args summary shows the path');

    const diffViewer = card?.querySelector('.diff-viewer');
    T.assert(diffViewer, 'diff-viewer block rendered');

    const added = card?.querySelector('.diff-added');
    T.assert(added, 'at least one .diff-added line (the new "const y = 2;")');

    const applyBtn = container.querySelector('.btn-apply');
    const rejectBtn = container.querySelector('.btn-reject');
    T.assert(applyBtn && rejectBtn, 'Apply + Reject buttons still mounted');

    // cleanup so the next test starts fresh
    clearPendingEdit();
    while (State.chatHistory.length > startLen) State.chatHistory.pop();
    container.innerHTML = '';
})();

// ============================================================================
// 2. No baseline — pendingEdit has path + code but no originalContent → <pre>
// ============================================================================

T.suite('Edit-approval card — no-baseline fallback shows proposed code (github#38)');

(() => {
    const container = setupContainer();
    const startLen = State.chatHistory.length;

    setPendingEdit({
        code: 'console.log("hello");\n',
        raw: '',
        path: 'note.js',
        originalContent: null,  // no file open at proposal time
    });

    finalizeAsHasCode(container);

    const card = container.querySelector('.edit-proposal');
    T.assert(card, 'edit-proposal card present');

    const summary = card?.querySelector('.tool-call-args-summary');
    T.assert(summary && (summary.textContent || '').includes('note.js'),
        'args summary still shows the path');

    T.assert(!card?.querySelector('.diff-viewer'),
        'no diff-viewer (no baseline to diff against)');

    const pre = card?.querySelector('pre.tool-call-json');
    T.assert(pre && (pre.textContent || '').includes('console.log'),
        'proposed code rendered in <pre>');

    clearPendingEdit();
    while (State.chatHistory.length > startLen) State.chatHistory.pop();
    container.innerHTML = '';
})();

// ============================================================================
// 3. Defensive null — pendingEdit cleared before render → bare buttons
// ============================================================================

T.suite('Edit-approval card — defensive null falls back to bare buttons (github#38)');

(() => {
    const container = setupContainer();
    const startLen = State.chatHistory.length;

    clearPendingEdit();  // explicit: nothing pending at render time

    finalizeAsHasCode(container);

    T.assert(!container.querySelector('.edit-proposal'),
        'no edit-proposal card when pendingEdit is null (defensive fallback)');

    const applyBtn = container.querySelector('.btn-apply');
    const rejectBtn = container.querySelector('.btn-reject');
    T.assert(applyBtn && rejectBtn,
        'Apply + Reject buttons still mount (legacy regression guard)');

    while (State.chatHistory.length > startLen) State.chatHistory.pop();
    container.innerHTML = '';
})();
