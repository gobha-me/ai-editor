/**
 * Tests for the 1.5.10 chat-history persistence fix (issue #16 follow-up).
 *
 * Pre-fix bug: every Storage write of `chatHistory` was clamped to the
 * last 100 messages, and init re-truncated to last 50/RECENT_COUNT on
 * page load. The result: any conversation past 100 messages silently
 * lost the older messages — both from the UI AND from the LLM context.
 *
 * Post-fix expectation: persistence is full-fidelity. State.chatHistory
 * round-trips through Storage with no length cap.
 */
import { State, Storage } from '../js/core.js';
import { addMessage, finalizeStreamingMessage } from '../js/chat/messages.js';

const { T } = window;

// Build a placeholder so finalizeStreamingMessage's DOM path doesn't throw.
function setupPlaceholder() {
    const old = document.getElementById('streaming-message');
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = 'streaming-message';
    el.className = 'message streaming';
    const content = document.createElement('div');
    content.className = 'message-content';
    el.appendChild(content);
    const time = document.createElement('div');
    time.className = 'message-time';
    el.appendChild(time);
    document.body.appendChild(el);
    return el;
}

// ============================================
// addMessage persists the FULL history, not just last 100
// ============================================

T.suite('Chat history — addMessage persists full history');

(() => {
    const startLen = State.chatHistory.length;

    // Push 250 user messages — well past the old 100-message cap
    for (let i = 0; i < 250; i++) {
        addMessage('user', `msg-${i}`);
    }

    T.eq(State.chatHistory.length, startLen + 250, "State.chatHistory grew to 250 new messages");

    const persisted = Storage.get('chatHistory', []);
    T.eq(persisted.length, State.chatHistory.length, "Storage holds the same length as State");
    T.assert(persisted.length > 100, `Storage retains > 100 messages (got ${persisted.length})`);

    // Confirm the OLDEST of the new messages is still in Storage — this is
    // the message that pre-fix would have been silently dropped.
    const newOldest = persisted[startLen];
    T.eq(newOldest.content, 'msg-0', "oldest pushed message survived persistence");

    // Cleanup
    State.chatHistory.length = startLen;
    Storage.set('chatHistory', State.chatHistory);
})();

// ============================================
// finalizeStreamingMessage persists past the 100-message boundary
// ============================================

T.suite('Chat history — finalizeStreamingMessage persists past 100');

(() => {
    const startLen = State.chatHistory.length;

    // Pre-seed with 120 messages so the next finalize push lands at index 120+
    for (let i = 0; i < 120; i++) {
        State.chatHistory.push({
            role: 'user',
            content: `seed-${i}`,
            timestamp: Date.now()
        });
    }
    Storage.set('chatHistory', State.chatHistory);

    setupPlaceholder();
    finalizeStreamingMessage('assistant reply at index 120', {});

    const persisted = Storage.get('chatHistory', []);
    T.eq(persisted.length, startLen + 121, "121 messages persisted (120 seed + 1 finalized)");

    // Find the finalized message — should be the last assistant entry
    const last = persisted[persisted.length - 1];
    T.eq(last.role, 'assistant', "last persisted message is the finalized assistant turn");
    T.eq(last.content, 'assistant reply at index 120', "finalized content survived");

    // The seed messages are still there — confirms no slice(-100) clamp
    T.eq(persisted[startLen].content, 'seed-0', "seed-0 survived through the persistence boundary");

    // Cleanup
    State.chatHistory.length = startLen;
    Storage.set('chatHistory', State.chatHistory);
    const tail = document.getElementById('streaming-message');
    if (tail) tail.remove();
})();

// ============================================
// Storage round-trip preserves arbitrary-length history
// ============================================

T.suite('Chat history — Storage round-trip preserves length');

(() => {
    const synth = [];
    for (let i = 0; i < 500; i++) {
        synth.push({
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: `synth-${i}`,
            timestamp: Date.now() + i
        });
    }

    Storage.set('chatHistory', synth);
    const back = Storage.get('chatHistory', []);

    T.eq(back.length, 500, "Storage round-trip preserves all 500 messages");
    T.eq(back[0].content, 'synth-0', "first message preserved");
    T.eq(back[499].content, 'synth-499', "last message preserved");
    T.eq(back[250].content, 'synth-250', "middle message preserved");

    // Cleanup
    Storage.set('chatHistory', []);
})();
