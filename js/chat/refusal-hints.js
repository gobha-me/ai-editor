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
