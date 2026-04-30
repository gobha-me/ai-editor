/**
 * Tests for js/chat/sessions-sync.js — per-conversation Git-native
 * projection of chat conversations to `.aieditor/sessions/<id>.json`.
 *
 * Pure serialize/parse functions are tested directly. The lifecycle
 * paths (enable/disable, mutation subscription, loadFromGit) exercise
 * the real `Storage` abstraction backed by the shim's localStorage; no
 * IDB interaction is required because conversation state lives behind
 * the Storage wrapper, which falls through to localStorage in the
 * pre-init / no-IDB Node test environment.
 *
 * @since 1.3.2
 */
import './_node-shim.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    sessionPath,
    serialize,
    parse,
    enable,
    disable,
    loadFromGit,
    getPendingContent,
    listPendingPaths,
    getDiagnostics,
    isEnabled,
    discardPendingSessionWrites,
    _setGitClientForTests,
    _resetForTests,
} from '../js/chat/sessions-sync.js';
import { Storage, EventBus } from '../js/core.js';
import { ConversationManager } from '../js/chat/conversations.js';

const WS = 'gitea:xcaliber/ai-editor';

function clearStorage() {
    // The shim's localStorage is a Map under the hood; clear it
    // between tests so no state leaks across cases.
    if (typeof globalThis.localStorage !== 'undefined' && globalThis.localStorage.clear) {
        globalThis.localStorage.clear();
    }
    // Storage also caches in memory.
    if (Storage._cache && typeof Storage._cache.clear === 'function') {
        Storage._cache.clear();
    }
}

function seedConversation({ id = 'abc1', title = 'A chat', synced = false, messages = [] } = {}) {
    const now = Date.now();
    const index = Storage.get('conversations') || [];
    index.push({
        id,
        title,
        createdAt: now,
        updatedAt: now,
        messageCount: messages.length,
        synced,
    });
    Storage.set('conversations', index);
    Storage.set(`conv-${id}`, { messages, summaryInfo: null, pruneStash: null });
    return id;
}

beforeEach(() => {
    clearStorage();
    _resetForTests();
});

/* ============================================================ */
/* Pure: paths                                                  */
/* ============================================================ */

test('sessionPath returns .aieditor/sessions/<id>.json', () => {
    assert.equal(sessionPath('abc'), '.aieditor/sessions/abc.json');
    assert.equal(sessionPath('gv8a2c3px5'), '.aieditor/sessions/gv8a2c3px5.json');
});

/* ============================================================ */
/* Pure: serialize                                              */
/* ============================================================ */

test('serialize emits stable JSON with schema_version', () => {
    const indexEntry = { id: 'abc', title: 'A', createdAt: 1, updatedAt: 2, messageCount: 1 };
    const payload = { messages: [{ role: 'user', content: 'hi' }], summaryInfo: null, pruneStash: null };
    const meta = { syncedBy: 'user:jeff', lastSyncedAt: 99 };
    const out = serialize(indexEntry, payload, meta);
    const parsed = JSON.parse(out);
    assert.equal(parsed.schema_version, 1);
    assert.equal(parsed.id, 'abc');
    assert.equal(parsed.title, 'A');
    assert.equal(parsed.createdAt, 1);
    assert.equal(parsed.updatedAt, 2);
    assert.equal(parsed.messageCount, 1);
    assert.deepEqual(parsed.messages, [{ role: 'user', content: 'hi' }]);
    assert.equal(parsed.synced_by, 'user:jeff');
    assert.equal(parsed.last_synced_at, 99);
});

test('serialize defaults messageCount from messages array when absent', () => {
    const out = serialize(
        { id: 'x', title: 'T', createdAt: 1, updatedAt: 2 },
        { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] },
    );
    const parsed = JSON.parse(out);
    assert.equal(parsed.messageCount, 2);
});

