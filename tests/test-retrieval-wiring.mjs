/**
 * Production wiring tests (1.5.1).
 *
 * Covers `js/intelligence/retrieval/wiring.js` — the integration seam
 * that bridges the production `Git` and `EmbeddingsClient` modules to the
 * existing pure-DI factories shipped through 1.5.0. The real `Git` and
 * `EmbeddingsClient` import browser-bound `core.js`; tests therefore
 * inject minimal fakes exposing only the methods the wiring module
 * touches (`Git.getFile`, `EmbeddingsClient.init`, `EmbeddingsClient.embed`).
 *
 * Pure-data, no DOM / State / network — runs under `node --test`.
 * Mirrors the sibling test files (`test-retrieval-loader.mjs`,
 * `test-retrieval-embedder.mjs`, `test-retrieval-walker.mjs`): each
 * `test()` block is focused on a single invariant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createProductionLoader,
    createProductionEmbedder,
    createProductionIngestWalker,
} from '../js/intelligence/retrieval/wiring.js';
import { createInMemoryChunkStore } from '../js/intelligence/retrieval/store.js';

/* ---------------- Fixture builders ---------------- */

/**
 * Minimal fake `Git` exposing only `getFile(owner, repo, path, ref)`. Returns
 * the file shape the production providers return: `{ name, path, sha, size,
 * content, encoding }`. `files` is a plain `Record<string, string>` keyed by
 * in-repo path; absent paths surface as a thrown `Error` so the controller's
 * existing error-isolation path is exercised.
 */
function makeFakeGit(files, opts = {}) {
    const calls = [];
    return {
        calls,
        getFile: async (owner, repo, path, ref) => {
            calls.push({ owner, repo, path, ref });
            if (opts.throwOn && opts.throwOn === path) {
                throw new Error(`fake Git: explicit throw for ${path}`);
            }
            if (!(path in files)) {
                throw new Error(`fake Git: file not found: ${path}`);
            }
            const content = files[path];
            return {
                name: path.split('/').pop(),
                path,
                sha: `sha_${path}`,
                size: content.length,
                content,
                encoding: 'utf-8',
            };
        },
    };
}

/**
 * Minimal fake `EmbeddingsClient`. Tracks `init()` invocation count and
 * resolves `embed(text)` to a deterministic 4-dim vector. `failOn(text)`
 * forces a `null` return; `throwOn(text)` forces a thrown error.
 */
function makeFakeEmbeddingsClient(opts = {}) {
    let initCalls = 0;
    let embedCalls = 0;
    const initBarrier = opts.initBarrier ?? Promise.resolve();
    return {
        get initCalls() { return initCalls; },
        get embedCalls() { return embedCalls; },
        init: async () => {
            initCalls += 1;
            await initBarrier;
            return true;
        },
        embed: async (text) => {
            embedCalls += 1;
            if (opts.failOn && opts.failOn === text) return null;
            if (opts.throwOn && opts.throwOn === text) {
                throw new Error(`fake EmbeddingsClient: explicit throw`);
            }
            // 4-dim deterministic vector keyed off text length + first/last char.
            const a = text.length / 100;
            const b = text.length === 0 ? 0 : text.charCodeAt(0) / 100;
            const c = text.length === 0 ? 0 : text.charCodeAt(text.length - 1) / 100;
            return [a, b, c, 0.5];
        },
    };
}

/* ---------------- createProductionLoader ---------------- */

test('createProductionLoader: calls Git.getFile with project-bound owner/repo/ref', async () => {
    const Git = makeFakeGit({ 'README.txt': 'Hello world.' });
    const loader = createProductionLoader({
        Git,
        project: { owner: 'acme', repo: 'editor', ref: 'main' },
    });
    const result = await loader.load('README.txt');
    assert.equal(Git.calls.length, 1);
    assert.deepEqual(Git.calls[0], { owner: 'acme', repo: 'editor', path: 'README.txt', ref: 'main' });
    assert.equal(result.bytes, 'Hello world.');
    assert.equal(result.source_uri, 'README.txt');
    assert.equal(result.content_type_hint, 'prose');
    assert.match(result.content_hash, /^[0-9a-f]{16}$/);
});

test('createProductionLoader: surfaces Git.getFile thrown errors verbatim', async () => {
    const Git = makeFakeGit({}, { throwOn: 'missing.txt' });
    const loader = createProductionLoader({
        Git,
        project: { owner: 'acme', repo: 'editor', ref: 'main' },
    });
    await assert.rejects(() => loader.load('missing.txt'), /explicit throw for missing\.txt/);
});

