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
} from '../js/intelligence/retrieval/measurement.js';

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

test('createMeasurementHarness: rejects missing ContextManager.findRelevantFiles', async () => {
    await assert.rejects(() => createMeasurementHarness({
        Git: makeFakeGit({}),
        EmbeddingsClient: makeFakeEmbeddingsClient(),
        ContextManager: {},
        project: PROJECT,
        modelId: MODEL_ID,
        sourceUris: [],
    }), /ContextManager must expose findRelevantFiles/);
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

test('run: defaults to QUERY_CORPUS when queries is not supplied', async () => {
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
    // QUERY_CORPUS has 42 entries per 1.5.3.
    assert.equal(report.total, 42);
    assert.equal(cm.calls.length, 42, 'legacy runner called once per corpus query');
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
