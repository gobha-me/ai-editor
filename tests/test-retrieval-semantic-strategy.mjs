/**
 * Semantic strategy tests (1.4.15).
 *
 * Covers `js/intelligence/retrieval/strategies/semantic.js` per
 * `docs/DESIGN-retrieval.md` §"Semantic (Phase 1)": embed → k-NN → BM25
 * (when index supplied) → RRF fusion → metadata filter → top quota,
 * including the failure-mode paths (short query, embedder unavailable,
 * empty collection, no BM25 index).
 *
 * Pure-data, no DOM / State / network — runs under `node --test`. The
 * strategy is dependency-injected (embedQuery + chunkVectorSearch +
 * optional getBM25Index), so tests construct deterministic fakes and
 * never touch the real `EmbeddingsClient`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createSemanticStrategy,
    tokenizeBM25,
    scoreBM25Doc,
    reciprocalRankFusion,
    applyMetadataFilter,
    applyScoreWeights,
} from '../js/intelligence/retrieval/strategies/semantic.js';

/* ---------------- Fixture builders ---------------- */

let nextId = 0;
const cid = () => `chunk_${(nextId++).toString(16).padStart(8, '0')}`;

/**
 * @param {string} content
 * @param {object} [overrides]
 * @returns {import('../js/intelligence/retrieval/contracts.js').ChunkRef}
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

/**
 * @param {Array<{chunk: any, similarity: number}>} ranked
 */
const knnFake = (ranked) => async (_vec, _coll, k) => ranked.slice(0, k);

/**
 * Embedder fake that returns a fixed vector for any non-empty query, or
 * null when the test wants to simulate "embedder unavailable."
 */
const embedFake = (vec) => async (_text) => vec;

/**
 * Build a BM25 index over a corpus with simple tokenization. Mirrors
 * the math the future ingest PR will run.
 */
function buildBM25Index(chunks, opts = {}) {
    /** @type {Map<string, number>} */
    const df = new Map();
    let totalLen = 0;
    for (const c of chunks) {
        const toks = tokenizeBM25(c.content);
        totalLen += toks.length;
        const seen = new Set(toks);
        for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
    }
    const avgdl = chunks.length === 0 ? 0 : totalLen / chunks.length;
    const N = chunks.length;
    /** @type {Map<string, number>} */
    const idfMap = new Map();
    for (const [t, n] of df) {
        idfMap.set(t, Math.log(((N - n + 0.5) / (n + 0.5)) + 1));
    }
    return { idfMap, avgdl, chunks, k1: opts.k1, b: opts.b };
}

const baseReq = (overrides = {}) => ({
    task: 'unit-test',
    query: 'authentication middleware design',
    collections: ['docs'],
    budget: { total_tokens: 8000, system_reserve: 800, output_reserve: 800, history_reserve: 1000 },
    history: null,
    filters: null,
    strategy_hints: null,
    priority_pins: null,
    task_ledger: null,
    ...overrides,
});

/* ---------------- tokenizeBM25 ---------------- */

test('tokenizeBM25 lowercases and word-splits', () => {
    assert.deepEqual(tokenizeBM25('Hello, World!'), ['hello', 'world']);
});

test('tokenizeBM25 drops punctuation/empties', () => {
    assert.deepEqual(tokenizeBM25('foo--bar___baz!!!'), ['foo', 'bar', 'baz']);
});

test('tokenizeBM25 returns empty for empty input', () => {
    assert.deepEqual(tokenizeBM25(''), []);
    assert.deepEqual(tokenizeBM25('   '), []);
    assert.deepEqual(tokenizeBM25(/** @type {any} */(null)), []);
});

/* ---------------- scoreBM25Doc ---------------- */

test('scoreBM25Doc returns 0 for empty query', () => {
    const idx = buildBM25Index([makeChunk('hello world')]);
    assert.equal(scoreBM25Doc([], 'hello world', idx), 0);
});

