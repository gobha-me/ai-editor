/**
 * Comparison harness tests (1.5.2).
 *
 * Covers `js/intelligence/retrieval/comparison.js` — the measurement
 * infrastructure for the §1.5.0 ≥80% legacy-vs-new agreement exit
 * criterion. Each test() block focused on a single invariant, mirroring
 * sibling test files (`test-retrieval-walker.mjs`, etc.). Pure-data, no
 * DOM / State / network — runs under `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createComparisonHarness,
    normalizeLegacyResult,
    normalizeComposerResult,
    jaccardSimilarity,
    precisionAtK,
    recallAtK,
    hitAtK,
    reciprocalRankAtK,
} from '../js/intelligence/retrieval/comparison.js';

/* ---------------- Fixture builders ---------------- */

/**
 * Build a legacy-shaped result: an array of `{ path, similarity, summary }`,
 * the shape `ContextManager.findRelevantFiles` returns.
 *
 * @param {string[]} paths
 * @returns {Array<{ path: string, similarity: number, summary: string }>}
 */
function legacyResult(paths) {
    return paths.map((p, i) => ({
        path: p,
        similarity: 1 - i * 0.1,
        summary: `summary of ${p}`,
    }));
}

/**
 * Build a Composer-shaped `RetrievalResult`. Each chunk has its
 * `metadata.source_uri` set so `normalizeComposerResult` can extract it.
 * One block per chunk so attention-order is observable.
 *
 * @param {string[]} sourceUris
 * @returns {{ blocks: any[], chunks_by_id: Object, used_tokens: number, diagnostics: Object }}
 */
function composerResult(sourceUris) {
    /** @type {Object<string, any>} */
    const chunks_by_id = {};
    /** @type {any[]} */
    const blocks = [];
    sourceUris.forEach((uri, i) => {
        const id = `chunk_${i}_${uri}`;
        chunks_by_id[id] = {
            id,
            content: `text of ${uri}`,
            metadata: { source_uri: uri, content_hash: `h${i}` },
            tokens: 100,
        };
        blocks.push({
            role: 'retrieved',
            content: `text of ${uri}`,
            chunks: [id],
            position: 'retrieved',
        });
    });
    return { blocks, chunks_by_id, used_tokens: 0, diagnostics: {} };
}

/**
 * Constant-clock factory: returns a `now()` that advances by `step` ms
 * on each call, starting at `start`. Used to make `durationMs` assertions
 * deterministic without real sleeps.
 */
function makeClock(start = 1000, step = 5) {
    let t = start - step;
    return () => {
        t += step;
        return t;
    };
}

/* ============================================================
 * Construction & validation (~7)
 * ============================================================ */

test('createComparisonHarness throws when options is missing or null', () => {
    assert.throws(() => createComparisonHarness(), /options must be an object/);
    assert.throws(() => createComparisonHarness(null), /options must be an object/);
});

test('createComparisonHarness throws when runLegacy is missing or non-callable', () => {
    assert.throws(
        () => createComparisonHarness({ runNew: async () => null }),
        /runLegacy must be a function/,
    );
    assert.throws(
        () => createComparisonHarness({ runLegacy: 42, runNew: async () => null }),
        /runLegacy must be a function/,
    );
});

test('createComparisonHarness throws when runNew is missing or non-callable', () => {
    assert.throws(
        () => createComparisonHarness({ runLegacy: async () => null }),
        /runNew must be a function/,
    );
    assert.throws(
        () => createComparisonHarness({ runLegacy: async () => null, runNew: 'no' }),
        /runNew must be a function/,
    );
});

test('createComparisonHarness throws when topK is invalid', () => {
    const base = { runLegacy: async () => null, runNew: async () => null };
    assert.throws(() => createComparisonHarness({ ...base, topK: 0 }), /topK must be a positive integer/);
    assert.throws(() => createComparisonHarness({ ...base, topK: -1 }), /topK must be a positive integer/);
    assert.throws(() => createComparisonHarness({ ...base, topK: 2.5 }), /topK must be a positive integer/);
    assert.throws(() => createComparisonHarness({ ...base, topK: '5' }), /topK must be a positive integer/);
});

test('createComparisonHarness throws when normalizers / metric / now are non-callable', () => {
    const base = { runLegacy: async () => null, runNew: async () => null };
    assert.throws(
        () => createComparisonHarness({ ...base, normalizeLegacy: 'bad' }),
        /normalizeLegacy must be a function/,
    );
    assert.throws(
        () => createComparisonHarness({ ...base, normalizeNew: 'bad' }),
        /normalizeNew must be a function/,
    );
    assert.throws(
        () => createComparisonHarness({ ...base, metric: 'bad' }),
        /metric must be a function/,
    );
    assert.throws(
        () => createComparisonHarness({ ...base, now: 'bad' }),
        /now must be a function/,
    );
});

