/**
 * Retrieval foundation tests (1.4.9).
 *
 * Covers the data contract: ChunkID determinism, chunker-version
 * invalidation, separator boundary safety, byte-range normalization,
 * input validation, the placeholder Composer, and a structural round-trip
 * that confirms a typedef-shaped ChunkRef threads through a tiny consumer.
 *
 * No DOM, no State, no network — pure-data foundation, runnable under
 * `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    computeChunkID,
    normalizeByteRange,
    CHUNKER_VERSION,
    compose,
} from '../js/intelligence/retrieval/index.js';

/* ---------------- computeChunkID determinism ---------------- */

test('computeChunkID is deterministic across calls', () => {
    const args = {
        collection: 'workspace_code',
        source_uri: 'file:///js/foo.js',
        byte_range: [0, 1024],
        chunker_version: 'v1',
    };
    const a = computeChunkID(args);
    const b = computeChunkID(args);
    assert.equal(a, b);
});

test('computeChunkID returns a 16-char lowercase hex string', () => {
    const id = computeChunkID({
        collection: 'c', source_uri: 's', byte_range: [0, 1], chunker_version: 'v1',
    });
    assert.equal(id.length, 16);
    assert.match(id, /^[0-9a-f]{16}$/);
});

/* ---------------- Chunker-version invalidation ---------------- */

test('changing chunker_version produces a different ChunkID', () => {
    const base = {
        collection: 'workspace_code',
        source_uri: 'file:///js/foo.js',
        byte_range: [0, 1024],
    };
    const v1 = computeChunkID({ ...base, chunker_version: 'v1' });
    const v2 = computeChunkID({ ...base, chunker_version: 'v2' });
    assert.notEqual(v1, v2);
});

test('changing collection produces a different ChunkID', () => {
    const base = {
        source_uri: 'file:///js/foo.js',
        byte_range: [0, 1024],
        chunker_version: 'v1',
    };
    assert.notEqual(
        computeChunkID({ ...base, collection: 'a' }),
        computeChunkID({ ...base, collection: 'b' }),
    );
});

test('changing source_uri produces a different ChunkID', () => {
    const base = {
        collection: 'workspace_code',
        byte_range: [0, 1024],
        chunker_version: 'v1',
    };
    assert.notEqual(
        computeChunkID({ ...base, source_uri: 'file:///a.js' }),
        computeChunkID({ ...base, source_uri: 'file:///b.js' }),
    );
});

test('changing byte_range produces a different ChunkID', () => {
    const base = {
        collection: 'workspace_code',
        source_uri: 'file:///js/foo.js',
        chunker_version: 'v1',
    };
    assert.notEqual(
        computeChunkID({ ...base, byte_range: [0, 1024] }),
        computeChunkID({ ...base, byte_range: [0, 2048] }),
    );
});

/* ---------------- Boundary safety ---------------- */

test('NUL-separated joins prevent boundary-shift collisions', () => {
    // Two distinct triples that would collide if the separator were
    // collapsed: ("a", "bc", ...) vs ("ab", "c", ...).
    const a = computeChunkID({
        collection: 'a', source_uri: 'bc', byte_range: [0, 1], chunker_version: 'v1',
    });
    const b = computeChunkID({
        collection: 'ab', source_uri: 'c', byte_range: [0, 1], chunker_version: 'v1',
    });
    assert.notEqual(a, b);
});

/* ---------------- normalizeByteRange ---------------- */

test('normalizeByteRange canonicalizes reversed ranges', () => {
    assert.equal(normalizeByteRange([100, 50]), '50..100');
    assert.equal(normalizeByteRange([50, 100]), '50..100');
});

test('normalizeByteRange accepts equal endpoints', () => {
    assert.equal(normalizeByteRange([42, 42]), '42..42');
});

test('normalizeByteRange rejects negative bounds', () => {
    assert.throws(() => normalizeByteRange([-1, 10]), /non-negative/);
    assert.throws(() => normalizeByteRange([0, -5]), /non-negative/);
});

test('normalizeByteRange rejects non-integer bounds', () => {
    assert.throws(() => normalizeByteRange([0.5, 10]), /integers/);
    assert.throws(() => normalizeByteRange([0, 10.1]), /integers/);
});

test('normalizeByteRange rejects non-finite bounds', () => {
    assert.throws(() => normalizeByteRange([Infinity, 10]), /finite/);
    assert.throws(() => normalizeByteRange([0, NaN]), /finite/);
});

