// @ts-check
/**
 * Retrieval Manager — production singleton owning the chunk-level
 * retrieval pipeline lifecycle. Replaces legacy `js/context-manager.js`
 * (file-level summary embeddings) at 1.5.14. Drives `find_relevant_files`,
 * the index-status indicator, the debug slideout's Indexer panel,
 * Settings → Storage's per-index list, and the auto-pause when the LLM
 * is generating.
 *
 * Built on the shipped 1.4.x–1.5.x DI factories: `createInMemoryChunkStore`
 * (1.4.20), `createProductionIngestWalker` (1.5.1), `createSemanticStrategy`
 * + `createStructuralStrategy` + `createThematicStrategy`, `compose`
 * (1.4.17 + 1.5.12 paraphrase opt + 1.8.1 lever-B expansion opt),
 * `buildBM25Index` (1.5.11), `buildParaphraserFromSettings` (1.5.12), and
 * `buildExpanderFromSettings` (1.8.1). Reuses the
 * `defaultComposeFiltersResolver` + `DEFAULT_SCORE_WEIGHTS` from the
 * canonical 1.5.11 T7 measurement so live `find_relevant_files` calls run
 * the same recipe as the gate-clearing run.
 *
 * @module intelligence/retrieval/manager
 */

import { State, EventBus, Storage } from '../../core.js';
import { EmbeddingsClient } from '../../embeddings-client.js';
import { Git } from '../../git.js';
import { IgnoreManager } from '../../ignore.js';
import { LLM } from '../../llm/api.js';
import { ConversationManager } from '../../chat/conversations.js';

import { createInMemoryChunkStore } from './store.js';
import { createProductionIngestWalker } from './wiring.js';
import { createSemanticStrategy } from './strategies/semantic.js';
import { createStructuralStrategy } from './strategies/structural.js';
import { createThematicStrategy } from './strategies/thematic.js';
import { compose } from './composer.js';
import { buildBM25Index } from './bm25-indexer.js';
import { buildParaphraserFromSettings } from './query-paraphraser.js';
import { createParaphraseIdbCache } from './paraphrase-cache-idb.js';
import { buildExpanderFromSettings } from './query-expander.js';
import { createExpanderIdbCache } from './expander-cache-idb.js';
import { defaultComposeFiltersResolver } from './measurement.js';
import { LRU } from './lru.js';
import {
    rollupToFiles,
    projectKeyFromString,
    resolveLiveBranches,
} from './manager-helpers.js';

// ============================================
// Constants & helpers
// ============================================

/** Max file size (bytes) considered for ingest, before delegation to IgnoreManager. */
const MAX_INDEX_SIZE = 250_000;

/** Embed cache scope. Composer budget. Walker concurrency. */
const DEFAULT_COLLECTION = 'default';
const DEFAULT_BUDGET = Object.freeze({
    total_tokens: 8000,
    system_reserve: 0,
    output_reserve: 0,
    history_reserve: 0,
});
const DEFAULT_CONCURRENCY = 4;

/** Storage key prefix for persisted chunk-store snapshots. New shape; legacy `embeddings-index-` keys are unrelated. */
const STORAGE_PREFIX = 'retrieval-chunks-';

/** @param {string} owner @param {string} repo @param {string} branch */
function projectKeyFor(owner, repo, branch) {
    return `${owner}/${repo}@${branch}`;
}

/** @param {string} projectKey */
function storageKeyFor(projectKey) {
    return `${STORAGE_PREFIX}${projectKey}`;
}

/**
 * Decide whether a path/size should be ingested. Mirrors legacy
 * ContextManager.shouldIndex — IgnoreManager handles binary / vendor /
 * generated patterns + a hard size ceiling.
 *
 * @param {string} path
 * @param {number} [size]
 * @returns {boolean}
 */
function shouldIndex(path, size) {
    if (typeof path !== 'string' || path.length === 0) return false;
    if (typeof size === 'number' && size > MAX_INDEX_SIZE) return false;
    return !IgnoreManager.isIgnored(path, size);
}

// ============================================
// Module-private state
// ============================================

/** @type {ReturnType<typeof createInMemoryChunkStore>} */
const store = createInMemoryChunkStore();

/** Active collection (= projectKey for current branch). Set by `_setProject`. */
let _collection = DEFAULT_COLLECTION;

/** Current indexed projectKey, or null if none loaded yet. */
let _indexedProject = /** @type {string|null} */ (null);

/** Indexing state (mirrors legacy field semantics). */
let _indexing = false;
let _indexProgress = /** @type {{current: number, total: number}|null} */ (null);
let _indexGeneration = 0;
let _manualPause = false;
let _autoPause = false;
let _pauseResolve = /** @type {(() => void)|null} */ (null);
let _abortController = /** @type {AbortController|null} */ (null);

/** Resume bookkeeping — paths skipped/pending when last walk aborted. */
let _resumeRemaining = /** @type {string[]|null} */ (null);

/** Per-call query stats. */
let _queryCount = 0;
let _lastQueried = /** @type {number|null} */ (null);

/** Lazily-built BM25 index over the current collection. Null until first ingest finishes. */
let _bm25Index = /** @type {any} */ (null);

