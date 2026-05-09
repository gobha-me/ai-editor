// @ts-check
/**
 * Pure helpers for `RetrievalManager`. Factored out of `manager.js` so
 * `node --test` can exercise them — the manager itself imports
 * browser-bound `core.js` / `git.js` / `embeddings-client.js` / `llm/api.js`
 * and is not node-importable.
 *
 * @module intelligence/retrieval/manager-helpers
 */

/**
 * Synthesize a one-line summary from a chunk for the legacy LLM-tool
 * response shape `{path, similarity, summary}`. Prefers structural
 * heading-path (prose) → first non-blank line (code / structured) →
 * truncated raw bytes. Capped at ~120 chars.
 *
 * @param {object|null|undefined} chunk
 * @returns {string}
 */
export function summaryForChunk(chunk) {
    if (!chunk || typeof chunk !== 'object') return '';
    const meta = /** @type {any} */ (chunk).metadata;
    const heading = meta?.structural?.heading_path;
    if (Array.isArray(heading) && heading.length > 0) {
        return heading.join(' › ').slice(0, 120);
    }
    const bytes = /** @type {any} */ (chunk).bytes;
    if (typeof bytes === 'string' && bytes.length > 0) {
        const firstLine = bytes.split('\n').find(l => l.trim().length > 0) || '';
        return firstLine.trim().slice(0, 120);
    }
    return '';
}

/**
 * Roll up Composer's chunk-level result to file-level
 * `{path, similarity, summary}` records. Two-pass aggregator paralleling
 * `normalizeComposerResult` in comparison.js: per-source max-score wins,
 * first-position breaks ties. Pass 2 carries the best-scoring chunk per
 * source so we can synthesize `summary`.
 *
 * @param {object|null|undefined} result Composer RetrievalResult.
 * @param {number} topK
 * @returns {Array<{path: string, similarity: number, summary: string}>}
 */
export function rollupToFiles(result, topK) {
    if (!result || typeof result !== 'object') return [];
    const blocks = /** @type {any} */ (result).blocks;
    const chunksById = /** @type {any} */ (result).chunks_by_id;
    if (!Array.isArray(blocks) || !chunksById || typeof chunksById !== 'object') return [];
    /** @type {Map<string, { firstPosition: number, maxScore: number, bestChunk: object|null }>} */
    const perSource = new Map();
    let position = 0;
    for (const block of blocks) {
        if (!block || !Array.isArray(block.chunks)) continue;
        for (const id of block.chunks) {
            if (typeof id !== 'string' || id.length === 0) continue;
            // 1.15.0 — Ledger marker surrogates carry source_uri="ledger://<turn>"
            // (see js/intelligence/retrieval/ledger-consumer.js reserved-namespace
            // doc on ChunkID). They're a model-facing prompt artifact, not a
            // discoverable file; surfacing them through `find_relevant_files`'s
            // file-rollup would pollute results with bogus `ledger://...` paths
            // and hide the actual file the marker references.
            if (id.startsWith('ledger_marker:')) continue;
            const chunk = chunksById[id];
            if (!chunk || typeof chunk !== 'object') continue;
            const meta = /** @type {any} */ (chunk).metadata;
            if (!meta || typeof meta !== 'object') continue;
            const uri = meta.source_uri;
            if (typeof uri !== 'string' || uri.length === 0) continue;
            const prov = /** @type {any} */ (chunk).provenance;
            const rawScore = prov && typeof prov === 'object' ? prov.score : undefined;
            const score = typeof rawScore === 'number' && Number.isFinite(rawScore) ? rawScore : 0;
            const existing = perSource.get(uri);
            if (existing === undefined) {
                perSource.set(uri, { firstPosition: position, maxScore: score, bestChunk: chunk });
            } else if (score > existing.maxScore) {
                existing.maxScore = score;
                existing.bestChunk = chunk;
            }
            position += 1;
        }
    }
    if (perSource.size === 0) return [];
    /** @type {Array<{ uri: string, firstPosition: number, maxScore: number, bestChunk: object|null }>} */
    const entries = [];
    for (const [uri, rec] of perSource) {
        entries.push({ uri, firstPosition: rec.firstPosition, maxScore: rec.maxScore, bestChunk: rec.bestChunk });
    }
    entries.sort((a, b) => {
        if (b.maxScore !== a.maxScore) return b.maxScore - a.maxScore;
        return a.firstPosition - b.firstPosition;
    });
    /** @type {Array<{path: string, similarity: number, summary: string}>} */
    const out = [];
    const k = typeof topK === 'number' && Number.isFinite(topK) && topK > 0 ? Math.floor(topK) : 5;
    for (let i = 0; i < entries.length && out.length < k; i++) {
        const e = entries[i];
        out.push({
            path: e.uri,
            similarity: e.maxScore,
            summary: summaryForChunk(e.bestChunk),
        });
    }
    return out;
}

/**
 * Parse an `${owner}/${repo}@${branch}` projectKey back into the loader's
 * `{owner, repo, ref}` triple. Used by the manager's per-file CRUD
 * incremental ingest so a one-shot controller can be wired against the
 * active project without re-reading `State.currentProject` (which may
 * have raced ahead during async ingest).
 *
 * @param {string} key
 * @returns {{owner: string, repo: string, ref: string}}
 */