test('scoreBM25Doc returns 0 when no query token appears in doc', () => {
    const idx = buildBM25Index([makeChunk('the quick brown fox')]);
    assert.equal(scoreBM25Doc(['zzzz'], 'the quick brown fox', idx), 0);
});

test('scoreBM25Doc rewards term-frequency match', () => {
    const corpus = [
        makeChunk('alpha alpha alpha beta'),
        makeChunk('alpha gamma delta'),
        makeChunk('beta gamma delta'),
        makeChunk('completely unrelated content here'),
    ];
    const idx = buildBM25Index(corpus);
    const sHigh = scoreBM25Doc(['alpha'], corpus[0].content, idx);
    const sLow = scoreBM25Doc(['alpha'], corpus[1].content, idx);
    assert.ok(sHigh > sLow, `expected ${sHigh} > ${sLow}`);
});

test('scoreBM25Doc length-normalizes', () => {
    const short = makeChunk('alpha');
    const long = makeChunk('alpha ' + 'noise '.repeat(40));
    const idx = buildBM25Index([short, long]);
    const sShort = scoreBM25Doc(['alpha'], short.content, idx);
    const sLong = scoreBM25Doc(['alpha'], long.content, idx);
    assert.ok(sShort > sLong, 'short doc with same TF should outscore long doc');
});

/* ---------------- reciprocalRankFusion ---------------- */

test('RRF rewards items appearing in both rankings', () => {
    const both = ['x'];
    const cosine = ['a', 'x', 'b'];
    const bm25 = ['x', 'c', 'd'];
    const fused = reciprocalRankFusion([cosine, bm25]);
    const xScore = fused.get('x');
    const aScore = fused.get('a');
    const cScore = fused.get('c');
    assert.ok(xScore > aScore, 'x in both should outscore a in one');
    assert.ok(xScore > cScore, 'x in both should outscore c in one');
});

test('RRF empty rankings produce empty map', () => {
    assert.equal(reciprocalRankFusion([]).size, 0);
    assert.equal(reciprocalRankFusion([[], []]).size, 0);
});

test('RRF higher rank (lower index) gets larger contribution', () => {
    const fused = reciprocalRankFusion([['a', 'b']]);
    assert.ok(fused.get('a') > fused.get('b'));
});

/* ---------------- applyMetadataFilter ---------------- */

test('metadata filter is identity when filter is null/undefined', () => {
    const chunks = [makeChunk('a'), makeChunk('b')];
    assert.equal(applyMetadataFilter(chunks, null).length, 2);
    assert.equal(applyMetadataFilter(chunks, undefined).length, 2);
});

test('metadata filter accepts only listed content_types', () => {
    const a = makeChunk('a', { content_type: 'prose' });
    const b = makeChunk('b', { content_type: 'code' });
    const c = makeChunk('c', { content_type: 'prose' });
    const out = applyMetadataFilter([a, b, c], { content_types: ['prose'] });
    assert.deepEqual(out.map(x => x.content), ['a', 'c']);
});

test('metadata filter custom predicate (function) accepts on truthy', () => {
    const a = makeChunk('a', { custom: { lang: 'js' } });
    const b = makeChunk('b', { custom: { lang: 'py' } });
    const out = applyMetadataFilter([a, b], {
        custom: { lang: (v) => v === 'js' },
    });
    assert.deepEqual(out.map(x => x.content), ['a']);
});

test('metadata filter custom predicate (literal) accepts on strict-equal', () => {
    const a = makeChunk('a', { custom: { lang: 'js' } });
    const b = makeChunk('b', { custom: { lang: 'py' } });
    const out = applyMetadataFilter([a, b], { custom: { lang: 'js' } });
    assert.deepEqual(out.map(x => x.content), ['a']);
});

test('metadata filter does not mutate input array', () => {
    const a = makeChunk('a');
    const input = [a];
    applyMetadataFilter(input, { content_types: ['code'] });
    assert.equal(input.length, 1);
});

