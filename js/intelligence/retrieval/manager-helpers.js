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
