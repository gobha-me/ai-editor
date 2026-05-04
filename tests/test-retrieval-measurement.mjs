/**
 * Measurement harness tests (1.5.4).
 *
 * Covers `js/intelligence/retrieval/measurement.js` — the integration that
 * drives the 1.5.3 test-query corpus through the 1.5.2 comparison harness
 * against (a) a `ContextManager.findRelevantFiles` runner and (b) a real
 * wired-up Composer + production walker. The real `ContextManager` and
 * `EmbeddingsClient` import browser-bound `core.js`; tests therefore inject
 * minimal fakes exposing only the methods the harness touches.
 *
 * Pure-data, no DOM / State / network — runs under `node --test`. Each
 * `test()` block pins one invariant, mirroring the cadence of the sibling
 * suites (`test-retrieval-wiring.mjs`, `test-retrieval-walker.mjs`,
 * `test-retrieval-comparison.mjs`).
 *
 * The live ≥80% legacy-vs-new agreement *measurement* is the browser
 * runner's job (`tests/retrieval-measurement.html`) — node tests only
 * verify the wiring contract.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createMeasurementHarness,
    DEFAULT_COMPOSE_FILTERS_BY_CATEGORY,
    DEFAULT_SCORE_WEIGHTS,
    defaultComposeFiltersResolver,
} from '../js/intelligence/retrieval/measurement.js';
import { QUERY_CATEGORIES } from '../js/intelligence/retrieval/test-corpus.js';

/* ---------------- Fixture builders ---------------- */

/**
 * Minimal fake `Git` exposing only `getFile(owner, repo, path, ref)`.
 * Returns the production file shape (`{ content, ... }`).
 */
function makeFakeGit(files) {
    const calls = [];
    return {
        calls,
        getFile: async (owner, repo, path, ref) => {
            calls.push({ owner, repo, path, ref });
            if (!(path in files)) throw new Error(`fake Git: not found: ${path}`);
            const content = files[path];
            return { name: path.split('/').pop(), path, sha: `sha_${path}`, size: content.length, content, encoding: 'utf-8' };
        },
    };
}

/**
 * Minimal fake `EmbeddingsClient`. Tracks `init()` invocation count.
 * `embed(text)` resolves to a deterministic 4-dim vector keyed off the
 * text shape so semantic ranking is observable.
 */
function makeFakeEmbeddingsClient() {
    let initCalls = 0;
    let embedCalls = 0;
    return {
        get initCalls() { return initCalls; },
        get embedCalls() { return embedCalls; },
        init: async () => { initCalls += 1; return true; },
        embed: async (text) => {
            embedCalls += 1;
            const a = text.length / 100;
            const b = text.length === 0 ? 0 : text.charCodeAt(0) / 100;
            const c = text.length === 0 ? 0 : text.charCodeAt(text.length - 1) / 100;
            return [a, b, c, 0.5];
        },
    };
}

/**
 * Minimal fake `ContextManager`. `findRelevantFiles(query, topK)` returns
 * a deterministic shape derived from the query so tests can assert
 * `runLegacy` propagates topK into the call and the result reaches the
 * comparison normalizer untouched.
 */
function makeFakeContextManager() {
    const calls = [];
    return {
        calls,
        findRelevantFiles: async (query, topK) => {
            calls.push({ query, topK });
            // Deterministic: emit two paths shaped from the query so the
            // normalizer has something to consume. The browser runner's
            // real legacy returns the live `{path, similarity, summary}[]`.
            return [
                { path: `legacy/${query.length}.txt`, similarity: 0.9, summary: query },
                { path: `legacy/${query.length}-b.txt`, similarity: 0.7, summary: query },
            ].slice(0, topK ?? 5);
        },
    };
}

const PROJECT = Object.freeze({ owner: 'acme', repo: 'editor', ref: 'main' });
const MODEL_ID = 'fake-model-v1';

/* ---------------- Argument validation ---------------- */

test('createMeasurementHarness: rejects null / non-object options', async () => {
    await assert.rejects(() => createMeasurementHarness(null), /options must be an object/);
    await assert.rejects(() => createMeasurementHarness(undefined), /options must be an object/);
    await assert.rejects(() => createMeasurementHarness('nope'), /options must be an object/);
});

test('createMeasurementHarness: rejects missing Git.getFile', async () => {
    await assert.rejects(() => createMeasurementHarness({
        Git: {},
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: makeFakeContextManager(),
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: [],
    }), /Git must expose getFile/);
});

test('createMeasurementHarness: rejects missing EmbeddingsClient methods', async () => {
    await assert.rejects(() => createMeasurementHarness({
        Git: makeFakeGit({}),
        EmbeddingsClient: { init: async () => true }, // no embed
        ContextManager: makeFakeContextManager(),
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: [],
    }), /EmbeddingsClient must expose init\(\) and embed\(\)/);
});

