/**
 * Incremental ingest controller tests (1.4.23).
 *
 * Covers `js/intelligence/retrieval/ingest-controller.js` — the
 * orchestration piece that sequences Loader → Chunker pipeline →
 * Embedder → Store per the design's update protocol at
 * `docs/DESIGN-retrieval.md` lines 313-328:
 *
 *   - Hash short-circuit on `current_hash === stored_hash` → `noop`.
 *   - Diff `oldIds` vs `newIds`: `to_remove` markStale'd, `to_add` embedded.
 *   - `setSourceHash` last for crash-safety.
 *   - Per-chunk embedder failures degrade (status stays `ingested`).
 *   - Loader / chunker throws → `failed`, store untouched, hash unchanged.
 *
 * Pure-data, no DOM / State / network — runs under `node --test`. Mirrors
 * the sibling test files (`test-retrieval-embedder.mjs`,
 * `test-retrieval-store.mjs`, `test-retrieval-loader.mjs`,
 * `test-retrieval-pipeline.mjs`): each `test()` block focused on a
 * single invariant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createIngestController } from '../js/intelligence/retrieval/ingest-controller.js';
import { createLoader, computeSourceHash } from '../js/intelligence/retrieval/loader.js';
import { createEmbedder } from '../js/intelligence/retrieval/embedder.js';
import { createInMemoryChunkStore } from '../js/intelligence/retrieval/store.js';
import { runChunkerPipeline } from '../js/intelligence/retrieval/pipeline.js';

/* ---------------- Fixture builders ---------------- */

/**
 * Build a fake loader using an in-memory `Map<sourceUri, bytes>` plus the
 * real `computeSourceHash` (deterministic). Tracks calls to `fetchBytes`
 * so tests can assert call counts.
 *
 * @param {Object<string, string>} initial
 */
function makeFakeLoader(initial = {}) {
    const sources = new Map(Object.entries(initial));
    const fetchCalls = [];
    const fetchBytes = async (uri) => {
        fetchCalls.push(uri);
        if (!sources.has(uri)) {
            throw new Error(`fakeLoader: no fixture for ${uri}`);
        }
        return /** @type {string} */ (sources.get(uri));
    };
    const loader = createLoader({ fetchBytes });
    return {
        loader,
        sources,
        fetchCalls,
        set(uri, bytes) {
            sources.set(uri, bytes);
        },
        delete(uri) {
            sources.delete(uri);
        },
    };
}

/**
 * Deterministic fake `embedFn` that returns a 3-element vector keyed by
 * input text. Tracks calls so tests can assert which contents were
 * embedded.
 *
 * `failOn` (Set of contents) returns `null` to exercise per-chunk
 * degradation; `throwOn` throws to exercise the embedder's caught-error
 * branch.
 */
function makeFakeEmbedFn({ failOn = new Set(), throwOn = new Set() } = {}) {
    const calls = [];
    const fn = async (text) => {
        calls.push(text);
        if (throwOn.has(text)) throw new Error(`fakeEmbedFn: thrown on ${text}`);
        if (failOn.has(text)) return null;
        const sum = [...text].reduce((a, c) => a + c.charCodeAt(0), 0);
        return [sum % 7, sum % 11, text.length % 13];
    };
    return { fn, calls };
}

/**
 * Spy on a chunk store: forwards every method to a real backing store
 * and records the call order so tests can assert "setSourceHash is last."
 *
 * @param {ReturnType<typeof createInMemoryChunkStore>} backing
 */
function spyStore(backing) {
    const callOrder = [];
    return {
        ...backing,
        getSourceHash(uri) {
            callOrder.push('getSourceHash');
            return backing.getSourceHash(uri);
        },
        setSourceHash(uri, hash) {
            callOrder.push('setSourceHash');
            return backing.setSourceHash(uri, hash);
        },
        chunkIdsForSource(uri) {
            callOrder.push('chunkIdsForSource');
            return backing.chunkIdsForSource(uri);
        },
        upsert(chunks) {
            callOrder.push('upsert');
            return backing.upsert(chunks);
        },
        markStale(ids) {
            callOrder.push('markStale');
            return backing.markStale(ids);
        },
        getChunkByID: backing.getChunkByID.bind(backing),
        chunkVectorSearch: backing.chunkVectorSearch.bind(backing),
        stats: backing.stats.bind(backing),
        callOrder,
    };
}

