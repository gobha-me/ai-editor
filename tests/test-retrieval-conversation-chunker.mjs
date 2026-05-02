/**
 * Conversation chunker tests (1.4.12).
 *
 * Covers `js/intelligence/retrieval/chunkers/conversation-chunker.js`:
 * empty input, single-turn, multi-turn, role variety, custom-metadata
 * pass-through, byte-range adjacency, ChunkID stability + chunker-version
 * invalidation, surrogate-safe handling of UTF-8 multi-byte content, and
 * input-validation rejection paths.
 *
 * No DOM, no State, no network — pure-data, runnable under `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    chunkConversation,
    computeChunkID,
    CHUNKER_VERSION,
} from '../js/intelligence/retrieval/index.js';

const baseInput = (turns, overrides = {}) => ({
    bytes: JSON.stringify(turns),
    collection: 'sessions',
    metadata: {
        source_uri: 'sessions/test-conversation.json',
        content_type: 'conversation',
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
        custom: {},
        ...overrides.metadata,
    },
    ...overrides.input,
});

/* ---------------- Empty input ---------------- */

test('empty bytes produces no chunks', () => {
    const out = chunkConversation({
        bytes: '',
        collection: 'sessions',
        metadata: { source_uri: 'sessions/x.json' },
    });
    assert.deepEqual(out, []);
});

test('empty turns array produces no chunks', () => {
    assert.deepEqual(chunkConversation(baseInput([])), []);
});

/* ---------------- Single + multi-turn ---------------- */

test('a single turn produces exactly one chunk with role + turn_index in custom', () => {
    const turns = [{ role: 'user', content: 'Hello there.' }];
    const chunks = chunkConversation(baseInput(turns));
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].content, 'Hello there.');
    assert.equal(chunks[0].metadata.content_type, 'conversation');
    assert.equal(chunks[0].metadata.structural, null);
    assert.equal(chunks[0].metadata.custom.role, 'user');
    assert.equal(chunks[0].metadata.custom.turn_index, 0);
});

test('chunks expose the contract surface (id, content, tokens, metadata, byte_range)', () => {
    const chunks = chunkConversation(baseInput([{ role: 'user', content: 'Hi.' }]));
    assert.equal(chunks.length, 1);
    const c = chunks[0];
    assert.equal(typeof c.id, 'string');
    assert.match(c.id, /^[0-9a-f]{16}$/);
    assert.equal(c.collection, 'sessions');
    assert.equal(typeof c.content, 'string');
    assert.equal(typeof c.tokens, 'number');
    assert.ok(c.tokens > 0);
    assert.equal(typeof c.metadata.content_hash, 'string');
    assert.match(c.metadata.content_hash, /^[0-9a-f]{8}$/);
    assert.equal(Array.isArray(c.byte_range), true);
    assert.equal(c.byte_range.length, 2);
});

test('multiple turns produce one chunk per turn, in order', () => {
    const turns = [
        { role: 'user', content: 'First message.' },
        { role: 'assistant', content: 'First reply.' },
        { role: 'user', content: 'Second message.' },
        { role: 'assistant', content: 'Second reply.' },
    ];
    const chunks = chunkConversation(baseInput(turns));
    assert.equal(chunks.length, turns.length);
    for (let i = 0; i < turns.length; i++) {
        assert.equal(chunks[i].content, turns[i].content);
        assert.equal(chunks[i].metadata.custom.role, turns[i].role);
        assert.equal(chunks[i].metadata.custom.turn_index, i);
    }
});

test('turn with empty content still emits a chunk (zero-length content, valid byte_range)', () => {
    const chunks = chunkConversation(baseInput([{ role: 'assistant', content: '' }]));
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].content, '');
    assert.ok(chunks[0].byte_range[1] >= chunks[0].byte_range[0]);
    assert.match(chunks[0].id, /^[0-9a-f]{16}$/);
});

/* ---------------- Role variety ---------------- */

test('role variety (user / assistant / tool / system) round-trips into custom.role', () => {
    const turns = [
        { role: 'system', content: 'System prompt.' },
        { role: 'user', content: 'User asks.' },
        { role: 'assistant', content: 'Assistant calls a tool.' },
        { role: 'tool', content: '{"result": "ok"}' },
    ];
    const chunks = chunkConversation(baseInput(turns));
    assert.deepEqual(
        chunks.map((c) => c.metadata.custom.role),
        ['system', 'user', 'assistant', 'tool'],
    );
});