test('metadata filter skips well-known custom.score_weights key (not treated as predicate)', () => {
    // Regression test: 1.5.8 introduces `custom.score_weights` as a
    // post-rank ranking signal, NOT a predicate. `applyMetadataFilter`
    // would otherwise interpret it as "match chunk.metadata.custom.score_weights"
    // and reject every chunk.
    const a = makeChunk('a', { custom: {} });
    const b = makeChunk('b', { custom: {} });
    const out = applyMetadataFilter([a, b], {
        custom: { score_weights: { content_types: { prose: 0.5 } } },
    });
    assert.equal(out.length, 2, 'score_weights must not gate admission');
});

/* ---------------- applyScoreWeights (1.5.8 / T5) ---------------- */

test('applyScoreWeights: null/undefined weights → identity sort by score desc', () => {
    const a = makeChunk('a');
    const b = makeChunk('b');
    const c = makeChunk('c');
    const scored = [
        { chunk: a, score: 0.3 },
        { chunk: b, score: 0.9 },
        { chunk: c, score: 0.5 },
    ];
    const outNull = applyScoreWeights(scored, null);
    assert.deepEqual(outNull.map(s => s.chunk.content), ['b', 'c', 'a']);
    assert.deepEqual(outNull.map(s => s.score), [0.9, 0.5, 0.3]);
    const outUndef = applyScoreWeights(scored, undefined);
    assert.deepEqual(outUndef.map(s => s.chunk.content), ['b', 'c', 'a']);
});

test('applyScoreWeights: content-type weights downweight prose to lower rank', () => {
    const proseHi = makeChunk('p', { content_type: 'prose' });
    const codeMid = makeChunk('c', { content_type: 'code' });
    const scored = [
        { chunk: proseHi, score: 0.8 },
        { chunk: codeMid, score: 0.5 },
    ];
    const out = applyScoreWeights(scored, { content_types: { prose: 0.5 } });
    // prose: 0.8 × 0.5 = 0.4; code: 0.5 × 1.0 = 0.5 → code wins.
    assert.deepEqual(out.map(s => s.chunk.content), ['c', 'p']);
    assert.equal(out[0].score, 0.5);
    assert.equal(out[1].score, 0.4);
});

test('applyScoreWeights: prefix weights downweight docs/ to lower rank', () => {
    const docsHi = makeChunk('d', { content_type: 'code', source_uri: 'docs/foo.md' });
    const jsMid = makeChunk('j', { content_type: 'code', source_uri: 'js/bar.js' });
    const scored = [
        { chunk: docsHi, score: 0.8 },
        { chunk: jsMid, score: 0.5 },
    ];
    const out = applyScoreWeights(scored, { prefixes: { 'docs/': 0.5, 'js/': 1.0 } });
    // docs/: 0.8 × 0.5 = 0.4; js/: 0.5 × 1.0 = 0.5 → js wins.
    assert.deepEqual(out.map(s => s.chunk.content), ['j', 'd']);
});

test('applyScoreWeights: content-type and prefix compose multiplicatively', () => {
    const proseDocsHi = makeChunk('pd', { content_type: 'prose', source_uri: 'docs/x.md' });
    const codeJs = makeChunk('cj', { content_type: 'code', source_uri: 'js/x.js' });
    const scored = [
        { chunk: proseDocsHi, score: 1.0 },
        { chunk: codeJs, score: 0.5 },
    ];
    const out = applyScoreWeights(scored, {
        content_types: { prose: 0.5, code: 1.0 },
        prefixes: { 'docs/': 0.5, 'js/': 1.0 },
    });
    // prose+docs: 1.0 × 0.5 × 0.5 = 0.25; code+js: 0.5 × 1.0 × 1.0 = 0.5
    assert.deepEqual(out.map(s => s.chunk.content), ['cj', 'pd']);
    assert.equal(out[0].score, 0.5);
    assert.equal(out[1].score, 0.25);
});

