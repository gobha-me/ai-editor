/**
 * Tests for js/chat/replay.js — read-only stepper for `.aieditor.session`
 * archives. Exercises the pure data-flow paths:
 *
 *   - `buildArchiveForConversation(id)` round-trips through `parse()` and
 *     produces a payload matching what was stored.
 *   - `loadFromString(content)` parses an archive and updates the
 *     module's state to point at turn 0; `next`/`prev`/`goto` move the
 *     index without touching `Storage` or the conversation manager.
 *   - Malformed inputs are rejected (invalid JSON, missing id, future
 *     schema_version) and module state stays clean.
 *
 * DOM rendering is not exercised under Node — the module guards every
 * `getElementById(...)` call with a null check, so loadFromString runs
 * to completion without a DOM and the `_stateSnapshotForTests()` seam
 * confirms the parsed payload landed.
 *
 * @since 1.3.3
 */
import './_node-shim.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildArchiveForConversation,
    loadFromString,
    next,
    prev,
    goto,
    clearLoaded,
    _stateSnapshotForTests,
    _resetForTests,
} from '../js/chat/replay.js';
import { parse } from '../js/chat/sessions-sync.js';
import { Storage } from '../js/core.js';

function clearStorage() {
    if (typeof globalThis.localStorage !== 'undefined' && globalThis.localStorage.clear) {
        globalThis.localStorage.clear();
    }
    if (Storage._cache && typeof Storage._cache.clear === 'function') {
        Storage._cache.clear();
    }
}

function seedConversation({ id = 'abc1', title = 'A chat', messages } = {}) {
    const now = Date.now();
    const msgs = messages || [
        { role: 'user', content: 'hi', timestamp: now - 2000 },
        {
            role: 'assistant',
            content: 'hello',
            timestamp: now - 1000,
            reasoning: {
                provider: 'venice',
                format: 'tag',
                content: 'thinking out loud',
                started_at: now - 1500,
                ended_at: now - 1100,
            },
            elapsedTime: 0.4,
        },
        {
            role: 'tool',
            content: '{"ok":true}',
            timestamp: now - 500,
            _display: { toolName: 'read_file', args: { path: 'a.js' }, result: { ok: true, line_count: 12 } },
        },
    ];
    const index = Storage.get('conversations') || [];
    index.push({
        id,
        title,
        createdAt: now - 5000,
        updatedAt: now,
        messageCount: msgs.length,
        synced: false,
    });
    Storage.set('conversations', index);
    Storage.set(`conv-${id}`, { messages: msgs, summaryInfo: null, pruneStash: null });
    return { id, msgs };
}

beforeEach(() => {
    clearStorage();
    _resetForTests();
});

/* ============================================================ */
/* Export — buildArchiveForConversation                          */
/* ============================================================ */

test('buildArchiveForConversation returns null for unknown id', () => {
    assert.equal(buildArchiveForConversation('nope'), null);
});

test('buildArchiveForConversation produces a parseable archive', () => {
    const { id, msgs } = seedConversation();
    const archive = buildArchiveForConversation(id);
    assert.ok(archive, 'archive should be present');
    assert.match(archive.filename, /\.aieditor\.session$/);

    const parsed = parse(archive.content);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.indexEntry.id, id);
    assert.equal(parsed.payload.messages.length, msgs.length);
    // Reasoning + tool _display survive the round-trip.
    assert.equal(parsed.payload.messages[1].reasoning.content, 'thinking out loud');
    assert.deepEqual(parsed.payload.messages[2]._display.args, { path: 'a.js' });
});

test('buildArchiveForConversation builds a slugged filename from the title', () => {
    seedConversation({ id: 'xyz9', title: 'Investigating the foo bar bug' });
    const archive = buildArchiveForConversation('xyz9');
    assert.equal(archive.filename, 'investigating-the-foo-bar-bug-xyz9.aieditor.session');
});

test('buildArchiveForConversation falls back to "conversation" for empty titles', () => {
    seedConversation({ id: 'tk1', title: '' });
    const archive = buildArchiveForConversation('tk1');
    assert.equal(archive.filename, 'conversation-tk1.aieditor.session');
});

/* ============================================================ */
/* Import — loadFromString                                       */
/* ============================================================ */

test('loadFromString parses a valid archive and seeds the stepper at 0', () => {
    const { id, msgs } = seedConversation();
    const archive = buildArchiveForConversation(id);
    const ok = loadFromString(archive.content, 'fixture.aieditor.session');
    assert.equal(ok, true);

    const snap = _stateSnapshotForTests();
    assert.equal(snap.indexEntry.id, id);
    assert.equal(snap.payload.messages.length, msgs.length);
    assert.equal(snap.index, 0);
    assert.equal(snap.sourceLabel, 'fixture.aieditor.session');
});