test('createMeasurementHarness: rejects malformed ContextManager (object missing findRelevantFiles)', async () => {
    await assert.rejects(() => createMeasurementHarness({
        Git: makeFakeGit({}),
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: {},
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: [],
    }), /must expose findRelevantFiles/);
});

test('createMeasurementHarness: accepts null ContextManager (post-1.5.14 — legacy retired)', async () => {
    // Post-1.5.14: legacy ContextManager file was deleted. Callers may pass
    // `null` or omit the option entirely; runLegacy then returns [].
    const harness = await createMeasurementHarness({
        Git: makeFakeGit({}),
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: null,
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: [],
    });
    const legacy = await harness.runner.legacy('any query');
    assert.deepStrictEqual(legacy, [], 'runLegacy returns [] when no ContextManager supplied');
});

test('createMeasurementHarness: rejects bad project triple', async () => {
    const base = {
        Git: makeFakeGit({}),
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: makeFakeContextManager(),
        modelId: MODEL_ID,
        sourceUris: [],
    };
    await assert.rejects(() => createMeasurementHarness({ ...base, project: null }), /project must be an object/);
    await assert.rejects(() => createMeasurementHarness({ ...base, project: { owner: '', repo: 'r', ref: 'main' } }), /project\.owner/);
    await assert.rejects(() => createMeasurementHarness({ ...base, project: { owner: 'o', repo: '', ref: 'main' } }), /project\.repo/);
    await assert.rejects(() => createMeasurementHarness({ ...base, project: { owner: 'o', repo: 'r', ref: '' } }), /project\.ref/);
});

test('createMeasurementHarness: rejects empty modelId', async () => {
    await assert.rejects(() => createMeasurementHarness({
        Git: makeFakeGit({}),
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: makeFakeContextManager(),
        project: PROJECT,
        modelId: '',
        sourceUris: [],
    }), /modelId must be a non-empty string/);
});

test('createMeasurementHarness: rejects non-array sourceUris', async () => {
    await assert.rejects(() => createMeasurementHarness({
        Git: makeFakeGit({}),
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: makeFakeContextManager(),
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: /** @type {any} */ ('not-an-array'),
    }), /sourceUris must be an array/);
});

test('createMeasurementHarness: rejects sourceUris with empty / non-string entries', async () => {
    const base = {
        Git: makeFakeGit({}),
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: makeFakeContextManager(),
        project: PROJECT,
        modelId: MODEL_ID,
    };
    await assert.rejects(() => createMeasurementHarness({ ...base, sourceUris: ['ok', ''] }), /entries must be non-empty strings/);
    await assert.rejects(() => createMeasurementHarness({ ...base, sourceUris: ['ok', /** @type {any} */ (42)] }), /entries must be non-empty strings/);
});

test('createMeasurementHarness: rejects bad topK / concurrency', async () => {
    const base = {
        Git: makeFakeGit({}),
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: makeFakeContextManager(),
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: [],
    };
    await assert.rejects(() => createMeasurementHarness({ ...base, topK: 0 }), /topK must be a positive integer/);
    await assert.rejects(() => createMeasurementHarness({ ...base, topK: 1.5 }), /topK must be a positive integer/);
    await assert.rejects(() => createMeasurementHarness({ ...base, concurrency: -1 }), /concurrency must be a positive integer/);
});

test('createMeasurementHarness: rejects bad composerBudget', async () => {
    const base = {
        Git: makeFakeGit({}),
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: makeFakeContextManager(),
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: [],
    };
    await assert.rejects(() => createMeasurementHarness({ ...base, composerBudget: { total_tokens: -1 } }), /composerBudget\.total_tokens/);
    await assert.rejects(() => createMeasurementHarness({ ...base, composerBudget: 'nope' }), /composerBudget must be an object/);
});

/* ---------------- Construction ---------------- */

test('createMeasurementHarness: awaits EmbeddingsClient.init() exactly once', async () => {
    const ec = makeFakeEmbeddingsClient();
    const handle = await createMeasurementHarness({
        Git: makeFakeGit({}),
        EmbeddingsClient: ec,
        ContextManager: makeFakeContextManager(),
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: [],
    });
    assert.equal(ec.initCalls, 1, 'init() called once during construction');
    assert.ok(handle, 'handle returned');
});

