// @ts-check
/**
 * AI Editor — MCP Catalog Merge: bundled-wins-on-collision (2.15.0)
 *
 * github#27 Phase 2 slice 1. Pure helper that combines the bundled
 * curated catalog (`MCP_CATALOG` from `catalog.js`) with whatever
 * Smithery returned (via `catalog-fetch.js#getRemoteCatalog`).
 *
 * Order in the output array:
 *   1. All bundled entries first, in their declared order. They're
 *      vetted, ship with full `tokenHint` / `authNote` strings, and
 *      have URLs ready to use without a follow-up detail fetch.
 *   2. Remote entries that did NOT collide with a bundled one, in
 *      whatever order they came in (the source already sorts by
 *      `useCount` desc).
 *
 * Collision rules — bundled wins:
 *   - Hard collision: bundled `id` === remote `id`. Drop the remote.
 *   - Soft collision: bundled `name` (lowercased + trimmed) ===
 *     remote `name`. Drop the remote. Catches the case where the
 *     bundled entry uses a custom slug but the human-facing name
 *     matches what Smithery shipped (e.g. bundled `linear` vs.
 *     remote with displayName "Linear").
 *
 * @module mcp/catalog-merge
 */

/**
 * Merge bundled + remote catalogs. Pure. Returns a frozen array.
 *
 * @param {ReadonlyArray<Object>} bundled
 * @param {ReadonlyArray<Object>} remote
 * @returns {ReadonlyArray<Object>}
 */
export function mergeCatalogs(bundled, remote) {
    const bundledArr = Array.isArray(bundled) ? bundled : [];
    const remoteArr = Array.isArray(remote) ? remote : [];

    const out = [];
    const seenIds = new Set();
    const seenNames = new Set();

    for (const entry of bundledArr) {
        if (!isUsableEntry(entry)) continue;
        out.push({ ...entry, source: entry.source || 'bundled' });
        seenIds.add(entry.id);
        if (typeof entry.name === 'string') {
            seenNames.add(entry.name.toLowerCase().trim());
        }
    }

    for (const entry of remoteArr) {
        if (!isUsableEntry(entry)) continue;
        if (seenIds.has(entry.id)) continue;
        const nameKey = typeof entry.name === 'string' ? entry.name.toLowerCase().trim() : '';
        if (nameKey && seenNames.has(nameKey)) continue;
        out.push({ ...entry, source: entry.source || 'remote' });
        seenIds.add(entry.id);
        if (nameKey) seenNames.add(nameKey);
    }

    return Object.freeze(out);
}

/**
 * Minimum required fields for a usable catalog entry. Both bundled and
 * remote entries must satisfy this; anything missing `id` or `name`, or
 * advertising an unsupported transport, is filtered out.
 *
 * @param {*} entry
 * @returns {boolean}
 */
function isUsableEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (typeof entry.id !== 'string' || !entry.id) return false;
    if (typeof entry.name !== 'string' || !entry.name) return false;
    if (entry.transport !== 'streamable-http') return false;
    return true;
}

// Test seam.
export const __test_isUsableEntry = isUsableEntry;
