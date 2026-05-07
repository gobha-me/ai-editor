/**
 * Provider `usage` field extractor (1.8.5).
 *
 * Single source of truth for parsing the `usage` block on an LLM response.
 * Both `cost-recorder._onCostUpdated()` (persistent path) and
 * `LLM._trackUsage()` (live `State.sessionCost` path) call through here so
 * the two surfaces can't drift on field coverage.
 *
 * Handles two response shapes:
 *
 * - **OpenAI shape** — `prompt_tokens`, `completion_tokens`,
 *   `prompt_tokens_details.cached_tokens`,
 *   `completion_tokens_details.reasoning_tokens`.
 * - **Anthropic shape** — `input_tokens`, `output_tokens`,
 *   `cache_read_input_tokens`, `cache_creation_input_tokens`.
 *
 * "First present wins" — no provider branching. OpenAI keys take priority
 * for input/output (because OpenRouter / Venice normalize Claude responses
 * to OpenAI shape, and we want their normalized counts to win); Anthropic
 * keys fill in when only Anthropic-shape arrives. Anthropic-native cache
 * fields are exposed as `cacheReadTokens` / `cacheCreationTokens` for UI
 * surfacing AND fold into `cachedTokens` when OpenAI's
 * `prompt_tokens_details.cached_tokens` is absent — that keeps
 * `_computeCost`'s existing cached-token discount working without a
 * separate Anthropic pricing path.
 */

/**
 * @typedef {Object} ExtractedUsage
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cachedTokens
 * @property {number} reasoningTokens
 * @property {number} cacheReadTokens      Anthropic-native `cache_read_input_tokens`. 0 when absent.
 * @property {number} cacheCreationTokens  Anthropic-native `cache_creation_input_tokens`. 0 when absent.
 */

/**
 * @param {any} usage
 * @returns {ExtractedUsage}
 */
export function extractUsage(usage) {
    if (!usage || typeof usage !== 'object') {
        return {
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
        };
    }

    const inputTokens =
        _num(usage.prompt_tokens) ??
        _num(usage.input_tokens) ??
        0;

    const outputTokens =
        _num(usage.completion_tokens) ??
        _num(usage.output_tokens) ??
        0;

    const cacheReadTokens     = _num(usage.cache_read_input_tokens)     ?? 0;
    const cacheCreationTokens = _num(usage.cache_creation_input_tokens) ?? 0;

    const cachedTokens =
        _num(usage.prompt_tokens_details?.cached_tokens) ??
        cacheReadTokens ??
        0;

    const reasoningTokens =
        _num(usage.completion_tokens_details?.reasoning_tokens) ??
        0;

    return {
        inputTokens,
        outputTokens,
        cachedTokens,
        reasoningTokens,
        cacheReadTokens,
        cacheCreationTokens,
    };
}

/**
 * Coerce a numeric-or-missing field. Returns the number when finite,
 * `undefined` when the field is absent or non-numeric so the `??` chain
 * in `extractUsage` cleanly falls through to the next candidate.
 *
 * @param {unknown} v
 * @returns {number|undefined}
 */
function _num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
