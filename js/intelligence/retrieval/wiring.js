// @ts-check
/**
 * Production wiring — the integration seam that bridges the production
 * `Git` and `EmbeddingsClient` modules to the existing pure-DI factories
 * shipped through 1.5.0 (Loader 1.4.21, Embedder 1.4.22, Store 1.4.20,
 * Controller 1.4.23, Walker 1.5.0).
 *
 * Per the roadmap (`docs/ROADMAP.md` §"Now"):
 *
 *   > The next 1.5.0-betaN PR adds production wiring to `Git.getFile()` /
 *   > `EmbeddingsClient.embed()`.
 *
 * Two contract gaps prevented the existing factories from being called
 * against the production modules directly:
 *
 *   1. `Git.getFile(owner, repo, path, ref)` returns
 *      `{ name, path, sha, size, content, encoding }` — a *file object*,
 *      not raw bytes. [`createLoader`](./loader.js) wants
 *      `fetchBytes: (uri) => Promise<string>`. The bridge pre-binds the
 *      project context (owner / repo / ref) and unwraps `.content`.
 *
 *   2. `EmbeddingsClient.embed(text)` already matches `embedFn` shape, but
 *      `EmbeddingsClient.init()` must be awaited once at construction
 *      (per [`docs/DESIGN-retrieval.md`](../../../../docs/DESIGN-retrieval.md)
 *      lines 304-308: *"Provider initialization at library startup, not
 *      per-call"*).
 *
 * Closing these gaps in a small wiring module — not as edits to
 * `loader.js` / `embedder.js` themselves — keeps the existing factories
 * pure-DI and node-test-safe (the real `Git` and `EmbeddingsClient` import
 * browser-bound `core.js`), and keeps the production seam in one
 * inspectable file.
 *
 * **Phase-1 scope decisions** (called out so future readers don't have to
 * reverse-engineer them from behavior):
 *
 *   1. **Project context closes over the loader.** `createProductionLoader`
 *      takes a `project = { owner, repo, ref }` triple at construction;
 *      the loader's `source_uri` is then a plain in-repo path. No URI-
 *      scheme parsing in Phase 1; a future multi-repo walker (deferred)
 *      revisits this. Mirrors how 1.4.15's Semantic strategy closes over
 *      `embedQuery` rather than threading it per call.
 *
 *   2. **No catching of `Git.getFile` errors.** The controller (1.4.23)
 *      already converts thrown loader errors into `failed` IngestResults
 *      per its documented contract; preserving that posture means a
 *      missing file or network blip flows through the existing error
 *      isolation rather than being silently swallowed here.
 *
 *   3. **`EmbeddingsClient.init()` awaited exactly once at construction.**
 *      `init()` is internally idempotent (returns early on
 *      `_initialized`), so a caller who already initialized the client
 *      pays no extra cost. We still await defensively to honor the
 *      design's "library startup" contract — every chunk emitted by the
 *      returned Embedder is guaranteed to see a ready provider.
 *
 *   4. **No state read.** `wiring.js` does not read `State` /
 *      `localStorage` / any DOM global. The caller threads `project` and
 *      `modelId` in. That keeps this module node-test-safe (under fakes)
 *      and matches the DI posture every other retrieval factory took.
 *
 *   5. **Composition factory returns three handles.**
 *      `createProductionIngestWalker` returns `{ walker, controller, store }`
 *      so callers can issue `walk()` calls, inspect controller stats,
 *      and look up chunks via `store.getChunkByID` for downstream
 *      consumers (the comparison harness's job at the next PR).
 *
 *   6. **No app-boot integration in this PR.** Nothing imports `wiring.js`
 *      outside the test suite and (after this PR) the barrel re-export.
 *      `find_relevant_files` keeps running through legacy
 *      `js/context-manager.js`. Removability holds (Decision §7).
 *
 * **Out of scope for 1.5.1:**
 *   - App-boot calls into `EmbeddingsClient.init()` or walker construction
 *     (the walker is *available* but not started at boot; the comparison
 *     harness PR triggers ingestion when its test runs).
 *   - The comparison harness running queries through both legacy
 *     `js/context-manager.js` and the new Composer (next PR).
 *   - Test-query fixture corpus (later PR).
 *   - The actual ≥80% legacy-vs-new agreement measurement that promotes
 *     the track (later PR).
 *   - Migration of `find_relevant_files` off `js/context-manager.js`
 *     (1.5.3 after the §1.5.x renumber that this PR lands).
 *   - Walker tree-walking / source-URI enumeration from `State.fileTree`
 *     (the consumer's job; the walker takes URIs, doesn't discover them).
 *   - Persistent embedding cache / IDB-backed storage (Phase 1.5.x).
 *   - File-size ceiling / filetype filters (Foundations 1.1.2 branch).
 *   - Multi-repo / cross-workspace URI scheme.
 *   - Thematic strategy (renumbered to 1.5.2 in this PR).
 *
 * **No runtime wire-up.** Nothing imports `createProductionLoader` /
 * `createProductionEmbedder` / `createProductionIngestWalker` outside the
 * test suite. With this module deleted (and the three barrel re-exports
 * removed), no production behavior degrades — Removability holds
 * (Decision §7).
 *
 * @module intelligence/retrieval/wiring
 */

