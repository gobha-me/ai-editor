// @ts-check
/**
 * AI Editor — MCP Server Catalog (2.3.0)
 *
 * Curated list of public MCP servers reachable from the browser. The Settings
 * → MCP Servers tab uses this to render a "Browse Catalog" picker that
 * pre-fills the existing add-server form, so users don't have to know the
 * URL / transport / auth conventions to wire up a popular server.
 *
 * This is **Phase 1** of github#27. The catalog is hand-curated, ships with
 * the release, and lives in source. A fetched registry (Glama / smithery /
 * modelcontextprotocol-servers) is Phase 2; OAuth flows are Phase 1.5.
 *
 * ## Entry shape
 *
 *   id              — stable slug, ^[a-z0-9][a-z0-9-]*$, unique. Used as the
 *                     starter id when added; the "Already added" check keys
 *                     off this. Does NOT need to match the runtime id (which
 *                     is derived from the user-edited label by `slugifyLabel`).
 *   name            — human-readable display name. Pre-fills the editor's
 *                     Label field.
 *   description     — 1–2 sentences shown under `name` in the catalog row.
 *   category        — one of: 'web-search' | 'dev-tools' | 'docs' |
 *                     'productivity' | 'integration'. Drives the icon.
 *   url             — server endpoint. May contain `{placeholder}` segments
 *                     (e.g. `{API_KEY}` in the path) — preserved verbatim by
 *                     the pre-fill, the user substitutes manually before Save.
 *   transport       — 'streamable-http'. Legacy HTTP+SSE and stdio are not
 *                     implemented by the browser bridge.
 *   requiresToken   — drives the "🔑 token required" badge. The token field
 *                     is NEVER pre-filled regardless of this flag.
 *   tokenHint?      — optional one-liner shown after pre-fill, describing
 *                     what the token is and where to get it.
 *   docsUrl         — link to the server's documentation. Opens in a new tab.
 *   authNote?       — optional caveat (e.g. "OAuth coming soon — bearer-token
 *                     workaround for now").
 *
 * ## How to add a 9th entry
 *
 * 1. Find a public MCP server reachable via streamable-http. Legacy HTTP+SSE
 *    and stdio servers will not work in the browser — skip them.
 * 2. Pick a slug id (`^[a-z0-9][a-z0-9-]*$`) that doesn't collide.
 * 3. Add an object to `MCP_CATALOG` below with all required fields.
 * 4. If `requiresToken: true`, include a `tokenHint` describing how to get one.
 * 5. Run `node --test tests/test-mcp-catalog.mjs` — the data tests enforce
 *    the invariants above.
 *
 * @module mcp/catalog
 */

/**
 * @typedef {Object} CatalogEntry
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {'web-search'|'dev-tools'|'docs'|'productivity'|'integration'} category
 * @property {string} url
 * @property {'streamable-http'} transport
 * @property {boolean} requiresToken
 * @property {string} [tokenHint]
 * @property {string} docsUrl
 * @property {string} [authNote]
 */

