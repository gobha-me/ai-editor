/**
 * Regression test for gobha-me/ai-editor#41 — ensures
 * `injectFinalizationButtons()` attaches continue + copy buttons to the last
 * assistant message AND edit + retry buttons to the last user message, when
 * called outside the `finalizeStreamingMessage` path (i.e. when the
 * streaming placeholder has already been disposed by `onRoundCommit`).
 *
 * Why this test exists: gitea PR #515 tried to fix the missing-continue-button
 * bug by calling `finalizeStreamingMessage('')` after removing the placeholder,
 * but that function gates ALL button rendering on finding the placeholder in
 * the DOM — so the call was a no-op. This test guards the *correct* path: a
 * dedicated injector that mirrors `_injectUserEditButtons` rather than going
 * through finalize.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeMockMessageEl({ existingActions = false } = {}) {
    const appended = [];
    return {
        appended,
        querySelector: (sel) => {
            if (sel === '.message-actions' && existingActions) return { __sentinel: 'existing-actions' };
            return null;
        },
        appendChild: (el) => { appended.push(el); },
    };
}

function makeMockContainer({ assistant = [], user = [] } = {}) {
    return {
        querySelectorAll: (sel) => {
            if (sel === '.chat-message.assistant') return assistant;
            if (sel === '.chat-message.user') return user;
            return [];
        },
    };
}

// `document.createElement` from the shim returns an object with `_innerHTML`;
// we use that to inspect the injected button HTML.
function lastAppendedHtml(el) {
    if (!el.appended.length) return null;
    const child = el.appended[el.appended.length - 1];
    return child._innerHTML ?? child.innerHTML ?? null;
}

const { initChatState } = await import('../js/chat/state.js');
const { injectFinalizationButtons } = await import('../js/chat/messages.js');

test('injectFinalizationButtons appends continue+copy on last assistant and edit+retry on last user', () => {
    const assistant1 = makeMockMessageEl();
    const assistant2 = makeMockMessageEl();
    const user1 = makeMockMessageEl();
    const user2 = makeMockMessageEl();
    const container = makeMockContainer({ assistant: [assistant1, assistant2], user: [user1, user2] });
    initChatState(container, null);

    injectFinalizationButtons();

    // Only the LAST of each role gets buttons
    assert.equal(assistant1.appended.length, 0, 'earlier assistant message should not receive buttons');
    assert.equal(user1.appended.length, 0, 'earlier user message should not receive buttons');
    assert.equal(assistant2.appended.length, 1, 'last assistant should receive exactly one action div');
    assert.equal(user2.appended.length, 1, 'last user should receive exactly one action div');

    const assistantHtml = lastAppendedHtml(assistant2);
    assert.match(assistantHtml, /data-action="continueResponse"/, 'continue button is injected');
    assert.match(assistantHtml, /data-action="copyMessage"/, 'copy button is injected');
    assert.match(assistantHtml, /btn-continue/, 'continue button has expected class');

    const userHtml = lastAppendedHtml(user2);
    assert.match(userHtml, /data-action="editMessage"/, 'edit button is injected');
    assert.match(userHtml, /data-action="retryLastMessage"/, 'retry button is injected');
});

test('injectFinalizationButtons is idempotent — skips when .message-actions already exists', () => {
    const assistant = makeMockMessageEl({ existingActions: true });
    const user = makeMockMessageEl({ existingActions: true });
    const container = makeMockContainer({ assistant: [assistant], user: [user] });
    initChatState(container, null);

    injectFinalizationButtons();

    assert.equal(assistant.appended.length, 0, 'should not re-inject assistant buttons');
    assert.equal(user.appended.length, 0, 'should not re-inject user buttons');
});

test('injectFinalizationButtons no-ops when there is no chat container', () => {
    initChatState(null, null);
    // Should not throw — function bails on `if (!chatContainer)` guards
    assert.doesNotThrow(() => injectFinalizationButtons());
});

test('injectFinalizationButtons no-ops when there are no matching messages', () => {
    const container = makeMockContainer({ assistant: [], user: [] });
    initChatState(container, null);
    assert.doesNotThrow(() => injectFinalizationButtons());
});
