/**
 * BM25 indexer tests (1.5.11).
 *
 * Covers `js/intelligence/retrieval/bm25-indexer.js` — the production
 * promotion of the test-fixture `buildBM25Index` from
 * `tests/test-retrieval-semantic-strategy.mjs:80-98`. The indexer
 * materializes a `BM25Index` matching the shape the Semantic strategy's
 * hybrid + pure-BM25 paths consume per the typedef pinned at
 * `strategies/semantic.js:78-84`.
 *
 * Pure-data, no DOM / State / network — runs under `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildBM25Index } from '../js/intelligence/retrieval/bm25-indexer.js';
import {
    tokenizeBM25,
    scoreBM25Doc,
    createSemanticStrategy,
} from '../js/intelligence/retrieval/strategies/semantic.js';

/* ---------------- Fixture builders ---------------- */

let nextId = 0;
const cid = () => `chunk_${(nextId++).toString(16).padStart(8, '0')}`;

/**
 * @param {string} content
 * @param {object} [overrides]
 */
function makeChunk(content, overrides = {}) {
    const id = overrides.id || cid();
    return {
        id,
        collection: overrides.collection || 'docs',
        content,
        tokens: overrides.tokens ?? Math.max(1, Math.ceil(content.length / 4)),
        metadata: {
            source_uri: overrides.source_uri || `docs/${id}.md`,
            content_type: overrides.content_type || 'prose',
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
            content_hash: overrides.content_hash || 'deadbeef',
            structural: overrides.structural ?? null,
            custom: overrides.custom || {},
        },
        provenance: {
            source_uri: overrides.source_uri || `docs/${id}.md`,
            byte_range: overrides.byte_range || [0, content.length],
            line_range: overrides.line_range || null,
            retrieved_by: 'pinned',
            score: 0,
            score_kind: 'cosine',
        },
        embedding: null,
    };
}

/* ---------------- Shape contract ---------------- */

test('buildBM25Index returns the BM25Index shape the strategy consumes', () => {
    const idx = buildBM25Index([makeChunk('hello world')]);
    assert.ok(idx.idfMap instanceof Map);
    assert.equal(typeof idx.avgdl, 'number');
    assert.ok(Array.isArray(idx.chunks));
});

test('buildBM25Index passes chunks through verbatim', () => {
    const c1 = makeChunk('alpha beta');
    const c2 = makeChunk('gamma delta');
    const idx = buildBM25Index([c1, c2]);
    assert.equal(idx.chunks.length, 2);
    assert.strictEqual(idx.chunks[0], c1);
    assert.strictEqual(idx.chunks[1], c2);
});

test('buildBM25Index input is not mutated', () => {
    const corpus = [makeChunk('alpha'), makeChunk('beta')];
    const snapshot = corpus.slice();
    buildBM25Index(corpus);
    assert.deepEqual(corpus, snapshot);
});

test('buildBM25Index throws TypeError on non-array input', () => {
    assert.throws(() => buildBM25Index(/** @type {any} */(null)), TypeError);
    assert.throws(() => buildBM25Index(/** @type {any} */({})), TypeError);
    assert.throws(() => buildBM25Index(/** @type {any} */('string')), TypeError);
});

/* ---------------- IDF formula ---------------- */

test('buildBM25Index computes IDF matching the BM25 formula ln((N − df + 0.5) / (df + 0.5) + 1)', () => {
    // Three chunks: "alpha" appears in 1, "beta" appears in 2, "gamma" in 3.
    const corpus = [
        makeChunk('alpha beta gamma'),
        makeChunk('beta gamma'),
        makeChunk('gamma'),
    ];
    const idx = buildBM25Index(corpus);
    const N = 3;
    const expectedAlpha = Math.log(((N - 1 + 0.5) / (1 + 0.5)) + 1);
    const expectedBeta = Math.log(((N - 2 + 0.5) / (2 + 0.5)) + 1);
    const expectedGamma = Math.log(((N - 3 + 0.5) / (3 + 0.5)) + 1);
    assert.equal(idx.idfMap.get('alpha'), expectedAlpha);
    assert.equal(idx.idfMap.get('beta'), expectedBeta);
    assert.equal(idx.idfMap.get('gamma'), expectedGamma);
});

test('buildBM25Index — rare terms get higher IDF than common terms', () => {
    const corpus = [
        makeChunk('rare common'),
        makeChunk('common'),
        makeChunk('common'),
        makeChunk('common'),
    ];
    const idx = buildBM25Index(corpus);
    const idfRare = idx.idfMap.get('rare');
    const idfCommon = idx.idfMap.get('common');
    assert.ok(idfRare > idfCommon, `rare ${idfRare} should outrank common ${idfCommon}`);
});