import { createLoader } from './loader.js';
import { createEmbedder } from './embedder.js';
import { createInMemoryChunkStore } from './store.js';
import { createIngestController } from './ingest-controller.js';
import { createIngestWalker } from './walker.js';

/**
 * @typedef {import('./contracts.js').ContentType}              ContentType
 * @typedef {import('./contracts.js').CollectionName}           CollectionName
 * @typedef {import('./contracts.js').IngestResult}             IngestResult
 * @typedef {import('./contracts.js').WalkResult}               WalkResult
 * @typedef {import('./contracts.js').Project}                  Project
 * @typedef {import('./contracts.js').ProductionLoaderOptions}  ProductionLoaderOptions
 * @typedef {import('./contracts.js').ProductionEmbedderOptions} ProductionEmbedderOptions
 * @typedef {import('./contracts.js').ProductionIngestWalkerOptions} ProductionIngestWalkerOptions
 * @typedef {import('./contracts.js').ProductionIngestWalkerHandle} ProductionIngestWalkerHandle
 * @typedef {import('./loader.js').Loader}                      Loader
 * @typedef {import('./embedder.js').Embedder}                  Embedder
 */

/* ---------------- Project validation ---------------- */

/**
 * Validate a `project` triple. Lifted to a helper so both the loader
 * factory and the composition factory share the same error messages.
 *
 * @param {*} project
 */
function validateProject(project) {
    if (!project || typeof project !== 'object') {
        throw new TypeError('createProductionLoader: project must be an object');
    }
    const { owner, repo, ref } = /** @type {any} */ (project);
    if (typeof owner !== 'string' || owner.length === 0) {
        throw new TypeError('createProductionLoader: project.owner must be a non-empty string');
    }
    if (typeof repo !== 'string' || repo.length === 0) {
        throw new TypeError('createProductionLoader: project.repo must be a non-empty string');
    }
    if (typeof ref !== 'string' || ref.length === 0) {
        throw new TypeError('createProductionLoader: project.ref must be a non-empty string');
    }
}

/* ---------------- Loader bridge ---------------- */

/**
 * Construct a Loader wired to `Git.getFile(owner, repo, path, ref)`. The
 * project triple is closed over at construction; the loader's `source_uri`
 * is then a plain in-repo path (e.g. `js/app.js`). Errors from
 * `Git.getFile` propagate verbatim so the controller can convert them
 * into `failed` IngestResults per its existing contract.
 *
 * Tests inject a fake `Git` exposing `getFile(owner, repo, path, ref)`
 * that returns `{ content: '...' }` (additional fields are ignored).
 *
 * @param {ProductionLoaderOptions} options
 * @returns {Loader}
 */