/** Strategy bundle — built lazily once `EmbeddingsClient.init()` resolves. */
let _strategies = /** @type {any[]|null} */ (null);

/**
 * 1.6.9 — query result LRU + index fingerprint.
 *
 * `_queryCache` short-circuits the whole `compose()` pipeline for repeat
 * `findRelevantFiles(query, topK)` calls within a session. Keys carry
 * the current `_indexFingerprint` so any chunk-store mutation
 * (re-ingest, file create/update/delete, branch switch, clear) bumps
 * the fingerprint and orphans the cached entries — they age out via
 * LRU rather than being swept on every mutation.
 *
 * The LRU also caches `[]` results so empty-corpus queries don't re-
 * walk the store; absent caching this would re-trigger `indexProject()`
 * on every miss for a corpus that genuinely has no matches.
 */
const QUERY_CACHE_DEFAULT_CAPACITY = 64;
/** @type {LRU<{files: Array<{path: string, similarity: number, summary: string}>, fingerprint: number}>} */
let _queryCache = new LRU(QUERY_CACHE_DEFAULT_CAPACITY);
let _indexFingerprint = 0;
let _queryCacheHits = 0;
let _queryCacheMisses = 0;

function _bumpIndexFingerprint() {
    _indexFingerprint += 1;
    if (_strategies) {
        for (const s of _strategies) {
            if (s && typeof s.clearMemo === 'function') {
                try { s.clearMemo(); } catch { /* ignore */ }
            }
        }
    }
}

/**
 * Compose a query-cache key. Query is normalized (lowercase + collapse
 * whitespace) so trivial variations land on the same entry; topK is
 * appended verbatim. The index fingerprint is NOT in the key — it's
 * stored alongside the cached value and compared on lookup, so an
 * entry written under fingerprint=2 stays addressable after a bump
 * but only returns on a fingerprint match. Avoids stranding entries
 * under a key that nothing will look up again.
 *
 * @param {string} query
 * @param {number} topK
 * @returns {string}
 */
function _queryCacheKey(query, topK) {
    const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ');
    return `${normalized}::${topK}`;
}

/**
 * Singleton paraphrase cache backed by IDB. Built once on demand;
 * `null` in environments without IndexedDB (Node tests). The
 * paraphraser's existing in-memory `Map` default takes over when this
 * returns `null`.
 *
 * @type {ReturnType<typeof createParaphraseIdbCache>|undefined}
 */
let _paraphraseIdbCache;

function _getParaphraseIdbCache() {
    if (_paraphraseIdbCache === undefined) {
        _paraphraseIdbCache = createParaphraseIdbCache();
    }
    return _paraphraseIdbCache;
}

/**
 * Lazy-initialised IDB-backed expansion-cache instance (1.8.1).
 * Constructed on first `findRelevantFiles` call so node tests / cold
 * starts pay nothing. Cleared in the same `_resetForTests` path as the
 * paraphrase cache.
 *
 * @type {ReturnType<typeof createExpanderIdbCache>|undefined}
 */
let _expanderIdbCache;

function _getExpanderIdbCache() {
    if (_expanderIdbCache === undefined) {
        _expanderIdbCache = createExpanderIdbCache();
    }
    return _expanderIdbCache;
}

// ============================================
// Strategy bundle
// ============================================

/**
 * Build the strategies array. The Semantic strategy reads `_bm25Index`
 * through a closure so a lazy fill after walker completion takes effect
 * on the very next query without strategy reconstruction.
 */
function _buildStrategies() {
    if (_strategies) return _strategies;
    const semantic = createSemanticStrategy({
        embedQuery: (text) => EmbeddingsClient.embed(text),
        chunkVectorSearch: store.chunkVectorSearch,
        getBM25Index: (coll) => coll === _collection ? _bm25Index : null,
    });
    const structural = createStructuralStrategy({
        runSemanticRetrieve: (req, k) => semantic.retrieve(req, k),
        getChunkByID: store.getChunkByID,
    });
    const thematic = createThematicStrategy({
        // @ts-ignore — store has the method even if the typedef doesn't list it
        getChunksForClustering: (collection) => store.getAllChunksForCollection(collection),
    });
    _strategies = [semantic, structural, thematic];
    return _strategies;
}

// ============================================
// Pause / resume
// ============================================

function _emitPauseState() {
    EventBus.emit('context:pauseChanged', {
        paused: _manualPause || _autoPause,
        manual: _manualPause,
        auto: _autoPause,
        indexing: _indexing,
        progress: _indexProgress,
    });
}

function _resolvePause() {
    if (_pauseResolve) {
        const r = _pauseResolve;
        _pauseResolve = null;
        r();
    }
}

// ============================================
// IDB persistence
// ============================================

/**
 * Persist the current chunk store + stats to IndexedDB under the active
 * project key. Best-effort — failures log but don't throw.
 */