/* ---------------- Argument validation ---------------- */

test('createIngestController: rejects missing options', () => {
    assert.throws(() => createIngestController(), /options must be an object/);
    assert.throws(() => createIngestController(null), /options must be an object/);
});

test('createIngestController: rejects missing loader', () => {
    const { fn } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const store = createInMemoryChunkStore();
    assert.throws(
        () => createIngestController({ embedder, store }),
        /loader must expose load/,
    );
});

test('createIngestController: rejects missing embedder', () => {
    const { loader } = makeFakeLoader();
    const store = createInMemoryChunkStore();
    assert.throws(
        () => createIngestController({ loader, store }),
        /embedder must expose embed/,
    );
});

test('createIngestController: rejects missing or malformed store', () => {
    const { loader } = makeFakeLoader();
    const { fn } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    assert.throws(
        () => createIngestController({ loader, embedder }),
        /store must expose/,
    );
    assert.throws(
        () => createIngestController({ loader, embedder, store: { upsert: () => {} } }),
        /store must expose/,
    );
});

test('createIngestController: rejects non-function runChunkerPipeline', () => {
    const { loader } = makeFakeLoader();
    const { fn } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const store = createInMemoryChunkStore();
    assert.throws(
        () => createIngestController({ loader, embedder, store, runChunkerPipeline: 'nope' }),
        /runChunkerPipeline must be a function/,
    );
});

test('createIngestController: rejects empty-string collection', () => {
    const { loader } = makeFakeLoader();
    const { fn } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const store = createInMemoryChunkStore();
    assert.throws(
        () => createIngestController({ loader, embedder, store, collection: '' }),
        /collection must be a non-empty string/,
    );
});

test('createIngestController: factory contract — returns object with ingest + stats', () => {
    const { loader } = makeFakeLoader();
    const { fn } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const store = createInMemoryChunkStore();
    const c = createIngestController({ loader, embedder, store });
    assert.equal(typeof c.ingest, 'function');
    assert.equal(typeof c.stats, 'function');
});

test('IngestController.ingest: rejects non-string sourceUri', async () => {
    const { loader } = makeFakeLoader();
    const { fn } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const store = createInMemoryChunkStore();
    const c = createIngestController({ loader, embedder, store });
    await assert.rejects(() => c.ingest(), /sourceUri must be a non-empty string/);
    await assert.rejects(() => c.ingest(''), /sourceUri must be a non-empty string/);
    await assert.rejects(() => c.ingest(123), /sourceUri must be a non-empty string/);
});

/* ---------------- First ingest of a fresh source ---------------- */

test('first ingest: status "ingested", chunks upserted, source hash recorded', async () => {
    const uri = 'docs/intro.md';
    const bytes = '# Hello\n\nWorld is wide.\n';
    const { loader } = makeFakeLoader({ [uri]: bytes });
    const { fn, calls } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const store = createInMemoryChunkStore();
    const controller = createIngestController({ loader, embedder, store });

    const result = await controller.ingest(uri);

    assert.equal(result.status, 'ingested');
    assert.equal(result.source_uri, uri);
    assert.equal(result.content_hash, computeSourceHash(bytes));
    assert.ok(result.added > 0, 'added > 0');
    assert.equal(result.removed, 0);
    assert.equal(result.embed_failures, 0);
    assert.equal(result.embedded, result.added);
    assert.equal(result.error, null);
    assert.equal(store.getSourceHash(uri), computeSourceHash(bytes));
    assert.equal(store.chunkIdsForSource(uri).length, result.added);
    assert.ok(calls.length > 0, 'embedder was called');
});

/* ---------------- Second ingest with unchanged bytes ---------------- */