test('applyScoreWeights: missing content-type or prefix entries default to 1.0', () => {
    const codeJs = makeChunk('cj', { content_type: 'code', source_uri: 'js/x.js' });
    const structPlugins = makeChunk('sp', { content_type: 'structured', source_uri: 'plugins/x.json' });
    const scored = [
        { chunk: codeJs, score: 0.7 },
        { chunk: structPlugins, score: 0.6 },
    ];
    // Map omits 'structured' and 'plugins/' — both default to 1.0.
    const out = applyScoreWeights(scored, {
        content_types: { prose: 0.5 },
        prefixes: { 'docs/': 0.5 },
    });
    // Both unchanged; original order by score preserved.
    assert.deepEqual(out.map(s => s.chunk.content), ['cj', 'sp']);
    assert.equal(out[0].score, 0.7);
    assert.equal(out[1].score, 0.6);
});

test('applyScoreWeights: longest matching prefix wins (js/intelligence/ beats js/)', () => {
    const inner = makeChunk('inner', { content_type: 'code', source_uri: 'js/intelligence/foo.js' });
    const outer = makeChunk('outer', { content_type: 'code', source_uri: 'js/bar.js' });
    const scored = [
        { chunk: inner, score: 1.0 },
        { chunk: outer, score: 1.0 },
    ];
    const out = applyScoreWeights(scored, {
        prefixes: { 'js/': 0.1, 'js/intelligence/': 1.0 },
    });
    // inner matches longer prefix → 1.0 × 1.0 = 1.0
    // outer matches only 'js/' → 1.0 × 0.1 = 0.1
    assert.deepEqual(out.map(s => s.chunk.content), ['inner', 'outer']);
    assert.equal(out[0].score, 1.0);
    assert.equal(out[1].score, 0.1);
});

test('applyScoreWeights: non-finite weights are treated as 1.0 (forgiving)', () => {
    const a = makeChunk('a', { content_type: 'prose' });
    const b = makeChunk('b', { content_type: 'code' });
    const scored = [
        { chunk: a, score: 1.0 },
        { chunk: b, score: 0.5 },
    ];
    // Garbage weight values for prose; should default to 1.0 not NaN/Infinity.
    const out = applyScoreWeights(scored, {
        content_types: { prose: NaN, code: Infinity },
    });
    assert.deepEqual(out.map(s => s.chunk.content), ['a', 'b']);
    assert.equal(out[0].score, 1.0);
    assert.equal(out[1].score, 0.5);
});

test('applyScoreWeights: does not mutate input array or input objects', () => {
    const a = makeChunk('a', { content_type: 'prose' });
    const input = [{ chunk: a, score: 1.0 }];
    const out = applyScoreWeights(input, { content_types: { prose: 0.5 } });
    assert.equal(input[0].score, 1.0, 'input score must not be mutated');
    assert.notStrictEqual(out, input, 'returns fresh array');
    assert.equal(out[0].score, 0.5);
});

test('applyScoreWeights: empty scored array → empty out', () => {
    assert.deepEqual(applyScoreWeights([], { content_types: { prose: 0.5 } }), []);
    assert.deepEqual(applyScoreWeights([], null), []);
});

test('applyScoreWeights: weights with neither content_types nor prefixes is identity sort', () => {
    const a = makeChunk('a');
    const b = makeChunk('b');
    const scored = [
        { chunk: a, score: 0.3 },
        { chunk: b, score: 0.7 },
    ];
    const out = applyScoreWeights(scored, /** @type {any} */ ({ irrelevant: 'value' }));
    assert.deepEqual(out.map(s => s.chunk.content), ['b', 'a']);
});