async function saveIndexToStorage() {
    if (!_indexedProject) return;
    try {
        // @ts-ignore
        const allChunks = await store.getAllChunksForCollection(_collection);
        /** @type {Object<string, string>} */
        const sourceHashes = {};
        const seenSources = new Set();
        for (const chunk of allChunks) {
            const uri = chunk?.metadata?.source_uri;
            if (typeof uri === 'string' && !seenSources.has(uri)) {
                seenSources.add(uri);
                const h = store.getSourceHash(uri);
                if (typeof h === 'string') sourceHashes[uri] = h;
            }
        }
        const data = {
            version: 1,
            project: _indexedProject,
            timestamp: Date.now(),
            collection: _collection,
            chunks: allChunks,
            sourceHashes,
            queryCount: _queryCount,
            lastQueried: _lastQueried,
        };
        Storage.set(storageKeyFor(_indexedProject), data);
    } catch (err) {
        console.warn('[Retrieval] Failed to persist index:', err);
    }
}

/**
 * Restore a chunk-store snapshot for the current project's branch from
 * IDB. Returns true on success, false if no snapshot exists or it's stale.
 *
 * @returns {Promise<boolean>}
 */
async function loadIndexFromStorage() {
    if (!State.currentProject) return false;
    const { owner, repo } = State.currentProject;
    const branch = State.currentBranch;
    const projectKey = projectKeyFor(owner, repo, branch);
    /** @type {any} */
    const data = Storage.get(storageKeyFor(projectKey));
    if (!data || !Array.isArray(data.chunks)) return false;

    const age = Date.now() - (data.timestamp || 0);
    const maxAgeDays = State.settings.embeddingCacheExpiry || 7;
    const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;
    if (age > maxAge) {
        console.log('[Retrieval] Cached index is stale, will re-walk');
        return false;
    }

    // Reset store state for the active collection (guard against stale chunks).
    _setProject(owner, repo, branch);
    try {
        if (data.chunks.length > 0) {
            store.upsert(data.chunks);
        }
        if (data.sourceHashes && typeof data.sourceHashes === 'object') {
            for (const [uri, hash] of Object.entries(data.sourceHashes)) {
                if (typeof hash === 'string') store.setSourceHash(uri, hash);
            }
        }
        _bm25Index = data.chunks.length > 0 ? buildBM25Index(data.chunks) : null;
        _indexedProject = projectKey;
        _queryCount = data.queryCount || 0;
        _lastQueried = data.lastQueried || null;
        console.log(`[Retrieval] Loaded ${data.chunks.length} chunks from cache`);
        return true;
    } catch (err) {
        console.warn('[Retrieval] Failed to load cached index:', err);
        return false;
    }
}

// ============================================
// Project / collection management
// ============================================

function _setProject(owner, repo, branch) {
    const projectKey = projectKeyFor(owner, repo, branch);
    if (_collection === projectKey) return;
    // Drop any chunks still in the prior collection — limits memory growth on long sessions.
    if (_collection && _collection !== projectKey) {
        try {
            // @ts-ignore
            store.getAllChunksForCollection(_collection).then((chunks) => {
                const ids = chunks.map(c => c.id).filter(Boolean);
                if (ids.length > 0) store.markStale(ids);
            }).catch(() => {});
        } catch { /* ignore */ }
    }
    _collection = projectKey;
    _bm25Index = null;
    _resumeRemaining = null;
    _bumpIndexFingerprint();
}

// ============================================
// Indexing (walk)
// ============================================

/**
 * Walk the current project's eligible source URIs through the production
 * ingest pipeline, populate the chunk store, and build the BM25 index.
 *
 * @param {boolean} force Force re-walk even if already indexed.
 * @param {boolean} resume Resume a partial walk if one was aborted.
 * @returns {Promise<number>} Number of chunks added.
 */
