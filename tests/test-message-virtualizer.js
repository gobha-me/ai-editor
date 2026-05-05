/**
 * Tests for the chat-message virtualizer (1.6.x dogfood DOM-bloat fix).
 *
 * Pre-fix: `renderMessages()` rendered every entry in `State.chatHistory`
 * eagerly. A 138-message session with ~5 tool blocks per assistant turn
 * pinned the browser tab at 100% CPU on layout/paint.
 *
 * Post-fix expectation: only a windowed slice of the history is mounted
 * at any time; older messages page in via a top sentinel +
 * IntersectionObserver. See `js/chat/message-virtualizer.js`.
 */
import { State, Storage } from '../js/core.js';
import { initChatState } from '../js/chat/state.js';
import { renderMessages, addMessage } from '../js/chat/messages.js';
import {
    _testTriggerExpand,
    _testTriggerPruneTop,
    _testGetState,
} from '../js/chat/message-virtualizer.js';

const { T } = window;

// Shared scroll container — initChatState wires it as the chat container
// for the entire test run. The container needs an explicit height so
// scrollHeight/clientHeight calculations behave like a real chat pane.
function setupContainer() {
    let container = document.getElementById('test-chat-messages');
    if (container) {
        container.innerHTML = '';
        return container;
    }
    container = document.createElement('div');
    container.id = 'test-chat-messages';
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

function seed(history, n, prefix = 'msg') {
    for (let i = 0; i < n; i++) {
        history.push({
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: `${prefix}-${i}`,
            timestamp: Date.now() + i,
        });
    }
}

function virtCount(container) {
    return container.querySelectorAll('[data-virt-idx]').length;
}

// ============================================
// Initial render only mounts the trailing window
// ============================================

T.suite('Message virtualizer — initial render mounts trailing window only');

(() => {
    const container = setupContainer();
    const startLen = State.chatHistory.length;
    seed(State.chatHistory, 200);

    renderMessages();

    const mounted = virtCount(container);
    T.assert(mounted <= 150, `mounted <= MAX_WINDOW (got ${mounted})`);
    T.assert(mounted >= 50,  `mounted >= BATCH (got ${mounted})`);
    T.assert(mounted < 200,  `eager render avoided (got ${mounted} < 200)`);

    // The newest message should be in the rendered window, not the oldest.
    const firstTagged = container.querySelector('[data-virt-idx]');
    const lastTagged = [...container.querySelectorAll('[data-virt-idx]')].pop();
    const firstIdx = parseInt(firstTagged.getAttribute('data-virt-idx'), 10);
    const lastIdx  = parseInt(lastTagged.getAttribute('data-virt-idx'), 10);
    T.eq(lastIdx, startLen + 199, "newest message is in the rendered window");
    T.assert(firstIdx > startLen, `oldest messages are NOT mounted (firstIdx=${firstIdx})`);

    // Cleanup
    State.chatHistory.length = startLen;
    Storage.set('chatHistory', State.chatHistory);
})();

// ============================================
// Top-expansion pages older messages in
// ============================================

T.suite('Message virtualizer — scroll-up triggers expand');

(() => {
    const container = setupContainer();
    const startLen = State.chatHistory.length;
    seed(State.chatHistory, 200);

    renderMessages();
    const before = virtCount(container);
    const stateBefore = _testGetState();
    T.assert(stateBefore.nextOlderIdx >= 0, "older messages exist to load");

    _testTriggerExpand();

    const after = virtCount(container);
    T.assert(after > before, `expand grew rendered count (before=${before}, after=${after})`);
    T.assert(after <= 200, `expand bounded by total history (got ${after})`);

    // Cleanup
    State.chatHistory.length = startLen;
    Storage.set('chatHistory', State.chatHistory);
})();

// ============================================
// addMessage at-bottom appends and prunes top to MAX_WINDOW
// ============================================

T.suite('Message virtualizer — addMessage at-bottom prunes top');

(() => {
    const container = setupContainer();
    const startLen = State.chatHistory.length;

    // Mount with the full window already maxed out
    seed(State.chatHistory, 150);
    renderMessages();
    // Force scroll-to-bottom so addMessage's notify path treats us as at-bottom
    container.scrollTop = container.scrollHeight;

    const before = virtCount(container);
    addMessage('user', 'tail-msg');
    // Manually invoke the prune the same way `_onScroll` would after the
    // user reaches bottom — JSDOM/headless tests don't reliably fire scroll.
    _testTriggerPruneTop();

    const after = virtCount(container);
    T.assert(after <= 150, `prune kept window <= MAX_WINDOW (got ${after})`);
    // The newest message should still be in the DOM.
    const lastTagged = [...container.querySelectorAll('[data-virt-idx]')].pop();
    T.eq(
        lastTagged.textContent.includes('tail-msg'),
        true,
        "newly-appended message survived the prune",
    );

    // Cleanup
    State.chatHistory.length = startLen;
    Storage.set('chatHistory', State.chatHistory);
    void before; // unused but kept for diagnostic clarity
})();

// ============================================
// "↓ N new" pill appears when scrolled up and a new message arrives
// ============================================

T.suite('Message virtualizer — pill on append-while-scrolled-up');

(() => {
    const container = setupContainer();
    const startLen = State.chatHistory.length;
    seed(State.chatHistory, 200);

    renderMessages();
    // Scroll to top to simulate "user reading old context"
    container.scrollTop = 0;

    addMessage('assistant', 'reply while scrolled up');

    const state = _testGetState();
    T.eq(state.hasPill, true, "pill mounted while user was scrolled up");
    T.assert(state.pendingNewCount >= 1, `pendingNewCount tracked (got ${state.pendingNewCount})`);

    const pill = container.querySelector('.chat-virt-pill');
    T.assert(!!pill, "pill exists in DOM");
    T.assert(pill.textContent.includes('new'), `pill labels the new count: "${pill.textContent}"`);

    // Cleanup
    State.chatHistory.length = startLen;
    Storage.set('chatHistory', State.chatHistory);
})();

// ============================================
// Empty history shows the welcome screen, no virtualizer mounted
// ============================================

T.suite('Message virtualizer — empty history renders welcome');

(() => {
    const container = setupContainer();
    const startLen = State.chatHistory.length;
    State.chatHistory.length = 0;

    renderMessages();

    T.assert(!!container.querySelector('.chat-welcome'), "welcome screen rendered");
    T.eq(_testGetState(), null, "no virtualizer state mounted for empty history");

    // Cleanup — restore prior state
    State.chatHistory.length = 0;
    for (let i = 0; i < startLen; i++) State.chatHistory.push({ role: 'user', content: 'x', timestamp: 0 });
    State.chatHistory.length = startLen;
    Storage.set('chatHistory', State.chatHistory);
})();