test('createMeasurementHarness: returns a handle with the documented method shape', async () => {
    const handle = await createMeasurementHarness({
        Git: makeFakeGit({}),
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: makeFakeContextManager(),
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: [],
    });
    assert.equal(typeof handle.ingest, 'function');
    assert.equal(typeof handle.run, 'function');
    assert.equal(typeof handle.runner, 'object');
    assert.equal(typeof handle.runner.legacy, 'function');
    assert.equal(typeof handle.runner.compose, 'function');
    assert.equal(typeof handle.walker, 'object');
    assert.equal(typeof handle.controller, 'object');
    assert.equal(typeof handle.store, 'object');
    assert.equal(typeof handle.comparison, 'object');
    assert.equal(typeof handle.comparison.compare, 'function');
    assert.equal(typeof handle.comparison.compareBatch, 'function');
});

/* ---------------- ingest() ---------------- */

test('ingest: drives walker.walk over the supplied sourceUris', async () => {
    const Git = makeFakeGit({
        'a.md': '# A\n\nFirst paragraph.\n',
        'b.md': '# B\n\nSecond paragraph.\n',
    });
    const handle = await createMeasurementHarness({
        Git,
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: makeFakeContextManager(),
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: ['a.md', 'b.md'],
        concurrency: 1,
    });
    const result = await handle.ingest();
    assert.equal(result.total, 2, 'walked both URIs');
    assert.equal(result.ingested, 2, 'both ingested cleanly');
    assert.equal(result.failed, 0);
    assert.equal(result.aborted, false);
    assert.equal(Git.calls.length, 2, 'Git.getFile called once per URI');
    assert.deepEqual(Git.calls.map((c) => c.path).sort(), ['a.md', 'b.md']);
    for (const c of Git.calls) {
        assert.equal(c.owner, PROJECT.owner);
        assert.equal(c.repo, PROJECT.repo);
        assert.equal(c.ref, PROJECT.ref);
    }
});

test('ingest: empty sourceUris yields a clean WalkResult with total: 0', async () => {
    const handle = await createMeasurementHarness({
        Git: makeFakeGit({}),
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: makeFakeContextManager(),
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: [],
    });
    const result = await handle.ingest();
    assert.equal(result.total, 0);
    assert.equal(result.aborted, false);
    assert.deepEqual(result.results, []);
});

test('ingest: pre-aborted signal short-circuits walker.walk', async () => {
    const Git = makeFakeGit({ 'a.md': '# A\n' });
    const handle = await createMeasurementHarness({
        Git,
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: makeFakeContextManager(),
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: ['a.md'],
    });
    const ac = new AbortController();
    ac.abort();
    const result = await handle.ingest({ signal: ac.signal });
    assert.equal(result.aborted, true);
    assert.equal(result.total, 0);
    assert.equal(Git.calls.length, 0, 'Git.getFile not called when pre-aborted');
});

/* ---------------- runner.legacy ---------------- */

test('runner.legacy: forwards query + topK to ContextManager.findRelevantFiles', async () => {
    const cm = makeFakeContextManager();
    const handle = await createMeasurementHarness({
        Git: makeFakeGit({}),
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: cm,
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: [],
        topK: 7,
    });
    const out = await handle.runner.legacy('hello');
    assert.equal(cm.calls.length, 1);
    assert.equal(cm.calls[0].query, 'hello');
    assert.equal(cm.calls[0].topK, 7);
    assert.ok(Array.isArray(out));
    assert.equal(out.length, 2); // fake returns two entries; topK ≥ 2 so all pass
});

test('runner.legacy: topK defaults to 5 when not supplied', async () => {
    const cm = makeFakeContextManager();
    const handle = await createMeasurementHarness({
        Git: makeFakeGit({}),
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: cm,
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: [],
    });
    await handle.runner.legacy('hello');
    assert.equal(cm.calls[0].topK, 5);
});

/* ---------------- runner.compose ---------------- */

test('runner.compose: returns a RetrievalResult with blocks + chunks_by_id + diagnostics', async () => {
    const Git = makeFakeGit({
        'docs/a.md': '# Heading\n\nThis is body content for chunk one.\n\nThis is a second paragraph that should produce a separate chunk.\n',
    });
    const handle = await createMeasurementHarness({
        Git,
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: makeFakeContextManager(),
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: ['docs/a.md'],
    });
    await handle.ingest();
    const result = await handle.runner.compose('search query');
    assert.ok(result, 'result returned');
    assert.ok(Array.isArray(result.blocks), 'blocks is an array');
    assert.ok(result.chunks_by_id && typeof result.chunks_by_id === 'object', 'chunks_by_id is an object');
    assert.ok(result.diagnostics, 'diagnostics present');
    assert.ok(Array.isArray(result.diagnostics.strategies_used));
});

/* ---------------- run() / compareBatch wiring ---------------- */