export function createProductionLoader(options) {
    if (!options || typeof options !== 'object') {
        throw new TypeError('createProductionLoader: options must be an object');
    }
    const { Git, project, contentTypeOverride } = options;
    if (!Git || typeof Git.getFile !== 'function') {
        throw new TypeError('createProductionLoader: Git must expose getFile()');
    }
    validateProject(project);
    if (contentTypeOverride !== undefined && typeof contentTypeOverride !== 'function') {
        throw new TypeError(
            'createProductionLoader: contentTypeOverride must be a function when provided',
        );
    }

    const { owner, repo, ref } = project;

    return createLoader({
        fetchBytes: async (path) => {
            const file = await Git.getFile(owner, repo, path, ref);
            if (!file || typeof file !== 'object' || typeof file.content !== 'string') {
                throw new TypeError(
                    `createProductionLoader: Git.getFile must resolve to { content: string }; got ${typeof file === 'object' && file ? typeof file.content : typeof file}`,
                );
            }
            return file.content;
        },
        contentTypeOverride,
    });
}

/* ---------------- Embedder bridge ---------------- */

/**
 * Construct an Embedder wired to `EmbeddingsClient.embed(text)`. Awaits
 * `EmbeddingsClient.init()` exactly once at construction so the returned
 * handle is guaranteed to see a ready provider on every `embed` call.
 *
 * `init()` is internally idempotent on the production client — repeated
 * calls return early after `_initialized` flips. The `await` here pays no
 * extra cost when init has already completed elsewhere; it is the
 * defensive contract honoring the design's "library startup" rule.
 *
 * @param {ProductionEmbedderOptions} options
 * @returns {Promise<Embedder>}
 */
export async function createProductionEmbedder(options) {
    if (!options || typeof options !== 'object') {
        throw new TypeError('createProductionEmbedder: options must be an object');
    }
    const { EmbeddingsClient, modelId, cache } = options;
    if (
        !EmbeddingsClient ||
        typeof EmbeddingsClient.init !== 'function' ||
        typeof EmbeddingsClient.embed !== 'function'
    ) {
        throw new TypeError(
            'createProductionEmbedder: EmbeddingsClient must expose init() and embed()',
        );
    }
    if (typeof modelId !== 'string' || modelId.length === 0) {
        throw new TypeError('createProductionEmbedder: modelId must be a non-empty string');
    }

    await EmbeddingsClient.init();

    return createEmbedder({
        embedFn: (text) => EmbeddingsClient.embed(text),
        modelId,
        cache,
    });
}

/* ---------------- Composition ---------------- */

/**
 * One-shot composition that wires the full ingest pipeline against
 * production `Git` + `EmbeddingsClient`. Returns the walker plus the
 * controller and store handles so callers can `walk()`, inspect stats,
 * and look up chunks for downstream consumers (the comparison harness's
 * job at the next PR).
 *
 * Async because `createProductionEmbedder` awaits `EmbeddingsClient.init()`.
 *
 * @param {ProductionIngestWalkerOptions} options
 * @returns {Promise<ProductionIngestWalkerHandle>}
 */
export async function createProductionIngestWalker(options) {
    if (!options || typeof options !== 'object') {
        throw new TypeError('createProductionIngestWalker: options must be an object');
    }
    const {
        Git,
        EmbeddingsClient,
        project,
        modelId,
        store,
        collection,
        concurrency,
        onProgress,
        embeddingCache,
        contentTypeOverride,
    } = options;

    const loader = createProductionLoader({ Git, project, contentTypeOverride });
    const embedder = await createProductionEmbedder({
        EmbeddingsClient,
        modelId,
        cache: embeddingCache,
    });
    const finalStore = store ?? createInMemoryChunkStore();
    const controller = createIngestController({
        loader,
        embedder,
        store: finalStore,
        collection,
    });
    const walker = createIngestWalker({
        controller,
        concurrency,
        onProgress,
    });

    return { walker, controller, store: finalStore };
}
