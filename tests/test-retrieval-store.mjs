/**
 * In-memory chunk store tests (1.4.20).
 *
 * Covers `js/intelligence/retrieval/store.js` — the Phase-1 fulfillment of
 * the dependency-injection seams the shipped strategies and Composer
 * already call against fakes (`getChunkByID` per `composer.js:144` and
 * `strategies/structural.js:261`; `chunkVectorSearch` per
 * `strategies/semantic.js:97-103`), plus the incremental-ingest API surface
 * from DESIGN-retrieval lines 313-328 (`getSourceHash`, `setSourceHash`,
 * `chunkIdsForSource`, `upsert`, `markStale`).
 *
 * Pure-data, no DOM / State / network — runs under `node --test`. Mirrors
 * the sibling test files (`test-retrieval-pipeline.mjs`,
 * `test-retrieval-structural-strategy.mjs`, …): each `test()` block is
 * focused on a single invariant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInMemoryChunkStore } from '../js/intelligence/retrieval/store.js';

/* ---------------- Fixture builders ---------------- */

let nextId = 0;
const cid = () => `chunk_${(nextId++).toString(16).padStart(8, '0')}`;

/**
 * Build a minimal `ChunkRef` for store tests. The structural and ingest
 * paths don't care about provenance/structural meta; tests that need them
 * override.
 *
 * @param {object} [overrides]
 * @returns {import('../js/intelligence/retrieval/contracts.js').ChunkRef}
 */
function makeChunk(overrides = {}) {
    const id = overrides.id ?? cid();
    const content = overrides.content ?? 'hello world';
    const collection = overrides.collection ?? 'docs';
    const source_uri = overrides.source_uri ?? `docs/${id}.md`;
    return {
        id,
        collection,
        content,
        tokens: overrides.tokens ?? Math.max(1, Math.ceil(content.length / 4)),
        metadata: {
            source_uri,
            content_type: overrides.content_type ?? 'prose',
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
            content_hash: overrides.content_hash ?? 'deadbeef',
            structural: overrides.structural ?? null,
            custom: overrides.custom ?? {},
        },
        provenance: {
            source_uri,
            byte_range: overrides.byte_range ?? [0, content.length],
            line_range: overrides.line_range ?? null,
            retrieved_by: overrides.retrieved_by ?? 'semantic',
            score: overrides.score ?? 0.5,
            score_kind: overrides.score_kind ?? 'cosine',
        },
        embedding: overrides.embedding === undefined ? null : overrides.embedding,
    };
}

/* ---------------- Factory + isolation ---------------- */

test('createInMemoryChunkStore() returns a handle with the documented method shape', () => {
    const store = createInMemoryChunkStore();
    for (const name of [
        'getChunkByID',
        'chunkVectorSearch',
        'getSourceHash',
        'setSourceHash',
        'chunkIdsForSource',
        'upsert',
        'markStale',
        'stats',
    ]) {
        assert.equal(typeof store[name], 'function', `${name} must be a function`);
    }
});

test('two stores from two factory calls do not share state', async () => {
    const a = createInMemoryChunkStore();
    const b = createInMemoryChunkStore();
    const chunk = makeChunk({ id: 'shared_id' });
    a.upsert([chunk]);
    assert.equal(b.stats().chunks, 0);
    assert.equal(await b.getChunkByID('shared_id'), null);
    assert.equal(a.stats().chunks, 1);
});

test('initial stats are zero across all dimensions', () => {
    const store = createInMemoryChunkStore();
    assert.deepEqual(store.stats(), { chunks: 0, collections: 0, sources: 0 });
});

/* ---------------- upsert ---------------- */

test('upsert + getChunkByID round-trip returns the canonical ref', async () => {
    const store = createInMemoryChunkStore();
    const chunk = makeChunk({ id: 'c_round' });
    store.upsert([chunk]);
    const got = await store.getChunkByID('c_round');
    assert.equal(got, chunk, 'store hands out the canonical ref, not a copy');
});

test('upsert with empty array is a no-op', () => {
    const store = createInMemoryChunkStore();
    store.upsert([]);
    assert.deepEqual(store.stats(), { chunks: 0, collections: 0, sources: 0 });
});