test('createProductionLoader: throws TypeError when Git.getFile returns non-string content', async () => {
    const Git = {
        getFile: async () => ({ name: 'a.txt', path: 'a.txt', sha: 's', size: 0, content: null, encoding: 'utf-8' }),
    };
    const loader = createProductionLoader({
        Git,
        project: { owner: 'acme', repo: 'editor', ref: 'main' },
    });
    await assert.rejects(() => loader.load('a.txt'), /Git\.getFile must resolve to/);
});

test('createProductionLoader: contentTypeOverride wins over extension detection', async () => {
    // A path with no extension would normally throw "unknown content_type"; the
    // override resolves it.
    const Git = makeFakeGit({ 'memory://session/abc123': '[{"role":"user","content":"hi"}]' });
    const loader = createProductionLoader({
        Git,
        project: { owner: 'acme', repo: 'editor', ref: 'main' },
        contentTypeOverride: (uri) => uri.startsWith('memory://') ? 'conversation' : null,
    });
    const result = await loader.load('memory://session/abc123');
    assert.equal(result.content_type_hint, 'conversation');
});

test('createProductionLoader: rejects missing options bag', () => {
    assert.throws(() => createProductionLoader(null), /options must be an object/);
    assert.throws(() => createProductionLoader(undefined), /options must be an object/);
});

test('createProductionLoader: rejects missing Git or non-function getFile', () => {
    const project = { owner: 'a', repo: 'b', ref: 'main' };
    assert.throws(
        () => createProductionLoader({ project }),
        /Git must expose getFile/,
    );
    assert.throws(
        () => createProductionLoader({ Git: { getFile: 'nope' }, project }),
        /Git must expose getFile/,
    );
});

test('createProductionLoader: rejects missing or malformed project', () => {
    const Git = makeFakeGit({});
    assert.throws(() => createProductionLoader({ Git }), /project must be an object/);
    assert.throws(
        () => createProductionLoader({ Git, project: { owner: '', repo: 'b', ref: 'main' } }),
        /project\.owner/,
    );
    assert.throws(
        () => createProductionLoader({ Git, project: { owner: 'a', repo: '', ref: 'main' } }),
        /project\.repo/,
    );
    assert.throws(
        () => createProductionLoader({ Git, project: { owner: 'a', repo: 'b', ref: '' } }),
        /project\.ref/,
    );
});

test('createProductionLoader: rejects non-function contentTypeOverride', () => {
    const Git = makeFakeGit({});
    assert.throws(
        () => createProductionLoader({
            Git,
            project: { owner: 'a', repo: 'b', ref: 'main' },
            contentTypeOverride: 'not-a-fn',
        }),
        /contentTypeOverride must be a function/,
    );
});

/* ---------------- createProductionEmbedder ---------------- */

test('createProductionEmbedder: awaits init() exactly once at construction', async () => {
    const EC = makeFakeEmbeddingsClient();
    assert.equal(EC.initCalls, 0);
    await createProductionEmbedder({ EmbeddingsClient: EC, modelId: 'm1' });
    assert.equal(EC.initCalls, 1);
});

test('createProductionEmbedder: subsequent embed() calls do not re-init', async () => {
    const EC = makeFakeEmbeddingsClient();
    const embedder = await createProductionEmbedder({ EmbeddingsClient: EC, modelId: 'm1' });
    const chunks = makeChunksForEmbed(3);
    await embedder.embed(chunks);
    await embedder.embed(chunks.slice(0, 1));
    assert.equal(EC.initCalls, 1, 'init() called once at construction, never again');
});

test('createProductionEmbedder: pass-through of vector results', async () => {
    const EC = makeFakeEmbeddingsClient();
    const embedder = await createProductionEmbedder({ EmbeddingsClient: EC, modelId: 'm1' });
    const chunks = makeChunksForEmbed(2);
    const refs = await embedder.embed(chunks);
    assert.equal(refs.length, 2);
    assert.ok(Array.isArray(refs[0].embedding));
    assert.equal(refs[0].embedding.length, 4);
});

test('createProductionEmbedder: null from EmbeddingsClient.embed degrades to chunk.embedding === null', async () => {
    const EC = makeFakeEmbeddingsClient({ failOn: 'fail-text' });
    const embedder = await createProductionEmbedder({ EmbeddingsClient: EC, modelId: 'm1' });
    const chunks = [
        makeChunkForEmbed({ id: 'c1', content: 'fail-text', content_hash: 'h1' }),
        makeChunkForEmbed({ id: 'c2', content: 'ok-text', content_hash: 'h2' }),
    ];
    const refs = await embedder.embed(chunks);
    assert.equal(refs[0].embedding, null);
    assert.ok(Array.isArray(refs[1].embedding));
    assert.equal(embedder.stats().failures, 1);
});