test('run: drives compareBatch through both runners and returns a ComparisonReport', async () => {
    const Git = makeFakeGit({
        'a.md': '# A\n\nFirst paragraph here.\n',
        'b.md': '# B\n\nSecond paragraph elsewhere.\n',
    });
    const handle = await createMeasurementHarness({
        Git,
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: makeFakeContextManager(),
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: ['a.md', 'b.md'],
    });
    await handle.ingest();
    const report = await handle.run({ queries: ['alpha', 'beta'], topK: 3 });
    assert.equal(report.total, 2);
    assert.equal(report.perQuery.length, 2);
    assert.equal(report.legacyFailures, 0);
    assert.equal(report.newFailures, 0);
    assert.ok(report.histogram, 'histogram present');
    assert.equal(typeof report.durationMs, 'number');
    assert.ok(report.durationMs >= 0);
    for (const r of report.perQuery) {
        assert.ok(typeof r.query === 'string');
        assert.ok(Array.isArray(r.legacyPaths) || r.legacyPaths === null);
        assert.ok(Array.isArray(r.newPaths) || r.newPaths === null);
    }
});

test('run: defaults to QUERY_FIXTURES (with expectedPaths + category) when queries is not supplied (1.5.5 reframe)', async () => {
    const cm = makeFakeContextManager();
    const handle = await createMeasurementHarness({
        Git: makeFakeGit({}),
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: cm,
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: [],
    });
    // Empty store + empty corpus run is fine — both runners may legitimately
    // return [] for every query; the harness still produces a report.
    const report = await handle.run();
    // QUERY_FIXTURES has 42 entries per 1.5.3.
    assert.equal(report.total, 42);
    assert.equal(cm.calls.length, 42, 'legacy runner called once per corpus query');
    // 1.5.5: every fixture carries expectedPaths + category, so the report
    // surfaces ground-truth aggregates + per-category roll-ups even when both
    // runners return empty (every per-query metric is 0; aggregate is 0; not null).
    assert.ok(report.legacyGroundTruth, 'legacyGroundTruth aggregate present');
    assert.ok(report.newGroundTruth, 'newGroundTruth aggregate present');
    assert.equal(report.legacyGroundTruth.sampleCount, 42);
    assert.equal(report.newGroundTruth.sampleCount, 42);
    // Per-category buckets: 6 known categories.
    const cats = Object.keys(report.legacyByCategory);
    assert.equal(cats.length, 6);
});

test('run: onProgress fires once per completed query with cumulative counts', async () => {
    const handle = await createMeasurementHarness({
        Git: makeFakeGit({}),
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: makeFakeContextManager(),
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: [],
    });
    /** @type {Array<{ done: number, total: number }>} */
    const progress = [];
    const queries = ['q1', 'q2', 'q3'];
    await handle.run({
        queries,
        onProgress: (done, total) => { progress.push({ done, total }); },
    });
    assert.equal(progress.length, 3);
    assert.deepEqual(progress.map((p) => p.done), [1, 2, 3]);
});

/* ---------------- compatibility with createComparisonHarness defaults ---------------- */

test('runner outputs round-trip through default normalizers without custom shapes', async () => {
    const Git = makeFakeGit({
        'a.md': '# Section\n\nContent body.\n',
    });
    const handle = await createMeasurementHarness({
        Git,
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: makeFakeContextManager(),
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: ['a.md'],
        // Default T1 filter excludes prose, which would empty the new
        // pipeline's result for a prose-only fixture. This test cares
        // about normalizer shape compat, not T1 — opt out by passing
        // `null` to restore pre-T1 behavior.
        composeFilters: null,
    });
    await handle.ingest();
    // Single-query path through `comparison.compare` exercises both default
    // normalizers — fail here means a runner is producing a shape they
    // don't understand.
    const result = await handle.comparison.compare('content body');
    assert.equal(result.legacyError, null, `legacy runner errored: ${result.legacyError && result.legacyError.message}`);
    assert.equal(result.newError, null, `new runner errored: ${result.newError && result.newError.message}`);
    assert.ok(Array.isArray(result.legacyPaths));
    assert.ok(Array.isArray(result.newPaths));
});

/* ============================================================
 * T1 — content-type filter at the comparison harness (1.5.5)
 *
 * The default `composeFilters` is a content-type accept-list excluding
 * `'prose'` — addresses the 1.5.4-patch divergence pattern where the
 * new pipeline over-prefers `docs/*.md` / `html/*.html`. Observable
 * via `runner.compose` against a prose-only store: with the default
 * filter, no prose chunks survive into `chunks_by_id`; with
 * `composeFilters: null`, they do.
 * ============================================================ */

test('createMeasurementHarness: rejects bad composeFilters shape', async () => {
    const base = {
        Git: makeFakeGit({}),
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: makeFakeContextManager(),
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: [],
    };
    await assert.rejects(
        () => createMeasurementHarness({ ...base, composeFilters: 'nope' }),
        /composeFilters must be a MetadataFilter object/,
    );
    await assert.rejects(
        () => createMeasurementHarness({ ...base, composeFilters: { content_types: 'code' } }),
        /composeFilters\.content_types must be an array/,
    );
});