test('createComparisonHarness returns a handle exposing compare, compareBatch, stats', () => {
    const h = createComparisonHarness({
        runLegacy: async () => [],
        runNew: async () => composerResult([]),
    });
    assert.equal(typeof h.compare, 'function');
    assert.equal(typeof h.compareBatch, 'function');
    assert.equal(typeof h.stats, 'function');
});

test('createComparisonHarness defaults to jaccardSimilarity when no metric supplied', async () => {
    const h = createComparisonHarness({
        runLegacy: async () => legacyResult(['a.js', 'b.js']),
        runNew: async () => composerResult(['a.js', 'c.js']),
    });
    const r = await h.compare('q');
    // |{a}| / |{a,b,c}| = 1/3
    assert.ok(Math.abs(r.agreement - 1 / 3) < 1e-9);
});

/* ============================================================
 * compare(query) — happy path & validation (~9)
 * ============================================================ */

test('compare returns ComparisonResult with paths + agreement on happy path', async () => {
    const h = createComparisonHarness({
        runLegacy: async () => legacyResult(['a.js', 'b.js', 'c.js']),
        runNew: async () => composerResult(['a.js', 'b.js', 'c.js']),
        now: makeClock(),
    });
    const r = await h.compare('hello');
    assert.equal(r.query, 'hello');
    assert.deepEqual(r.legacyPaths, ['a.js', 'b.js', 'c.js']);
    assert.deepEqual(r.newPaths, ['a.js', 'b.js', 'c.js']);
    assert.equal(r.legacyError, null);
    assert.equal(r.newError, null);
    assert.equal(r.agreement, 1);
    assert.ok(typeof r.durationMs === 'number' && r.durationMs >= 0);
});

test('compare throws when query is not a string', async () => {
    const h = createComparisonHarness({
        runLegacy: async () => [],
        runNew: async () => composerResult([]),
    });
    await assert.rejects(() => h.compare(42), /query must be a string/);
    await assert.rejects(() => h.compare(undefined), /query must be a string/);
});

test('compare per-query topK overrides the harness default', async () => {
    const h = createComparisonHarness({
        runLegacy: async () => legacyResult(['a', 'b', 'c', 'd', 'e', 'f']),
        runNew: async () => composerResult(['a', 'b', 'c', 'd', 'e', 'f']),
        topK: 5,
    });
    const r = await h.compare('q', { topK: 2 });
    assert.equal(r.legacyPaths.length, 2);
    assert.equal(r.newPaths.length, 2);
});

test('compare rejects invalid opts.topK', async () => {
    const h = createComparisonHarness({
        runLegacy: async () => [],
        runNew: async () => composerResult([]),
    });
    await assert.rejects(() => h.compare('q', { topK: 0 }), /topK must be a positive integer/);
    await assert.rejects(() => h.compare('q', { topK: -3 }), /topK must be a positive integer/);
});

test('compare normalizes raw legacy result via default normalizeLegacyResult', async () => {
    const h = createComparisonHarness({
        runLegacy: async () => legacyResult(['x/y.js', 'z.js']),
        runNew: async () => composerResult([]),
    });
    const r = await h.compare('q');
    assert.deepEqual(r.legacyPaths, ['x/y.js', 'z.js']);
});

test('compare normalizes raw new result via default normalizeComposerResult', async () => {
    const h = createComparisonHarness({
        runLegacy: async () => [],
        runNew: async () => composerResult(['p/q.js', 'r.js']),
    });
    const r = await h.compare('q');
    assert.deepEqual(r.newPaths, ['p/q.js', 'r.js']);
});

test('compare records legacyError and continues to runNew when runLegacy throws', async () => {
    const boom = new Error('legacy down');
    const h = createComparisonHarness({
        runLegacy: async () => { throw boom; },
        runNew: async () => composerResult(['a.js']),
    });
    const r = await h.compare('q');
    assert.equal(r.legacyPaths, null);
    assert.deepEqual(r.newPaths, ['a.js']);
    assert.equal(r.legacyError, boom);
    assert.equal(r.newError, null);
    assert.equal(r.agreement, null);
});

test('compare records newError and continues from already-completed runLegacy when runNew throws', async () => {
    const boom = new Error('new down');
    const h = createComparisonHarness({
        runLegacy: async () => legacyResult(['a.js']),
        runNew: async () => { throw boom; },
    });
    const r = await h.compare('q');
    assert.deepEqual(r.legacyPaths, ['a.js']);
    assert.equal(r.newPaths, null);
    assert.equal(r.legacyError, null);
    assert.equal(r.newError, boom);
    assert.equal(r.agreement, null);
});

test('compare records both errors when both runners throw', async () => {
    const e1 = new Error('A');
    const e2 = new Error('B');
    const h = createComparisonHarness({
        runLegacy: async () => { throw e1; },
        runNew: async () => { throw e2; },
    });
    const r = await h.compare('q');
    assert.equal(r.legacyError, e1);
    assert.equal(r.newError, e2);
    assert.equal(r.agreement, null);
});