test('createProductionEmbedder: modelId participates in cache key — same content under different models embeds twice', async () => {
    const EC = makeFakeEmbeddingsClient();
    const e1 = await createProductionEmbedder({ EmbeddingsClient: EC, modelId: 'small' });
    const e2 = await createProductionEmbedder({ EmbeddingsClient: EC, modelId: 'large' });
    const chunk = makeChunkForEmbed({ id: 'c1', content: 'shared', content_hash: 'h-shared' });
    await e1.embed([chunk]);
    await e2.embed([chunk]);
    assert.equal(EC.embedCalls, 2, 'distinct modelIds must not collide on the cache key');
});

test('createProductionEmbedder: rejects missing options bag', async () => {
    await assert.rejects(() => createProductionEmbedder(null), /options must be an object/);
});

test('createProductionEmbedder: rejects missing EmbeddingsClient or non-function methods', async () => {
    await assert.rejects(
        () => createProductionEmbedder({ modelId: 'm' }),
        /EmbeddingsClient must expose init\(\) and embed\(\)/,
    );
    await assert.rejects(
        () => createProductionEmbedder({ EmbeddingsClient: { init: () => {} }, modelId: 'm' }),
        /EmbeddingsClient must expose init\(\) and embed\(\)/,
    );
});

test('createProductionEmbedder: rejects missing or empty modelId', async () => {
    const EC = makeFakeEmbeddingsClient();
    await assert.rejects(
        () => createProductionEmbedder({ EmbeddingsClient: EC }),
        /modelId must be a non-empty string/,
    );
    await assert.rejects(
        () => createProductionEmbedder({ EmbeddingsClient: EC, modelId: '' }),
        /modelId must be a non-empty string/,
    );
});

test('createProductionEmbedder: init() resolves before any embed() call (race-free under slow init)', async () => {
    let initResolved = false;
    let initRelease;
    const initBarrier = new Promise((r) => { initRelease = r; });
    const EC = makeFakeEmbeddingsClient({ initBarrier });
    const orig = EC.embed;
    EC.embed = async (text) => {
        // If embed runs before init has resolved, this fails.
        assert.equal(initResolved, true, 'embed must not run before init() resolves');
        return orig(text);
    };

    const constructionP = createProductionEmbedder({ EmbeddingsClient: EC, modelId: 'm' });
    // Let microtasks drain; the embedder factory should still be awaiting init.
    await new Promise((r) => setTimeout(r, 0));
    initResolved = true;
    initRelease(); // release the init barrier
    const embedder = await constructionP;
    const refs = await embedder.embed(makeChunksForEmbed(1));
    assert.equal(refs.length, 1);
});

/* ---------------- createProductionIngestWalker ---------------- */

test('createProductionIngestWalker: returns { walker, controller, store } with all populated', async () => {
    const Git = makeFakeGit({});
    const EC = makeFakeEmbeddingsClient();
    const handle = await createProductionIngestWalker({
        Git,
        EmbeddingsClient: EC,
        project: { owner: 'a', repo: 'b', ref: 'main' },
        modelId: 'm',
    });
    assert.equal(typeof handle.walker.walk, 'function');
    assert.equal(typeof handle.walker.stats, 'function');
    assert.equal(typeof handle.controller.ingest, 'function');
    assert.equal(typeof handle.store.getChunkByID, 'function');
});

test('createProductionIngestWalker: injected store is honored (not replaced)', async () => {
    const Git = makeFakeGit({});
    const EC = makeFakeEmbeddingsClient();
    const customStore = createInMemoryChunkStore();
    const handle = await createProductionIngestWalker({
        Git,
        EmbeddingsClient: EC,
        project: { owner: 'a', repo: 'b', ref: 'main' },
        modelId: 'm',
        store: customStore,
    });
    assert.equal(handle.store, customStore);
});

