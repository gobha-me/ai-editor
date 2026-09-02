// @ts-check
/**
 * AI Editor — MCP Catalog Source: Smithery registry adapter (2.15.0)
 *
 * github#27 Phase 2 slice 1. Wraps the Smithery public registry
 * (`https://registry.smithery.ai/servers`) so the Settings → MCP Servers
 * → Browse Catalog picker can show ~hundreds of remote-reachable servers
 * alongside the 8 bundled curated ones from `catalog.js`.
 *
 * Two endpoints used:
 *   - LIST (`?q=is:remote&pageSize=100`) — paginated metadata only. The
 *     `remote: true` filter excludes stdio entries the bridge can't speak
 *     to (`js/mcp/protocol.js` implements Streamable HTTP only).
 *   - DETAIL (`/{qualifiedName}`) — fetched lazily when the user picks an
 *     entry, because the list endpoint does NOT include the connection
 *     URL (`connections[].deploymentUrl`).
 *
 * Pure parsers are exported separately for `node --test` coverage; IO
 * functions accept an injected `fetchImpl` so tests can stub the network
 * without spinning up a server.
 *
 * @module mcp/catalog-source
 */

const SMITHERY_BASE = 'https://registry.smithery.ai/servers';
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_ENTRIES = 100;

/**
 * Parse a Smithery list response into our `CatalogEntry`-shaped objects.
 * Pure — no IO, no globals. Defensive on malformed input (returns `[]`).
 *
 * The list endpoint omits the connection URL, so each parsed entry has
 * `url: ''` and `transport: 'streamable-http'` as placeholders. The
 * real values land via `parseSmitheryDetailResponse` after the user
 * picks the entry.
 *
 * @param {*} json — raw parsed JSON from the list endpoint
 * @returns {Array<Object>}
 */
export function parseSmitheryListResponse(json) {
    if (!json || typeof json !== 'object') return [];
    if (!Array.isArray(json.servers)) return [];
    const out = [];
    for (const item of json.servers) {
        const entry = smitheryListItemToCatalogEntry(item);
        if (entry) out.push(entry);
    }
    return out;
}

/**
 * Parse a Smithery detail response into the `{url, transport}` pair the
 * settings tab needs to fill in the add-server form. Pure.
 *
 * Smithery's `connections[]` array can contain multiple entries; we pick
 * the first whose `type` matches our supported transport. The
 * mapping rules:
 *   - `type === 'http'` /
 *     `type === 'streamable-http'` → `transport: 'streamable-http'`
 *   - anything else            → skipped (next connection is tried)
 *
 * Returns `null` if no usable connection is found, the URL is empty, or
 * the response is malformed. The settings tab surfaces a toast in that
 * case rather than silently failing.
 *
 * @param {*} json
 * @returns {{url: string, transport: 'streamable-http'} | null}
 */
export function parseSmitheryDetailResponse(json) {
    if (!json || typeof json !== 'object') return null;
    if (!Array.isArray(json.connections)) return null;
    for (const conn of json.connections) {
        if (!conn || typeof conn !== 'object') continue;
        const type = typeof conn.type === 'string' ? conn.type.toLowerCase() : '';
        const url = typeof conn.deploymentUrl === 'string' ? conn.deploymentUrl.trim() : '';
        if (!url) continue;
        if (type === 'http' || type === 'streamable-http') return { url, transport: 'streamable-http' };
    }
    return null;
}

/**
 * Normalize one Smithery list item into the `CatalogEntry` shape (with
 * `url: ''` deferred to the detail fetch). Pure; defensive on missing
 * fields. Returns `null` for items that fail the minimum-required check.
 *
 * @param {*} item
 * @returns {Object|null}
 */