test('serialize defaults synced_by/last_synced_at when meta omitted', () => {
    const out = serialize({ id: 'x', title: 'T', createdAt: 1, updatedAt: 2 }, { messages: [] });
    const parsed = JSON.parse(out);
    assert.equal(parsed.synced_by, 'user:local');
    assert.ok(Number.isFinite(parsed.last_synced_at));
});

/* ============================================================ */
/* Pure: parse                                                  */
/* ============================================================ */

test('parse round-trips a serialized session', () => {
    const indexEntry = { id: 'abc', title: 'Round trip', createdAt: 100, updatedAt: 200, messageCount: 1 };
    const payload = { messages: [{ role: 'user', content: 'q' }], summaryInfo: null, pruneStash: null };
    const out = serialize(indexEntry, payload, { syncedBy: 'user:test', lastSyncedAt: 300 });
    const result = parse(out);
    assert.equal(result.ok, true);
    if (result.ok) {
        assert.equal(result.indexEntry.id, 'abc');
        assert.equal(result.indexEntry.title, 'Round trip');
        assert.deepEqual(result.payload.messages, payload.messages);
        assert.equal(result.meta.syncedBy, 'user:test');
        assert.equal(result.meta.lastSyncedAt, 300);
    }
});

test('parse warns on malformed JSON', () => {
    const result = parse('{not json', { sourcePath: 'x.json' });
    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.equal(result.warning.type, 'malformed_json');
        assert.equal(result.warning.sourcePath, 'x.json');
    }
});

test('parse warns on empty content', () => {
    const result = parse('');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.warning.type, 'empty');
});

test('parse warns when id is missing', () => {
    const result = parse(JSON.stringify({ title: 'no id', createdAt: 1, updatedAt: 2 }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.warning.type, 'missing_id');
});

test('parse warns when content is not an object', () => {
    const result = parse(JSON.stringify(['array', 'not', 'object']));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.warning.type, 'not_an_object');
});

/* ============================================================ */
/* Lifecycle: enable / disable                                  */
/* ============================================================ */

test('enable activates the layer and disable resets it', async () => {
    assert.equal(isEnabled(), false);
    await enable(WS);
    assert.equal(isEnabled(), true);
    disable();
    assert.equal(isEnabled(), false);
});

test('enable rejects empty workspaceId', async () => {
    await assert.rejects(() => enable(''), /workspaceId/);
    await assert.rejects(() => enable(/** @type {*} */(null)), /workspaceId/);
});

test('enable is idempotent for the same workspace, throws on switch without disable', async () => {
    await enable(WS);
    await enable(WS); // no-op
    await assert.rejects(() => enable('other-ws'), /disable\(\) before switching/);
});

/* ============================================================ */
/* Pending buffer: only synced conversations contribute          */
/* ============================================================ */

test('mutation on a non-synced conversation produces no pending content', async () => {
    seedConversation({ id: 'no-sync', synced: false, messages: [{ role: 'user', content: 'hi' }] });
    await enable(WS);
    EventBus.emit('conversation:saved', { id: 'no-sync' });
    assert.equal(getPendingContent(sessionPath('no-sync')), null);
    assert.deepEqual(listPendingPaths(), []);
});

test('mutation on a synced conversation produces pending content', async () => {
    seedConversation({ id: 'do-sync', synced: true, messages: [{ role: 'user', content: 'hello' }] });
    await enable(WS);
    EventBus.emit('conversation:saved', { id: 'do-sync' });
    const path = sessionPath('do-sync');
    const content = getPendingContent(path);
    assert.notEqual(content, null);
    const parsed = JSON.parse(content);
    assert.equal(parsed.id, 'do-sync');
    assert.equal(parsed.messages.length, 1);
});

test('initial flush projects every already-synced conversation on enable', async () => {
    seedConversation({ id: 'a', synced: true, messages: [{ role: 'user', content: '1' }] });
    seedConversation({ id: 'b', synced: false, messages: [{ role: 'user', content: '2' }] });
    seedConversation({ id: 'c', synced: true, messages: [{ role: 'user', content: '3' }] });

    await enable(WS);
    const paths = listPendingPaths();
    assert.deepEqual(paths.sort(), [sessionPath('a'), sessionPath('c')].sort());
});