test('createProductionIngestWalker: end-to-end smoke — two prose URIs ingest with deterministic vectors', async () => {
    const Git = makeFakeGit({
        'docs/intro.txt': 'First paragraph here.\n\nSecond paragraph here.',
        'docs/usage.txt': 'How to use this thing in practice.',
    });
    const EC = makeFakeEmbeddingsClient();
    const handle = await createProductionIngestWalker({
        Git,
        EmbeddingsClient: EC,
        project: { owner: 'acme', repo: 'editor', ref: 'main' },
        modelId: 'unit-model',
    });
    const result = await handle.walker.walk(['docs/intro.txt', 'docs/usage.txt']);

    assert.equal(result.total, 2);
    assert.equal(result.ingested, 2, 'both sources should ingest cleanly');
    assert.equal(result.failed, 0);
    assert.equal(result.aborted, false);
    assert.ok(result.chunksAdded >= 2, 'each prose source emits at least one chunk');

    const stats = handle.controller.stats();
    assert.equal(stats.ingested, 2);
    assert.equal(stats.failed, 0);

    // Git.getFile observed exactly twice (one call per source).
    assert.equal(Git.calls.length, 2);
    assert.deepEqual(
        Git.calls.map((c) => c.path).sort(),
        ['docs/intro.txt', 'docs/usage.txt'],
    );

    // Embeddings were produced for the chunks (deterministic fake never returns null here).
    assert.equal(result.embedFailures, 0);
});

test('createProductionIngestWalker: walker propagates Git.getFile errors as failed IngestResults', async () => {
    const Git = makeFakeGit({}, { throwOn: 'docs/missing.txt' });
    const EC = makeFakeEmbeddingsClient();
    const handle = await createProductionIngestWalker({
        Git,
        EmbeddingsClient: EC,
        project: { owner: 'acme', repo: 'editor', ref: 'main' },
        modelId: 'unit-model',
    });
    const result = await handle.walker.walk(['docs/missing.txt']);
    assert.equal(result.total, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.ingested, 0);
    assert.equal(result.aborted, false);
});

test('createProductionIngestWalker: concurrency / collection / onProgress flow through', async () => {
    const Git = makeFakeGit({
        'a.txt': 'alpha alpha alpha.',
        'b.txt': 'beta beta beta.',
    });
    const EC = makeFakeEmbeddingsClient();
    const progressCalls = [];
    const handle = await createProductionIngestWalker({
        Git,
        EmbeddingsClient: EC,
        project: { owner: 'a', repo: 'b', ref: 'main' },
        modelId: 'm',
        collection: 'workspace_docs',
        concurrency: 1, // sequential — input order observable on results
        onProgress: (done, total) => progressCalls.push({ done, total }),
    });
    const result = await handle.walker.walk(['a.txt', 'b.txt']);
    assert.equal(result.total, 2);
    assert.equal(result.ingested, 2);
    assert.equal(progressCalls.length, 2, 'onProgress fires once per completed source');
    assert.deepEqual(progressCalls.map((c) => c.total), [2, 2]);

    // Verify chunks landed in the requested collection by spot-checking one.
    const oneChunkId = handle.store.chunkIdsForSource('a.txt')[0];
    const ref = await handle.store.getChunkByID(oneChunkId);
    assert.equal(ref.collection, 'workspace_docs');
});

test('createProductionIngestWalker: embeddingCache is threaded through to the embedder', async () => {
    const Git = makeFakeGit({ 'a.txt': 'shared content.' });
    const EC = makeFakeEmbeddingsClient();
    const cacheStore = new Map();
    const cache = {
        get: (k) => (cacheStore.has(k) ? cacheStore.get(k) : null),
        set: (k, v) => { cacheStore.set(k, v); },
        size: () => cacheStore.size,
    };
    const handle = await createProductionIngestWalker({
        Git,
        EmbeddingsClient: EC,
        project: { owner: 'a', repo: 'b', ref: 'main' },
        modelId: 'm',
        embeddingCache: cache,
    });
    await handle.walker.walk(['a.txt']);
    assert.ok(cacheStore.size >= 1, 'cache should hold at least one entry after a successful ingest');
});

test('createProductionIngestWalker: rejects missing options bag', async () => {
    await assert.rejects(() => createProductionIngestWalker(null), /options must be an object/);
});

/* ---------------- Local helpers for embedder tests ---------------- */

function makeChunkForEmbed({ id = 'c0', content = 'hello', content_hash = 'h0', source_uri = 'docs/x.txt' } = {}) {
    return {
        id,
        collection: 'docs',
        content,
        tokens: Math.max(1, Math.ceil(content.length / 4)),
        metadata: {
            source_uri,
            content_type: 'prose',
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
            content_hash,
            structural: null,
            custom: {},
        },
        byte_range: [0, content.length],
    };
}

function makeChunksForEmbed(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push(makeChunkForEmbed({
            id: `c${i}`,
            content: `chunk content ${i}`,
            content_hash: `h${i}`,
            source_uri: `docs/${i}.txt`,
        }));
    }
    return out;
}