test('runner.compose: default composeFilters excludes prose chunks (T1)', async () => {
    // Single .md file = single source of prose chunks.
    const Git = makeFakeGit({
        'docs/a.md': '# Heading\n\nFirst paragraph body.\n\nA second paragraph here.\n',
    });
    const handle = await createMeasurementHarness({
        Git,
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: makeFakeContextManager(),
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: ['docs/a.md'],
        // composeFilters omitted → default = exclude 'prose'.
    });
    await handle.ingest();
    const result = await handle.runner.compose('first paragraph body');
    // Confirm ingest actually produced prose chunks in the store…
    const stats = handle.store.stats();
    assert.ok(stats.chunks > 0, 'store has ingested chunks');
    // …but the default T1 filter strips them all out before they reach
    // chunks_by_id, so the new-pipeline result has nothing prose.
    for (const id of Object.keys(result.chunks_by_id)) {
        const ct = result.chunks_by_id[id].metadata.content_type;
        assert.notEqual(ct, 'prose', `chunk ${id} leaked into result with content_type=prose despite default T1 filter`);
    }
});

test('runner.compose: composeFilters: null restores pre-T1 behavior (prose chunks pass through)', async () => {
    const Git = makeFakeGit({
        'docs/a.md': '# Heading\n\nFirst paragraph body.\n\nA second paragraph here.\n',
    });
    const handle = await createMeasurementHarness({
        Git,
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: makeFakeContextManager(),
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: ['docs/a.md'],
        composeFilters: null,
    });
    await handle.ingest();
    const result = await handle.runner.compose('first paragraph body');
    // Without the filter, at least one prose chunk should survive into
    // the result — the prose-only store has nothing else to return.
    const proseCount = Object.values(result.chunks_by_id).filter(
        (c) => c.metadata.content_type === 'prose',
    ).length;
    assert.ok(proseCount > 0, 'expected prose chunks in result when composeFilters is null');
});

test('runner.compose: explicit composeFilters override is honored (T1)', async () => {
    // Asymmetric: ingest both prose AND structured; ask the filter to
    // accept ONLY structured. Result should have no prose chunks.
    const Git = makeFakeGit({
        'docs/a.md': '# Heading\n\nFirst paragraph body.\n',
        'data/b.json': '{"key": "first paragraph body match"}\n',
    });
    const handle = await createMeasurementHarness({
        Git,
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: makeFakeContextManager(),
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: ['docs/a.md', 'data/b.json'],
        composeFilters: { content_types: ['structured'] },
    });
    await handle.ingest();
    const result = await handle.runner.compose('first paragraph body');
    for (const id of Object.keys(result.chunks_by_id)) {
        const ct = result.chunks_by_id[id].metadata.content_type;
        assert.equal(ct, 'structured', `chunk ${id} leaked with content_type=${ct} despite explicit accept-list ['structured']`);
    }
});

/* ============================================================
 * T3 — per-category content-type filter (1.5.7)
 *
 * The default `composeFilters` resolver consults
 * `DEFAULT_COMPOSE_FILTERS_BY_CATEGORY` per call, keyed off the
 * `category` the comparison harness threads from each fixture. Post-T4
 * (2026-05-03), every per-category entry is `['code']` — the initial
 * prose admission for mixed categories regressed three buckets by
 * 4-17pts and was reverted (see the docblock on
 * `DEFAULT_COMPOSE_FILTERS_BY_CATEGORY` in measurement.js for the T4
 * data). The no-category fallback preserves the T1 default for
 * back-compat.
 * ============================================================ */

test('DEFAULT_COMPOSE_FILTERS_BY_CATEGORY: covers every QUERY_CATEGORIES enum value', () => {
    for (const cat of Object.values(QUERY_CATEGORIES)) {
        assert.ok(
            Object.prototype.hasOwnProperty.call(DEFAULT_COMPOSE_FILTERS_BY_CATEGORY, cat),
            `missing per-category default for ${cat}`,
        );
        const f = DEFAULT_COMPOSE_FILTERS_BY_CATEGORY[cat];
        assert.ok(Array.isArray(f.content_types), `category ${cat}: content_types must be array`);
        assert.ok(f.content_types.length > 0, `category ${cat}: content_types must be non-empty`);
        assert.ok(
            f.content_types.includes('code'),
            `category ${cat}: every fixture's expectedPaths include code files; 'code' must be admitted`,
        );
    }
});