test('retrieve cosine path: filter.custom.score_weights re-orders by weighted score', async () => {
    // Cosine candidates with prose at top, code mid; default order would
    // return prose first. With prose downweighted to 0.5, code wins.
    const proseHi = makeChunk('p', { content_type: 'prose', source_uri: 'docs/x.md' });
    const codeMid = makeChunk('c', { content_type: 'code', source_uri: 'js/y.js' });
    const strat = createSemanticStrategy({
        embedQuery: embedFake([1, 0, 0]),
        chunkVectorSearch: knnFake([
            { chunk: proseHi, score: 0.9, similarity: 0.9 },
            { chunk: codeMid, score: 0.6, similarity: 0.6 },
        ]),
    });
    const out = await strat.retrieve(baseReq({
        filters: {
            custom: { score_weights: { content_types: { prose: 0.5, code: 1.0 } } },
        },
    }), 5);
    // prose: 0.9 × 0.5 = 0.45; code: 0.6 × 1.0 = 0.6 → code first.
    assert.deepEqual(out.map(c => c.content), ['c', 'p']);
});

/* ---------------- factory validation ---------------- */

test('factory throws when embedQuery is missing/non-function', () => {
    assert.throws(() => createSemanticStrategy(/** @type {any} */({ chunkVectorSearch: () => [] })), TypeError);
    assert.throws(() => createSemanticStrategy(/** @type {any} */({ embedQuery: 'nope', chunkVectorSearch: () => [] })), TypeError);
});

test('factory throws when chunkVectorSearch is missing/non-function', () => {
    assert.throws(() => createSemanticStrategy(/** @type {any} */({ embedQuery: async () => [1, 2, 3] })), TypeError);
});

test('factory throws when getBM25Index is supplied as non-function', () => {
    assert.throws(() => createSemanticStrategy(/** @type {any} */({
        embedQuery: async () => [1, 2, 3],
        chunkVectorSearch: async () => [],
        getBM25Index: 'not-a-fn',
    })), TypeError);
});

/* ---------------- applies_to ---------------- */

test('applies_to returns 0 for null/empty/whitespace query', () => {
    const strat = createSemanticStrategy({
        embedQuery: async () => [1, 2, 3],
        chunkVectorSearch: async () => [],
    });
    assert.equal(strat.applies_to(baseReq({ query: null })).score, 0);
    assert.equal(strat.applies_to(baseReq({ query: '' })).score, 0);
    assert.equal(strat.applies_to(baseReq({ query: '   ' })).score, 0);
});

test('applies_to returns positive score with a non-empty query', () => {
    const strat = createSemanticStrategy({
        embedQuery: async () => [1, 2, 3],
        chunkVectorSearch: async () => [],
    });
    const a = strat.applies_to(baseReq({ query: 'authentication middleware' }));
    assert.ok(a.score > 0.5);
    assert.equal(typeof a.reason, 'string');
});

test('strategy.name is "semantic"', () => {
    const strat = createSemanticStrategy({
        embedQuery: async () => [1, 2, 3],
        chunkVectorSearch: async () => [],
    });
    assert.equal(strat.name, 'semantic');
});

/* ---------------- retrieve — happy paths ---------------- */

test('retrieve returns top-quota cosine candidates with cosine score_kind when no BM25 index', async () => {
    const c1 = makeChunk('alpha doc');
    const c2 = makeChunk('beta doc');
    const c3 = makeChunk('gamma doc');
    const ranked = [
        { chunk: c1, similarity: 0.9 },
        { chunk: c2, similarity: 0.7 },
        { chunk: c3, similarity: 0.5 },
    ];
    const strat = createSemanticStrategy({
        embedQuery: embedFake([0.1, 0.2, 0.3]),
        chunkVectorSearch: knnFake(ranked),
    });
    const out = await strat.retrieve(baseReq(), 2);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, c1.id);
    assert.equal(out[1].id, c2.id);
    for (const c of out) {
        assert.equal(c.provenance.score_kind, 'cosine');
        assert.equal(c.provenance.retrieved_by, 'semantic');
        assert.equal(c.embedding, null);
    }
    assert.equal(out[0].provenance.score, 0.9);
});