test('upsert distributes ids across collections; chunkVectorSearch sees only its own', async () => {
    const store = createInMemoryChunkStore();
    store.upsert([
        makeChunk({ id: 'a1', collection: 'collA', embedding: [1, 0] }),
        makeChunk({ id: 'b1', collection: 'collB', embedding: [1, 0] }),
        makeChunk({ id: 'a2', collection: 'collA', embedding: [0.5, 0.5] }),
    ]);
    const inA = await store.chunkVectorSearch([1, 0], 'collA', 10);
    const inB = await store.chunkVectorSearch([1, 0], 'collB', 10);
    assert.deepEqual(
        inA.map((r) => r.chunk.id).sort(),
        ['a1', 'a2'],
        'collA chunks',
    );
    assert.deepEqual(inB.map((r) => r.chunk.id), ['b1'], 'collB chunks');
});

test('same-id re-upsert replaces the chunk (covers the embedder back-fill case)', async () => {
    const store = createInMemoryChunkStore();
    const before = makeChunk({ id: 'c_replace', embedding: null });
    const after = makeChunk({
        id: 'c_replace',
        embedding: [1, 0, 0],
        source_uri: before.metadata.source_uri,
        collection: before.collection,
    });
    store.upsert([before]);
    store.upsert([after]);
    const got = await store.getChunkByID('c_replace');
    assert.equal(got, after);
    assert.deepEqual(got.embedding, [1, 0, 0]);
    assert.equal(store.stats().chunks, 1, 'replace, not duplicate');
});

test('upsert validates id, collection, metadata.source_uri and throws TypeError on missing fields', () => {
    const store = createInMemoryChunkStore();
    const valid = makeChunk();
    assert.throws(() => store.upsert([{ ...valid, id: '' }]), /upsert: chunks\[0\]\.id/);
    assert.throws(() => store.upsert([{ ...valid, collection: '' }]), /upsert: chunks\[0\]\.collection/);
    assert.throws(
        () =>
            store.upsert([
                { ...valid, metadata: { ...valid.metadata, source_uri: '' } },
            ]),
        /upsert: chunks\[0\]\.metadata\.source_uri/,
    );
    assert.throws(() => store.upsert(null), /upsert: chunks must be an array/);
    assert.equal(store.stats().chunks, 0, 'no chunk persisted after a validation throw');
});

/* ---------------- getChunkByID ---------------- */

test('getChunkByID(unknown) returns null', async () => {
    const store = createInMemoryChunkStore();
    assert.equal(await store.getChunkByID('nope'), null);
});

test('getChunkByID with falsy / empty input returns null without throwing', async () => {
    const store = createInMemoryChunkStore();
    assert.equal(await store.getChunkByID(''), null);
    assert.equal(await store.getChunkByID(null), null);
    assert.equal(await store.getChunkByID(undefined), null);
});

/* ---------------- chunkVectorSearch ---------------- */

test('chunkVectorSearch returns top-k sorted descending by similarity', async () => {
    const store = createInMemoryChunkStore();
    store.upsert([
        makeChunk({ id: 'far', collection: 'c', embedding: [1, 0] }),
        makeChunk({ id: 'mid', collection: 'c', embedding: [0.7, 0.7] }),
        makeChunk({ id: 'near', collection: 'c', embedding: [0, 1] }),
    ]);
    const results = await store.chunkVectorSearch([0, 1], 'c', 3);
    assert.deepEqual(
        results.map((r) => r.chunk.id),
        ['near', 'mid', 'far'],
    );
    for (let i = 1; i < results.length; i++) {
        assert.ok(
            results[i - 1].similarity >= results[i].similarity,
            `monotonically non-increasing at index ${i}`,
        );
    }
});

test('chunkVectorSearch with k=1 returns the single top match', async () => {
    const store = createInMemoryChunkStore();
    store.upsert([
        makeChunk({ id: 'a', collection: 'c', embedding: [1, 0] }),
        makeChunk({ id: 'b', collection: 'c', embedding: [0, 1] }),
    ]);
    const results = await store.chunkVectorSearch([1, 0], 'c', 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].chunk.id, 'a');
});

test('chunkVectorSearch with k > collection size returns all available, no padding', async () => {
    const store = createInMemoryChunkStore();
    store.upsert([
        makeChunk({ id: 'a', collection: 'c', embedding: [1, 0] }),
        makeChunk({ id: 'b', collection: 'c', embedding: [0, 1] }),
    ]);
    const results = await store.chunkVectorSearch([1, 0], 'c', 100);
    assert.equal(results.length, 2);
});

test('chunkVectorSearch with k <= 0 returns []', async () => {
    const store = createInMemoryChunkStore();
    store.upsert([makeChunk({ id: 'a', collection: 'c', embedding: [1, 0] })]);
    assert.deepEqual(await store.chunkVectorSearch([1, 0], 'c', 0), []);
    assert.deepEqual(await store.chunkVectorSearch([1, 0], 'c', -1), []);
    assert.deepEqual(await store.chunkVectorSearch([1, 0], 'c', NaN), []);
});

