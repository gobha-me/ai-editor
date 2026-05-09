// @ts-check
/**
 * Ingest ordering + token-budget cap (2.4.0).
 *
 * Replaces the legacy `slice(0, maxIndexFiles)` truncation in
 * `manager._indexProject` with two passes:
 *
 *   1. **Order.** Sort eligible files so the user's primary languages
 *      lead. Provider-supplied stats win; cascade to an in-memory
 *      extension-scan fallback when the provider doesn't support
 *      language stats (Local), the network call fails, or the repo is
 *      too small for the upstream API to return entries.
 *   2. **Cap.** Walk the ordered list accumulating estimated tokens.
 *      Stop at the first of two limits: `maxIndexTokens` (the primary
 *      lever, default 300k) or `maxIndexFiles` (a hard upper-bound
 *      safety net, default 5000).
 *
 * Why this slot. The 2026-05-08 cost-dashboard export established
 * `search_in_files` as the dominant cost shape — exactly the X^N
 * grep-fallback the model reaches for when retrieval isn't earning
 * its keep, the symptom of a cold embedder after a branch switch *or*
 * an indexer that ran out of room before reaching the user's language.
 * Half (a) — delta-indexing on branch switch — shipped at 2.2.0.
 * This module is half (b).
 *
 * Pure helpers; no DOM, no global state, no network. The orchestrator
 * `orderByLanguageStats` takes the provider lookup as a callback so
 * tests can inject mocks without monkey-patching `Git`.
 *
 * @module intelligence/retrieval/ingest-ordering
 */

import { estimateTokensFromSize } from '../compression/tokens.js';
import { extensionOf, languageForExtension } from './language-extensions.js';

/**
 * @typedef {Object} LanguageEntry
 * @property {string}   language    - canonical name, e.g. "JavaScript"
 * @property {number}   weight      - share in [0,1]; entries sort by this descending
 * @property {string[]} extensions  - lowercase ext list, e.g. [".js", ".mjs"]
 */

/**
 * @typedef {Object} FileLike
 * @property {string}  path
 * @property {number} [size]
 */

/**
 * @typedef {Object} CapResult
 * @property {FileLike[]} files
 * @property {number}     droppedForBudget   - count dropped (over budget OR over file ceiling)
 * @property {number}     estTotalTokens     - sum of estimated tokens accepted
 */

/**
 * Default token budget for `capByTokenBudget` callers that don't pass
 * a settings object. Defensible bound: at the curated `chars/3.5`
 * heuristic, 300k tokens ≈ ~1 MB of text — strictly dominates the
 * legacy 200-file ceiling on small/medium repos while staying
 * conservative on huge ones.
 */
export const DEFAULT_MAX_INDEX_TOKENS = 300_000;

/**
 * Default file-count safety net. Was the primary lever pre-2.4.0 at
 * 200; raised to 5000 here because tokens are now the primary lever
 * and this only fires on degenerate huge repos.
 */
export const DEFAULT_MAX_INDEX_FILES = 5000;

/* -------------------------------------------------------------------- */
/* Sorting                                                              */
/* -------------------------------------------------------------------- */

/**
 * Build a `Map<extension, rank>` where rank 0 = highest-weight
 * language. Earlier-listed languages win on tie (consistent with
 * `Map.has` short-circuit). The caller must already have sorted
 * `langs` descending by weight.
 *
 * @param {LanguageEntry[]} langs
 * @returns {Map<string, number>}
 */
function buildExtensionRanking(langs) {
    const rank = new Map();
    for (let i = 0; i < langs.length; i++) {
        const exts = langs[i] && Array.isArray(langs[i].extensions) ? langs[i].extensions : [];
        for (const ext of exts) {
            if (typeof ext === 'string' && ext && !rank.has(ext)) {
                rank.set(ext.toLowerCase(), i);
            }
        }
    }
    return rank;
}

/**
 * Stable sort `files` by language rank ascending. Files whose
 * extension isn't in any language entry sort to the end but are
 * **not** dropped — the caller still walks them after preferred
 * languages are exhausted, until the token budget closes.
 *
 * Pure: returns a new array, doesn't mutate input.
 *
 * @param {FileLike[]} files
 * @param {LanguageEntry[]} langs
 * @returns {FileLike[]}
 */
export function sortFilesByLanguageWeight(files, langs) {
    if (!Array.isArray(files) || files.length === 0) return Array.isArray(files) ? files.slice() : [];
    if (!Array.isArray(langs) || langs.length === 0) return files.slice();
    const rank = buildExtensionRanking(langs);
    const indexed = files.map((file, idx) => ({
        file,
        idx,
        rank: rank.get(extensionOf(file && file.path ? file.path : '')) ?? Infinity,
    }));
    indexed.sort((a, b) => (a.rank - b.rank) || (a.idx - b.idx));
    return indexed.map(x => x.file);
}

/* -------------------------------------------------------------------- */
/* Extension-scan fallback                                              */
/* -------------------------------------------------------------------- */

/**
 * Tally bytes per file extension across `files`, group into known
 * languages where we can, normalize to weights summing to 1, and
 * return the same shape `sortFilesByLanguageWeight` consumes.
 *
 * Used when no upstream language stats are available — Local
 * provider, network failures, or repos too small/empty for the
 * provider's `/languages` endpoint to return entries.
 *
 * Files without an extension contribute nothing (Dockerfile,
 * Makefile — there's nothing to rank by). Files without a `size`
 * field contribute 1 byte each, so file-count drives ordering when
 * size data is unavailable.
 *
 * Unknown extensions become synthetic "Other (.xyz)" language
 * entries. They still earn their place in the ranking on weight.
 *
 * @param {FileLike[]} files
 * @returns {LanguageEntry[]}
 */