test('retrieve k-NN k = quota * 3 (gives the store room to filter)', async () => {
    let observedK = -1;
    const candidates = Array.from({ length: 30 }, (_, i) => ({
        chunk: makeChunk(`c${i}`),
        similarity: 1 - i * 0.01,
    }));
    const strat = createSemanticStrategy({
        embedQuery: embedFake([0.1]),
        chunkVectorSearch: async (_v, _c, k) => {
            observedK = k;
            return candidates.slice(0, k);
        },
    });
    await strat.retrieve(baseReq(), 5);
    assert.equal(observedK, 15);
});

test('retrieve preserves provenance.byte_range carry-forward', async () => {
    const c = makeChunk('doc', { byte_range: [12, 99] });
    const strat = createSemanticStrategy({
        embedQuery: embedFake([0.1]),
        chunkVectorSearch: knnFake([{ chunk: c, similarity: 0.8 }]),
    });
    const out = await strat.retrieve(baseReq(), 1);
    assert.deepEqual(out[0].provenance.byte_range, [12, 99]);
});

test('retrieve hybrid path fuses cosine + BM25 via RRF and labels score_kind="hybrid"', async () => {
    const docs = [
        makeChunk('authentication middleware login session token'),
        makeChunk('database migration schema'),
        makeChunk('css styling layout flexbox'),
        makeChunk('authentication ssh oauth keys'),
    ];
    // Cosine ranks doc 2 (css) high (silly cosine fixture), BM25 will rank
    // docs 0 and 3 high. RRF fusion should bring 0 and 3 to the top.
    const ranked = [
        { chunk: docs[2], similarity: 0.95 },
        { chunk: docs[0], similarity: 0.8 },
        { chunk: docs[3], similarity: 0.7 },
        { chunk: docs[1], similarity: 0.5 },
    ];
    const idx = buildBM25Index(docs);
    const strat = createSemanticStrategy({
        embedQuery: embedFake([0.1]),
        chunkVectorSearch: knnFake(ranked),
        getBM25Index: () => idx,
    });
    const out = await strat.retrieve(baseReq({ query: 'authentication oauth keys' }), 2);
    assert.equal(out.length, 2);
    for (const c of out) {
        assert.equal(c.provenance.score_kind, 'hybrid');
        assert.equal(c.provenance.retrieved_by, 'semantic');
    }
    const ids = new Set(out.map(c => c.id));
    assert.ok(ids.has(docs[0].id) || ids.has(docs[3].id),
        'fusion should surface the BM25-favored authentication chunks');
});

/* ---------------- retrieve — failure modes ---------------- */

test('retrieve short query without BM25 → empty result', async () => {
    const c = makeChunk('alpha beta');
    const strat = createSemanticStrategy({
        embedQuery: embedFake([0.1]),
        chunkVectorSearch: knnFake([{ chunk: c, similarity: 0.9 }]),
    });
    // 2 tokens — below MIN_TOKENS_FOR_SEMANTIC (3)
    const out = await strat.retrieve(baseReq({ query: 'auth oauth' }), 5);
    assert.deepEqual(out, []);
});

test('retrieve short query with BM25 → pure-BM25 fallback, score_kind="bm25"', async () => {
    const docs = [
        makeChunk('alpha doc one'),
        makeChunk('alpha alpha doc two'),
        makeChunk('beta doc three'),
    ];
    const idx = buildBM25Index(docs);
    const strat = createSemanticStrategy({
        embedQuery: embedFake([0.1]),
        chunkVectorSearch: knnFake([]),
        getBM25Index: () => idx,
    });
    // 1 token, below threshold
    const out = await strat.retrieve(baseReq({ query: 'alpha' }), 5);
    assert.ok(out.length > 0);
    for (const c of out) {
        assert.equal(c.provenance.score_kind, 'bm25');
        assert.equal(c.provenance.retrieved_by, 'semantic');
    }
    // doc 1 has TF=2 for alpha, should rank first
    assert.equal(out[0].id, docs[1].id);
});