async function indexProject(force = false, resume = false) {
    if (!isEnabled()) return 0;
    if (!State.currentProject) {
        console.log('[Retrieval] No project loaded');
        return 0;
    }

    const snapshot = {
        owner: State.currentProject.owner,
        repo: State.currentProject.repo,
        branch: State.currentBranch,
        fileTree: [...State.fileTree],
    };
    const projectKey = projectKeyFor(snapshot.owner, snapshot.repo, snapshot.branch);

    // Cancel any in-flight walk before starting a new one.
    if (_indexing) {
        console.log(`[Retrieval] Cancelling in-progress walk for ${projectKey}`);
        _indexGeneration += 1;
        if (_abortController) _abortController.abort();
        await new Promise(r => setTimeout(r, 50));
    }

    // Already indexed? Short-circuit unless forced/resuming.
    // @ts-ignore
    const existingChunks = await store.getAllChunksForCollection(projectKey);
    if (!force && !resume && _indexedProject === projectKey && existingChunks.length > 0) {
        console.log('[Retrieval] Project already indexed');
        return existingChunks.length;
    }

    _setProject(snapshot.owner, snapshot.repo, snapshot.branch);
    if (!resume) {
        if (existingChunks.length > 0) {
            const ids = existingChunks.map(c => c.id).filter(Boolean);
            store.markStale(ids);
        }
        _bm25Index = null;
        _queryCount = 0;
        _lastQueried = null;
    }

    const allFiles = snapshot.fileTree.filter(f => f.type === 'file');
    const eligible = allFiles.filter(f => shouldIndex(f.path, f.size));
    const skipped = allFiles.length - eligible.length;
    const maxFiles = State.settings.maxIndexFiles || 200;
    let files = eligible.slice(0, maxFiles);

    if (resume && _resumeRemaining && _resumeRemaining.length > 0) {
        const remaining = new Set(_resumeRemaining);
        files = files.filter(f => remaining.has(f.path));
        console.log(`[Retrieval] Resuming with ${files.length} pending files`);
    }

    const sourceUris = files.map(f => f.path);
    const totalFiles = sourceUris.length;
    if (totalFiles === 0) {
        _indexedProject = projectKey;
        return 0;
    }

    const generation = ++_indexGeneration;
    _indexing = true;
    _indexProgress = { current: 0, total: totalFiles };
    _autoPause = false;
    _abortController = new AbortController();

    EventBus.emit('context:indexStart', { project: projectKey, resuming: resume });
    _emitPauseState();

    const walkedUris = new Set();
    let chunksAdded = 0;

    try {
        const modelId = State.settings.embeddingModel || 'Xenova/all-MiniLM-L6-v2';
        const project = { owner: snapshot.owner, repo: snapshot.repo, ref: snapshot.branch };

        const { walker } = await createProductionIngestWalker({
            Git,
            EmbeddingsClient,
            project,
            modelId,
            store,
            collection: projectKey,
            concurrency: DEFAULT_CONCURRENCY,
            onProgress: (done, total, latest) => {
                if (_indexGeneration !== generation) return;
                if (latest && typeof latest.source_uri === 'string') {
                    walkedUris.add(latest.source_uri);
                }
                _indexProgress = { current: done, total: total > 0 ? total : totalFiles };
                EventBus.emit('context:indexProgress', {
                    current: done,
                    total: _indexProgress.total,
                    percent: Math.round((done / _indexProgress.total) * 100),
                });
            },
        });

        const walkResult = await walker.walk(sourceUris, { signal: _abortController.signal });

        if (_indexGeneration !== generation) {
            console.log('[Retrieval] Walk completed but project switched — discarding');
            return 0;
        }

        if (walkResult.aborted) {
            // Build resume bookkeeping from the URIs we never reached.
            const remaining = sourceUris.filter(uri => !walkedUris.has(uri));
            _resumeRemaining = remaining;
        } else {
            _resumeRemaining = null;
            // Build BM25 over the populated corpus.
            // @ts-ignore
            const allChunks = await store.getAllChunksForCollection(projectKey);
            _bm25Index = buildBM25Index(allChunks);
            chunksAdded = allChunks.length;
            _bumpIndexFingerprint();
        }

        _indexedProject = projectKey;

        await saveIndexToStorage();

        EventBus.emit('context:indexComplete', {
            project: projectKey,
            filesIndexed: walkedUris.size,
            totalFiles: allFiles.length,
            eligible: eligible.length,
            skipped,
        });

        return chunksAdded;
    } catch (err) {
        console.error('[Retrieval] Indexing failed:', err);
        EventBus.emit('context:indexError', { error: /** @type {Error} */ (err).message });
        return 0;
    } finally {
        if (_indexGeneration === generation) {
            _indexing = false;
            _indexProgress = null;
            _autoPause = false;
            _abortController = null;
            _emitPauseState();
        }
    }
}

// ============================================
// Per-file CRUD updates (incremental ingest)
// ============================================

/**
 * Re-ingest a single source URI through the controller. Used by the
 * `git:fileCreated` / `git:fileUpdated` / `context:prMerged` listeners.
 * Best-effort; failures log silently.
 *
 * @param {string} uri
 */
async function _ingestSingle(uri) {
    if (!isEnabled() || !_indexedProject) return;
    if (!shouldIndex(uri)) return;
    try {
        // Build a one-shot controller pinned to the active collection.
        const { controller } = await createProductionIngestWalker({
            Git,
            EmbeddingsClient,
            project: projectKeyFromString(_indexedProject),
            modelId: State.settings.embeddingModel || 'Xenova/all-MiniLM-L6-v2',
            store,
            collection: _collection,
            concurrency: 1,
        });
        const result = await controller.ingest(uri);
        if (result.status === 'ingested') {
            // Rebuild BM25 over the updated corpus — cheap relative to a full walk.
            // @ts-ignore
            const allChunks = await store.getAllChunksForCollection(_collection);
            _bm25Index = buildBM25Index(allChunks);
            _bumpIndexFingerprint();
            await saveIndexToStorage();
        }
    } catch (err) {
        console.warn(`[Retrieval] Failed to ingest ${uri}:`, err);
    }
}

/**
 * Drop a source's chunks. Used by `git:fileDeleted` / `git:fileRenamed`.
 *
 * @param {string} uri
 */
function removeFileIndex(uri) {
    if (!_indexedProject) return;
    const ids = store.chunkIdsForSource(uri);
    if (ids.length === 0) return;
    store.markStale(ids);
    _bumpIndexFingerprint();
    EventBus.emit('context:fileRemoved', { path: uri });
    saveIndexToStorage();
}

// ============================================
// Public API — query
// ============================================

