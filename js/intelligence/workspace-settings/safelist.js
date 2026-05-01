// @ts-check
/**
 * Workspace-settings safelist + denylist — the security boundary for the
 * `.aieditor/settings.json` overrides shipped in 1.4.4.
 *
 * Two lists, both frozen:
 *
 *   - `SAFELIST` — keys that MAY be overridden per-workspace. Each entry
 *     is a top-level `State.settings` key. Tightly curated; start small,
 *     relax later only with explicit per-key justification.
 *   - `DENYLIST` — keys that MUST NEVER appear in a workspace settings
 *     file. Tests assert no overlap with `SAFELIST` and that every known
 *     credential-bearing key is denylisted. The serializer strips any
 *     denylisted key on read (defense in depth: never trust the file even
 *     if a hostile branch added one).
 *
 * Why each excluded key is excluded:
 *
 *   - `llmApiKey`, `embeddingApiKey` — credential. Committing leaks
 *     tokens to git history.
 *   - `llmEndpoint`, `embeddingEndpoint` — paired with the api key;
 *     workstation-personal too (corporate proxies).
 *   - `connections` — git tokens.
 *   - `mcpServers` — bearer tokens for MCP HTTP transports.
 *   - `veniceParameters`, `openRouterParameters` — provider-specific
 *     blocks that include auth/billing fields.
 *   - `apiProvider` — switching it without paired credentials silently
 *     breaks every chat call. Workstation-personal.
 *   - `llmModel`, `commitModel` — model availability differs across
 *     teammates' provider accounts. A workspace forcing a model the
 *     teammate hasn't enabled silently breaks their session.
 *   - `disabledModels`, `modelOverrides` — workstation-personal display
 *     preferences. Sharing them silently changes teammates' model menus.
 *   - `advancedParams` — temperature, top-p, etc. Workstation-personal
 *     experimentation; not a project-shared concern.
 *
 * Removability: deleting this file + the workspace-settings module dir
 * reverts to 1.4.3 behavior. The hardcoded const lists never need a
 * migration; consumers either import them or fall back to no-op when the
 * module is missing.
 *
 * @since 1.4.4
 * @module intelligence/workspace-settings/safelist
 */

/**
 * Top-level `State.settings` keys safe to override via
 * `.aieditor/settings.json`. Frozen.
 *
 * @type {ReadonlyArray<string>}
 */
export const SAFELIST = Object.freeze([
    // Editor & visual
    'theme',
    'uiScale',
    'editorFontSize',
    'showLineNumbers',
    'editorKeybindingMode',
    'editorScanInvisibleUnicode',
    'showIssues',
    'showPullRequests',

    // Ghost text (1.4.7). Whole subtree —
    // `ghostText.enabled` / `.hotkey` / `.maxTokens` / `.contextLines` /
    // `.model` travel together. No credentials. The model field is an id,
    // not an API key; per-repo override is useful when a team ships a
    // workspace where one specific completion model fits the codebase.
    'ghostText',

    // Behavior
    'role',
    'summarizerMode',
    'summarizer',
    'llmIdleTimeout',
    'toolTimeout',
    'summaryTimeout',

    // Embeddings (non-credential, local-only fields)
    'useEmbeddings',
    'autoReindex',
    'embeddingCacheExpiry',
    'maxRelevantFiles',
    'maxIndexFiles',
    'embeddingProvider',
    'embeddingModel',

    // Test-driven loop bounds (1.4.5). Whole subtree — `testLoop.enabled`
    // / `testLoop.maxIterations` etc. travel together. No credentials.
    'testLoop',
]);

/**
 * Keys that MUST NEVER be loaded from `.aieditor/settings.json`. Every
 * credential-bearing or workstation-personal key sits here. Tests assert
 * no overlap with `SAFELIST`.
 *
 * @type {ReadonlyArray<string>}
 */
export const DENYLIST = Object.freeze([
    // Credentials
    'llmApiKey',
    'llmEndpoint',
    'embeddingApiKey',
    'embeddingEndpoint',
    'connections',
    'mcpServers',
    'veniceParameters',
    'openRouterParameters',

    // Workstation-personal
    'apiProvider',
    'llmModel',
    'commitModel',
    'disabledModels',
    'modelOverrides',
    'advancedParams',
]);

const _safeSet = new Set(SAFELIST);
const _denySet = new Set(DENYLIST);

/**
 * @param {string} key
 * @returns {boolean} True iff `key` is on the safelist (and not on the
 *   denylist — denylist always wins as defense in depth).
 */
export function isSafelisted(key) {
    if (typeof key !== 'string' || key.length === 0) return false;
    if (_denySet.has(key)) return false;
    return _safeSet.has(key);
}

/**
 * @param {string} key
 * @returns {boolean} True iff `key` is on the denylist.
 */
export function isDenylisted(key) {
    return typeof key === 'string' && _denySet.has(key);
}

/**
 * Filter an arbitrary object down to the safelisted keys, dropping every
 * other entry. Returns a new object; input is not mutated.
 *
 * Used by the serializer to strip unsafe keys from a parsed
 * `.aieditor/settings.json` before merging into `State.settings`.
 *
 * @param {Record<string, unknown>} obj
 * @returns {{ accepted: Record<string, unknown>, rejected: string[] }}
 *   `rejected` lists keys present in input but stripped — caller surfaces
 *   them as diagnostics ("teammate tried to commit `llmApiKey`; ignored").
 */
export function filterToSafelisted(obj) {
    /** @type {Record<string, unknown>} */
    const accepted = {};
    /** @type {string[]} */
    const rejected = [];
    if (!obj || typeof obj !== 'object') return { accepted, rejected };
    for (const [k, v] of Object.entries(obj)) {
        if (isSafelisted(k)) {
            accepted[k] = v;
        } else {
            rejected.push(k);
        }
    }
    return { accepted, rejected };
}
