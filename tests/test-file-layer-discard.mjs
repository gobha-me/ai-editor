/**
 * Tests for `discardPendingMemoryWrites()` — PR #7 helper that drops
 * paths from `_pendingFiles` without touching the IDB source records.
 * Two callers in production: the commit modal's auto-clear hook after a
 * successful batch commit, and the protected-branch "Discard" button.
 */
import './_node-shim.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    create, list,
    enable, disable,
    listPendingPaths,
    discardPendingMemoryWrites,
    isEnabled,
    MEMORY_EVENTS,
    _setIDBImpl, createMemoryFakeIDB, _resetMutexForTests,
    _resetFileLayerForTests,
} from '../js/intelligence/memory/index.js';
import { EventBus } from '../js/core.js';

const WS = 'gitea:xcaliber/ai-editor';

function wsInput(over = {}) {
    return {
        scope: 'workspace',
        owner_id_or_workspace_id: WS,
        key: 'preferred_test_runner',
        value: 'node:test',
        category: 'preferences',
        source: 'user_explicit',
        created_by: 'user:jeff',
        actor: 'user:jeff',
        ...over,
    };
}

let fake;

beforeEach(() => {
    fake = createMemoryFakeIDB();
    _setIDBImpl(fake);
    _resetMutexForTests();
    _resetFileLayerForTests();
});

test('discardPendingMemoryWrites is a no-op when the layer is disabled', () => {
    assert.equal(isEnabled(), false);
    const dropped = discardPendingMemoryWrites(['.aieditor/memory/preferences.md']);
    assert.deepEqual(dropped, []);
});

test('discards a single named path; the rest stay pending', async () => {
    await enable(WS);
    await create(wsInput({ key: 'a', category: 'preferences' }));
    await create(wsInput({ key: 'b', category: 'decisions' }));
    // Settle async mutation handler.
    await new Promise((resolve) => setImmediate(resolve));
    const before = listPendingPaths();
    assert.ok(before.includes('.aieditor/memory/preferences.md'));
    assert.ok(before.includes('.aieditor/memory/decisions.md'));

    const dropped = discardPendingMemoryWrites(['.aieditor/memory/preferences.md']);
    assert.deepEqual(dropped, ['.aieditor/memory/preferences.md']);
    const after = listPendingPaths();
    assert.equal(after.includes('.aieditor/memory/preferences.md'), false);
    assert.ok(after.includes('.aieditor/memory/decisions.md'));
});

test('passing no paths argument clears every pending path', async () => {
    await enable(WS);
    await create(wsInput({ key: 'a', category: 'preferences' }));
    await create(wsInput({ key: 'b', category: 'decisions' }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(listPendingPaths().length >= 2);

    const dropped = discardPendingMemoryWrites();
    assert.ok(dropped.length >= 2);
    assert.deepEqual(listPendingPaths(), []);
});

test('IDB source records survive a discard (projection-only)', async () => {
    await enable(WS);
    await create(wsInput({ key: 'survives_discard' }));
    await new Promise((resolve) => setImmediate(resolve));
    const before = await list({ scope: 'workspace', owner_id_or_workspace_id: WS });
    assert.equal(before.length, 1);

    discardPendingMemoryWrites();
    const after = await list({ scope: 'workspace', owner_id_or_workspace_id: WS });
    assert.equal(after.length, 1);
    assert.equal(after[0].key, 'survives_discard');
});

test('emits exactly one MEMORY_EVENTS.UPDATED when paths are dropped', async () => {
    await enable(WS);
    await create(wsInput({ key: 'a', category: 'preferences' }));
    await create(wsInput({ key: 'b', category: 'decisions' }));
    await new Promise((resolve) => setImmediate(resolve));

    let count = 0;
    let lastPayload = undefined;
    const off = EventBus.on(MEMORY_EVENTS.UPDATED, (e) => {
        count++;
        lastPayload = e;
    });
    try {
        discardPendingMemoryWrites();
        assert.equal(count, 1, 'one synthetic UPDATED event for the discard batch');
        assert.deepEqual(lastPayload, { before: null, after: null });
    } finally {
        off();
    }
});

test('discarding an unknown path is a no-op (no event, no throw)', async () => {
    await enable(WS);
    let count = 0;
    const off = EventBus.on(MEMORY_EVENTS.UPDATED, () => { count++; });
    try {
        const dropped = discardPendingMemoryWrites(['.aieditor/memory/never-existed.md']);
        assert.deepEqual(dropped, []);
        assert.equal(count, 0);
    } finally {
        off();
    }
});