function isEnabled() {
    return State.settings.useEmbeddings === true;
}

/**
 * Find relevant files for a query. Drop-in replacement for legacy
 * `ContextManager.findRelevantFiles`. Returns `{path, similarity, summary}`
 * records; capped at `topK`.
 *
 * @param {string} query
 * @param {number} [topK]
 * @returns {Promise<Array<{path: string, similarity: number, summary: string}>>}
 */
async function findRelevantFiles(query, topK = 5) {
    if (!isEnabled()) return [];
    if (typeof query !== 'string' || query.trim().length === 0) return [];

    // 1.6.9 — query cache short-circuit. Identical (query, topK) within the
    // current index generation returns immediately, bypassing semantic k-NN,
    // BM25, structural walks, paraphrase LLM call, and rollup. The
    // `retrieval:turn-stats` event still fires (with all-zero strategy stats
    // and `cache_hit: true`) so the cost dashboard reflects that retrieval
    // ran for this turn — the win is the absence of token spend, not
    // absence of attribution.
    const cacheKey = _queryCacheKey(query, topK);
    const cached = _queryCache.get(cacheKey);
    if (cached && cached.fingerprint === _indexFingerprint) {
        _queryCacheHits += 1;
        _trackQuery();
        _emitRetrievalCacheHit();
        console.log(`[Retrieval] Query cache HIT for: "${query}"`);
        return cached.files.map(f => ({ ...f }));
    }
    _queryCacheMisses += 1;

    // @ts-ignore
    const corpusChunks = await store.getAllChunksForCollection(_collection);
    if (corpusChunks.length === 0) {
        console.log('[Retrieval] No chunks indexed, walking project first…');
        await indexProject(false, false);
    }
    // @ts-ignore
    const finalCorpus = await store.getAllChunksForCollection(_collection);
    if (finalCorpus.length === 0) return [];

    try {
        const strategies = _buildStrategies();
        const filters = defaultComposeFiltersResolver({ category: null });
        // Merge in the score weights so live calls match the canonical 1.5.11 T7 recipe.
        // (`defaultComposeFiltersResolver` already merges DEFAULT_SCORE_WEIGHTS.)

        /** @type {any} */
        const req = {
            task: '',
            query,
            collections: [_collection],
            budget: DEFAULT_BUDGET,
            history: null,
            filters,
            strategy_hints: null,
            priority_pins: null,
            task_ledger: null,
        };

        const paraphraser = buildParaphraserFromSettings(State.settings, {
            chatFn: (args) => LLM.chat(args),
            // 1.6.9 — back the per-instance cache with IDB so paraphrases
            // survive page reload. Falls back to the in-memory default
            // when IndexedDB isn't available (Node tests).
            cache: _getParaphraseIdbCache() ?? undefined,
        });
        // 1.8.1 — Cross-file query expansion (lever B). Mutually exclusive
        // with the paraphraser at the back-end level: the Composer ignores
        // the paraphraser when an expander is wired (so the UI guard is
        // belt-and-braces, not load-bearing). Same chatFn as paraphrase —
        // both pre-passes route LLM calls through `LLM.chat` so cost
        // accounting works through the existing session-cost delta.
        const expander = buildExpanderFromSettings(State.settings, {
            chatFn: (args) => LLM.chat(args),
            cache: _getExpanderIdbCache() ?? undefined,
        });

        /** @type {any} */
        const composeOpts = {};
        if (expander) composeOpts.queryExpander = expander;
        else if (paraphraser) composeOpts.queryParaphraser = paraphraser;

        // 1.6.8 — snapshot session totals before compose() so a delta
        // captures any LLM tokens spent inside retrieval (paraphrase chatFn
        // today; future LLM-spending strategies like a reranker would land
        // here too). Embedding-token plumbing is deferred — semantic's
        // EmbeddingsClient calls don't currently route through LLM._trackUsage.
        const sc = State.sessionCost || {};
        const tokensBefore = (sc.totalInputTokens || 0) + (sc.totalOutputTokens || 0);

        const result = await compose(req, { strategies, getChunkByID: store.getChunkByID }, composeOpts);

        const files = rollupToFiles(result, topK);

        // 1.6.9 — store the rolled-up file list under the current fingerprint
        // so a repeat call within this index generation hits the cache. Empty
        // results are cached too (avoids re-walking a corpus that genuinely
        // matches nothing).
        _queryCache.set(cacheKey, {
            files: files.map(f => ({ ...f })),
            fingerprint: _indexFingerprint,
        });

        _emitRetrievalTurnStats(result, tokensBefore, !!paraphraser, !!expander);

        _trackQuery();

        console.log(`[Retrieval] Found ${files.length} relevant files for query: "${query}"`);
        files.forEach((r, i) => {
            console.log(`  ${i + 1}. ${r.path} (similarity: ${r.similarity.toFixed(3)})`);
        });

        return files;
    } catch (err) {
        console.error('[Retrieval] Failed to find relevant files:', err);
        return [];
    }
}