export function extensionScanFallback(files) {
    if (!Array.isArray(files) || files.length === 0) return [];
    /** @type {Map<string, number>} */
    const extToBytes = new Map();
    let totalBytes = 0;
    for (const file of files) {
        const ext = extensionOf(file && file.path ? file.path : '');
        if (!ext) continue;
        const size = (file && typeof file.size === 'number' && file.size > 0) ? file.size : 1;
        extToBytes.set(ext, (extToBytes.get(ext) || 0) + size);
        totalBytes += size;
    }
    if (totalBytes === 0) return [];

    /** @type {Map<string, {bytes: number, extensions: Set<string>}>} */
    const byLanguage = new Map();
    for (const [ext, bytes] of extToBytes) {
        const lang = languageForExtension(ext) || `Other (${ext})`;
        const entry = byLanguage.get(lang) || { bytes: 0, extensions: new Set() };
        entry.bytes += bytes;
        entry.extensions.add(ext);
        byLanguage.set(lang, entry);
    }

    return Array.from(byLanguage.entries())
        .map(([language, entry]) => ({
            language,
            weight: entry.bytes / totalBytes,
            extensions: Array.from(entry.extensions),
        }))
        .sort((a, b) => b.weight - a.weight);
}

/* -------------------------------------------------------------------- */
/* Token-budget cap                                                     */
/* -------------------------------------------------------------------- */

/**
 * Walk `orderedFiles` accumulating estimated tokens until either the
 * token budget or the file-count safety net is reached. Always emits
 * at least the first file (degenerate-case guard against an oversized
 * file at the head leaving the index empty).
 *
 * Settings shape:
 *   - `maxIndexTokens` (default 300_000) — primary lever.
 *   - `maxIndexFiles`  (default 5000)    — hard upper bound.
 *
 * Both caps apply; first to fire wins. `droppedForBudget` counts files
 * not included for either reason (caller can surface in UI / cost
 * telemetry).
 *
 * @param {FileLike[]} orderedFiles
 * @param {{maxIndexTokens?: number, maxIndexFiles?: number}} [settings]
 * @returns {CapResult}
 */
export function capByTokenBudget(orderedFiles, settings) {
    const out = /** @type {FileLike[]} */ ([]);
    if (!Array.isArray(orderedFiles) || orderedFiles.length === 0) {
        return { files: out, droppedForBudget: 0, estTotalTokens: 0 };
    }
    const tokenBudget = (settings && typeof settings.maxIndexTokens === 'number' && settings.maxIndexTokens > 0)
        ? settings.maxIndexTokens
        : DEFAULT_MAX_INDEX_TOKENS;
    const fileCeiling = (settings && typeof settings.maxIndexFiles === 'number' && settings.maxIndexFiles > 0)
        ? settings.maxIndexFiles
        : DEFAULT_MAX_INDEX_FILES;
    let used = 0;
    let droppedForBudget = 0;
    for (const file of orderedFiles) {
        if (out.length >= fileCeiling) {
            droppedForBudget++;
            continue;
        }
        const est = estimateTokensFromSize(file && typeof file.size === 'number' ? file.size : 0);
        // Always include the first file even if it alone exceeds the budget.
        if (out.length > 0 && used + est > tokenBudget) {
            droppedForBudget++;
            continue;
        }
        out.push(file);
        used += est;
    }
    return { files: out, droppedForBudget, estTotalTokens: used };
}

/* -------------------------------------------------------------------- */
/* Orchestrator                                                         */
/* -------------------------------------------------------------------- */

/**
 * Resolve the language ranking for `files` and sort. Cascades:
 *
 *   1. Call `getLanguages(owner, repo, ref)` — returns a `LanguageEntry[]`
 *      or `null` for "unsupported / fall back."
 *   2. On `null`, throw, or empty array → `extensionScanFallback(files)`.
 *   3. On still-empty (e.g. files without extensions) → leave order
 *      untouched.
 *
 * Never throws. A provider error degrades to extension-scan; the
 * indexer always proceeds.
 *
 * @param {FileLike[]} files
 * @param {{owner: string, repo: string, ref?: string}} project
 * @param {(owner: string, repo: string, ref?: string) => Promise<LanguageEntry[]|null>} getLanguages
 * @returns {Promise<{files: FileLike[], langs: LanguageEntry[], source: 'provider'|'fallback'|'none'}>}
 */
export async function orderByLanguageStats(files, project, getLanguages) {
    /** @type {LanguageEntry[]|null} */
    let langs = null;
    /** @type {'provider'|'fallback'|'none'} */
    let source = 'none';
    try {
        if (typeof getLanguages === 'function' && project && project.owner && project.repo) {
            langs = await getLanguages(project.owner, project.repo, project.ref);
            if (Array.isArray(langs) && langs.length > 0) source = 'provider';
        }
    } catch (err) {
        // Network failure, 404, auth — degrade silently, log so it's
        // visible in the dev console.
        try { console.warn('[Retrieval] getLanguages failed; falling back to extension scan', err); } catch { /* noop */ }
        langs = null;
    }
    if (!Array.isArray(langs) || langs.length === 0) {
        langs = extensionScanFallback(files);
        source = langs.length > 0 ? 'fallback' : 'none';
    }
    return {
        files: sortFilesByLanguageWeight(files, langs),
        langs,
        source,
    };
}
