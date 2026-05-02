/**
 * Embedder integration tests (1.4.22).
 *
 * Covers `js/intelligence/retrieval/embedder.js` — the back-fill seam
 * between the chunker pipeline (1.4.19) and the chunk store (1.4.20).
 * Per DESIGN-retrieval lines 304-308 the Embedder caches by
 * `(content_hash, embedder_model_id)`; per the module's Phase-1 scope
 * decisions failures degrade rather than throw, batching is sequential,
 * and chunks arriving with `embedding != null` pass through untouched.
 *
 * Pure-data, no DOM / State / network — runs under `node --test`.
 * Mirrors the sibling test files
 * (`test-retrieval-store.mjs`, `test-retrieval-loader.mjs`,
 * `test-retrieval-pipeline.mjs`, …): each `test()` block is focused on a
 * single invariant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEmbedder } from '../js/intelligence/retrieval/embedder.js';

/* ---------------- Fixture builders ---------------- */

let nextId = 0;
const cid = () => `chunk_${(nextId++).toString(16).padStart(8, '0')}`;

/**
 * Build a minimal `Chunk` (chunker output shape — no provenance, no
 * embedding). Tests that need a `ChunkRef` (with embedding pre-baked)
 * supply `embedding` via overrides.
 *
 * @param {object} [overrides]
 */
function makeChunk(overrides = {}) {
    const id = overrides.id ?? cid();
    const content = overrides.content ?? 'hello world';
    const collection = overrides.collection ?? 'docs';
    const source_uri = overrides.source_uri ?? `docs/${id}.md`;
    const content_hash = overrides.content_hash ?? `hash_${id}`;
    const base = {
        id,
        collection,
        content,
        tokens: overrides.tokens ?? Math.max(1, Math.ceil(content.length / 4)),
        metadata: {
            source_uri,
            content_type: overrides.content_type ?? 'prose',
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
            content_hash,
            structural: overrides.structural ?? null,
            custom: overrides.custom ?? {},
        },
        byte_range: overrides.byte_range ?? [0, content.length],
    };
    if ('embedding' in overrides) {
        // Promote to ChunkRef shape with an inline stub provenance so the
        // input is recognizable as already-embedded.
        return {
            ...base,
            provenance: overrides.provenance ?? {
                source_uri,
                byte_range: base.byte_range,
                line_range: null,
                retrieved_by: 'pinned',
                score: 0,
                score_kind: 'cosine',
            },
            embedding: overrides.embedding,
        };
    }
    return base;
}

/**
 * Build a deterministic fake `embedFn` that returns short vectors keyed
 * to the input text. Tracks calls for assertions.
 */
function makeFakeEmbedFn() {
    const calls = [];
    /** @type {(t: string) => Promise<number[]|null>} */
    const fn = async (text) => {
        calls.push(text);
        // Tiny deterministic vector so tests can assert exact equality.
        const sum = [...text].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
        return [sum % 7, sum % 11, text.length % 13];
    };
    return { fn, calls };
}

/* ---------------- Argument validation ---------------- */

test('createEmbedder: rejects missing options', () => {
    assert.throws(() => createEmbedder(), /options must be an object/);
    assert.throws(() => createEmbedder(null), /options must be an object/);
});

test('createEmbedder: rejects non-function embedFn', () => {
    assert.throws(
        () => createEmbedder({ embedFn: 'nope', modelId: 'm1' }),
        /embedFn must be a function/,
    );
    assert.throws(
        () => createEmbedder({ modelId: 'm1' }),
        /embedFn must be a function/,
    );
});

test('createEmbedder: rejects missing or non-string modelId', () => {
    const embedFn = async () => [1, 2, 3];
    assert.throws(
        () => createEmbedder({ embedFn }),
        /modelId must be a non-empty string/,
    );
    assert.throws(
        () => createEmbedder({ embedFn, modelId: '' }),
        /modelId must be a non-empty string/,
    );
    assert.throws(
        () => createEmbedder({ embedFn, modelId: 123 }),
        /modelId must be a non-empty string/,
    );
});