/**
 * 1.6.8 — translate Composer diagnostics + the session-cost delta into a
 * `retrieval:turn-stats` event so the cost-recorder can attribute hits and
 * paraphrase tokens to the active conversation. No-op when no conversation
 * is active or the diagnostics block is missing (defensive — Composer
 * always populates `chunks_returned_per_strategy` today).
 *
 * @param {any} composeResult        Return value of `compose()`.
 * @param {number} tokensBefore      `State.sessionCost.totalInputTokens + totalOutputTokens` snapshot taken before `compose()`.
 * @param {boolean} hasParaphraser   True when the paraphraser wired in this call. Used to decide whether to record a `paraphrase` row.
 * @param {boolean} [hasExpander]    1.8.1 — True when the cross-file expander was wired in this call. When present, the paraphrase attribution slot is replaced by an `expansion` slot (the two are mutually exclusive at the back end so only one ever fires per turn).
 */
function _emitRetrievalTurnStats(composeResult, tokensBefore, hasParaphraser, hasExpander = false) {
    const convId = ConversationManager.getActiveId();
    if (!convId) return;

    const diag = composeResult && composeResult.diagnostics;
    const perStrategy = (diag && diag.chunks_returned_per_strategy) || {};

    /** @type {Object<string, {hits: number, tokens: number}>} */
    const strategyStats = {};
    for (const [name, hits] of Object.entries(perStrategy)) {
        strategyStats[name] = { hits: Number(hits) || 0, tokens: 0 };
    }

    const sc = State.sessionCost || {};
    const tokensAfter = (sc.totalInputTokens || 0) + (sc.totalOutputTokens || 0);
    const prePassTokens = Math.max(tokensAfter - tokensBefore, 0);

    if (hasExpander) {
        // 1.8.1 — emit an `expansion` row when the cross-file expander was
        // wired (mutually exclusive with paraphrase per the Composer's
        // priority rule). Always emit even on zero tokens (cache hit) so
        // the dashboard reflects that expansion was active for this turn.
        const slot = strategyStats.expansion || { hits: 0, tokens: 0 };
        slot.tokens = prePassTokens;
        strategyStats.expansion = slot;
    } else if (hasParaphraser) {
        // Always emit a `paraphrase` row when the paraphraser was wired —
        // even when tokens are 0 (cache hit) — so the dashboard reflects
        // that paraphrasing was active for this turn.
        const slot = strategyStats.paraphrase || { hits: 0, tokens: 0 };
        slot.tokens = prePassTokens;
        strategyStats.paraphrase = slot;
    } else if (prePassTokens > 0) {
        // Defensive: if a future code path spends tokens during retrieval
        // without a paraphraser/expander instance, attribute them under
        // `retrieval` so they don't vanish silently.
        strategyStats.retrieval = { hits: 0, tokens: prePassTokens };
    }

    if (Object.keys(strategyStats).length === 0) return;

    EventBus.emit('retrieval:turn-stats', {
        conversationId: convId,
        strategyStats,
    });
}

/**
 * 1.6.9 — emit a `retrieval:turn-stats` event for a query-cache hit so
 * the cost-recorder still attributes the turn (zero tokens, hits-from-
 * cache marker). Mirrors the event shape from `_emitRetrievalTurnStats`
 * but populates `cache_hit: true` and a synthetic `cache` strategy slot.
 */
function _emitRetrievalCacheHit() {
    const convId = ConversationManager.getActiveId();
    if (!convId) return;
    EventBus.emit('retrieval:turn-stats', {
        conversationId: convId,
        cache_hit: true,
        strategyStats: {
            cache: { hits: 1, tokens: 0 },
        },
    });
}

function _trackQuery() {
    _queryCount += 1;
    _lastQueried = Date.now();
    if (_indexedProject) {
        const key = storageKeyFor(_indexedProject);
        const existing = Storage.get(key);
        if (existing) {
            existing.queryCount = _queryCount;
            existing.lastQueried = _lastQueried;
            Storage.set(key, existing);
        }
    }
}

// ============================================
// Branch-index lifecycle (parity with legacy)
// ============================================

function clearIndex() {
    // @ts-ignore
    store.getAllChunksForCollection(_collection).then(chunks => {
        const ids = chunks.map(c => c.id).filter(Boolean);
        if (ids.length > 0) store.markStale(ids);
        _bm25Index = null;
        _indexedProject = null;
        _bumpIndexFingerprint();
        EventBus.emit('context:indexCleared');
    }).catch(() => {});
}

function removeIndexForBranch(branchName) {
    if (!State.currentProject) return;
    const { owner, repo } = State.currentProject;
    const projectKey = projectKeyFor(owner, repo, branchName);
    Storage.remove(storageKeyFor(projectKey));
    if (_indexedProject === projectKey) {
        // @ts-ignore
        store.getAllChunksForCollection(projectKey).then(chunks => {
            const ids = chunks.map(c => c.id).filter(Boolean);
            if (ids.length > 0) store.markStale(ids);
            _indexedProject = null;
            _bm25Index = null;
            _bumpIndexFingerprint();
        }).catch(() => {});
    }
    console.log(`[Retrieval] Removed index for branch: ${branchName}`);
}

/**
 * @param {string} sourceBranch
 * @param {string} targetBranch
 * @returns {boolean}
 */