/* ---------------- Custom metadata pass-through ---------------- */

test('extra top-level fields on a turn flow into metadata.custom', () => {
    const turns = [{
        role: 'tool',
        content: '{"result": "ok"}',
        timestamp: 1_700_000_001_000,
        tool_name: 'read_file',
        tool_result_for: 'call-42',
    }];
    const chunks = chunkConversation(baseInput(turns));
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].metadata.custom.timestamp, 1_700_000_001_000);
    assert.equal(chunks[0].metadata.custom.tool_name, 'read_file');
    assert.equal(chunks[0].metadata.custom.tool_result_for, 'call-42');
    assert.equal(chunks[0].metadata.custom.role, 'tool');
    assert.equal(chunks[0].metadata.custom.turn_index, 0);
});

test('turn.metadata sub-object (HistoryTurn shape) merges into metadata.custom', () => {
    const turns = [{
        role: 'assistant',
        content: 'I touched two files.',
        metadata: { file_ops: ['edit:foo.js', 'edit:bar.js'], speaker_id: 'agent' },
    }];
    const chunks = chunkConversation(baseInput(turns));
    assert.deepEqual(chunks[0].metadata.custom.file_ops, ['edit:foo.js', 'edit:bar.js']);
    assert.equal(chunks[0].metadata.custom.speaker_id, 'agent');
});

test('input-level metadata.custom takes precedence over per-turn extras on key conflict', () => {
    const turns = [{ role: 'user', content: 'Hi.', tag: 'turn-tag' }];
    const chunks = chunkConversation(baseInput(turns, { metadata: { custom: { tag: 'input-tag' } } }));
    assert.equal(chunks[0].metadata.custom.tag, 'input-tag');
});

test('metadata.custom defaults to {} (plus role+turn_index) when input omits it and turn has no extras', () => {
    const turns = [{ role: 'user', content: 'Hello.' }];
    const chunks = chunkConversation({
        bytes: JSON.stringify(turns),
        collection: 'sessions',
        metadata: { source_uri: 'sessions/x.json' },
    });
    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0].metadata.custom, { role: 'user', turn_index: 0 });
});

/* ---------------- Byte-range adjacency + ChunkID stability ---------------- */

test('consecutive chunks share a byte_range boundary (chunk[i+1].start === chunk[i].end)', () => {
    const turns = [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
    ];
    const chunks = chunkConversation(baseInput(turns));
    assert.equal(chunks[0].byte_range[0], 0);
    for (let i = 1; i < chunks.length; i++) {
        assert.equal(chunks[i].byte_range[0], chunks[i - 1].byte_range[1]);
    }
});

test('byte_range of each chunk equals UTF-8 byte length of JSON.stringify(turn)', () => {
    const turns = [
        { role: 'user', content: 'plain' },
        { role: 'assistant', content: 'multi-byte: é' }, // é = 2 UTF-8 bytes
    ];
    const chunks = chunkConversation(baseInput(turns));
    for (let i = 0; i < turns.length; i++) {
        const expectedLen = new TextEncoder().encode(JSON.stringify(turns[i])).length;
        const span = chunks[i].byte_range[1] - chunks[i].byte_range[0];
        assert.equal(span, expectedLen, `turn ${i} byte span mismatch`);
    }
});

test('identical input produces identical chunk IDs across runs', () => {
    const turns = [
        { role: 'user', content: 'First.' },
        { role: 'assistant', content: 'Second.' },
        { role: 'user', content: 'Third.' },
    ];
    const a = chunkConversation(baseInput(turns));
    const b = chunkConversation(baseInput(turns));
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) {
        assert.equal(a[i].id, b[i].id);
    }
});

test('chunk ID matches canonical computeChunkID under CHUNKER_VERSION.conversation', () => {
    const turns = [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
    ];
    const chunks = chunkConversation(baseInput(turns));
    for (const c of chunks) {
        const expected = computeChunkID({
            collection: 'sessions',
            source_uri: 'sessions/test-conversation.json',
            byte_range: c.byte_range,
            chunker_version: CHUNKER_VERSION.conversation,
        });
        assert.equal(c.id, expected);
    }
});