export function projectKeyFromString(key) {
    if (typeof key !== 'string' || key.length === 0) {
        return { owner: '', repo: '', ref: '' };
    }
    const at = key.lastIndexOf('@');
    if (at < 0) return { owner: '', repo: key, ref: '' };
    const ref = key.slice(at + 1);
    const head = key.slice(0, at);
    const slash = head.indexOf('/');
    if (slash < 0) return { owner: '', repo: head, ref };
    return {
        owner: head.slice(0, slash),
        repo: head.slice(slash + 1),
        ref,
    };
}

/**
 * Resolve the `liveBranches` argument for `cleanupOrphanedIndexes` from
 * a (possibly empty) `branches:refresh` event payload, falling back to
 * `State.branches`. Returns `null` when no source yields a non-empty
 * branch list — caller MUST skip cleanup in that case, because passing
 * `[]` to `cleanupOrphanedIndexes` would treat every persisted index as
 * orphaned and wipe the project.
 *
 * @param {object|null|undefined} payload Event payload (may have `liveBranches`).
 * @param {Array<{name?: string}>|null|undefined} stateBranches Fallback from `State.branches`.
 * @returns {string[]|null}
 */
export function resolveLiveBranches(payload, stateBranches) {
    const explicit = payload && Array.isArray(/** @type {any} */ (payload).liveBranches)
        ? /** @type {any} */ (payload).liveBranches
        : null;
    if (explicit && explicit.length > 0) {
        return explicit.filter(/** @param {unknown} n */ n => typeof n === 'string' && n.length > 0);
    }
    if (Array.isArray(stateBranches) && stateBranches.length > 0) {
        const names = stateBranches
            .map(b => b?.name)
            .filter(/** @param {unknown} n */ n => typeof n === 'string' && n.length > 0);
        return names.length > 0 ? /** @type {string[]} */ (names) : null;
    }
    return null;
}

/**
 * @typedef {Object} DeltaIndexResult
 * @property {boolean} ok                 — true means delta path completed; false means caller should fall back to a full re-walk.
 * @property {string}  [reason]           — short tag for why delta declined (only set when `ok` is false).
 * @property {number}  [reindexed]        — count of paths actually re-ingested (only set when `ok` is true).
 * @property {number}  [totalDelta]       — diff + dirty-tabs union size (only set when `ok` is true).
 */

/**
 * @typedef {Object} DeltaIndexDeps
 * @property {string|undefined} previousBranch
 * @property {string} branch
 * @property {Array<{path?: string, dirty?: boolean}>} openTabs
 * @property {() => unknown} hasSourceIndex            — falsy result short-circuits before any IO
 * @property {() => Promise<string[]|null>} fetchDiff  — resolves to paths, or null on error/unsupported
 * @property {() => boolean} cloneIndex                — clone source-branch index → target branch
 * @property {() => Promise<boolean>} loadIndex        — load cloned blob into runtime
 * @property {(paths: string[]) => Promise<number>} reindexChanged — re-ingest the diff set
 */

/**
 * Decide and execute the delta-indexing path for a branch switch.
 *
 * If the previous branch has a persisted index AND the provider can
 * compute the diff between two tips, the caller can clone that index to
 * the new branch and re-embed only files that differ — instead of a full
 * re-walk. Layers in any dirty open tabs since their content differs from
 * any branch tip.
 *
 * Dependencies are injected so this orchestration is testable under
 * `node --test` without importing the production manager (which pulls in
 * browser-bound `core.js` / `git.js`).
 *
 * @param {DeltaIndexDeps} deps
 * @returns {Promise<DeltaIndexResult>}
 */
export async function tryDeltaIndexFromBranch(deps) {
    const {
        previousBranch, branch, openTabs,
        hasSourceIndex, fetchDiff, cloneIndex, loadIndex, reindexChanged,
    } = deps;

    if (!previousBranch || previousBranch === branch) {
        return { ok: false, reason: 'no-previous-branch' };
    }
    if (!hasSourceIndex()) {
        return { ok: false, reason: 'no-source-index' };
    }

    let diffPaths;
    try {
        diffPaths = await fetchDiff();
    } catch {
        diffPaths = null;
    }
    if (!Array.isArray(diffPaths)) {
        return { ok: false, reason: 'diff-unavailable' };
    }

    if (!cloneIndex()) {
        return { ok: false, reason: 'clone-failed' };
    }
    if (!(await loadIndex())) {
        return { ok: false, reason: 'load-failed' };
    }

    const dirtyPaths = (openTabs || [])
        .filter(t => t && t.dirty && typeof t.path === 'string' && t.path.length > 0)
        .map(t => /** @type {string} */ (t.path));
    const allPaths = Array.from(new Set([...diffPaths, ...dirtyPaths]));

    if (allPaths.length === 0) {
        return { ok: true, reindexed: 0, totalDelta: 0 };
    }

    const reindexed = await reindexChanged(allPaths);
    return { ok: true, reindexed, totalDelta: allPaths.length };
}