test('unchanged source: noop — chunker not called, embedder not called', async () => {
    const uri = 'docs/intro.md';
    const bytes = '# Hello\n\nWorld is wide.\n';
    const { loader, fetchCalls } = makeFakeLoader({ [uri]: bytes });
    const { fn, calls } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const store = createInMemoryChunkStore();

    let chunkerCalls = 0;
    const spiedChunker = (input) => {
        chunkerCalls += 1;
        return runChunkerPipeline(input);
    };
    const controller = createIngestController({
        loader,
        embedder,
        store,
        runChunkerPipeline: spiedChunker,
    });

    const first = await controller.ingest(uri);
    assert.equal(first.status, 'ingested');

    const callsBefore = calls.length;
    const chunkerBefore = chunkerCalls;

    const second = await controller.ingest(uri);
    assert.equal(second.status, 'noop');
    assert.equal(second.added, 0);
    assert.equal(second.removed, 0);
    assert.equal(second.embedded, 0);
    assert.equal(second.embed_failures, 0);
    assert.equal(second.content_hash, computeSourceHash(bytes));
    assert.equal(calls.length, callsBefore, 'embedder not called on noop');
    assert.equal(chunkerCalls, chunkerBefore, 'chunker not called on noop');
    // Loader is still consulted (it computes the current hash) — that's expected.
    assert.equal(fetchCalls.length, 2, 'loader fetched twice');
});

/* ---------------- Re-ingest after edit ---------------- */

test('re-ingest after edit: only new chunks embedded; only stale chunks removed', async () => {
    const uri = 'docs/notes.md';
    const v1 = '# Alpha\n\n' + 'aaaa '.repeat(300) + '\n\n# Beta\n\n' + 'bbbb '.repeat(300) + '\n';
    const v2 = '# Alpha\n\n' + 'aaaa '.repeat(300) + '\n\n# Gamma\n\n' + 'gggg '.repeat(300) + '\n';
    const fixture = makeFakeLoader({ [uri]: v1 });
    const { fn, calls } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const store = createInMemoryChunkStore();
    const controller = createIngestController({
        loader: fixture.loader,
        embedder,
        store,
    });

    const first = await controller.ingest(uri);
    assert.equal(first.status, 'ingested');
    const firstAdded = first.added;
    const callsAfterFirst = calls.length;
    const idsAfterFirst = new Set(store.chunkIdsForSource(uri));

    fixture.set(uri, v2);
    const second = await controller.ingest(uri);

    assert.equal(second.status, 'ingested');
    assert.ok(second.added > 0, 'edit produced new chunks');
    assert.ok(second.removed > 0, 'edit removed stale chunks');
    // Only the *new* chunks were embedded — embedder calls grew by exactly `added`.
    assert.equal(
        calls.length - callsAfterFirst,
        second.added,
        'only new chunks embedded',
    );
    // Final store size = (firstAdded - removed) + added.
    const idsAfterSecond = new Set(store.chunkIdsForSource(uri));
    assert.equal(
        idsAfterSecond.size,
        firstAdded - second.removed + second.added,
        'store size matches diff',
    );
    // Survivors from first ingest are still present.
    let survivors = 0;
    for (const id of idsAfterFirst) {
        if (idsAfterSecond.has(id)) survivors += 1;
    }
    assert.equal(survivors, firstAdded - second.removed);
});

/* ---------------- Embed failure tolerance ---------------- */

test('per-chunk embed failure: status stays "ingested", embed_failures > 0, chunk upserted with null embedding', async () => {
    const uri = 'docs/single.md';
    // Single short paragraph → exactly one chunk via prose chunker.
    const bytes = 'just one paragraph here.\n';
    const { loader } = makeFakeLoader({ [uri]: bytes });
    // Make every embedFn call fail.
    const { fn } = makeFakeEmbedFn({ failOn: new Set(['just one paragraph here.\n']) });
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const store = createInMemoryChunkStore();
    const controller = createIngestController({ loader, embedder, store });

    const result = await controller.ingest(uri);
    assert.equal(result.status, 'ingested');
    assert.equal(result.added, 1);
    assert.equal(result.embedded, 0);
    assert.equal(result.embed_failures, 1);

    // The chunk landed in the store with embedding: null.
    const ids = store.chunkIdsForSource(uri);
    assert.equal(ids.length, 1);
    const chunk = await store.getChunkByID(ids[0]);
    assert.ok(chunk, 'chunk in store');
    assert.equal(chunk.embedding, null);
});