function copyIndexForBranch(sourceBranch, targetBranch) {
    if (!State.currentProject) return false;
    const { owner, repo } = State.currentProject;
    const sourceKey = storageKeyFor(projectKeyFor(owner, repo, sourceBranch));
    const targetKey = storageKeyFor(projectKeyFor(owner, repo, targetBranch));
    /** @type {any} */
    const sourceData = Storage.get(sourceKey);
    if (!sourceData || !Array.isArray(sourceData.chunks)) {
        console.log(`[Retrieval] No index to copy from ${sourceBranch}`);
        return false;
    }
    const cloned = {
        ...sourceData,
        project: projectKeyFor(owner, repo, targetBranch),
        timestamp: Date.now(),
        collection: projectKeyFor(owner, repo, targetBranch),
        // Re-tag chunks to the new collection. ChunkID stays stable (content-derived).
        chunks: sourceData.chunks.map(c => ({ ...c, collection: projectKeyFor(owner, repo, targetBranch) })),
        queryCount: 0,
        lastQueried: null,
    };
    Storage.set(targetKey, cloned);
    console.log(`[Retrieval] Copied index (${sourceData.chunks.length} chunks) from ${sourceBranch} → ${targetBranch}`);
    return true;
}

/**
 * Drop persisted indexes for branches no longer in the live list.
 *
 * @param {string[]} liveBranches
 */
function cleanupOrphanedIndexes(liveBranches) {
    if (!State.currentProject) return;
    const { owner, repo } = State.currentProject;
    const prefix = `${STORAGE_PREFIX}${owner}/${repo}@`;
    const branchSet = new Set(liveBranches);
    let removed = 0;
    for (const key of Storage.keys(STORAGE_PREFIX)) {
        if (key.startsWith(prefix)) {
            const branch = key.slice(prefix.length);
            if (!branchSet.has(branch)) {
                Storage.remove(key);
                removed += 1;
                console.log(`[Retrieval] Cleaned up orphaned index: ${branch}`);
            }
        }
    }
    if (removed > 0) console.log(`[Retrieval] Cleaned up ${removed} orphaned index(es)`);
}

/**
 * Incremental re-ingest after a merge.
 *
 * @param {string[]} changedPaths
 * @returns {Promise<number>}
 */
async function reindexChanged(changedPaths) {
    if (!isEnabled() || !_indexedProject) return 0;
    if (!Array.isArray(changedPaths)) return 0;
    let updated = 0;
    for (const path of changedPaths) {
        if (!shouldIndex(path)) continue;
        try {
            await _ingestSingle(path);
            updated += 1;
        } catch {
            // File may have been deleted during the merge — drop from index.
            removeFileIndex(path);
        }
    }
    if (updated > 0) {
        await saveIndexToStorage();
        console.log(`[Retrieval] Incrementally re-ingested ${updated} changed file(s)`);
    }
    return updated;
}

// ============================================
// Pause / resume API
// ============================================

function togglePause() {
    _manualPause = !_manualPause;
    if (!_manualPause) _autoPause = false;
    if (_manualPause && _abortController) {
        // Abort the in-flight walk; resume re-walks the unprocessed URIs.
        _abortController.abort();
    }
    _emitPauseState();
    if (!_manualPause && !_autoPause) {
        _resolvePause();
        // If we have a partial walk pending, resume it.
        if (_resumeRemaining && _resumeRemaining.length > 0) {
            indexProject(false, true);
        }
    }
}

function autoPause() {
    if (!_indexing || _manualPause) return;
    if (!_autoPause) {
        _autoPause = true;
        if (_abortController) _abortController.abort();
        _emitPauseState();
    }
}

function autoResume() {
    if (!_autoPause) return;
    _autoPause = false;
    _emitPauseState();
    if (!_manualPause) {
        _resolvePause();
        if (_resumeRemaining && _resumeRemaining.length > 0) {
            indexProject(false, true);
        }
    }
}

// ============================================
// Stats getters (for legacy consumer compatibility)
// ============================================

function getStats() {
    return {
        // @ts-ignore — sync access via store.stats() for the chunk count
        filesIndexed: store.stats().sources,
        project: _indexedProject,
        isIndexing: _indexing,
        enabled: isEnabled(),
        queryCount: _queryCount,
        lastQueried: _lastQueried,
        // 1.6.9 — cache observability for the LLM debug modal.
        cache: {
            queryCacheHits: _queryCacheHits,
            queryCacheMisses: _queryCacheMisses,
            queryCacheSize: _queryCache.size,
            indexFingerprint: _indexFingerprint,
        },
    };
}

function getFilesIndexed() { return store.stats().sources; }
function getIndexProgress() { return _indexProgress; }
function isIndexing() { return _indexing; }
function isPaused() { return _manualPause || _autoPause; }
function getIndexedProject() { return _indexedProject; }

/**
 * Count how many files in the current State.fileTree would be eligible for
 * indexing. Used by find_relevant_files' readiness gate (github#29) to decide
 * whether the index has enough coverage to return useful results, vs. failing
 * fast with a recoverable `indexer_not_ready` envelope. Live recompute (not
 * cached) so it stays accurate as the tree changes.
 */