test('createEmbedder: rejects malformed cache', () => {
    const embedFn = async () => [1, 2, 3];
    assert.throws(
        () => createEmbedder({ embedFn, modelId: 'm1', cache: {} }),
        /cache must implement \{ get, set, size \}/,
    );
    assert.throws(
        () => createEmbedder({ embedFn, modelId: 'm1', cache: 'nope' }),
        /cache must implement \{ get, set, size \}/,
    );
});

test('Embedder.embed: rejects non-array input', async () => {
    const { fn } = makeFakeEmbedFn();
    const e = createEmbedder({ embedFn: fn, modelId: 'm1' });
    await assert.rejects(() => e.embed('not-an-array'), /chunks must be an array/);
    await assert.rejects(() => e.embed(null), /chunks must be an array/);
});

test('Embedder.embedOne: rejects non-object input', async () => {
    const { fn } = makeFakeEmbedFn();
    const e = createEmbedder({ embedFn: fn, modelId: 'm1' });
    await assert.rejects(() => e.embedOne(null), /chunk must be an object/);
    await assert.rejects(() => e.embedOne('nope'), /chunk must be an object/);
});

/* ---------------- Round-trip + ChunkRef shape ---------------- */

test('embed: back-fills embedding on every chunk in a batch', async () => {
    const { fn, calls } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const chunks = [
        makeChunk({ content: 'alpha' }),
        makeChunk({ content: 'beta' }),
        makeChunk({ content: 'gamma' }),
    ];
    const out = await embedder.embed(chunks);

    assert.equal(out.length, 3);
    for (const c of out) {
        assert.ok(Array.isArray(c.embedding), `embedding present on ${c.id}`);
        assert.equal(c.embedding.length, 3);
    }
    assert.deepEqual(calls, ['alpha', 'beta', 'gamma']);
});

test('embed: output chunks have ChunkRef shape (provenance present)', async () => {
    const { fn } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const out = await embedder.embed([makeChunk({ content: 'x' })]);
    const c = out[0];
    assert.ok(c.provenance, 'provenance set');
    assert.equal(typeof c.provenance.source_uri, 'string');
    assert.equal(typeof c.provenance.score_kind, 'string');
    // byte_range threaded through from the chunk's byte_range slot.
    assert.deepEqual(c.provenance.byte_range, [0, 1]);
});

test('embed: input chunks are not mutated', async () => {
    const { fn } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const c = makeChunk({ content: 'x' });
    const snapshot = JSON.stringify(c);
    await embedder.embed([c]);
    assert.equal(JSON.stringify(c), snapshot, 'input chunk untouched');
    assert.equal('embedding' in c, false, 'no embedding field grafted onto input');
    assert.equal('provenance' in c, false, 'no provenance field grafted onto input');
});

test('embed: empty input returns [] without calling embedFn', async () => {
    const { fn, calls } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const out = await embedder.embed([]);
    assert.deepEqual(out, []);
    assert.equal(calls.length, 0);
    assert.deepEqual(embedder.stats(), { hits: 0, misses: 0, failures: 0, cached: 0 });
});

/* ---------------- Cache: hit, miss, model swap ---------------- */

test('cache hit: same content_hash, same modelId → embedFn called once', async () => {
    const { fn, calls } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const c1 = makeChunk({ content: 'shared', content_hash: 'h1' });
    const c2 = makeChunk({ content: 'shared', content_hash: 'h1' });
    await embedder.embed([c1]);
    await embedder.embed([c2]);
    assert.equal(calls.length, 1, 'embedFn called only once');
    const s = embedder.stats();
    assert.equal(s.hits, 1);
    assert.equal(s.misses, 1);
    assert.equal(s.cached, 1);
});

test('cache miss across model swap: same content_hash, different modelId → two calls', async () => {
    const { fn: fn1, calls: calls1 } = makeFakeEmbedFn();
    const { fn: fn2, calls: calls2 } = makeFakeEmbedFn();
    const e1 = createEmbedder({ embedFn: fn1, modelId: 'm1' });
    const e2 = createEmbedder({ embedFn: fn2, modelId: 'm2' });
    const c = makeChunk({ content: 'shared', content_hash: 'h1' });
    await e1.embed([c]);
    await e2.embed([c]);
    // Different modelId → different cache key → both embedders call.
    assert.equal(calls1.length, 1);
    assert.equal(calls2.length, 1);
});