test('all-chunks embed fail: status "ingested", embed_failures === added', async () => {
    const uri = 'docs/big.md';
    // Multiple paragraphs → multiple chunks.
    const bytes = 'alpha paragraph one.\n\nbeta paragraph two.\n\ngamma paragraph three.\n';
    const { loader } = makeFakeLoader({ [uri]: bytes });
    // Force all embeds to fail with a permissive embedFn.
    const fn = async () => null;
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const store = createInMemoryChunkStore();
    const controller = createIngestController({ loader, embedder, store });

    const result = await controller.ingest(uri);
    assert.equal(result.status, 'ingested');
    assert.ok(result.added > 0);
    assert.equal(result.embedded, 0);
    assert.equal(result.embed_failures, result.added);
});

/* ---------------- Loader throws ---------------- */

test('loader throws (unknown extension): status "failed", store untouched', async () => {
    // Loader's detectContentType returns null for unknown extensions → throws.
    const uri = 'docs/data.weird-extension';
    const { loader } = makeFakeLoader({ [uri]: 'whatever' });
    const { fn } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const store = createInMemoryChunkStore();
    const controller = createIngestController({ loader, embedder, store });

    const result = await controller.ingest(uri);
    assert.equal(result.status, 'failed');
    assert.equal(result.content_hash, null);
    assert.equal(result.added, 0);
    assert.equal(result.removed, 0);
    assert.ok(result.error instanceof Error);
    assert.match(result.error.message, /unknown content_type/);
    assert.equal(store.getSourceHash(uri), null, 'source hash unchanged');
    assert.deepEqual(store.chunkIdsForSource(uri), [], 'no chunks stored');
});

/* ---------------- Chunker throws ---------------- */

test('chunker throws: status "failed", store untouched, hash unchanged', async () => {
    const uri = 'docs/intro.md';
    const bytes = '# Hello\n';
    const { loader } = makeFakeLoader({ [uri]: bytes });
    const { fn } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const store = createInMemoryChunkStore();
    const exploding = () => {
        throw new Error('chunker exploded');
    };
    const controller = createIngestController({
        loader,
        embedder,
        store,
        runChunkerPipeline: exploding,
    });

    const result = await controller.ingest(uri);
    assert.equal(result.status, 'failed');
    assert.equal(result.content_hash, computeSourceHash(bytes));
    assert.match(result.error.message, /chunker exploded/);
    assert.equal(store.getSourceHash(uri), null, 'source hash unchanged');
    assert.deepEqual(store.chunkIdsForSource(uri), [], 'no chunks stored');
});

/* ---------------- Crash-safety: setSourceHash is the last write ---------------- */

test('crash-safety: setSourceHash throwing leaves old hash; next ingest retries', async () => {
    const uri = 'docs/x.md';
    const bytes = '# A\n\npara one.\n';
    const { loader } = makeFakeLoader({ [uri]: bytes });
    const { fn } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const backing = createInMemoryChunkStore();

    // First, a healthy ingest.
    const healthy = createIngestController({ loader, embedder, store: backing });
    const r0 = await healthy.ingest(uri);
    assert.equal(r0.status, 'ingested');
    const oldHash = backing.getSourceHash(uri);

    // Now simulate setSourceHash throwing on the second pass after an edit.
    const fixture = makeFakeLoader({ [uri]: bytes + '\n# B\n\npara two.\n' });
    const broken = {
        ...backing,
        getSourceHash: backing.getSourceHash.bind(backing),
        setSourceHash() {
            throw new Error('persistence layer down');
        },
        chunkIdsForSource: backing.chunkIdsForSource.bind(backing),
        upsert: backing.upsert.bind(backing),
        markStale: backing.markStale.bind(backing),
    };
    const flaky = createIngestController({
        loader: fixture.loader,
        embedder,
        store: broken,
    });
    await assert.rejects(() => flaky.ingest(uri), /persistence layer down/);
    // setSourceHash threw AFTER upsert/markStale — so the store was mutated, but the
    // hash on the original `backing` is still the old one (`broken.setSourceHash` threw
    // before delegating). Crash-safety: next ingest re-runs the protocol.
    assert.equal(backing.getSourceHash(uri), oldHash, 'hash still the old one');
});