function getEligibleFileCount() {
    const tree = State.fileTree;
    if (!Array.isArray(tree)) return 0;
    let count = 0;
    for (const f of tree) {
        if (f?.type !== 'file') continue;
        if (shouldIndex(f.path, f.size)) count++;
    }
    return count;
}

// ============================================
// Public surface
// ============================================

export const RetrievalManager = {
    isEnabled,
    findRelevantFiles,
    indexProject,
    reindexChanged,
    removeFileIndex,
    clearIndex,
    removeIndexForBranch,
    copyIndexForBranch,
    cleanupOrphanedIndexes,
    saveIndexToStorage,
    loadIndexFromStorage,
    togglePause,
    autoPause,
    autoResume,
    getStats,
    getFilesIndexed,
    getEligibleFileCount,
    getIndexProgress,
    isIndexing,
    isPaused,
    getIndexedProject,
    /** Test/diagnostic seam: drops all in-memory state (does NOT touch IDB). */
    _resetForTesting() {
        // @ts-ignore
        store.getAllChunksForCollection(_collection).then(chunks => {
            const ids = chunks.map(c => c.id).filter(Boolean);
            if (ids.length > 0) store.markStale(ids);
        }).catch(() => {});
        _indexedProject = null;
        _indexing = false;
        _indexProgress = null;
        _indexGeneration = 0;
        _manualPause = false;
        _autoPause = false;
        _pauseResolve = null;
        _abortController = null;
        _resumeRemaining = null;
        _queryCount = 0;
        _lastQueried = null;
        _bm25Index = null;
        _strategies = null;
        _collection = DEFAULT_COLLECTION;
        // 1.6.9 — reset cache state for tests.
        _queryCache = new LRU(QUERY_CACHE_DEFAULT_CAPACITY);
        _indexFingerprint = 0;
        _queryCacheHits = 0;
        _queryCacheMisses = 0;
        _paraphraseIdbCache = undefined;
        _expanderIdbCache = undefined;
    },
};

// ============================================
// Event listeners — automatic index lifecycle
// ============================================

EventBus.on('project:loaded', async () => {
    if (!isEnabled()) return;
    const loaded = await loadIndexFromStorage();
    if (!loaded && State.settings.autoReindex !== false) {
        console.log('[Retrieval] Auto-walking project…');
        setTimeout(() => indexProject(), 1000);
    }
});

EventBus.on('branch:switch', async () => {
    if (!isEnabled() || !State.currentProject) return;
    const { owner, repo } = State.currentProject;
    const branch = State.currentBranch;
    const newKey = projectKeyFor(owner, repo, branch);
    if (_indexedProject === newKey) return; // Already on this branch
    _setProject(owner, repo, branch);
    _indexedProject = null;
    _queryCount = 0;
    _lastQueried = null;
    const loaded = await loadIndexFromStorage();
    if (!loaded && State.settings.autoReindex !== false) {
        setTimeout(() => indexProject(), 1000);
    }
});

EventBus.on('git:branchDeleted', ({ name }) => {
    if (!isEnabled()) return;
    removeIndexForBranch(name);
});

EventBus.on('branch:created', ({ sourceBranch, targetBranch }) => {
    if (!isEnabled()) return;
    copyIndexForBranch(sourceBranch, targetBranch);
});

EventBus.on('branches:refresh', (payload) => {
    if (!isEnabled()) return;
    // Most call sites emit with no payload (the button at app.js:btnRefreshFiles
    // and the post-merge fan-out at pr-tools.js); resolve from State.branches
    // inside the timeout so refreshBranches() has a chance to land first.
    setTimeout(() => {
        const liveBranches = resolveLiveBranches(payload, State.branches);
        if (!liveBranches || liveBranches.length === 0) return;
        cleanupOrphanedIndexes(liveBranches);
    }, 500);
});

EventBus.on('context:prMerged', async ({ deletedBranch, changedFiles }) => {
    if (!isEnabled() || !State.currentProject) return;

    if (deletedBranch) removeIndexForBranch(deletedBranch);

    const { owner, repo } = State.currentProject;
    const branch = State.currentBranch;
    const currentKey = projectKeyFor(owner, repo, branch);
    if (_indexedProject === currentKey && changedFiles?.length > 0) {
        await reindexChanged(changedFiles);
    }
});

EventBus.on('git:fileCreated', async ({ path, content }) => {
    if (!isEnabled()) return;
    if (!shouldIndex(path)) return;
    await _ingestSingle(path);
});

EventBus.on('git:fileUpdated', async ({ path, content }) => {
    if (!isEnabled()) return;
    if (!shouldIndex(path)) return;
    await _ingestSingle(path);
});

EventBus.on('git:fileDeleted', ({ path }) => {
    if (!isEnabled()) return;
    removeFileIndex(path);
});

EventBus.on('git:fileRenamed', async ({ oldPath, newPath, content }) => {
    if (!isEnabled()) return;
    removeFileIndex(oldPath);
    if (shouldIndex(newPath)) {
        await _ingestSingle(newPath);
    }
});