test('cache: distinct content_hash → distinct cache entries', async () => {
    const { fn, calls } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    await embedder.embed([
        makeChunk({ content: 'same-text', content_hash: 'h1' }),
        makeChunk({ content: 'same-text', content_hash: 'h2' }),
    ]);
    assert.equal(calls.length, 2);
    assert.equal(embedder.stats().cached, 2);
});

test('cache: missing content_hash → never cached, always re-embedded', async () => {
    const { fn, calls } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const c1 = makeChunk({ content: 'noncached' });
    const c2 = makeChunk({ content: 'noncached' });
    // Strip content_hash so the cache key is unusable.
    delete c1.metadata.content_hash;
    delete c2.metadata.content_hash;
    await embedder.embed([c1, c2]);
    assert.equal(calls.length, 2, 'no cache means two calls');
    assert.equal(embedder.stats().cached, 0);
});

/* ---------------- Failure tolerance ---------------- */

test('failure: embedFn returns null → that chunk gets embedding null, batch continues', async () => {
    const calls = [];
    /** @type {(t: string) => Promise<number[]|null>} */
    const embedFn = async (text) => {
        calls.push(text);
        if (text === 'fails') return null;
        return [1, 2, 3];
    };
    const embedder = createEmbedder({ embedFn, modelId: 'm1' });
    const out = await embedder.embed([
        makeChunk({ content: 'ok-1' }),
        makeChunk({ content: 'fails' }),
        makeChunk({ content: 'ok-2' }),
    ]);
    assert.equal(out.length, 3);
    assert.deepEqual(out[0].embedding, [1, 2, 3]);
    assert.equal(out[1].embedding, null);
    assert.deepEqual(out[2].embedding, [1, 2, 3]);
    const s = embedder.stats();
    assert.equal(s.failures, 1);
    assert.equal(s.cached, 2, 'failed chunk not cached');
});

test('failure: embedFn throws → caught, that chunk gets null, batch continues', async () => {
    /** @type {(t: string) => Promise<number[]|null>} */
    const embedFn = async (text) => {
        if (text === 'boom') throw new Error('provider exploded');
        return [9, 9, 9];
    };
    const embedder = createEmbedder({ embedFn, modelId: 'm1' });
    const out = await embedder.embed([
        makeChunk({ content: 'first' }),
        makeChunk({ content: 'boom' }),
        makeChunk({ content: 'last' }),
    ]);
    assert.equal(out.length, 3);
    assert.deepEqual(out[0].embedding, [9, 9, 9]);
    assert.equal(out[1].embedding, null);
    assert.deepEqual(out[2].embedding, [9, 9, 9]);
    assert.equal(embedder.stats().failures, 1);
});

test('failure: embedFn returns non-array (contract violation) → degrade to null', async () => {
    /** @type {(t: string) => Promise<any>} */
    const embedFn = async () => ({ malformed: true });
    const embedder = createEmbedder({ embedFn, modelId: 'm1' });
    const out = await embedder.embed([makeChunk({ content: 'x' })]);
    assert.equal(out[0].embedding, null);
    assert.equal(embedder.stats().failures, 1);
});

/* ---------------- Idempotence ---------------- */

test('idempotent: pre-embedded chunks pass through untouched, no embedFn call', async () => {
    const { fn, calls } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const baked = makeChunk({ content: 'pre', embedding: [42, 42, 42] });
    const fresh = makeChunk({ content: 'new' });
    const out = await embedder.embed([baked, fresh]);
    assert.deepEqual(out[0].embedding, [42, 42, 42]);
    assert.ok(Array.isArray(out[1].embedding));
    assert.deepEqual(calls, ['new'], 'only the un-embedded chunk hits embedFn');
});

test('idempotent: pre-embedded chunk preserves its existing provenance', async () => {
    const { fn } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const customProv = {
        source_uri: 'baked.md',
        byte_range: [10, 42],
        line_range: [3, 7],
        retrieved_by: 'semantic',
        score: 0.87,
        score_kind: 'cosine',
    };
    const baked = makeChunk({
        content: 'baked',
        embedding: [1, 2, 3],
        provenance: customProv,
    });
    const out = await embedder.embed([baked]);
    assert.deepEqual(out[0].provenance, customProv);
});