test('buildBM25Index counts a term once per chunk regardless of repetition (DF, not TF)', () => {
    // "alpha" appears 5x in chunk 0, 1x in chunk 1 — DF should be 2, not 6.
    const corpus = [
        makeChunk('alpha alpha alpha alpha alpha'),
        makeChunk('alpha beta'),
    ];
    const idx = buildBM25Index(corpus);
    const N = 2;
    const expectedAlpha = Math.log(((N - 2 + 0.5) / (2 + 0.5)) + 1);
    assert.equal(idx.idfMap.get('alpha'), expectedAlpha);
});

/* ---------------- avgdl ---------------- */

test('buildBM25Index — avgdl is total tokens / N', () => {
    const corpus = [
        makeChunk('one two three'),  // 3 tokens
        makeChunk('four five'),       // 2 tokens
        makeChunk('six'),             // 1 token
    ];
    const idx = buildBM25Index(corpus);
    assert.equal(idx.avgdl, 6 / 3); // 2.0
});

test('buildBM25Index — avgdl divides by chunks.length (counts empty docs in N)', () => {
    // Matches the test-fixture convention so existing tests in
    // test-retrieval-semantic-strategy.mjs keep producing the same
    // avgdl when buildBM25Index is substituted in.
    const corpus = [
        makeChunk('one two three'), // 3 tokens
        makeChunk(''),              // 0 tokens but counted in N
    ];
    const idx = buildBM25Index(corpus);
    assert.equal(idx.avgdl, 3 / 2); // 1.5
});

/* ---------------- Edge cases ---------------- */

test('buildBM25Index — empty corpus produces empty idfMap and avgdl=0', () => {
    const idx = buildBM25Index([]);
    assert.equal(idx.idfMap.size, 0);
    assert.equal(idx.avgdl, 0);
    assert.equal(idx.chunks.length, 0);
});

test('buildBM25Index — single chunk produces idf=ln(1.5/1.5 + 1)=ln(2) per token', () => {
    const idx = buildBM25Index([makeChunk('alpha beta')]);
    const expected = Math.log(((1 - 1 + 0.5) / (1 + 0.5)) + 1); // ln(2)
    assert.equal(idx.idfMap.get('alpha'), expected);
    assert.equal(idx.idfMap.get('beta'), expected);
});

test('buildBM25Index — identical chunks (DF == N) produce IDF = ln(1.0 / N+0.5 + 1)', () => {
    // Term in every chunk → df = N → numerator (N - N + 0.5)/(N + 0.5)
    // approaches 0 for large N → IDF approaches ln(1) = 0.
    const corpus = [
        makeChunk('alpha'),
        makeChunk('alpha'),
        makeChunk('alpha'),
    ];
    const idx = buildBM25Index(corpus);
    const N = 3;
    const expected = Math.log(((N - N + 0.5) / (N + 0.5)) + 1);
    assert.equal(idx.idfMap.get('alpha'), expected);
    assert.ok(expected > 0, 'BM25 IDF stays positive for in-every-doc terms (the +1 inside log)');
});

test('buildBM25Index — chunks with non-string content are coerced to empty', () => {
    const goodChunk = makeChunk('alpha beta');
    const nullChunk = { ...makeChunk('placeholder'), content: null };
    const undefChunk = { ...makeChunk('placeholder2'), content: undefined };
    // Should not throw; the null/undef chunks contribute 0 tokens.
    const idx = buildBM25Index(/** @type {any} */([goodChunk, nullChunk, undefChunk]));
    assert.equal(idx.chunks.length, 3);
    // avgdl = 2 tokens / 3 chunks
    assert.equal(idx.avgdl, 2 / 3);
    assert.ok(idx.idfMap.has('alpha'));
    assert.ok(idx.idfMap.has('beta'));
});

test('buildBM25Index — non-ASCII content tokenizes to empty (matches tokenizeBM25)', () => {
    // tokenizeBM25 splits on /[^a-z0-9]+/ after lowercasing. Pure-CJK
    // content has no a-z0-9 characters → tokens drop to [].
    const corpus = [
        makeChunk('日本語のテスト'),
        makeChunk('alpha beta'),
    ];
    const idx = buildBM25Index(corpus);
    assert.equal(idx.idfMap.size, 2); // only 'alpha' and 'beta'
    assert.ok(idx.idfMap.has('alpha'));
    assert.ok(idx.idfMap.has('beta'));
    // avgdl = 2 tokens / 2 chunks
    assert.equal(idx.avgdl, 1);
});

/* ---------------- k1/b passthrough ---------------- */