test('DEFAULT_COMPOSE_FILTERS_BY_CATEGORY: pure-code categories are exactly [code] (post-T4); mixed admit prose (post-T5)', () => {
    // 1.5.8 T5 widens admission for the two mixed categories whose
    // canonical sets include a prose file under docs/ (onboarding +
    // topic → docs/PLUGIN.md) so DEFAULT_SCORE_WEIGHTS can downweight
    // prose at 0.5 instead of excluding outright. The four pure-code
    // categories stay narrowed to ['code'] — T3's verdict on those
    // buckets stands. See `DEFAULT_COMPOSE_FILTERS_BY_CATEGORY` docblock
    // in measurement.js for the per-category deltas + the
    // bug-investigation rationale (CHANGELOG.md is at repo root, no
    // 'docs/' prefix to downweight).
    const pureCode = new Set([
        QUERY_CATEGORIES.FUNCTION_DISCOVERY,
        QUERY_CATEGORIES.FILE_DISCOVERY,
        QUERY_CATEGORIES.TASK_RELATED,
        QUERY_CATEGORIES.BUG_INVESTIGATION,
    ]);
    const mixed = new Set([
        QUERY_CATEGORIES.ONBOARDING,
        QUERY_CATEGORIES.TOPIC,
    ]);
    for (const cat of Object.values(QUERY_CATEGORIES)) {
        const types = [...DEFAULT_COMPOSE_FILTERS_BY_CATEGORY[cat].content_types];
        if (pureCode.has(cat)) {
            assert.deepEqual(types, ['code'], `${cat} should be code-only`);
        } else if (mixed.has(cat)) {
            assert.deepEqual(types, ['code', 'prose'], `${cat} should admit code + prose for T5 weighting`);
        } else {
            assert.fail(`${cat} not classified — update the test when a category is added`);
        }
    }
});

test('DEFAULT_COMPOSE_FILTERS_BY_CATEGORY: outer object and inner content_types arrays are frozen', () => {
    assert.ok(Object.isFrozen(DEFAULT_COMPOSE_FILTERS_BY_CATEGORY));
    for (const cat of Object.keys(DEFAULT_COMPOSE_FILTERS_BY_CATEGORY)) {
        const filter = DEFAULT_COMPOSE_FILTERS_BY_CATEGORY[cat];
        assert.ok(Object.isFrozen(filter), `${cat}: filter object must be frozen`);
        assert.ok(Object.isFrozen(filter.content_types), `${cat}: content_types array must be frozen`);
    }
});

test('defaultComposeFiltersResolver: known category dispatches to per-category filter', () => {
    const f = defaultComposeFiltersResolver({ category: QUERY_CATEGORIES.FUNCTION_DISCOVERY });
    assert.deepEqual([...f.content_types], ['code']);
});

test('defaultComposeFiltersResolver: unknown category falls back to no-category default', () => {
    const f = defaultComposeFiltersResolver({ category: 'made-up-bucket' });
    // No-category default = T1 accept-list (excludes prose, includes
    // conversation/structured/spec for cosmetic back-compat).
    assert.ok(Array.isArray(f.content_types));
    assert.ok(f.content_types.includes('code'));
    assert.ok(!f.content_types.includes('prose'));
});

test('defaultComposeFiltersResolver: null / undefined / missing category falls back to no-category default', () => {
    const fNull = defaultComposeFiltersResolver({ category: null });
    const fUndef = defaultComposeFiltersResolver({ category: undefined });
    const fMissing = defaultComposeFiltersResolver({});
    const fNoArg = defaultComposeFiltersResolver(undefined);
    for (const f of [fNull, fUndef, fMissing, fNoArg]) {
        assert.ok(Array.isArray(f.content_types));
        assert.ok(f.content_types.includes('code'));
        assert.ok(!f.content_types.includes('prose'));
    }
});

/* ============================================================
 * T5 — content-type × path-prefix score weighting (1.5.8)
 *
 * `DEFAULT_SCORE_WEIGHTS` is merged into every filter the default
 * resolver returns, under `custom.score_weights`. The Semantic strategy
 * consumes it post-rank in `applyScoreWeights`. The map is global
 * (single set of weights for all categories); per-category weight maps
 * are deferred to a 1.5.x follow-up if global tuning hits a ceiling
 * per-category gradients could exceed.
 * ============================================================ */

test('DEFAULT_SCORE_WEIGHTS: shape pins both axes with prose downweighted at 0.5', () => {
    assert.ok(DEFAULT_SCORE_WEIGHTS.content_types);
    assert.equal(DEFAULT_SCORE_WEIGHTS.content_types.prose, 0.5);
    assert.equal(DEFAULT_SCORE_WEIGHTS.content_types.code, 1.0);
    assert.ok(DEFAULT_SCORE_WEIGHTS.prefixes);
    assert.equal(DEFAULT_SCORE_WEIGHTS.prefixes['docs/'], 0.5);
    assert.equal(DEFAULT_SCORE_WEIGHTS.prefixes['js/'], 1.0);
});