test('normalizeByteRange rejects bad shape', () => {
    assert.throws(() => normalizeByteRange([0]), /tuple/);
    assert.throws(() => normalizeByteRange([0, 1, 2]), /tuple/);
    // @ts-expect-error — exercising the runtime check
    assert.throws(() => normalizeByteRange('0,10'), /tuple/);
});

test('reversed byte_range hashes to the same ChunkID as the canonical one', () => {
    // Loaders sometimes report swapped offsets; canonicalization keeps
    // those from spawning ghost chunks.
    const base = {
        collection: 'c', source_uri: 's', chunker_version: 'v1',
    };
    assert.equal(
        computeChunkID({ ...base, byte_range: [10, 100] }),
        computeChunkID({ ...base, byte_range: [100, 10] }),
    );
});

/* ---------------- Input validation ---------------- */

test('computeChunkID rejects empty collection', () => {
    assert.throws(() => computeChunkID({
        collection: '', source_uri: 's', byte_range: [0, 1], chunker_version: 'v1',
    }), /collection/);
});

test('computeChunkID rejects non-string collection', () => {
    assert.throws(() => computeChunkID({
        // @ts-expect-error — exercising the runtime check
        collection: 42, source_uri: 's', byte_range: [0, 1], chunker_version: 'v1',
    }), /collection/);
});

test('computeChunkID rejects empty source_uri', () => {
    assert.throws(() => computeChunkID({
        collection: 'c', source_uri: '', byte_range: [0, 1], chunker_version: 'v1',
    }), /source_uri/);
});

test('computeChunkID rejects empty chunker_version', () => {
    assert.throws(() => computeChunkID({
        collection: 'c', source_uri: 's', byte_range: [0, 1], chunker_version: '',
    }), /chunker_version/);
});

/* ---------------- CHUNKER_VERSION registry ---------------- */

test('CHUNKER_VERSION is frozen and covers all five content types', () => {
    assert.equal(Object.isFrozen(CHUNKER_VERSION), true);
    assert.deepEqual(Object.keys(CHUNKER_VERSION).sort(), [
        'code', 'conversation', 'prose', 'spec', 'structured',
    ]);
});

test('CHUNKER_VERSION drives ChunkID invalidation through computeChunkID', () => {
    const base = {
        collection: 'workspace_code',
        source_uri: 'file:///x.js',
        byte_range: [0, 100],
    };
    const idAtRegistry = computeChunkID({ ...base, chunker_version: CHUNKER_VERSION.code });
    const idAtV2 = computeChunkID({ ...base, chunker_version: 'v2' });
    assert.notEqual(idAtRegistry, idAtV2);
});

/* ---------------- Composer placeholder ---------------- */

test('compose() throws "not implemented" until the Composer ships', async () => {
    await assert.rejects(
        () => compose(/** @type {any} */ ({})),
        /not implemented/,
    );
});

/* ---------------- ChunkRef structural round-trip ---------------- */

test('a typedef-shaped ChunkRef threads through a tiny consumer', () => {
    /** @type {import('../js/intelligence/retrieval/contracts.js').ChunkRef} */
    const chunk = {
        id: computeChunkID({
            collection: 'api_docs',
            source_uri: 'https://example.test/docs/auth',
            byte_range: [0, 800],
            chunker_version: CHUNKER_VERSION.spec,
        }),
        collection: 'api_docs',
        content: '## OAuth2\n\nThe authentication flow accepts ...',
        tokens: 42,
        metadata: {
            source_uri: 'https://example.test/docs/auth',
            content_type: 'spec',
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
            content_hash: 'abc123',
            structural: {
                heading_path: ['API Reference', 'Auth', 'OAuth2'],
                node_kind: 'section',
                parent_id: null,
                sibling_order: 0,
            },
            custom: {},
        },
        provenance: {
            source_uri: 'https://example.test/docs/auth',
            byte_range: [0, 800],
            line_range: [1, 24],
            retrieved_by: 'semantic',
            score: 0.83,
            score_kind: 'cosine',
        },
        embedding: null,
    };

    // Tiny consumer: pulls out fields the Composer will need at minimum.
    const summary = {
        id: chunk.id,
        tokens: chunk.tokens,
        firstHeading: chunk.metadata.structural?.heading_path[0] ?? null,
        scoreKind: chunk.provenance.score_kind,
    };
    assert.equal(summary.tokens, 42);
    assert.equal(summary.firstHeading, 'API Reference');
    assert.equal(summary.scoreKind, 'cosine');
    assert.match(summary.id, /^[0-9a-f]{16}$/);
});
