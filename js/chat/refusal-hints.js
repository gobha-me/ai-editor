/**
 * Refusal-envelope behavioral hints.
 *
 * The duplicate-streak guard in handlers.js fires `REFUSED: <tool> called N
 * consecutive times with identical args` once a model loops on the same tool
 * call. The infrastructure works (gitea#301 / 1.7.1), but cheap-tier models
 * read the error string and fail to extract a behavioral hint pointing at
 * *what* different approach to take. This module supplies tool-specific
 * next-action guidance so weak models can break out of the loop without
 * escalating to a more expensive tier.
 *
 * Origin: Grok-4-3 looped 7+ times on `get_ci_status` against a fresh branch
 * with no PR (HTML-Games dogfood, 2026-05-07). The result was structurally
 * "success" but informationally empty; the model treated empty as "I haven't
 * called this yet" and re-fired.
 *
 * 2.9.1 — qwen-3-6-plus on Venice looped on `list_tools_by_category
 * category=code.project` (ai-editor 2.9.0 dogfood, 2026-05-09). The text-only
 * "pick a different tool to set it up" steered without naming candidates;
 * the model re-emitted the same call. `buildRefusalPayload` now augments the
 * envelope at `streak >= 3` with concrete `suggestions` sampled from a
 * *different* category than the offender, plus an imperative "STOP" wording
 * and (optionally) the user's last message verbatim.
 *
 * Pure: no browser globals, no module-level mutation. `node --test` runs it
 * shim-free, mirroring the cache-invalidation.js shape.
 */

const HINTS = {
    get_ci_status:
        'If the prior result returned no useful info (e.g. "0 checks" or empty statuses), the precondition may not be met yet — for a fresh branch, create a PR with `create_pull_request` first, then re-check CI.',
    wait_for_ci:
        'If `get_ci_status` returned no checks for this ref, waiting will not surface any — the precondition (a PR or CI trigger) is missing. Create a PR first.',
    // Add tools as future dogfood traces surface them.
};

const GENERIC =
    'Re-read the prior result rather than retrying. If it was empty/uninformative, a precondition is likely missing — pick a different tool to set it up rather than re-firing this one.';

export function getRefusalHint(toolName) {
    return HINTS[toolName] || GENERIC;
}

/* -------------------------------------------------------------------------- */
/* buildRefusalPayload — 2.9.1 strong-refusal payload                         */
/* -------------------------------------------------------------------------- */

const STRONG_THRESHOLD = 3;
const SUGGEST_COUNT = 5;

/**
 * 32-bit FNV-1a — seed for deterministic suggestion selection. Derived from
 * the offending tool name so the same loop produces the same advice across
 * retries within a session.
 *
 * @param {string} str
 * @returns {number}
 */
function _hash32(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/**
 * Pick `count` items from `names` deterministically, seeded by `seedKey`.
 * Returns at most `count` names — fewer when the pool is smaller. Always
 * sorted alphabetically in the output so order is stable across retries.
 *
 * @param {string[]} names
 * @param {number} count
 * @param {string} seedKey
 * @returns {string[]}
 */
function _pickDeterministic(names, count, seedKey) {
    if (names.length === 0 || count <= 0) return [];
    const sorted = [...new Set(names)].sort();
    if (sorted.length <= count) return sorted;
    const indices = new Set();
    let s = _hash32(seedKey) || 1;
    while (indices.size < count) {
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        indices.add(s % sorted.length);
    }
    return [...indices].sort((a, b) => a - b).map(i => sorted[i]);
}

/**
 * Build the refusal envelope returned to the LLM when a duplicate-streak
 * fires. Below `streak=3`, returns the legacy soft-message shape (the
 * production path never lands here today, but the function stays defined
 * across the full streak range for testability and future use). At
 * `streak >= 3`, replaces the soft text with imperative wording and adds
 * concrete recovery candidates:
 *
 *   - `suggestions[]`: up to 5 tool names sampled from categories distinct
 *     from the offender's. Seeded by tool name → stable across retries.
 *   - `last_user_message?`: verbatim user request, when supplied.
 *
 * @param {string} toolName
 * @param {number} streak
 * @param {{
 *   catalog?: Array<{name: string, category: string}>,
 *   lastUserMessage?: string,
 *   suggestionCount?: number
 * }} [opts]
 * @returns {{
 *   error: string,
 *   _refused: true,
 *   suggestions?: string[],
 *   last_user_message?: string
 * }}
 */
export function buildRefusalPayload(toolName, streak, opts = {}) {
    if (streak < STRONG_THRESHOLD) {
        return {
            error: `REFUSED: ${toolName} called ${streak} consecutive times with identical args. ${getRefusalHint(toolName)}`,
            _refused: true,
        };
    }

    const catalog = Array.isArray(opts.catalog) ? opts.catalog : [];
    const offender = catalog.find(t => t && t.name === toolName);
    const offendingCategory = offender ? offender.category : null;
    const otherCategoryNames = catalog
        .filter(t => t && typeof t.name === 'string' && t.name !== toolName)
        .filter(t => offendingCategory == null || t.category !== offendingCategory)
        .map(t => t.name);

    const wanted = typeof opts.suggestionCount === 'number'
        ? opts.suggestionCount
        : SUGGEST_COUNT;
    const suggestions = _pickDeterministic(otherCategoryNames, wanted, toolName);

    const suggestionPart = suggestions.length > 0
        ? ` Try one of: [${suggestions.join(', ')}].`
        : '';
    const error =
        `STOP. You have called ${toolName} ${streak} consecutive times with identical args — the registry is REFUSING to execute it.${suggestionPart}` +
        ` Or respond to the user with what you already have. Do not call ${toolName} again with these arguments.`;

    /** @type {{error: string, _refused: true, suggestions?: string[], last_user_message?: string}} */
    const out = { error, _refused: true };
    if (suggestions.length > 0) out.suggestions = suggestions;
    if (typeof opts.lastUserMessage === 'string' && opts.lastUserMessage.length > 0) {
        out.last_user_message = opts.lastUserMessage;
    }
    return out;
}

// Test seams.
export const _testing = {
    STRONG_THRESHOLD,
    SUGGEST_COUNT,
    _hash32,
    _pickDeterministic,
};