/** @type {ReadonlyArray<CatalogEntry>} */
export const MCP_CATALOG = Object.freeze([
    {
        id: 'deepwiki',
        name: 'DeepWiki',
        description: 'AI-generated wikis for public GitHub repositories. Read structured docs and ask questions about any project.',
        category: 'docs',
        url: 'https://mcp.deepwiki.com/mcp',
        transport: 'streamable-http',
        requiresToken: false,
        docsUrl: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp',
    },
    {
        id: 'gitmcp',
        name: 'GitMCP (per-repo docs)',
        description: 'On-the-fly MCP server for any GitHub repository. Substitute {owner}/{repo} in the URL to point at a specific project\u2019s code + docs.',
        category: 'docs',
        url: 'https://gitmcp.io/{owner}/{repo}',
        transport: 'streamable-http',
        requiresToken: false,
        tokenHint: 'No token. Replace {owner}/{repo} in the URL with the GitHub path you want indexed (e.g. gitmcp.io/anthropics/anthropic-sdk-python).',
        docsUrl: 'https://gitmcp.io/',
    },
    {
        id: 'semgrep',
        name: 'Semgrep',
        description: 'Static analysis and security scanning for code. Identify vulnerabilities and policy violations across multiple languages.',
        category: 'dev-tools',
        url: 'https://mcp.semgrep.ai/mcp',
        transport: 'streamable-http',
        requiresToken: false,
        docsUrl: 'https://semgrep.dev/docs/extensions/semgrep-mcp',
    },
    {
        id: 'apify',
        name: 'Apify Actors',
        description: 'Run thousands of pre-built web scrapers and automation actors for data extraction, browser automation, and SERP collection.',
        category: 'web-search',
        url: 'https://mcp.apify.com',
        transport: 'streamable-http',
        requiresToken: true,
        tokenHint: 'Bearer token: create one at https://console.apify.com → Settings → Integrations → API tokens.',
        docsUrl: 'https://docs.apify.com/platform/integrations/mcp',
    },
    {
        id: 'firecrawl',
        name: 'Firecrawl',
        description: 'Web scraping and extraction. Crawl whole sites, extract structured data, and convert pages to LLM-ready markdown.',
        category: 'web-search',
        url: 'https://mcp.firecrawl.dev/{API_KEY}/v2/mcp',
        transport: 'streamable-http',
        requiresToken: true,
        tokenHint: 'API key: get one at https://www.firecrawl.dev/app/api-keys. Replace {API_KEY} in the URL before saving — the URL contains the credential, so leave the separate token field empty.',
        docsUrl: 'https://docs.firecrawl.dev/mcp',
    },
    {
        id: 'linear',
        name: 'Linear',
        description: 'Read and write Linear issues, projects, and cycles. Plan work and triage tickets without leaving the chat.',
        category: 'productivity',
        url: 'https://mcp.linear.app/mcp',
        transport: 'streamable-http',
        requiresToken: true,
        tokenHint: 'Personal API key: Linear → Settings → Account → Security & access → Personal API keys.',
        authNote: 'Linear recommends OAuth for interactive clients; its MCP endpoint also accepts a Linear API key or OAuth token in the bearer-token field.',
        docsUrl: 'https://linear.app/docs/mcp',
    },
    {
        id: 'notion',
        name: 'Notion',
        description: 'Read and write Notion pages and databases. Useful for capturing notes and querying knowledge bases inline.',
        category: 'productivity',
        url: 'https://mcp.notion.com/mcp',
        transport: 'streamable-http',
        requiresToken: true,
        tokenHint: 'Integration token: https://www.notion.so/my-integrations → New integration → copy the secret. Then share the target pages with the integration.',
        authNote: 'Notion\u2019s production posture is OAuth; bearer-token mode works today via internal integrations.',
        docsUrl: 'https://developers.notion.com/docs/mcp',
    },
    {
        id: 'sentry',
        name: 'Sentry',
        description: 'Query Sentry issues, releases, and performance data. Surface the latest errors and stack traces inline while debugging.',
        category: 'integration',
        url: 'https://mcp.sentry.dev/mcp',
        transport: 'streamable-http',
        requiresToken: true,
        tokenHint: 'User auth token: Sentry → Settings → Account → API → Auth Tokens. Scopes: org:read + project:read at minimum.',
        docsUrl: 'https://docs.sentry.io/product/sentry-mcp/',
    },
]);

const CATEGORIES = Object.freeze(['web-search', 'dev-tools', 'docs', 'productivity', 'integration']);

/**
 * Set of categories the catalog uses. Useful for tests and any UI that wants
 * to render category filters in a future Phase 2.
 * @returns {ReadonlyArray<string>}
 */
export function getCategories() {
    return CATEGORIES;
}

const CATEGORY_ICONS = Object.freeze({
    'web-search': '\uD83D\uDD0E',
    'dev-tools': '\uD83D\uDEE0\uFE0F',
    'docs': '\uD83D\uDCD6',
    'productivity': '\u2728',
    'integration': '\uD83D\uDD0C',
});

/**
 * Map a category to its emoji icon. Falls back to a generic plug for unknown
 * categories (the data tests catch those — this is belt-and-braces).
 * @param {string} category
 * @returns {string}
 */
export function categoryIcon(category) {
    return CATEGORY_ICONS[category] || '\uD83D\uDD0C';
}

/**
 * Pure: convert a catalog entry into the starter object consumed by
 * `showServerEditor(null, starter)` in `js/settings/mcp-servers-tab.js`.
 *
 * Invariants enforced here (and verified by tests/test-mcp-catalog-prefill.mjs):
 *   • `token` is always `''`. Catalog entries never carry secrets.
 *   • Unsupported or missing transports return `null`; catalog data is never
 *     silently coerced into the implemented transport.
 *   • `roles` defaults to 'all'.
 *   • URL placeholder segments (e.g. `{API_KEY}`) are preserved verbatim — the
 *     user substitutes them in the form before clicking Save.
 *   • `null` / non-object input returns `null` (defensive).
 *
 * @param {CatalogEntry|null|undefined} entry
 * @returns {{label: string, url: string, transport: 'streamable-http', token: string, enabled: boolean, roles: string} | null}
 */
export function catalogEntryToStarter(entry) {
    if (!entry || typeof entry !== 'object') return null;
    if (entry.transport !== 'streamable-http') return null;
    return {
        label: String(entry.name || ''),
        url: String(entry.url || ''),
        transport: 'streamable-http',
        token: '',
        enabled: true,
        roles: 'all',
    };
}