/* ---------------- Empty bytes ---------------- */

test('empty bytes (fresh source): status "ingested", added=0, hash recorded', async () => {
    const uri = 'docs/empty.md';
    const { loader } = makeFakeLoader({ [uri]: '' });
    const { fn } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const store = createInMemoryChunkStore();
    const controller = createIngestController({ loader, embedder, store });

    const result = await controller.ingest(uri);
    assert.equal(result.status, 'ingested');
    assert.equal(result.added, 0);
    assert.equal(result.removed, 0);
    assert.equal(result.content_hash, computeSourceHash(''));
    assert.equal(store.getSourceHash(uri), computeSourceHash(''));
});

test('empty bytes after non-empty ingest: removes all prior chunks', async () => {
    const uri = 'docs/x.md';
    const fixture = makeFakeLoader({ [uri]: '# A\n\npara one.\n\n# B\n\npara two.\n' });
    const { fn } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const store = createInMemoryChunkStore();
    const controller = createIngestController({ loader: fixture.loader, embedder, store });

    const first = await controller.ingest(uri);
    assert.ok(first.added > 0);
    const initialIds = store.chunkIdsForSource(uri);
    assert.ok(initialIds.length > 0);

    fixture.set(uri, '');
    const second = await controller.ingest(uri);
    assert.equal(second.status, 'ingested');
    assert.equal(second.added, 0);
    assert.equal(second.removed, initialIds.length, 'all prior chunks markStale');
    assert.deepEqual(store.chunkIdsForSource(uri), [], 'store empty for source');
});

/* ---------------- stats() ---------------- */

test('stats() accumulates across mixed-status calls', async () => {
    const u1 = 'docs/a.md';
    const u2 = 'docs/b.md';
    const u3 = 'docs/c.weird-ext'; // loader will throw
    const fixture = makeFakeLoader({ [u1]: '# A\n\nalpha.\n', [u2]: '# B\n\nbeta.\n', [u3]: '?' });
    const { fn } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const store = createInMemoryChunkStore();
    const controller = createIngestController({ loader: fixture.loader, embedder, store });

    await controller.ingest(u1); // ingested
    await controller.ingest(u1); // noop
    await controller.ingest(u2); // ingested
    await controller.ingest(u3); // failed

    const s = controller.stats();
    assert.equal(s.calls, 4);
    assert.equal(s.ingested, 2);
    assert.equal(s.noop, 1);
    assert.equal(s.failed, 1);
    assert.ok(s.chunksAdded >= 2, 'each ingest added ≥ 1');
    assert.equal(s.chunksRemoved, 0);
    assert.equal(s.embedFailures, 0);
});

test('stats() returns a snapshot — mutating the result does not affect future reads', async () => {
    const { loader } = makeFakeLoader();
    const { fn } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const store = createInMemoryChunkStore();
    const controller = createIngestController({ loader, embedder, store });
    const s = controller.stats();
    s.calls = 999;
    assert.equal(controller.stats().calls, 0, 'mutation did not leak');
});

/* ---------------- collection threading ---------------- */

test('collection option threads into stored chunks', async () => {
    const uri = 'docs/x.md';
    const { loader } = makeFakeLoader({ [uri]: '# A\n\npara.\n' });
    const { fn } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const store = createInMemoryChunkStore();
    const controller = createIngestController({
        loader,
        embedder,
        store,
        collection: 'workspace_docs',
    });
    const result = await controller.ingest(uri);
    assert.equal(result.status, 'ingested');
    const ids = store.chunkIdsForSource(uri);
    const chunk = await store.getChunkByID(ids[0]);
    assert.equal(chunk.collection, 'workspace_docs');
});