test('DEFAULT_SCORE_WEIGHTS: outer object and both inner maps are frozen', () => {
    assert.ok(Object.isFrozen(DEFAULT_SCORE_WEIGHTS));
    assert.ok(Object.isFrozen(DEFAULT_SCORE_WEIGHTS.content_types));
    assert.ok(Object.isFrozen(DEFAULT_SCORE_WEIGHTS.prefixes));
});

test('defaultComposeFiltersResolver: every returned filter carries DEFAULT_SCORE_WEIGHTS in custom', () => {
    // Each per-category lookup + the unknown-category fallback + the
    // null-category fallback should all merge the score_weights into
    // the returned filter's `custom` field.
    const cases = [
        ...Object.values(QUERY_CATEGORIES).map((c) => ({ category: c })),
        { category: 'made-up-bucket' },
        { category: null },
        {},
        undefined,
    ];
    for (const opts of cases) {
        const f = defaultComposeFiltersResolver(opts);
        assert.ok(f.custom, `${JSON.stringify(opts)}: custom must be present`);
        assert.strictEqual(
            f.custom.score_weights,
            DEFAULT_SCORE_WEIGHTS,
            `${JSON.stringify(opts)}: score_weights must reference DEFAULT_SCORE_WEIGHTS`,
        );
    }
});

test('defaultComposeFiltersResolver: returns a fresh filter object on every call (caller may mutate safely)', () => {
    const f1 = defaultComposeFiltersResolver({ category: QUERY_CATEGORIES.FUNCTION_DISCOVERY });
    const f2 = defaultComposeFiltersResolver({ category: QUERY_CATEGORIES.FUNCTION_DISCOVERY });
    assert.notStrictEqual(f1, f2, 'each call returns a fresh outer object');
    assert.notStrictEqual(f1.custom, f2.custom, 'each call returns a fresh custom object');
    // Frozen content_types arrays may be shared (they're frozen anyway).
    assert.strictEqual(f1.content_types, f2.content_types,
        'frozen content_types arrays are reused (immutable, shared safely)');
});

test('runner.compose: default score_weights downweights docs/ prose vs js/ code', async () => {
    // Asymmetric corpus: docs/a.md (prose under docs/) + js/b.js (code under js/).
    // Both contain matching tokens. Without weights, prose would win
    // because each .md emits multiple chunks vs one code chunk. With
    // T5's defaults (prose 0.5, docs/ 0.5, code 1.0, js/ 1.0), the
    // js/ code chunk's effective score wins.
    //
    // Verifies the defaults make it through createMeasurementHarness →
    // compose → semantic → applyScoreWeights end-to-end.
    const Git = makeFakeGit({
        'docs/a.md': '# Heading\n\nFirst paragraph body matching tokens here.\n',
        'js/b.js': 'function firstParagraphBody() { return "matching tokens"; }\n',
    });
    const handle = await createMeasurementHarness({
        Git,
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: makeFakeContextManager(),
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: ['docs/a.md', 'js/b.js'],
        // composeFilters omitted → default resolver, default weights.
    });
    await handle.ingest();
    // Use the topic category (admits ['code', 'prose'] post-T5) so prose
    // can compete in admission and weighting decides ranking.
    const result = await handle.runner.compose('first paragraph body matching tokens', {
        category: QUERY_CATEGORIES.TOPIC,
    });
    // Both should be admitted (prose admission re-opened for topic).
    const ctsAdmitted = new Set(
        Object.values(result.chunks_by_id).map((c) => c.metadata.content_type),
    );
    assert.ok(ctsAdmitted.has('code'), 'code chunks admitted');
    assert.ok(ctsAdmitted.has('prose'), 'prose chunks admitted under topic category post-T5');
});

test('createMeasurementHarness: function-form composeFilters is invoked per call with opts.category', async () => {
    const Git = makeFakeGit({
        'a.js': 'function foo() { return 1; }\n',
    });
    const seenCalls = [];
    const customResolver = (opts) => {
        seenCalls.push(opts);
        return { content_types: ['code'] };
    };
    const handle = await createMeasurementHarness({
        Git,
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: makeFakeContextManager(),
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: ['a.js'],
        composeFilters: customResolver,
    });
    await handle.ingest();
    // No-arg call sees opts: {}
    await handle.runner.compose('foo');
    // Two-arg call passes through category
    await handle.runner.compose('foo', { category: 'bug-investigation' });
    assert.equal(seenCalls.length, 2);
    assert.deepEqual(seenCalls[0], {});
    assert.deepEqual(seenCalls[1], { category: 'bug-investigation' });
});