test('chunkVectorSearch skips chunks whose embedding is null', async () => {
    const store = createInMemoryChunkStore();
    store.upsert([
        makeChunk({ id: 'no_emb', collection: 'c', embedding: null }),
        makeChunk({ id: 'with_emb', collection: 'c', embedding: [1, 0] }),
    ]);
    const results = await store.chunkVectorSearch([1, 0], 'c', 10);
    assert.deepEqual(results.map((r) => r.chunk.id), ['with_emb']);
});

test('chunkVectorSearch skips chunks with mismatched embedding length (no throw)', async () => {
    const store = createInMemoryChunkStore();
    store.upsert([
        makeChunk({ id: 'short', collection: 'c', embedding: [1] }),
        makeChunk({ id: 'right', collection: 'c', embedding: [1, 0, 0] }),
        makeChunk({ id: 'long', collection: 'c', embedding: [1, 0, 0, 0, 0] }),
    ]);
    const results = await store.chunkVectorSearch([1, 0, 0], 'c', 10);
    assert.deepEqual(results.map((r) => r.chunk.id), ['right']);
});

test('chunkVectorSearch with unknown collection returns []', async () => {
    const store = createInMemoryChunkStore();
    store.upsert([makeChunk({ id: 'a', collection: 'real', embedding: [1, 0] })]);
    assert.deepEqual(await store.chunkVectorSearch([1, 0], 'absent', 5), []);
});

test('chunkVectorSearch rejects empty / non-array queryVec with TypeError', async () => {
    const store = createInMemoryChunkStore();
    await assert.rejects(
        () => store.chunkVectorSearch([], 'c', 5),
        /queryVec must be a non-empty number\[\]/,
    );
    await assert.rejects(
        () => store.chunkVectorSearch(null, 'c', 5),
        /queryVec must be a non-empty number\[\]/,
    );
});

test('chunkVectorSearch handles zero-norm vectors without NaN', async () => {
    const store = createInMemoryChunkStore();
    store.upsert([
        makeChunk({ id: 'zero', collection: 'c', embedding: [0, 0, 0] }),
        makeChunk({ id: 'unit', collection: 'c', embedding: [1, 0, 0] }),
    ]);
    const results = await store.chunkVectorSearch([1, 0, 0], 'c', 10);
    for (const r of results) {
        assert.ok(Number.isFinite(r.similarity), `similarity is finite for ${r.chunk.id}`);
    }
    assert.equal(results[0].chunk.id, 'unit', 'zero-norm chunk does not outrank a real match');
});

/* ---------------- getSourceHash / setSourceHash ---------------- */

test('setSourceHash + getSourceHash round-trip', () => {
    const store = createInMemoryChunkStore();
    store.setSourceHash('docs/x.md', 'abc123');
    assert.equal(store.getSourceHash('docs/x.md'), 'abc123');
});

test('getSourceHash returns null for unknown source', () => {
    const store = createInMemoryChunkStore();
    assert.equal(store.getSourceHash('docs/missing.md'), null);
});

test('setSourceHash validates inputs', () => {
    const store = createInMemoryChunkStore();
    assert.throws(() => store.setSourceHash('', 'h'), /sourceUri must be a non-empty string/);
    assert.throws(() => store.setSourceHash('uri', 5), /hash must be a string/);
});

/* ---------------- chunkIdsForSource ---------------- */

test('chunkIdsForSource returns the ids registered to a source after upsert', () => {
    const store = createInMemoryChunkStore();
    store.upsert([
        makeChunk({ id: 'p1', source_uri: 'docs/page.md' }),
        makeChunk({ id: 'p2', source_uri: 'docs/page.md' }),
        makeChunk({ id: 'q1', source_uri: 'docs/other.md' }),
    ]);
    assert.deepEqual(store.chunkIdsForSource('docs/page.md').sort(), ['p1', 'p2']);
    assert.deepEqual(store.chunkIdsForSource('docs/other.md'), ['q1']);
});

test('chunkIdsForSource returns a fresh array — mutation does not leak back', () => {
    const store = createInMemoryChunkStore();
    store.upsert([makeChunk({ id: 'fresh', source_uri: 'docs/once.md' })]);
    const a = store.chunkIdsForSource('docs/once.md');
    a.push('injected');
    a.length = 0;
    const b = store.chunkIdsForSource('docs/once.md');
    assert.deepEqual(b, ['fresh'], 'original list intact after caller mutated the returned array');
});