test('untoggling synced drops the pending entry on next save', async () => {
    seedConversation({ id: 'flip', synced: true, messages: [{ role: 'user', content: 'm' }] });
    await enable(WS);
    EventBus.emit('conversation:saved', { id: 'flip' });
    assert.notEqual(getPendingContent(sessionPath('flip')), null);

    // Untoggle: flip the flag in storage and emit the toggle event.
    const index = Storage.get('conversations');
    index.find((c) => c.id === 'flip').synced = false;
    Storage.set('conversations', index);
    EventBus.emit('conversation:syncToggled', { id: 'flip', synced: false });

    assert.equal(getPendingContent(sessionPath('flip')), null);
});

test('deleting a conversation drops its pending entry', async () => {
    seedConversation({ id: 'gone', synced: true, messages: [{ role: 'user', content: 'm' }] });
    await enable(WS);
    EventBus.emit('conversation:saved', { id: 'gone' });
    assert.notEqual(getPendingContent(sessionPath('gone')), null);

    EventBus.emit('conversation:deleted', { id: 'gone' });
    assert.equal(getPendingContent(sessionPath('gone')), null);
});

test('discardPendingSessionWrites drops listed paths only', async () => {
    seedConversation({ id: 'a', synced: true, messages: [{ role: 'user', content: '1' }] });
    seedConversation({ id: 'b', synced: true, messages: [{ role: 'user', content: '2' }] });
    await enable(WS);
    assert.equal(listPendingPaths().length, 2);

    const dropped = discardPendingSessionWrites([sessionPath('a')]);
    assert.deepEqual(dropped, [sessionPath('a')]);
    assert.deepEqual(listPendingPaths(), [sessionPath('b')]);
});

/* ============================================================ */
/* loadFromGit                                                  */
/* ============================================================ */

test('loadFromGit hydrates a new conversation from .aieditor/sessions/', async () => {
    await enable(WS);

    const remoteEntry = { id: 'remote-1', title: 'From other machine', createdAt: 1, updatedAt: 1000, messageCount: 0 };
    const remotePayload = { messages: [{ role: 'user', content: 'hi from elsewhere' }], summaryInfo: null, pruneStash: null };
    const remoteContent = serialize(remoteEntry, remotePayload, { syncedBy: 'user:other', lastSyncedAt: 1000 });

    const fakeGit = {
        async getDirContents() {
            return [{ path: '.aieditor/sessions/remote-1.json' }];
        },
        async getFile() {
            return { content: remoteContent };
        },
    };

    const result = await loadFromGit({ owner: 'o', repo: 'r', branch: 'main', gitClient: fakeGit });
    assert.equal(result.seeded, 1);
    assert.equal(result.skipped, 0);

    const index = Storage.get('conversations') || [];
    const hydrated = index.find((c) => c.id === 'remote-1');
    assert.ok(hydrated, 'remote-1 should be hydrated into local index');
    assert.equal(hydrated.synced, true);
    assert.equal(hydrated.title, 'From other machine');

    const payload = Storage.get('conv-remote-1');
    assert.deepEqual(payload.messages, remotePayload.messages);
});

test('loadFromGit skips when local copy is newer (latest-updatedAt wins)', async () => {
    seedConversation({ id: 'merge-1', synced: true });
    const localIndex = Storage.get('conversations');
    const localEntry = localIndex.find((c) => c.id === 'merge-1');
    localEntry.updatedAt = 5000;
    Storage.set('conversations', localIndex);

    await enable(WS);

    const remoteEntry = { id: 'merge-1', title: 'older', createdAt: 1, updatedAt: 1000, messageCount: 0 };
    const remoteContent = serialize(remoteEntry, { messages: [], summaryInfo: null, pruneStash: null });

    const fakeGit = {
        async getDirContents() { return [{ path: '.aieditor/sessions/merge-1.json' }]; },
        async getFile() { return { content: remoteContent }; },
    };

    const result = await loadFromGit({ owner: 'o', repo: 'r', gitClient: fakeGit });
    assert.equal(result.seeded, 0);
    assert.equal(result.updated, 0);
    assert.equal(result.skipped, 1);

    const index = Storage.get('conversations') || [];
    const stillThere = index.find((c) => c.id === 'merge-1');
    assert.equal(stillThere.updatedAt, 5000, 'local entry should be unchanged');
    assert.notEqual(stillThere.title, 'older');
});