test('retrieve embedder unavailable (returns null) without BM25 → empty', async () => {
    const c = makeChunk('alpha beta gamma delta');
    const strat = createSemanticStrategy({
        embedQuery: embedFake(null),
        chunkVectorSearch: knnFake([{ chunk: c, similarity: 0.9 }]),
    });
    const out = await strat.retrieve(baseReq(), 5);
    assert.deepEqual(out, []);
});

test('retrieve embedder unavailable with BM25 → pure-BM25 fallback', async () => {
    const docs = [
        makeChunk('authentication middleware design'),
        makeChunk('database schema migration'),
    ];
    const idx = buildBM25Index(docs);
    const strat = createSemanticStrategy({
        embedQuery: embedFake(null),
        chunkVectorSearch: knnFake([]),
        getBM25Index: () => idx,
    });
    const out = await strat.retrieve(baseReq(), 5);
    assert.ok(out.length > 0);
    assert.equal(out[0].provenance.score_kind, 'bm25');
});

test('retrieve empty collection (k-NN returns []) → empty result, not error', async () => {
    const strat = createSemanticStrategy({
        embedQuery: embedFake([0.1]),
        chunkVectorSearch: knnFake([]),
    });
    const out = await strat.retrieve(baseReq(), 5);
    assert.deepEqual(out, []);
});

test('retrieve no collections in request → empty', async () => {
    const strat = createSemanticStrategy({
        embedQuery: embedFake([0.1]),
        chunkVectorSearch: knnFake([{ chunk: makeChunk('x'), similarity: 1 }]),
    });
    const out = await strat.retrieve(baseReq({ collections: [] }), 5);
    assert.deepEqual(out, []);
});

test('retrieve quota <= 0 → empty', async () => {
    const strat = createSemanticStrategy({
        embedQuery: embedFake([0.1]),
        chunkVectorSearch: knnFake([{ chunk: makeChunk('x'), similarity: 1 }]),
    });
    assert.deepEqual(await strat.retrieve(baseReq(), 0), []);
    assert.deepEqual(await strat.retrieve(baseReq(), -1), []);
});

/* ---------------- retrieve — metadata filter ---------------- */

test('retrieve applies content_types filter to cosine path', async () => {
    const proseChunk = makeChunk('prose content', { content_type: 'prose' });
    const codeChunk = makeChunk('code content', { content_type: 'code' });
    const strat = createSemanticStrategy({
        embedQuery: embedFake([0.1]),
        chunkVectorSearch: knnFake([
            { chunk: proseChunk, similarity: 0.9 },
            { chunk: codeChunk, similarity: 0.8 },
        ]),
    });
    const out = await strat.retrieve(
        baseReq({ filters: { content_types: ['code'] } }),
        5,
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].id, codeChunk.id);
});

test('retrieve applies custom-predicate filter to BM25 fallback path', async () => {
    const a = makeChunk('alpha alpha', { custom: { tier: 'A' } });
    const b = makeChunk('alpha alpha alpha', { custom: { tier: 'B' } });
    const idx = buildBM25Index([a, b]);
    const strat = createSemanticStrategy({
        embedQuery: embedFake(null),
        chunkVectorSearch: knnFake([]),
        getBM25Index: () => idx,
    });
    const out = await strat.retrieve(
        baseReq({ query: 'alpha', filters: { custom: { tier: 'A' } } }),
        5,
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].id, a.id);
});

test('retrieve does not mutate input chunks (provenance carry creates fresh refs)', async () => {
    const original = makeChunk('immutable doc');
    const beforeProv = { ...original.provenance };
    const strat = createSemanticStrategy({
        embedQuery: embedFake([0.1]),
        chunkVectorSearch: knnFake([{ chunk: original, similarity: 0.9 }]),
    });
    await strat.retrieve(baseReq(), 1);
    assert.deepEqual(original.provenance, beforeProv);
});