test('chunkIdsForSource returns [] for unknown source', () => {
    const store = createInMemoryChunkStore();
    assert.deepEqual(store.chunkIdsForSource('docs/never.md'), []);
});

/* ---------------- markStale ---------------- */

test('markStale removes the chunk from getChunkByID', async () => {
    const store = createInMemoryChunkStore();
    store.upsert([makeChunk({ id: 's1', source_uri: 'docs/s.md', embedding: [1, 0] })]);
    const removed = store.markStale(['s1']);
    assert.equal(removed, 1);
    assert.equal(await store.getChunkByID('s1'), null);
});

test('markStale removes the chunk from chunkVectorSearch results', async () => {
    const store = createInMemoryChunkStore();
    store.upsert([
        makeChunk({ id: 'live', collection: 'c', embedding: [1, 0] }),
        makeChunk({ id: 'doomed', collection: 'c', embedding: [0.99, 0.01] }),
    ]);
    store.markStale(['doomed']);
    const results = await store.chunkVectorSearch([1, 0], 'c', 10);
    assert.deepEqual(results.map((r) => r.chunk.id), ['live']);
});

test('markStale removes the chunk from chunkIdsForSource (incremental-ingest invariant)', () => {
    const store = createInMemoryChunkStore();
    store.upsert([
        makeChunk({ id: 'p1', source_uri: 'docs/page.md' }),
        makeChunk({ id: 'p2', source_uri: 'docs/page.md' }),
    ]);
    store.markStale(['p1']);
    assert.deepEqual(store.chunkIdsForSource('docs/page.md'), ['p2']);
});

test('markStale is idempotent and counts only ids that were actually removed', () => {
    const store = createInMemoryChunkStore();
    store.upsert([makeChunk({ id: 'real' })]);
    const first = store.markStale(['real', 'phantom']);
    const second = store.markStale(['real']);
    assert.equal(first, 1, 'phantom id contributes 0');
    assert.equal(second, 0, 're-marking removed id contributes 0');
});

test('markStale handles non-iterable / empty input', () => {
    const store = createInMemoryChunkStore();
    assert.equal(store.markStale([]), 0);
    assert.equal(store.markStale(null), 0);
    assert.equal(store.markStale(undefined), 0);
});

/* ---------------- Incremental-ingest end-to-end ---------------- */

test('incremental-ingest pseudocode (DESIGN-retrieval lines 313-328) runs cleanly against the handle', async () => {
    const store = createInMemoryChunkStore();
    const uri = 'docs/page.md';

    // First ingest: brand-new source, three chunks.
    store.setSourceHash(uri, 'hash_v1');
    store.upsert([
        makeChunk({ id: 'a', source_uri: uri, collection: 'docs' }),
        makeChunk({ id: 'b', source_uri: uri, collection: 'docs' }),
        makeChunk({ id: 'c', source_uri: uri, collection: 'docs' }),
    ]);
    assert.deepEqual(store.chunkIdsForSource(uri).sort(), ['a', 'b', 'c']);

    // Second ingest: source edited. New chunk set is { b, c, d } — 'a' is stale, 'd' is new.
    const newChunkIds = new Set(['b', 'c', 'd']);
    const oldChunkIds = store.chunkIdsForSource(uri);
    const toRemove = oldChunkIds.filter((id) => !newChunkIds.has(id));
    const toAdd = ['d'].filter((id) => !oldChunkIds.includes(id));
    assert.deepEqual(toRemove, ['a']);
    assert.deepEqual(toAdd, ['d']);

    store.upsert(toAdd.map((id) => makeChunk({ id, source_uri: uri, collection: 'docs' })));
    const removed = store.markStale(toRemove);
    assert.equal(removed, 1);
    store.setSourceHash(uri, 'hash_v2');

    assert.deepEqual(store.chunkIdsForSource(uri).sort(), ['b', 'c', 'd']);
    assert.equal(store.getSourceHash(uri), 'hash_v2');
    assert.equal(await store.getChunkByID('a'), null);
});

test('same-hash early-return path leaves the store unchanged', async () => {
    const store = createInMemoryChunkStore();
    const uri = 'docs/static.md';
    store.setSourceHash(uri, 'unchanged_hash');
    store.upsert([makeChunk({ id: 's1', source_uri: uri })]);
    const before = store.stats();

    // Re-ingest detects identical hash and short-circuits — no upsert, no markStale.
    if (store.getSourceHash(uri) === 'unchanged_hash') {
        // NoOp.
    }
    const after = store.stats();
    assert.deepEqual(after, before);
    assert.notEqual(await store.getChunkByID('s1'), null);
});