test('loadFromGit overwrites local when remote is newer', async () => {
    seedConversation({ id: 'merge-2', synced: true, title: 'local' });
    const localIndex = Storage.get('conversations');
    const localEntry = localIndex.find((c) => c.id === 'merge-2');
    localEntry.updatedAt = 1000;
    Storage.set('conversations', localIndex);

    await enable(WS);

    const remoteEntry = { id: 'merge-2', title: 'remote', createdAt: 1, updatedAt: 5000, messageCount: 1 };
    const remotePayload = { messages: [{ role: 'user', content: 'remote msg' }], summaryInfo: null, pruneStash: null };
    const remoteContent = serialize(remoteEntry, remotePayload);

    const fakeGit = {
        async getDirContents() { return [{ path: '.aieditor/sessions/merge-2.json' }]; },
        async getFile() { return { content: remoteContent }; },
    };

    const result = await loadFromGit({ owner: 'o', repo: 'r', gitClient: fakeGit });
    assert.equal(result.seeded, 0);
    assert.equal(result.updated, 1);

    const index = Storage.get('conversations') || [];
    const updated = index.find((c) => c.id === 'merge-2');
    assert.equal(updated.title, 'remote');
    assert.equal(updated.updatedAt, 5000);
    assert.equal(Storage.get('conv-merge-2').messages[0].content, 'remote msg');
});

test('loadFromGit treats getDirContents failure as no-sessions-yet (no-op)', async () => {
    await enable(WS);
    const fakeGit = {
        async getDirContents() { throw new Error('404 Not Found'); },
        async getFile() { throw new Error('not used'); },
    };
    const result = await loadFromGit({ owner: 'o', repo: 'r', gitClient: fakeGit });
    assert.equal(result.seeded, 0);
    assert.equal(result.updated, 0);
    assert.equal(result.warnings, 0);
});

test('loadFromGit accumulates a warning on a malformed session file', async () => {
    await enable(WS);
    const fakeGit = {
        async getDirContents() { return [{ path: '.aieditor/sessions/bad.json' }]; },
        async getFile() { return { content: '{not json' }; },
    };
    const result = await loadFromGit({ owner: 'o', repo: 'r', gitClient: fakeGit });
    assert.equal(result.warnings, 1);
    const diag = getDiagnostics();
    assert.equal(diag.warnings[0].type, 'malformed_json');
});

/* ============================================================ */
/* ConversationManager.setSynced / isSynced                      */
/* ============================================================ */

test('ConversationManager.setSynced flips the flag and emits conversation:syncToggled', () => {
    seedConversation({ id: 'cm-1', synced: false });
    let captured = null;
    const off = EventBus.on('conversation:syncToggled', (e) => { captured = e; });

    const result = ConversationManager.setSynced('cm-1', true);
    off();
    assert.equal(result, true);
    assert.equal(ConversationManager.isSynced('cm-1'), true);
    assert.deepEqual(captured, { id: 'cm-1', synced: true });
});

test('ConversationManager.setSynced returns the resolved bool when no change', () => {
    seedConversation({ id: 'cm-2', synced: true });
    const result = ConversationManager.setSynced('cm-2', true);
    assert.equal(result, true); // resolved value, not a no-op signal
});

test('ConversationManager.isSynced returns false for unknown ids', () => {
    assert.equal(ConversationManager.isSynced('does-not-exist'), false);
});