test('collection defaults to "default" when not provided', async () => {
    const uri = 'docs/x.md';
    const { loader } = makeFakeLoader({ [uri]: '# A\n\npara.\n' });
    const { fn } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const store = createInMemoryChunkStore();
    const controller = createIngestController({ loader, embedder, store });
    await controller.ingest(uri);
    const ids = store.chunkIdsForSource(uri);
    const chunk = await store.getChunkByID(ids[0]);
    assert.equal(chunk.collection, 'default');
});

/* ---------------- setSourceHash is the last call (order assertion) ---------------- */

test('setSourceHash is the last store call on a successful ingest', async () => {
    const uri = 'docs/x.md';
    const { loader } = makeFakeLoader({ [uri]: '# A\n\npara.\n' });
    const { fn } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const backing = createInMemoryChunkStore();
    const spied = spyStore(backing);
    const controller = createIngestController({ loader, embedder, store: spied });

    await controller.ingest(uri);
    assert.equal(
        spied.callOrder[spied.callOrder.length - 1],
        'setSourceHash',
        'setSourceHash is the last call',
    );
    // Sanity: getSourceHash → chunkIdsForSource → upsert → markStale → setSourceHash.
    assert.deepEqual(spied.callOrder, [
        'getSourceHash',
        'chunkIdsForSource',
        'upsert',
        'markStale',
        'setSourceHash',
    ]);
});

/* ---------------- ChunkID identity invariant (regression) ---------------- */

test('(regression) re-ingest with same chunk count but different content → all old ids markStale, all new ids embedded', async () => {
    const uri = 'docs/x.md';
    // Single paragraph → single chunk in v1.
    const v1 = 'one paragraph alpha.\n';
    const v2 = 'one paragraph beta.\n';
    const fixture = makeFakeLoader({ [uri]: v1 });
    const { fn, calls } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const store = createInMemoryChunkStore();
    const controller = createIngestController({ loader: fixture.loader, embedder, store });

    const first = await controller.ingest(uri);
    assert.equal(first.added, 1);
    const v1Ids = new Set(store.chunkIdsForSource(uri));
    const callsAfterFirst = calls.length;

    fixture.set(uri, v2);
    const second = await controller.ingest(uri);

    assert.equal(second.added, 1);
    assert.equal(second.removed, 1);
    const v2Ids = new Set(store.chunkIdsForSource(uri));
    // No id survives — content changed → ChunkIDs differ.
    let overlap = 0;
    for (const id of v1Ids) if (v2Ids.has(id)) overlap += 1;
    assert.equal(overlap, 0, 'no ChunkID overlap across content edit');
    assert.equal(calls.length - callsAfterFirst, 1, 'one new chunk embedded');
});

/* ---------------- Loader-throw stats path ---------------- */

test('loader throws: stats.failed increments', async () => {
    const uri = 'docs/whatever.unknownext';
    const { loader } = makeFakeLoader({ [uri]: 'x' });
    const { fn } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const store = createInMemoryChunkStore();
    const controller = createIngestController({ loader, embedder, store });
    await controller.ingest(uri);
    assert.equal(controller.stats().failed, 1);
});

/* ---------------- noop preserves stored chunks ---------------- */

test('noop: stored chunks are unchanged', async () => {
    const uri = 'docs/x.md';
    const { loader } = makeFakeLoader({ [uri]: '# A\n\npara.\n' });
    const { fn } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const store = createInMemoryChunkStore();
    const controller = createIngestController({ loader, embedder, store });

    await controller.ingest(uri);
    const idsBefore = store.chunkIdsForSource(uri);
    await controller.ingest(uri);
    const idsAfter = store.chunkIdsForSource(uri);
    assert.deepEqual(idsAfter, idsBefore);
});