test('loadFromString rejects malformed JSON', () => {
    const ok = loadFromString('{not json', 'broken');
    assert.equal(ok, false);
    const snap = _stateSnapshotForTests();
    assert.equal(snap.payload, null);
    assert.equal(snap.indexEntry, null);
});

test('loadFromString rejects archives without an id', () => {
    const bogus = JSON.stringify({ schema_version: 1, title: 'no id here', messages: [] });
    const ok = loadFromString(bogus, 'no-id');
    assert.equal(ok, false);
    assert.equal(_stateSnapshotForTests().payload, null);
});

test('loadFromString rejects future schema_version', () => {
    const future = JSON.stringify({
        schema_version: 99,
        id: 'abc',
        title: 'too new',
        createdAt: 1, updatedAt: 2, messageCount: 0,
        messages: [],
    });
    const ok = loadFromString(future, 'future');
    assert.equal(ok, false);
    assert.equal(_stateSnapshotForTests().payload, null);
});

test('loadFromString accepts archives where schema_version is absent (treated as v1)', () => {
    // The 1.3.2 parser tolerates missing schema_version (defaults to v1
    // semantics); replay should match — only future versions block.
    const v0 = JSON.stringify({
        id: 'legacy1',
        title: 'no schema_version field',
        createdAt: 1, updatedAt: 2, messageCount: 1,
        messages: [{ role: 'user', content: 'hi' }],
    });
    const ok = loadFromString(v0, 'legacy');
    assert.equal(ok, true);
    assert.equal(_stateSnapshotForTests().indexEntry.id, 'legacy1');
});

/* ============================================================ */
/* Stepper navigation                                            */
/* ============================================================ */

test('next/prev move within bounds and clamp at the ends', () => {
    const { id, msgs } = seedConversation();
    loadFromString(buildArchiveForConversation(id).content);
    assert.equal(_stateSnapshotForTests().index, 0);

    next();
    assert.equal(_stateSnapshotForTests().index, 1);
    next();
    assert.equal(_stateSnapshotForTests().index, 2);
    next();
    // Past the end is a clamp, not a wrap or an error.
    assert.equal(_stateSnapshotForTests().index, msgs.length - 1);

    prev();
    assert.equal(_stateSnapshotForTests().index, 1);
    prev();
    assert.equal(_stateSnapshotForTests().index, 0);
    prev();
    assert.equal(_stateSnapshotForTests().index, 0);
});

test('goto clamps out-of-range and accepts the in-range value', () => {
    const { id, msgs } = seedConversation();
    loadFromString(buildArchiveForConversation(id).content);

    goto(99);
    assert.equal(_stateSnapshotForTests().index, msgs.length - 1);
    goto(-5);
    assert.equal(_stateSnapshotForTests().index, 0);
    goto(1);
    assert.equal(_stateSnapshotForTests().index, 1);
});

test('next/prev/goto are no-ops when nothing is loaded', () => {
    next(); prev(); goto(2);
    const snap = _stateSnapshotForTests();
    assert.equal(snap.payload, null);
    assert.equal(snap.index, 0);
});

/* ============================================================ */
/* clearLoaded                                                   */
/* ============================================================ */

test('clearLoaded drops the parsed payload and resets the index', () => {
    const { id } = seedConversation();
    loadFromString(buildArchiveForConversation(id).content);
    assert.ok(_stateSnapshotForTests().payload);

    clearLoaded();
    const snap = _stateSnapshotForTests();
    assert.equal(snap.payload, null);
    assert.equal(snap.indexEntry, null);
    assert.equal(snap.meta, null);
    assert.equal(snap.index, 0);
});

/* ============================================================ */
/* Round-trip: export → parse → import preserves shape          */
/* ============================================================ */

test('round-trip: exported bytes parse back to the seeded payload', () => {
    const { id, msgs } = seedConversation();
    const archive = buildArchiveForConversation(id);
    const ok = loadFromString(archive.content, archive.filename);
    assert.equal(ok, true);

    const snap = _stateSnapshotForTests();
    assert.equal(snap.payload.messages.length, msgs.length);
    // Spot-check that reasoning + tool metadata round-trip byte-stable.
    assert.equal(snap.payload.messages[1].reasoning.format, 'tag');
    assert.equal(snap.payload.messages[2]._display.toolName, 'read_file');
    // Re-serializing the freshly-parsed view (via buildArchive on a
    // subsequent re-seed) is stable — the assertion is implicit in
    // sessions-sync's stable-key serialize, but we double-check
    // messageCount survived.
    assert.equal(snap.indexEntry.messageCount, msgs.length);
});
