/**
 * Regression test for the 1.21.1 chatHistory alias corruption bug.
 *
 * Pre-fix, `ConversationManager.save()` stored
 * `messages: State.chatHistory` directly into the conv-{id} payload
 * — a live reference, not a snapshot. Combined with the in-place
 * `ChatHistoryStore.replace()` mutation introduced at 1.11.0
 * (`length = 0` then `push(...arr)`), this meant that switching away
 * from a conversation aliased its cached payload's `messages` field
 * to `State.chatHistory`. The next conversation switch's
 * `ChatHistoryStore.replace(payload.messages)` then cleared *both*
 * arrays in the same mutation — dropping all messages of the
 * previously-active conversation.
 *
 * The fire-and-forget IDB write that was queued by the prior
 * `save()` would then structured-clone the post-mutation array,
 * persisting the corrupted (empty) state to durable storage.
 *
 * The Storage stub here intentionally stores values by reference —
 * same as `Storage._cache.set()` — so the test faithfully exercises
 * the alias path. JSON.stringify-on-read would mask the bug.
 *
 * Fix: `js/chat/conversations.js:182` snapshots `messages` with
 * `.slice()` before storing.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { State, Storage } from '../js/core.js';
import { ConversationManager } from '../js/chat/conversations.js';
import { ChatHistoryStore } from '../js/chat/history-store.js';

// ============================================
// Storage stub — in-memory Map storing values by reference (mirrors
// the production `Storage._cache.set(key, value)` behavior).
// ============================================

const _origGet = Storage.get.bind(Storage);
const _origSet = Storage.set.bind(Storage);
const _origRemove = Storage.remove.bind(Storage);

let store = new Map();

function installStub() {
    store = new Map();
    Storage.get = (key, defaultValue = null) => (store.has(key) ? store.get(key) : defaultValue);
    Storage.set = (key, value) => { store.set(key, value); };
    Storage.remove = (key) => { store.delete(key); };
}

function restoreStub() {
    Storage.get = _origGet;
    Storage.set = _origSet;
    Storage.remove = _origRemove;
}

function reset() {
    store.clear();
    State.chatHistory.length = 0;
    State.scratchpad = {};
    State.toolActionLog = [];
    State.todo = [];
    State.lastExchangeTokens = null;
}

test.before(installStub);
test.after(restoreStub);

// ============================================
// Direct alias check — the smoking-gun assertion.
// ============================================

test('save() does not alias State.chatHistory into the cached payload', () => {
    reset();
    ChatHistoryStore.append({ role: 'user', content: 'hello' });
    ConversationManager.save();

    const id = ConversationManager.getActiveId();
    const cached = store.get(`conv-${id}`);

    assert.notEqual(
        cached.messages,
        State.chatHistory,
        'cached payload.messages must be a snapshot, not the live State.chatHistory reference',
    );

    // Mutate the live array; the cached snapshot must NOT see it.
    const cachedLenBefore = cached.messages.length;
    ChatHistoryStore.append({ role: 'assistant', content: 'world' });
    assert.equal(
        cached.messages.length,
        cachedLenBefore,
        'mutating State.chatHistory after save() must not change the cached payload',
    );
});

// ============================================
// End-to-end: save A → load B → save B → load A — A must survive.
// ============================================

test('round-trip: switching conversations preserves the previously-active one', () => {
    reset();

    // === Conversation A: 3 messages, save and become active ===
    ChatHistoryStore.append({ role: 'user', content: 'A1' });
    ChatHistoryStore.append({ role: 'assistant', content: 'A2' });
    ChatHistoryStore.append({ role: 'user', content: 'A3' });
    ConversationManager.save();
    const idA = ConversationManager.getActiveId();
    assert.ok(idA, 'A should have an active id after save');

    // === Conversation B: create a separate cached payload ===
    // Seeded directly into the store so we can control its message list
    // without going through save() (which would already break the alias
    // post-fix; we want a clean B payload to load into).
    const idB = 'conv-b-fixture';
    store.set(`conv-${idB}`, {
        messages: [
            { role: 'user', content: 'B1' },
            { role: 'assistant', content: 'B2' },
        ],
        summaryInfo: null,
        pruneStash: null,
        toolActionLog: [],
        todos: [],
        scratchpad: {},
    });
    store.set('conversations', [
        { id: idA, title: 'A', createdAt: 1, updatedAt: 1, messageCount: 3 },
        { id: idB, title: 'B', createdAt: 2, updatedAt: 2, messageCount: 2 },
    ]);

    // === Switch to B — pre-fix this would have corrupted A's cache ===
    ConversationManager.load(idB);
    assert.equal(ConversationManager.getActiveId(), idB);
    assert.equal(State.chatHistory.length, 2);
    assert.equal(State.chatHistory[0].content, 'B1');

    // === Verify A's cached payload still has its 3 messages ===
    const cachedA = store.get(`conv-${idA}`);
    assert.ok(cachedA, 'A should still be cached');
    assert.equal(
        cachedA.messages.length,
        3,
        `pre-fix bug: A's cached messages get cleared by ChatHistoryStore.replace's in-place mutation when it ran for B (got ${cachedA.messages.length}, expected 3)`,
    );
    assert.equal(cachedA.messages[0].content, 'A1');
    assert.equal(cachedA.messages[2].content, 'A3');

    // === Switch back to A — its messages must still be there ===
    ConversationManager.load(idA);
    assert.equal(ConversationManager.getActiveId(), idA);
    assert.equal(
        State.chatHistory.length,
        3,
        `pre-fix bug: A's messages were lost during the B↔A round-trip (got ${State.chatHistory.length}, expected 3)`,
    );
    assert.equal(State.chatHistory[0].content, 'A1');
    assert.equal(State.chatHistory[2].content, 'A3');
});