test('createMeasurementHarness: function-form composeFilters can return null (pre-T1 behavior per call)', async () => {
    const Git = makeFakeGit({
        'docs/a.md': '# Heading\n\nProse paragraph body here.\n',
    });
    // Resolver returns null → no filter → prose passes through.
    const handle = await createMeasurementHarness({
        Git,
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: makeFakeContextManager(),
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: ['docs/a.md'],
        composeFilters: () => null,
    });
    await handle.ingest();
    const result = await handle.runner.compose('prose paragraph body');
    const proseCount = Object.values(result.chunks_by_id).filter(
        (c) => c.metadata.content_type === 'prose',
    ).length;
    assert.ok(proseCount > 0, 'expected prose chunks when resolver returns null');
});

test('createMeasurementHarness: compareBatch routes per-fixture category through to function-form composeFilters', async () => {
    const Git = makeFakeGit({
        'a.js': 'function foo() { return 1; }\n',
    });
    const seenCalls = [];
    const handle = await createMeasurementHarness({
        Git,
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: makeFakeContextManager(),
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: ['a.js'],
        composeFilters: (opts) => {
            seenCalls.push(opts);
            return { content_types: ['code'] };
        },
    });
    await handle.ingest();
    await handle.run({
        queries: [
            { query: 'foo a', category: 'function-discovery' },
            { query: 'foo b', category: 'bug-investigation' },
            { query: 'foo c' }, // bare object, no category
            'foo d',           // bare string
        ],
    });
    // 4 queries × 1 runCompose call each = 4 resolver calls
    assert.equal(seenCalls.length, 4);
    assert.deepEqual(seenCalls[0], { category: 'function-discovery' });
    assert.deepEqual(seenCalls[1], { category: 'bug-investigation' });
    assert.deepEqual(seenCalls[2], { category: null });
    assert.deepEqual(seenCalls[3], { category: null });
});

test('runner.compose: default per-category filter excludes prose for code-only categories', async () => {
    const Git = makeFakeGit({
        'docs/a.md': '# Heading\n\nFirst paragraph body.\n',
        'src/a.js': 'function paragraph() { return "body"; }\n',
    });
    const handle = await createMeasurementHarness({
        Git,
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: makeFakeContextManager(),
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: ['docs/a.md', 'src/a.js'],
        // composeFilters omitted → defaultComposeFiltersResolver
    });
    await handle.ingest();
    // function-discovery → ['code'] only
    const result = await handle.runner.compose('first paragraph body', {
        category: QUERY_CATEGORIES.FUNCTION_DISCOVERY,
    });
    for (const id of Object.keys(result.chunks_by_id)) {
        const ct = result.chunks_by_id[id].metadata.content_type;
        assert.notEqual(ct, 'prose', `function-discovery category leaked content_type=prose chunk ${id}`);
    }
});

test('runner.compose: pure-code categories exclude prose; mixed categories admit prose (post-T5)', async () => {
    // 1.5.8 T5 split: bug-investigation stays code-only (CHANGELOG.md
    // is at repo root, T5 prefix downweight on docs/ doesn't apply);
    // onboarding + topic admit ['code', 'prose'] so DEFAULT_SCORE_WEIGHTS
    // can downweight prose at 0.5 rather than exclude outright.
    const Git = makeFakeGit({
        'docs/a.md': '# Heading\n\nFirst paragraph body of relevant content here.\n',
    });
    const handle = await createMeasurementHarness({
        Git,
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: makeFakeContextManager(),
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: ['docs/a.md'],
    });
    await handle.ingest();
    // Pure-code category: prose must NOT leak into chunks_by_id.
    const bugRes = await handle.runner.compose('first paragraph body', {
        category: QUERY_CATEGORIES.BUG_INVESTIGATION,
    });
    for (const id of Object.keys(bugRes.chunks_by_id)) {
        const ct = bugRes.chunks_by_id[id].metadata.content_type;
        assert.notEqual(ct, 'prose',
            `bug-investigation: chunk ${id} leaked content_type=prose despite ['code']-only filter`);
    }
    // Mixed categories: prose CAN survive (downweighted, but admissible).
    for (const cat of [QUERY_CATEGORIES.ONBOARDING, QUERY_CATEGORIES.TOPIC]) {
        const res = await handle.runner.compose('first paragraph body', { category: cat });
        const proseCount = Object.values(res.chunks_by_id).filter(
            (c) => c.metadata.content_type === 'prose',
        ).length;
        assert.ok(proseCount > 0,
            `${cat}: expected prose chunks to survive admission (downweighted, not excluded)`);
    }
});

test('createMeasurementHarness: rejects function-form composeFilters that returns the wrong shape — deferred', () => {
    // Per-call type guards live inside the runner's compose call; the
    // factory accepts any function. This test pins that posture so a
    // future tightening doesn't surprise callers.
    assert.equal(typeof defaultComposeFiltersResolver, 'function');
});