function smitheryListItemToCatalogEntry(item) {
    if (!item || typeof item !== 'object') return null;
    if (item.remote !== true) return null; // belt-and-braces over the `?q=is:remote` filter
    const qualifiedName = typeof item.qualifiedName === 'string' ? item.qualifiedName.trim() : '';
    if (!qualifiedName) return null;

    const id = sanitizeId(qualifiedName);
    if (!id) return null;

    const name = typeof item.displayName === 'string' && item.displayName.trim()
        ? item.displayName.trim()
        : qualifiedName;
    const description = typeof item.description === 'string' ? item.description.trim() : '';
    const homepage = typeof item.homepage === 'string' && item.homepage.trim() ? item.homepage.trim() : '';
    const docsUrl = homepage || `https://smithery.ai/server/${encodeURIComponent(qualifiedName)}`;
    const useCount = Number.isFinite(item.useCount) ? Number(item.useCount) : 0;
    const verified = item.verified === true;
    const iconUrl = typeof item.iconUrl === 'string' ? item.iconUrl.trim() : '';

    return {
        id,
        name,
        description,
        category: 'integration',         // Smithery list omits category; default
        url: '',                          // Lazy — populated on detail fetch
        transport: 'streamable-http',     // Default until detail fetch resolves
        requiresToken: true,              // Conservative — show the field
        docsUrl,
        source: 'remote',
        qualifiedName,
        useCount,
        verified,
        iconUrl,
    };
}

/**
 * Smithery `qualifiedName` values can contain `/` and other characters
 * outside our slug shape (`^[a-z0-9][a-z0-9-]*$`). Bring them in line so
 * the existing `MCPServerRegistry.getServer(id)` "Already added" check
 * works the same way it does for bundled entries.
 *
 * @param {string} qualifiedName
 * @returns {string}
 */
function sanitizeId(qualifiedName) {
    return qualifiedName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Fetch the remote-only Smithery server list. Sorts by `useCount` desc
 * (popular first) and caps at `maxEntries` so the picker stays scannable.
 *
 * Throws on network failure / non-2xx — the caller (catalog-fetch.js)
 * catches and falls back to the cache → bundled chain.
 *
 * @param {{fetchImpl?: typeof fetch, pageSize?: number, maxEntries?: number}} [opts]
 * @returns {Promise<Array<Object>>}
 */
export async function fetchRemoteList({
    fetchImpl = globalThis.fetch,
    pageSize = DEFAULT_PAGE_SIZE,
    maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
    const url = `${SMITHERY_BASE}?q=${encodeURIComponent('is:remote')}&pageSize=${encodeURIComponent(String(pageSize))}`;
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!res || !res.ok) {
        const status = res ? res.status : 'no-response';
        throw new Error(`smithery list ${status}`);
    }
    const json = await res.json();
    const entries = parseSmitheryListResponse(json);
    entries.sort((a, b) => (b.useCount || 0) - (a.useCount || 0));
    return entries.slice(0, maxEntries);
}

/**
 * Fetch a single server's detail (specifically: its connection URL and
 * transport). Used lazily on "Use this server" click for remote entries.
 *
 * Returns `null` when the server has no usable Streamable HTTP connection, so
 * the settings tab can show a clear "no usable connection" toast rather
 * than pre-filling a broken form.
 *
 * @param {string} qualifiedName
 * @param {{fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<{url: string, transport: 'streamable-http'} | null>}
 */
export async function fetchRemoteDetail(qualifiedName, { fetchImpl = globalThis.fetch } = {}) {
    if (typeof qualifiedName !== 'string' || !qualifiedName.trim()) {
        throw new Error('qualifiedName required');
    }
    if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
    const url = `${SMITHERY_BASE}/${encodeURIComponent(qualifiedName.trim())}`;
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!res || !res.ok) {
        const status = res ? res.status : 'no-response';
        throw new Error(`smithery detail ${status}`);
    }
    const json = await res.json();
    return parseSmitheryDetailResponse(json);
}

// Test seams.
export const __test_smitheryListItemToCatalogEntry = smitheryListItemToCatalogEntry;
export const __test_sanitizeId = sanitizeId;