test('buildBM25Index — k1/b round-trip when supplied', () => {
    const idx = buildBM25Index([makeChunk('alpha')], { k1: 2.0, b: 0.5 });
    assert.equal(idx.k1, 2.0);
    assert.equal(idx.b, 0.5);
});

test('buildBM25Index — k1/b absent when opts not supplied (strategy applies its defaults)', () => {
    const idx = buildBM25Index([makeChunk('alpha')]);
    assert.equal(idx.k1, undefined);
    assert.equal(idx.b, undefined);
});

test('buildBM25Index — opts ignored when not numeric', () => {
    const idx = buildBM25Index(
        [makeChunk('alpha')],
        /** @type {any} */({ k1: 'high', b: null }),
    );
    assert.equal(idx.k1, undefined);
    assert.equal(idx.b, undefined);
});

/* ---------------- Strategy interop (the load-bearing claim) ---------------- */

test('buildBM25Index — scoreBM25Doc against a built index produces non-zero scores for matching terms', () => {
    const corpus = [
        makeChunk('alpha alpha beta'),
        makeChunk('gamma delta'),
        makeChunk('alpha gamma'),
    ];
    const idx = buildBM25Index(corpus);
    const queryTokens = tokenizeBM25('alpha');
    const sMatch = scoreBM25Doc(queryTokens, corpus[0].content, idx);
    const sNoMatch = scoreBM25Doc(queryTokens, corpus[1].content, idx);
    assert.ok(sMatch > 0, `matching doc should score > 0, got ${sMatch}`);
    assert.equal(sNoMatch, 0);
});

test('buildBM25Index — wired into createSemanticStrategy via getBM25Index, hybrid path activates', async () => {
    // Sanity check the load-bearing wiring contract: a real index returned
    // from buildBM25Index satisfies the hybrid-path consumer in semantic.js.
    const corpus = [
        makeChunk('authentication middleware design pattern', { id: 'c1', source_uri: 'auth.md' }),
        makeChunk('database query optimization', { id: 'c2', source_uri: 'db.md' }),
        makeChunk('frontend rendering pipeline', { id: 'c3', source_uri: 'render.md' }),
    ];
    const idx = buildBM25Index(corpus);

    // Fakes for the two required deps.
    const fakeVec = [0.1, 0.2, 0.3];
    const knnFake = async (_vec, _coll, k) =>
        corpus.slice(0, k).map((chunk, i) => ({ chunk, similarity: 1 - i * 0.1 }));
    const embedFake = async () => fakeVec;

    const strategy = createSemanticStrategy({
        embedQuery: embedFake,
        chunkVectorSearch: knnFake,
        getBM25Index: (coll) => coll === 'docs' ? idx : null,
    });

    /** @type {import('../js/intelligence/retrieval/contracts.js').RetrievalRequest} */
    const req = {
        task: 'unit-test',
        // Three-plus tokens so the strategy takes the hybrid path; <3
        // tokens triggers the pure-BM25 fallback (MIN_TOKENS_FOR_SEMANTIC).
        query: 'authentication middleware design',
        collections: ['docs'],
        budget: { total_tokens: 8000, system_reserve: 800, output_reserve: 800, history_reserve: 1000 },
        history: null,
        filters: null,
        strategy_hints: null,
        priority_pins: null,
        task_ledger: null,
    };
    const results = await strategy.retrieve(req, 3);
    assert.ok(results.length > 0, 'hybrid path should return results');
    const kinds = new Set(results.map(r => r.provenance.score_kind));
    assert.ok(kinds.has('hybrid'), `expected score_kind 'hybrid' from BM25-fed strategy, got ${[...kinds]}`);
});

test('buildBM25Index — empty index injection still gracefully degrades', async () => {
    // An index built from an empty corpus shouldn't crash the strategy.
    const idx = buildBM25Index([]);
    const fakeVec = [0.1, 0.2, 0.3];
    const knnFake = async () => [];
    const embedFake = async () => fakeVec;
    const strategy = createSemanticStrategy({
        embedQuery: embedFake,
        chunkVectorSearch: knnFake,
        getBM25Index: () => idx,
    });
    /** @type {import('../js/intelligence/retrieval/contracts.js').RetrievalRequest} */
    const req = {
        task: 'unit-test',
        query: 'anything',
        collections: ['docs'],
        budget: { total_tokens: 8000, system_reserve: 800, output_reserve: 800, history_reserve: 1000 },
        history: null,
        filters: null,
        strategy_hints: null,
        priority_pins: null,
        task_ledger: null,
    };
    const results = await strategy.retrieve(req, 3);
    assert.deepEqual(results, []);
});