test('a hypothetical chunker_version bump produces different IDs at the same byte_range', () => {
    const chunks = chunkConversation(baseInput([
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
    ]));
    for (const c of chunks) {
        const v2 = computeChunkID({
            collection: 'sessions',
            source_uri: 'sessions/test-conversation.json',
            byte_range: c.byte_range,
            chunker_version: 'v2',
        });
        assert.notEqual(c.id, v2);
    }
});

test('ChunkIDs are stable across cosmetically-different JSON envelopes (compact vs pretty)', () => {
    // The chunker's byte_range derives from canonical per-turn serialization,
    // not from the envelope's whitespace, so the same logical conversation
    // produces the same ChunkIDs regardless of how the caller serialized it.
    const turns = [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: 'y' },
    ];
    const compact = chunkConversation({
        bytes: JSON.stringify(turns),
        collection: 'sessions',
        metadata: { source_uri: 'sessions/x.json' },
    });
    const pretty = chunkConversation({
        bytes: JSON.stringify(turns, null, 2),
        collection: 'sessions',
        metadata: { source_uri: 'sessions/x.json' },
    });
    assert.equal(compact.length, pretty.length);
    for (let i = 0; i < compact.length; i++) {
        assert.equal(compact[i].id, pretty[i].id);
        assert.deepEqual(compact[i].byte_range, pretty[i].byte_range);
    }
});

/* ---------------- Unicode safety ---------------- */

test('multi-byte UTF-8 content survives chunking with intact strings', () => {
    const turns = [
        { role: 'user', content: '🚀 launch sequence' },
        { role: 'assistant', content: 'café — ready' },
    ];
    const chunks = chunkConversation(baseInput(turns));
    assert.equal(chunks[0].content, '🚀 launch sequence');
    assert.equal(chunks[1].content, 'café — ready');
});

/* ---------------- Structural placeholder ---------------- */

test('emitted chunks carry metadata.structural === null (StructureExtractor lands later)', () => {
    const chunks = chunkConversation(baseInput([{ role: 'user', content: 'q' }]));
    assert.equal(chunks[0].metadata.structural, null);
});

/* ---------------- Input validation ---------------- */

test('chunkConversation rejects missing input', () => {
    // @ts-expect-error — runtime check
    assert.throws(() => chunkConversation(null), /input/);
    // @ts-expect-error — runtime check
    assert.throws(() => chunkConversation(undefined), /input/);
});

test('chunkConversation rejects non-string bytes', () => {
    assert.throws(
        // @ts-expect-error — runtime check
        () => chunkConversation({ bytes: 42, collection: 'sessions', metadata: { source_uri: 's' } }),
        /bytes/,
    );
});

test('chunkConversation rejects empty collection', () => {
    assert.throws(
        () => chunkConversation({ bytes: '[]', collection: '', metadata: { source_uri: 's' } }),
        /collection/,
    );
});

test('chunkConversation rejects missing source_uri', () => {
    assert.throws(
        // @ts-expect-error — runtime check
        () => chunkConversation({ bytes: '[]', collection: 'sessions', metadata: {} }),
        /source_uri/,
    );
});

test('chunkConversation rejects malformed JSON', () => {
    assert.throws(
        () => chunkConversation({
            bytes: '{not valid json',
            collection: 'sessions',
            metadata: { source_uri: 's' },
        }),
        /valid JSON/,
    );
});

test('chunkConversation rejects non-array root', () => {
    assert.throws(
        () => chunkConversation({
            bytes: JSON.stringify({ role: 'user', content: 'hi' }),
            collection: 'sessions',
            metadata: { source_uri: 's' },
        }),
        /array of turns/,
    );
});

test('chunkConversation rejects a turn missing role', () => {
    assert.throws(
        () => chunkConversation(baseInput([{ content: 'no role' }])),
        /missing string 'role'/,
    );
});

test('chunkConversation rejects a turn missing content', () => {
    assert.throws(
        () => chunkConversation(baseInput([{ role: 'user' }])),
        /missing string 'content'/,
    );
});

test('chunkConversation rejects a turn with non-string role', () => {
    assert.throws(
        () => chunkConversation(baseInput([{ role: 42, content: 'hi' }])),
        /missing string 'role'/,
    );
});

test('chunkConversation rejects a non-object turn entry', () => {
    assert.throws(
        () => chunkConversation(baseInput(['not a turn'])),
        /is not an object/,
    );
});
