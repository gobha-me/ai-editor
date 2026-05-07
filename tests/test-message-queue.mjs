/**
 * Tests for the queued user input module (github#33 Phase 2 — 1.9.1).
 *
 * Exercises the pure-state surface in js/chat/state.js — enqueue/drain,
 * cap behavior, FIFO ordering, cancel-preservation contract, event
 * emission. The DOM-side panel and the chat-loop drain seam are
 * exercised in the browser suite (tests/index.html).
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EventBus } from '../js/core.js';
import {
    enqueueUserMessage,
    peekUserMessageQueue,
    drainUserMessageQueue,
    removeQueuedUserMessage,
    clearUserMessageQueue,
    getUserMessageQueueLength,
    cancelToolLoop,
    resetToolLoopCancel,
} from '../js/chat/state.js';

function reset() {
    // Empty the queue between tests without firing the cancel path.
    while (getUserMessageQueueLength() > 0) drainUserMessageQueue();
    resetToolLoopCancel();
}

// ============================================
// Enqueue / drain basics
// ============================================

test('enqueueUserMessage stores text and snapshot of images', () => {
    reset();
    const r = enqueueUserMessage({ text: 'hello', images: [{ name: 'a.png', dataUrl: 'data:1' }] });
    assert.equal(r.queued, true);
    assert.equal(r.droppedOldest, false);
    assert.equal(r.length, 1);
    const peek = peekUserMessageQueue();
    assert.equal(peek.length, 1);
    assert.equal(peek[0].text, 'hello');
    assert.equal(peek[0].images.length, 1);
    assert.equal(peek[0].images[0].name, 'a.png');
});

test('peek returns a copy — caller mutation does not affect queue', () => {
    reset();
    enqueueUserMessage({ text: 'one' });
    const peek = peekUserMessageQueue();
    peek.push({ text: 'mutated', images: [] });
    assert.equal(getUserMessageQueueLength(), 1);
});

test('drainUserMessageQueue returns FIFO and empties storage', () => {
    reset();
    enqueueUserMessage({ text: 'one' });
    enqueueUserMessage({ text: 'two' });
    enqueueUserMessage({ text: 'three' });
    const drained = drainUserMessageQueue();
    assert.equal(drained.length, 3);
    assert.equal(drained[0].text, 'one');
    assert.equal(drained[1].text, 'two');
    assert.equal(drained[2].text, 'three');
    assert.equal(getUserMessageQueueLength(), 0);
});

test('enqueue normalizes missing fields', () => {
    reset();
    enqueueUserMessage({ text: 'plain' });
    const peek = peekUserMessageQueue();
    assert.deepEqual(peek[0].images, []);
    assert.equal(peek[0].text, 'plain');
});

// ============================================
// Cap behavior
// ============================================

test('enqueue past cap drops oldest and signals droppedOldest', () => {
    reset();
    for (let i = 1; i <= 5; i++) enqueueUserMessage({ text: `m${i}` });
    assert.equal(getUserMessageQueueLength(), 5);
    const r = enqueueUserMessage({ text: 'm6' });
    assert.equal(r.droppedOldest, true);
    assert.equal(r.length, 5);
    const peek = peekUserMessageQueue();
    assert.equal(peek[0].text, 'm2', 'oldest (m1) should have been dropped');
    assert.equal(peek[4].text, 'm6');
});

test('enqueue twice past cap drops two oldest', () => {
    reset();
    for (let i = 1; i <= 7; i++) enqueueUserMessage({ text: `m${i}` });
    assert.equal(getUserMessageQueueLength(), 5);
    const peek = peekUserMessageQueue();
    assert.equal(peek[0].text, 'm3');
    assert.equal(peek[4].text, 'm7');
});

// ============================================
// Removal & explicit clear
// ============================================

test('removeQueuedUserMessage removes by index', () => {
    reset();
    enqueueUserMessage({ text: 'a' });
    enqueueUserMessage({ text: 'b' });
    enqueueUserMessage({ text: 'c' });
    assert.equal(removeQueuedUserMessage(1), true);
    const peek = peekUserMessageQueue();
    assert.equal(peek.length, 2);
    assert.equal(peek[0].text, 'a');
    assert.equal(peek[1].text, 'c');
});

test('removeQueuedUserMessage returns false for out-of-range index', () => {
    reset();
    enqueueUserMessage({ text: 'only' });
    assert.equal(removeQueuedUserMessage(5), false);
    assert.equal(removeQueuedUserMessage(-1), false);
    assert.equal(getUserMessageQueueLength(), 1);
});

test('clearUserMessageQueue empties the queue and emits 0', () => {
    reset();
    enqueueUserMessage({ text: 'a' });
    enqueueUserMessage({ text: 'b' });
    let lastEmit = -1;
    const off = EventBus.on('chat:queueChanged', (n) => { lastEmit = n; });
    try {
        clearUserMessageQueue();
        assert.equal(getUserMessageQueueLength(), 0);
        assert.equal(lastEmit, 0);
    } finally {
        off();
    }
});

// ============================================
// Cancel-preservation contract (load-bearing)
// ============================================

test('cancelToolLoop does NOT clear the queue', () => {
    reset();
    enqueueUserMessage({ text: 'queued before cancel' });
    enqueueUserMessage({ text: 'still queued' });
    cancelToolLoop();
    assert.equal(
        getUserMessageQueueLength(),
        2,
        'queue must survive cancellation per github#33 Phase 2 spec'
    );
    const peek = peekUserMessageQueue();
    assert.equal(peek[0].text, 'queued before cancel');
    assert.equal(peek[1].text, 'still queued');
    resetToolLoopCancel();
});

// ============================================
// Event emission
// ============================================

test('enqueue emits chat:queueChanged with new length', () => {
    reset();
    const seen = [];
    const off = EventBus.on('chat:queueChanged', (n) => { seen.push(n); });
    try {
        enqueueUserMessage({ text: 'a' });
        enqueueUserMessage({ text: 'b' });
        enqueueUserMessage({ text: 'c' });
        assert.deepEqual(seen, [1, 2, 3]);
    } finally {
        off();
    }
});

test('drain emits chat:queueChanged with 0', () => {
    reset();
    enqueueUserMessage({ text: 'a' });
    enqueueUserMessage({ text: 'b' });
    let last = -1;
    const off = EventBus.on('chat:queueChanged', (n) => { last = n; });
    try {
        drainUserMessageQueue();
        assert.equal(last, 0);
    } finally {
        off();
    }
});