test('compare durationMs computed via injected now()', async () => {
    let t = 0;
    const clock = () => {
        t += 7;
        return t;
    };
    const h = createComparisonHarness({
        runLegacy: async () => [],
        runNew: async () => composerResult([]),
        now: clock,
    });
    const r = await h.compare('q');
    // Two now() calls per compare (start + end); duration = step.
    assert.equal(r.durationMs, 7);
});

test('compare with custom metric uses it instead of jaccard', async () => {
    const h = createComparisonHarness({
        runLegacy: async () => legacyResult(['a.js']),
        runNew: async () => composerResult(['a.js']),
        metric: () => 0.42,
    });
    const r = await h.compare('q');
    assert.equal(r.agreement, 0.42);
});

test('compare clamps out-of-range metric outputs to [0, 1]', async () => {
    let next = 1.5;
    const h = createComparisonHarness({
        runLegacy: async () => legacyResult(['a.js']),
        runNew: async () => composerResult(['a.js']),
        metric: () => next,
    });
    const r1 = await h.compare('q');
    assert.equal(r1.agreement, 1);
    next = -0.3;
    const r2 = await h.compare('q');
    assert.equal(r2.agreement, 0);
    next = NaN;
    const r3 = await h.compare('q');
    assert.equal(r3.agreement, 0);
});

/* ============================================================
 * compareBatch — aggregation, progress, errors, streaming (~7)
 * ============================================================ */

test('compareBatch aggregates ComparisonResult[] in input order', async () => {
    const h = createComparisonHarness({
        runLegacy: async (q) => legacyResult([`leg_${q}.js`]),
        runNew: async (q) => composerResult([`leg_${q}.js`]),
    });
    const report = await h.compareBatch(['x', 'y', 'z']);
    assert.equal(report.total, 3);
    assert.deepEqual(report.perQuery.map((r) => r.query), ['x', 'y', 'z']);
});

test('compareBatch meanAgreement excludes null-agreement entries', async () => {
    let n = 0;
    const h = createComparisonHarness({
        runLegacy: async () => {
            n += 1;
            if (n === 2) throw new Error('flaky');
            return legacyResult(['a.js']);
        },
        runNew: async () => composerResult(['a.js']),
    });
    const report = await h.compareBatch(['q1', 'q2', 'q3']);
    // q1: agreement 1.0, q2: null (legacy threw), q3: 1.0 → mean = (1 + 1) / 2 = 1.
    assert.equal(report.meanAgreement, 1);
    assert.equal(report.legacyFailures, 1);
});

test('compareBatch meanAgreement is null when no successful pair exists', async () => {
    const h = createComparisonHarness({
        runLegacy: async () => { throw new Error('down'); },
        runNew: async () => composerResult([]),
    });
    const report = await h.compareBatch(['q1', 'q2']);
    assert.equal(report.meanAgreement, null);
    assert.equal(report.legacyFailures, 2);
});

test('compareBatch histogram buckets agreement values correctly', async () => {
    // Build deterministic agreement values by injecting a metric.
    const values = [0.1, 0.3, 0.5, 0.7, 0.9, 1.0, 0.0, 0.2, 0.4, 0.6, 0.8];
    let i = 0;
    const h = createComparisonHarness({
        runLegacy: async () => legacyResult(['a.js']),
        runNew: async () => composerResult(['a.js']),
        metric: () => values[i++],
    });
    const report = await h.compareBatch(values.map((_, idx) => `q${idx}`));
    // values landing in each bucket:
    //   0.0-0.2 (< 0.2): 0.1, 0.0     → 2
    //   0.2-0.4 (< 0.4): 0.3, 0.2     → 2
    //   0.4-0.6 (< 0.6): 0.5, 0.4     → 2
    //   0.6-0.8 (< 0.8): 0.7, 0.6     → 2
    //   0.8-1.0 (≤ 1.0): 0.9, 1.0, 0.8 → 3
    assert.deepEqual(report.histogram, {
        '0.0-0.2': 2,
        '0.2-0.4': 2,
        '0.4-0.6': 2,
        '0.6-0.8': 2,
        '0.8-1.0': 3,
    });
});

test('compareBatch onProgress fires in order; throw does not abort the batch', async () => {
    const h = createComparisonHarness({
        runLegacy: async () => legacyResult(['a.js']),
        runNew: async () => composerResult(['a.js']),
    });
    /** @type {Array<[number, number, string]>} */
    const calls = [];
    let throwOnce = true;
    const report = await h.compareBatch(['q1', 'q2', 'q3'], {
        onProgress: (done, total, latest) => {
            calls.push([done, total, latest.query]);
            if (throwOnce && done === 2) {
                throwOnce = false;
                throw new Error('progress went bad');
            }
        },
    });
    assert.equal(report.total, 3);
    assert.deepEqual(calls.map((c) => c[2]), ['q1', 'q2', 'q3']);
    assert.deepEqual(calls.map((c) => c[1]), [3, 3, 3]);
});

