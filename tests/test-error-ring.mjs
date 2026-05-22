/**
 * Tests for js/intelligence/error-ring.js — gitea#506, self-introspection
 * Phase 2 (2.92.0). The ring backs the get_recent_errors introspection tool.
 *
 * Strategy:
 *   - `record()` / `read()` / `clear()` are tested directly against the
 *     module's internal ring (exposed via _testing._ring + _resetInitialized).
 *   - `init()` is tested by replacing window.addEventListener with a capture
 *     stub so we can drive synthetic 'error' / 'unhandledrejection' events
 *     through the registered listeners.
 *
 * Runs under `node --test`. See `[[reference_testing_ci]]` — file name must
 * match the `tests/test-*.mjs` glob.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    record,
    read,
    clear,
    init,
    _testing,
} from '../js/intelligence/error-ring.js';

function resetRing() {
    clear();
    _testing._resetInitialized();
}

// ============================================
// record() / read() — basic shape + ordering
// ============================================

test('record + read: single entry roundtrips with ts, source, message', () => {
    resetRing();
    record('test', 'first message');
    const out = read();
    assert.equal(out.length, 1);
    assert.equal(out[0].source, 'test');
    assert.equal(out[0].message, 'first message');
    assert.ok(typeof out[0].ts === 'number');
    assert.equal(out[0].stack, undefined);
});

test('record + read: stack is preserved when supplied, omitted otherwise', () => {
    resetRing();
    record('with-stack', 'oops', 'Error\n  at line 42');
    record('no-stack', 'oops2');
    const out = read();
    // Newest-first ordering — no-stack came in last.
    assert.equal(out[0].source, 'no-stack');
    assert.equal(out[0].stack, undefined);
    assert.equal(out[1].source, 'with-stack');
    assert.equal(out[1].stack, 'Error\n  at line 42');
});

test('record + read: newest-first ordering', () => {
    resetRing();
    record('test', 'a');
    record('test', 'b');
    record('test', 'c');
    const out = read();
    assert.equal(out[0].message, 'c');
    assert.equal(out[1].message, 'b');
    assert.equal(out[2].message, 'a');
});

// ============================================
// FIFO overflow at RING_CAPACITY
// ============================================

test('record: drops oldest at RING_CAPACITY (50)', () => {
    resetRing();
    for (let i = 0; i < _testing.RING_CAPACITY + 5; i++) {
        record('test', `entry ${i}`);
    }
    const out = read();
    // Ring caps at capacity.
    assert.equal(out.length, _testing.RING_CAPACITY);
    // Newest is the last one pushed.
    assert.equal(out[0].message, `entry ${_testing.RING_CAPACITY + 4}`);
    // Oldest surviving is at index 5 (entries 0..4 were dropped).
    assert.equal(out[out.length - 1].message, 'entry 5');
});

// ============================================
// read() limit param
// ============================================

test('read({limit}): clamps to requested count', () => {
    resetRing();
    for (let i = 0; i < 20; i++) record('test', `entry ${i}`);
    const out = read({ limit: 5 });
    assert.equal(out.length, 5);
    assert.equal(out[0].message, 'entry 19');
    assert.equal(out[4].message, 'entry 15');
});

test('read({limit}): undefined limit returns up to RING_CAPACITY', () => {
    resetRing();
    for (let i = 0; i < 20; i++) record('test', `entry ${i}`);
    const out = read();
    assert.equal(out.length, 20);
});

test('read({limit}): limit clamped to RING_CAPACITY ceiling', () => {
    resetRing();
    for (let i = 0; i < 60; i++) record('test', `entry ${i}`);
    const out = read({ limit: 9999 });
    assert.equal(out.length, _testing.RING_CAPACITY);
});

// ============================================
// Truncation of oversized payloads
// ============================================

test('record: truncates messages longer than MAX_MESSAGE_CHARS', () => {
    resetRing();
    const long = 'x'.repeat(_testing.MAX_MESSAGE_CHARS + 100);
    record('test', long);
    const out = read();
    assert.ok(out[0].message.endsWith('…[truncated]'));
    assert.ok(out[0].message.length <= _testing.MAX_MESSAGE_CHARS + 20);
});

test('record: truncates stacks longer than MAX_STACK_CHARS', () => {
    resetRing();
    const long = 'y'.repeat(_testing.MAX_STACK_CHARS + 500);
    record('test', 'short', long);
    const out = read();
    assert.ok(out[0].stack.endsWith('…[truncated]'));
    assert.ok(out[0].stack.length <= _testing.MAX_STACK_CHARS + 20);
});

// ============================================
// Read returns copies (caller can't corrupt ring)
// ============================================

test('read(): returns plain copies — mutating result does not corrupt ring', () => {
    resetRing();
    record('test', 'a');
    const out1 = read();
    out1[0].message = 'tampered';
    const out2 = read();
    assert.equal(out2[0].message, 'a');
});

// ============================================
// init() — listener wiring + idempotency
// ============================================

test('init(): wires window.error + unhandledrejection listeners and is idempotent', () => {
    resetRing();
    // Capture stub for addEventListener.
    /** @type {Record<string, Function[]>} */
    const captured = { error: [], unhandledrejection: [] };
    const originalAdd = globalThis.window.addEventListener;
    globalThis.window.addEventListener = (type, fn) => {
        if (type === 'error' || type === 'unhandledrejection') {
            captured[type].push(fn);
        }
    };
    try {
        init();
        assert.equal(captured.error.length, 1);
        assert.equal(captured.unhandledrejection.length, 1);
        // Second call is a no-op (idempotent).
        init();
        assert.equal(captured.error.length, 1);
        assert.equal(captured.unhandledrejection.length, 1);

        // Drive a synthetic error event through the captured handler.
        captured.error[0]({
            message: 'synthetic error',
            error: { stack: 'Error: synthetic\n  at fake.js:1' },
        });
        let out = read({ limit: 1 });
        assert.equal(out[0].source, 'window.onerror');
        assert.equal(out[0].message, 'synthetic error');
        assert.ok(out[0].stack && out[0].stack.includes('fake.js'));

        // Drive a synthetic rejection with an Error reason.
        const err = new Error('rejected reason');
        captured.unhandledrejection[0]({ reason: err });
        out = read({ limit: 1 });
        assert.equal(out[0].source, 'unhandledrejection');
        assert.equal(out[0].message, 'rejected reason');
        assert.ok(typeof out[0].stack === 'string' && out[0].stack.length > 0);

        // Drive a rejection with a string reason (no stack).
        captured.unhandledrejection[0]({ reason: 'bare string' });
        out = read({ limit: 1 });
        assert.equal(out[0].source, 'unhandledrejection');
        assert.equal(out[0].message, 'bare string');
        assert.equal(out[0].stack, undefined);
    } finally {
        globalThis.window.addEventListener = originalAdd;
        resetRing();
    }
});

// ============================================
// clear() seam
// ============================================

test('clear(): empties the ring', () => {
    resetRing();
    record('test', 'a');
    record('test', 'b');
    clear();
    assert.equal(read().length, 0);
});