test('idempotent: pre-embedded chunk is NOT cached under the embedder key', async () => {
    // A pre-embedded chunk's vector may have come from a different model;
    // caching it under (this modelId, content_hash) would poison subsequent
    // lookups. The module avoids this — verify by checking a follow-up
    // un-embedded chunk with the same content_hash still triggers embedFn.
    const { fn, calls } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const baked = makeChunk({
        content: 'shared',
        content_hash: 'shared_h',
        embedding: [99, 99, 99],
    });
    const fresh = makeChunk({ content: 'shared', content_hash: 'shared_h' });
    await embedder.embed([baked]);
    await embedder.embed([fresh]);
    assert.equal(calls.length, 1, 'fresh chunk re-embedded; baked vector did not poison cache');
});

/* ---------------- embedOne convenience ---------------- */

test('embedOne: behaves equivalently to embed([chunk])', async () => {
    const { fn } = makeFakeEmbedFn();
    const e1 = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const e2 = createEmbedder({ embedFn: fn, modelId: 'm1' });
    const c = makeChunk({ content: 'solo', content_hash: 'solo_h' });
    const single = await e1.embedOne(c);
    const [batched] = await e2.embed([c]);
    assert.deepEqual(single.embedding, batched.embedding);
    assert.equal(single.id, batched.id);
});

/* ---------------- Injected cache ---------------- */

test('injected cache: caller-supplied cache is consulted instead of the default', async () => {
    const events = [];
    /** @type {Map<string, number[]>} */
    const m = new Map();
    const cache = {
        get(k) {
            events.push(['get', k]);
            return m.has(k) ? m.get(k) : null;
        },
        set(k, v) {
            events.push(['set', k]);
            m.set(k, v);
        },
        size() {
            return m.size;
        },
    };
    const { fn, calls } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'mX', cache });
    const c = makeChunk({ content: 'inject', content_hash: 'inj_h' });
    await embedder.embed([c]);
    await embedder.embed([c]);
    assert.equal(calls.length, 1, 'second call hit the injected cache');
    assert.equal(m.size, 1);
    // First call: get (miss) + set. Second call: get (hit).
    const ops = events.map(([op]) => op);
    assert.deepEqual(ops, ['get', 'set', 'get']);
    // Cache key shape — `${modelId}::${content_hash}`.
    assert.equal(events[0][1], 'mX::inj_h');
});

test('injected cache: stats().cached reflects the injected backing', async () => {
    /** @type {Map<string, number[]>} */
    const m = new Map();
    const cache = {
        get: (k) => (m.has(k) ? m.get(k) : null),
        set: (k, v) => void m.set(k, v),
        size: () => m.size,
    };
    const { fn } = makeFakeEmbedFn();
    const embedder = createEmbedder({ embedFn: fn, modelId: 'm1', cache });
    await embedder.embed([
        makeChunk({ content: 'a', content_hash: 'ha' }),
        makeChunk({ content: 'b', content_hash: 'hb' }),
    ]);
    assert.equal(embedder.stats().cached, 2);
});

/* ---------------- stats() shape ---------------- */

test('stats(): tracks hits, misses, failures, cached', async () => {
    const calls = [];
    /** @type {(t: string) => Promise<number[]|null>} */
    const embedFn = async (text) => {
        calls.push(text);
        if (text === 'bad') return null;
        return [text.length, 0, 0];
    };
    const embedder = createEmbedder({ embedFn, modelId: 'm1' });
    // First batch: two misses (one success, one failure) → cached: 1.
    await embedder.embed([
        makeChunk({ content: 'good', content_hash: 'g' }),
        makeChunk({ content: 'bad', content_hash: 'b' }),
    ]);
    // Second batch: one hit (good's content_hash again), one new miss (success).
    await embedder.embed([
        makeChunk({ content: 'good', content_hash: 'g' }),
        makeChunk({ content: 'fresh', content_hash: 'f' }),
    ]);
    const s = embedder.stats();
    assert.equal(s.hits, 1, 'one hit on the second pass');
    assert.equal(s.misses, 3, 'three misses total: good#1, bad#1, fresh#1');
    assert.equal(s.failures, 1, 'one failure: bad');
    assert.equal(s.cached, 2, 'two successful embeddings cached: good, fresh');
});