test('compareBatch handles empty input → total: 0, meanAgreement: null', async () => {
    const h = createComparisonHarness({
        runLegacy: async () => legacyResult(['a.js']),
        runNew: async () => composerResult(['a.js']),
    });
    const report = await h.compareBatch([]);
    assert.equal(report.total, 0);
    assert.equal(report.meanAgreement, null);
    assert.deepEqual(report.perQuery, []);
});

test('compareBatch accepts Set, generators, and AsyncIterable inputs', async () => {
    const h = createComparisonHarness({
        runLegacy: async (q) => legacyResult([`${q}.js`]),
        runNew: async (q) => composerResult([`${q}.js`]),
    });

    // Set
    const r1 = await h.compareBatch(new Set(['a', 'b', 'a']));
    assert.equal(r1.total, 2);

    // Generator
    function* gen() {
        yield 'x';
        yield 'y';
    }
    const r2 = await h.compareBatch(gen());
    assert.equal(r2.total, 2);

    // AsyncIterable
    async function* agen() {
        yield 'p';
        yield 'q';
        yield 'r';
    }
    const r3 = await h.compareBatch(agen());
    assert.equal(r3.total, 3);
});

test('compareBatch rejects non-iterable input + non-string elements', async () => {
    const h = createComparisonHarness({
        runLegacy: async () => [],
        runNew: async () => composerResult([]),
    });
    await assert.rejects(
        () => h.compareBatch(/** @type {any} */ (42)),
        /must be an Iterable or AsyncIterable/,
    );
    await assert.rejects(
        () => h.compareBatch(/** @type {any} */ (['ok', 7])),
        /items must be strings or \{ query/,
    );
});

/* ============================================================
 * stats() snapshot (~2)
 * ============================================================ */

test('stats() reflects total calls and per-side failures across compare + compareBatch', async () => {
    let n = 0;
    const h = createComparisonHarness({
        runLegacy: async () => {
            n += 1;
            if (n === 2) throw new Error('legacy');
            return legacyResult(['a.js']);
        },
        runNew: async () => composerResult(['a.js']),
    });
    await h.compare('a');
    await h.compare('b'); // legacy throws on this one
    await h.compareBatch(['c', 'd']);
    const s = h.stats();
    assert.equal(s.calls, 4);
    assert.equal(s.runLegacyFailures, 1);
    assert.equal(s.runNewFailures, 0);
    assert.equal(s.batches, 1);
});

test('stats() returns a fresh snapshot each call (mutation does not leak)', async () => {
    const h = createComparisonHarness({
        runLegacy: async () => [],
        runNew: async () => composerResult([]),
    });
    await h.compare('x');
    const s1 = h.stats();
    s1.calls = 999;
    const s2 = h.stats();
    assert.equal(s2.calls, 1);
});

/* ============================================================
 * Default normalizers (~8)
 * ============================================================ */

test('normalizeLegacyResult: empty / non-array / null → []', () => {
    assert.deepEqual(normalizeLegacyResult([], { topK: 5 }), []);
    assert.deepEqual(normalizeLegacyResult(null, { topK: 5 }), []);
    assert.deepEqual(normalizeLegacyResult(undefined, { topK: 5 }), []);
    assert.deepEqual(normalizeLegacyResult(42, { topK: 5 }), []);
});

test('normalizeLegacyResult: dedup of duplicate paths preserves order', () => {
    const raw = legacyResult(['a.js', 'b.js', 'a.js', 'c.js', 'b.js']);
    assert.deepEqual(normalizeLegacyResult(raw, { topK: 5 }), ['a.js', 'b.js', 'c.js']);
});

test('normalizeLegacyResult: topK cap', () => {
    const raw = legacyResult(['a', 'b', 'c', 'd', 'e', 'f']);
    assert.deepEqual(normalizeLegacyResult(raw, { topK: 3 }), ['a', 'b', 'c']);
});

test('normalizeLegacyResult: skips malformed entries (missing/non-string path)', () => {
    /** @type {any[]} */
    const raw = [
        { path: 'a.js', similarity: 1 },
        null,
        { similarity: 0.5 },               // missing path
        { path: 42 },                       // non-string path
        { path: '', similarity: 0.1 },      // empty path
        'not an object',
        { path: 'b.js' },
    ];
    assert.deepEqual(normalizeLegacyResult(raw, { topK: 5 }), ['a.js', 'b.js']);
});

test('normalizeLegacyResult: accepts { files: [...] } envelope (LLM tool wrap)', () => {
    const raw = { files: legacyResult(['a.js', 'b.js']) };
    assert.deepEqual(normalizeLegacyResult(raw, { topK: 5 }), ['a.js', 'b.js']);
});

test('normalizeComposerResult: extracts unique source URIs in attention order', () => {
    const raw = composerResult(['a.js', 'b.js', 'a.js', 'c.js']);
    assert.deepEqual(normalizeComposerResult(raw, { topK: 5 }), ['a.js', 'b.js', 'c.js']);
});

test('normalizeComposerResult: missing chunks_by_id / blocks → []', () => {
    assert.deepEqual(normalizeComposerResult(null, { topK: 5 }), []);
    assert.deepEqual(normalizeComposerResult({}, { topK: 5 }), []);
    assert.deepEqual(normalizeComposerResult({ blocks: [] }, { topK: 5 }), []);
    assert.deepEqual(
        normalizeComposerResult({ blocks: [{ chunks: ['x'] }], chunks_by_id: {} }, { topK: 5 }),
        [],
    );
});

test('normalizeComposerResult: skips chunks lacking metadata.source_uri; topK cap honored', () => {
    /** @type {any} */
    const raw = {
        blocks: [
            { role: 'retrieved', content: '', chunks: ['c1', 'c2', 'c3', 'c4'], position: 'retrieved' },
        ],
        chunks_by_id: {
            c1: { id: 'c1', metadata: { source_uri: 'a.js' } },
            c2: { id: 'c2' },                              // no metadata
            c3: { id: 'c3', metadata: { source_uri: '' } }, // empty
            c4: { id: 'c4', metadata: { source_uri: 'b.js' } },
        },
    };
    assert.deepEqual(normalizeComposerResult(raw, { topK: 1 }), ['a.js']);
    assert.deepEqual(normalizeComposerResult(raw, { topK: 5 }), ['a.js', 'b.js']);
});

/* ============================================================
 * T2 — source-uri rollup at the normalizer (1.5.5)
 *
 * Scoring-aware fixtures pin the new contract: aggregate per
 * source_uri (max provenance.score) before truncating to topK so a
 * code file with one strong chunk beats a docs file with many medium
 * chunks. Score-less fixtures (the back-compat lock above) tie at 0
 * and fall back to first-position order — covered by case #4 below.
 * ============================================================ */

/**
 * Build a single-block composer result with explicit per-chunk scores.
 * `entries` is `[{ uri, score }, ...]`; chunk ids are positional and
 * unique. Mirrors the shape `composerResult([...])` produces but lets
 * a test author pin `provenance.score` per chunk.
 *
 * @param {Array<{ uri: string, score: number }>} entries
 */
function composerResultWithScores(entries) {
    /** @type {Object<string, any>} */
    const chunks_by_id = {};
    /** @type {string[]} */
    const ids = [];
    entries.forEach(({ uri, score }, i) => {
        const id = `chunk_${i}`;
        chunks_by_id[id] = {
            id,
            content: `text of ${uri} #${i}`,
            metadata: { source_uri: uri, content_hash: `h${i}` },
            tokens: 100,
            provenance: {
                source_uri: uri,
                byte_range: null,
                line_range: null,
                retrieved_by: 'semantic',
                score,
                score_kind: 'cosine',
            },
        };
        ids.push(id);
    });
    return {
        blocks: [{ role: 'retrieved', content: '', chunks: ids, position: 'retrieved' }],
        chunks_by_id,
        used_tokens: 0,
        diagnostics: {},
    };
}

test('normalizeComposerResult: ranks by max provenance.score across a source\'s chunks (T2 rollup)', () => {
    // a.js: chunks scoring [0.5, 0.85, 0.6] → max 0.85
    // b.js: chunks scoring [0.7]            → max 0.70
    // c.js: chunks scoring [0.4, 0.4]       → max 0.40
    const raw = composerResultWithScores([
        { uri: 'a.js', score: 0.5 },
        { uri: 'b.js', score: 0.7 },
        { uri: 'a.js', score: 0.85 },
        { uri: 'c.js', score: 0.4 },
        { uri: 'a.js', score: 0.6 },
        { uri: 'c.js', score: 0.4 },
    ]);
    assert.deepEqual(normalizeComposerResult(raw, { topK: 3 }), ['a.js', 'b.js', 'c.js']);
});

test('normalizeComposerResult: a single high-scoring chunk beats many medium-scoring chunks for the same file (T2 docs-vs-code regression)', () => {
    // The 1.5.4-patch divergence pattern: 20 prose chunks @ 0.7 each
    // crowded a single code chunk @ 0.85 out of the top-K because the
    // prose file's first chunk was added before the code chunk was
    // visited. T2 rolls up per source_uri before truncating, so
    // code.js's max-score 0.85 wins despite docs.md appearing first.
    const docsChunks = Array.from({ length: 20 }, () => ({ uri: 'docs.md', score: 0.7 }));
    const raw = composerResultWithScores([
        ...docsChunks.slice(0, 10),
        { uri: 'code.js', score: 0.85 },
        ...docsChunks.slice(10),
    ]);
    assert.deepEqual(normalizeComposerResult(raw, { topK: 1 }), ['code.js']);
    // topK=2 still keeps both; docs.md isn't excluded, just outranked.
    assert.deepEqual(normalizeComposerResult(raw, { topK: 2 }), ['code.js', 'docs.md']);
});

test('normalizeComposerResult: ties on score break by first-encounter position (back-compat)', () => {
    // Three files, all with identical max score. Order in output
    // matches the order their first chunk was visited.
    const raw = composerResultWithScores([
        { uri: 'b.js', score: 0.5 },
        { uri: 'a.js', score: 0.5 },
        { uri: 'c.js', score: 0.5 },
        // Later duplicate of a.js with same score must not promote it
        // ahead of b.js (b.js was visited first).
        { uri: 'a.js', score: 0.5 },
    ]);
    assert.deepEqual(normalizeComposerResult(raw, { topK: 3 }), ['b.js', 'a.js', 'c.js']);
});

test('normalizeComposerResult: missing / non-finite provenance.score treated as 0; existing score-less fixtures unchanged (back-compat)', () => {
    // composerResult() (the existing fixture helper) emits chunks with
    // no `provenance` field at all — they should all tie at maxScore=0
    // and fall back to first-position order, matching the pre-T2
    // attachment-order dedup output exactly.
    const raw = composerResult(['a.js', 'b.js', 'a.js', 'c.js']);
    assert.deepEqual(normalizeComposerResult(raw, { topK: 5 }), ['a.js', 'b.js', 'c.js']);

    // NaN / Infinity / non-number scores all coerce to 0 and tie.
    const weird = {
        blocks: [{ role: 'retrieved', content: '', chunks: ['c1', 'c2', 'c3', 'c4'], position: 'retrieved' }],
        chunks_by_id: {
            c1: { id: 'c1', metadata: { source_uri: 'a.js' }, provenance: { score: NaN } },
            c2: { id: 'c2', metadata: { source_uri: 'b.js' }, provenance: { score: Infinity } },
            c3: { id: 'c3', metadata: { source_uri: 'c.js' }, provenance: { score: 'high' } },
            c4: { id: 'c4', metadata: { source_uri: 'd.js' } /* no provenance */ },
        },
    };
    assert.deepEqual(normalizeComposerResult(weird, { topK: 5 }), ['a.js', 'b.js', 'c.js', 'd.js']);
});

/* ============================================================
 * Default metrics (~5)
 * ============================================================ */

test('jaccardSimilarity: identical → 1, disjoint → 0', () => {
    assert.equal(jaccardSimilarity(['a', 'b'], ['a', 'b']), 1);
    assert.equal(jaccardSimilarity(['a', 'b'], ['c', 'd']), 0);
});

test('jaccardSimilarity: partial overlap exact value', () => {
    // |{a}| / |{a, b, c}| = 1/3
    assert.ok(Math.abs(jaccardSimilarity(['a', 'b'], ['a', 'c']) - 1 / 3) < 1e-9);
    // |{a, b}| / |{a, b, c, d}| = 2/4 = 0.5
    assert.equal(jaccardSimilarity(['a', 'b'], ['a', 'b', 'c', 'd']), 0.5);
});

test('jaccardSimilarity: both empty → 1, one empty → 0', () => {
    assert.equal(jaccardSimilarity([], []), 1);
    assert.equal(jaccardSimilarity(['a'], []), 0);
    assert.equal(jaccardSimilarity([], ['a']), 0);
});

test('jaccardSimilarity: duplicates within an input are coerced to set, do not skew', () => {
    assert.equal(jaccardSimilarity(['a', 'a', 'a'], ['a']), 1);
    assert.equal(jaccardSimilarity(['a', 'b', 'b'], ['a', 'b']), 1);
});

test('precisionAtK: full overlap → 1, no overlap → 0', () => {
    assert.equal(precisionAtK(['a', 'b', 'c'], ['a', 'b', 'c'], 3), 1);
    assert.equal(precisionAtK(['a', 'b', 'c'], ['x', 'y', 'z'], 3), 0);
});

test('precisionAtK: divides by k not by predicted length; k <= 0 → 0', () => {
    // 1 hit out of k=5 → 0.2 even though predicted is shorter than k.
    assert.equal(precisionAtK(['a'], ['a', 'b'], 5), 0.2);
    assert.equal(precisionAtK(['a', 'b'], ['a', 'b'], 0), 0);
    assert.equal(precisionAtK(['a', 'b'], ['a', 'b'], -2), 0);
});

test('precisionAtK: only first k of predicted are considered (after dedup)', () => {
    // predicted dedup'd: [a, b, c, d]; first 2 considered: {a, b}; ref = {a, b}; hits = 2; / k = 2 = 1
    assert.equal(precisionAtK(['a', 'a', 'b', 'c', 'd'], ['a', 'b'], 2), 1);
    // first 3 considered: {a, b, c}; ref = {a, b}; hits = 2; / k = 3 ≈ 0.667
    const expected = 2 / 3;
    assert.ok(Math.abs(precisionAtK(['a', 'b', 'c', 'd'], ['a', 'b'], 3) - expected) < 1e-9);
});

/* ============================================================
 * 1.5.5 reframe — recall@k, hit@k, MRR (ground-truth metrics)
 * ============================================================ */

test('recallAtK: divides by reference size, not k; ceiling 1.0 when all relevant landed in top-k', () => {
    // ref = {a, b, c}; top-5 contains all three → hits/|ref| = 3/3 = 1.0
    assert.equal(recallAtK(['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c'], 5), 1);
    // ref = {a, b, c}; top-2 contains 2 → 2/3
    assert.ok(Math.abs(recallAtK(['a', 'b', 'd', 'e'], ['a', 'b', 'c'], 2) - 2 / 3) < 1e-9);
});

test('recallAtK: small reference set reaches 1.0 where precisionAtK is pegged low', () => {
    // ref = {a}; top-5 = [a, x, y, z, w] → recall 1.0; precision 0.2
    assert.equal(recallAtK(['a', 'x', 'y', 'z', 'w'], ['a'], 5), 1);
    assert.equal(precisionAtK(['a', 'x', 'y', 'z', 'w'], ['a'], 5), 0.2);
});

test('recallAtK: empty reference → 0 (no relevant set to recall against)', () => {
    assert.equal(recallAtK(['a', 'b'], [], 5), 0);
});

test('recallAtK: bad inputs → 0', () => {
    assert.equal(recallAtK(['a'], ['a'], 0), 0);
    assert.equal(recallAtK(['a'], ['a'], -1), 0);
    assert.equal(recallAtK(/** @type {any} */ (null), ['a'], 5), 0);
});

test('hitAtK: 1 if any expected in top-k else 0', () => {
    assert.equal(hitAtK(['a', 'b', 'c'], ['c'], 5), 1);
    assert.equal(hitAtK(['a', 'b', 'c'], ['z'], 5), 0);
    // hit just outside top-k → 0
    assert.equal(hitAtK(['a', 'b', 'c', 'd', 'e', 'TARGET'], ['TARGET'], 5), 0);
    // empty / bad inputs
    assert.equal(hitAtK(['a'], [], 5), 0);
    assert.equal(hitAtK(['a'], ['a'], 0), 0);
});

test('reciprocalRankAtK: 1/rank of first hit, 0 if no hit in top-k', () => {
    assert.equal(reciprocalRankAtK(['a', 'b', 'c'], ['a'], 5), 1);     // rank 1
    assert.equal(reciprocalRankAtK(['a', 'b', 'c'], ['b'], 5), 0.5);   // rank 2
    assert.equal(reciprocalRankAtK(['a', 'b', 'c', 'd', 'e'], ['e'], 5), 0.2); // rank 5
    assert.equal(reciprocalRankAtK(['a', 'b', 'c', 'd', 'e', 'TARGET'], ['TARGET'], 5), 0); // outside top-k
    assert.equal(reciprocalRankAtK(['a', 'b'], [], 5), 0);
});

test('reciprocalRankAtK: dedup applied to predicted before counting rank', () => {
    // Duplicate 'a' at the front shouldn't shift 'b' beyond rank 2.
    assert.equal(reciprocalRankAtK(['a', 'a', 'b'], ['b'], 5), 0.5);
});

/* ============================================================
 * 1.5.5 reframe — compare() + compareBatch() with ground truth
 * ============================================================ */

test('compare: opts.expectedPaths populates legacyGroundTruth + newGroundTruth on the result', async () => {
    const h = createComparisonHarness({
        runLegacy: async () => legacyResult(['noise.md', 'unrelated.css']),
        runNew: async () => composerResult(['js/chat/messages.js', 'js/chat/index.js']),
    });
    const r = await h.compare('where is the chat history rendered?', {
        expectedPaths: ['js/chat/messages.js', 'js/chat/index.js', 'js/chat/state.js'],
        category: 'file-discovery',
    });
    assert.deepEqual(r.expectedPaths, ['js/chat/messages.js', 'js/chat/index.js', 'js/chat/state.js']);
    assert.equal(r.category, 'file-discovery');
    assert.ok(r.legacyGroundTruth, 'legacyGroundTruth populated');
    assert.ok(r.newGroundTruth, 'newGroundTruth populated');
    // Legacy paths {noise.md, unrelated.css} ∩ expected {messages, index, state} = ∅
    assert.equal(r.legacyGroundTruth.recallAt5, 0);
    assert.equal(r.legacyGroundTruth.hitAt5, 0);
    // New paths {messages.js, index.js} ∩ expected = {messages.js, index.js} → 2/3 recall
    assert.ok(Math.abs(r.newGroundTruth.recallAt5 - 2 / 3) < 1e-9);
    assert.equal(r.newGroundTruth.hitAt5, 1);
    assert.equal(r.newGroundTruth.mrr, 1); // first prediction is a hit
});

test('compare: omitting expectedPaths leaves ground-truth fields null (back-compat)', async () => {
    const h = createComparisonHarness({
        runLegacy: async () => legacyResult(['a.js']),
        runNew: async () => composerResult(['a.js']),
    });
    const r = await h.compare('q');
    assert.equal(r.expectedPaths, null);
    assert.equal(r.category, null);
    assert.equal(r.legacyGroundTruth, null);
    assert.equal(r.newGroundTruth, null);
    // Agreement still computed.
    assert.equal(r.agreement, 1);
});

test('compare: expectedPaths still populates ground-truth when one side errors (other side scores; errored side null)', async () => {
    const h = createComparisonHarness({
        runLegacy: async () => { throw new Error('legacy down'); },
        runNew: async () => composerResult(['a.js']),
    });
    const r = await h.compare('q', { expectedPaths: ['a.js'] });
    assert.ok(r.legacyError, 'legacy errored');
    assert.equal(r.legacyGroundTruth, null);
    assert.ok(r.newGroundTruth);
    assert.equal(r.newGroundTruth.hitAt5, 1);
});

test('compareBatch: accepts fixture-shaped objects + aggregates ground-truth metrics', async () => {
    const fixtures = [
        { query: 'q1', expectedPaths: ['a.js'], category: 'cat-A' },
        { query: 'q2', expectedPaths: ['b.js', 'c.js'], category: 'cat-A' },
        { query: 'q3', expectedPaths: ['d.js'], category: 'cat-B' },
    ];
    const responses = {
        q1: ['a.js'],            // hit @ rank 1
        q2: ['b.js', 'x.js'],    // hit b (rank 1), miss c → recall 0.5
        q3: ['x.js', 'y.js'],    // no hit
    };
    const h = createComparisonHarness({
        runLegacy: async (q) => legacyResult(responses[q] || []),
        runNew: async (q) => composerResult(responses[q] || []),
    });
    const report = await h.compareBatch(fixtures);
    assert.equal(report.total, 3);
    // newGroundTruth: recall = (1 + 0.5 + 0) / 3 = 0.5
    assert.ok(report.newGroundTruth);
    assert.ok(Math.abs(report.newGroundTruth.meanRecallAt5 - 0.5) < 1e-9);
    // hit@5 mean: (1 + 1 + 0) / 3 ≈ 0.667
    assert.ok(Math.abs(report.newGroundTruth.meanHitAt5 - 2 / 3) < 1e-9);
    // MRR mean: (1 + 1 + 0) / 3 ≈ 0.667
    assert.ok(Math.abs(report.newGroundTruth.meanMRR - 2 / 3) < 1e-9);
    assert.equal(report.newGroundTruth.sampleCount, 3);
    // Per-category roll-up: cat-A = 2 fixtures, cat-B = 1.
    assert.ok(report.newByCategory['cat-A']);
    assert.equal(report.newByCategory['cat-A'].sampleCount, 2);
    // cat-A recall mean = (1 + 0.5) / 2 = 0.75
    assert.ok(Math.abs(report.newByCategory['cat-A'].meanRecallAt5 - 0.75) < 1e-9);
    assert.ok(report.newByCategory['cat-B']);
    assert.equal(report.newByCategory['cat-B'].sampleCount, 1);
    assert.equal(report.newByCategory['cat-B'].meanRecallAt5, 0);
});

test('compareBatch: pure-string input still works (back-compat); ground-truth aggregates are null/empty', async () => {
    const h = createComparisonHarness({
        runLegacy: async () => legacyResult(['a.js']),
        runNew: async () => composerResult(['a.js']),
    });
    const report = await h.compareBatch(['q1', 'q2']);
    assert.equal(report.total, 2);
    assert.equal(report.legacyGroundTruth, null);
    assert.equal(report.newGroundTruth, null);
    assert.deepEqual(report.legacyByCategory, {});
    assert.deepEqual(report.newByCategory, {});
    // Agreement still aggregated.
    assert.equal(report.meanAgreement, 1);
});

test('compareBatch: mixed string + fixture items both work in one batch', async () => {
    const items = [
        'plain-string-q',
        { query: 'fixture-q', expectedPaths: ['a.js'] },
    ];
    const h = createComparisonHarness({
        runLegacy: async () => legacyResult(['a.js']),
        runNew: async () => composerResult(['a.js']),
    });
    const report = await h.compareBatch(items);
    assert.equal(report.total, 2);
    // Only the fixture-q contributed to ground-truth aggregates.
    assert.ok(report.newGroundTruth);
    assert.equal(report.newGroundTruth.sampleCount, 1);
    assert.equal(report.newGroundTruth.meanRecallAt5, 1);
});

test('compareBatch: rejects fixture object with missing/non-string query', async () => {
    const h = createComparisonHarness({
        runLegacy: async () => [],
        runNew: async () => composerResult([]),
    });
    await assert.rejects(
        () => h.compareBatch([{ expectedPaths: ['a.js'] }]),
        /fixture object must have a string `query`/,
    );
});

test('compareBatch: rejects fixture object with non-array expectedPaths', async () => {
    const h = createComparisonHarness({
        runLegacy: async () => [],
        runNew: async () => composerResult([]),
    });
    await assert.rejects(
        () => h.compareBatch([{ query: 'q', expectedPaths: 'not-an-array' }]),
        /fixture `expectedPaths` must be an array or null/,
    );
});
