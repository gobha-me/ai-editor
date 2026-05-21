/**
 * Refusal-envelope behavioral hints.
 *
 * The duplicate-streak guard in tool-loop-core.js fires `REFUSED: <tool> called N
 * consecutive times with identical args` once a model loops on the same tool
 * call. The infrastructure works (gitea#301 / 1.7.1), but cheap-tier models
 * read the error string and fail to extract a behavioral hint pointing at
 * *what* different approach to take. This module supplies tool-specific
 * next-action guidance so weak models can break out of the loop without
 * escalating to a more expensive tier.
 *
 * `buildRefusalPayload` here authors the `RefusedEnvelope` shape
 * (`kind: 'refused', _refused: true`) named in
 * `./agent-loop-contracts.js`. The per-tool `next_action_hint` registry
 * is the loop-side concatenation feed for that envelope per
 * `DESIGN-agent-loop.md` §"The Authorship Rule" — see also
 * `./agent-loop-contracts.js` for the source-side citation point.
 *
 * @see ./agent-loop-contracts.js
 *
 * Origin: Grok-4-3 looped 7+ times on `get_ci_status` against a fresh branch
 * with no PR (HTML-Games dogfood, 2026-05-07). The result was structurally
 * "success" but informationally empty; the model treated empty as "I haven't
 * called this yet" and re-fired.
 *
 * 2.9.1 — qwen-3-6-plus on Venice looped on `list_tools_by_category
 * category=code.project` (ai-editor 2.9.0 dogfood, 2026-05-09). The text-only
 * "pick a different tool to set it up" steered without naming candidates;
 * `buildRefusalPayload` then augmented the envelope at `streak >= 3` with
 * a `suggestions` array sampled from a *different* category than the
 * offender's, plus imperative "STOP" wording.
 *
 * 2.82.0 (gitea#488) — `suggestions` removed. Field replay (qwen-3-6-plus on
 * `xcaliber/HTML-Games` #238, 2026-05-21): `list_dirty_files` looped, and the
 * deterministic-seeded picker produced `[list_pull_requests, peek_project_file,
 * preview_network, read_plugin_source, scratchpad_clear]` — none answered
 * "what's dirty in the working tree?" The picker had no semantic awareness,
 * only off-category names, so any tool-name suggestion was a guess. The model
 * took the bait and burned several turns chasing the false alternatives. New
 * prose names two off-ramps the guard actually admits: respond with what
 * was already gathered, or change at least one argument before retrying.
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
/* buildRefusalPayload — strong-refusal envelope for consecutive-identical    */
/* -------------------------------------------------------------------------- */

const STRONG_THRESHOLD = 3;

/**
 * Build the refusal envelope returned to the LLM when a duplicate-streak
 * fires. Below `streak=3`, returns the legacy soft-message shape (the
 * production path never lands here today, but the function stays defined
 * across the full streak range for testability and future use). At
 * `streak >= 3`, replaces the soft text with imperative wording naming
 * the two off-ramps the guard actually admits: respond with what was
 * already gathered, or change at least one argument before retrying.
 *
 * Pre-2.82.0 the strong-refusal envelope also carried a `suggestions`
 * array of off-category tool names picked deterministically by FNV-1a
 * seed. The picker had no functional/semantic awareness — see the
 * module-header note for the gitea#488 field replay that motivated the
 * removal.
 *
 * @param {string} toolName
 * @param {number} streak
 * @param {{ lastUserMessage?: string }} [opts]
 * @returns {import('./agent-loop-contracts.js').RefusedEnvelope}  Loop-authored `kind: 'refused'` envelope; tool was not invoked.
 */
export function buildRefusalPayload(toolName, streak, opts = {}) {
    if (streak < STRONG_THRESHOLD) {
        return {
            error: `REFUSED: ${toolName} called ${streak} consecutive times with identical args. ${getRefusalHint(toolName)}`,
            _refused: true,
        };
    }

    const error =
        `STOP. You have called ${toolName} ${streak} consecutive times with identical args — the registry is REFUSING to execute it.` +
        ` Respond to the user with what you already have, or change at least one argument before retrying.` +
        ` Do not call ${toolName} again with these arguments.`;

    /** @type {{error: string, _refused: true, last_user_message?: string}} */
    const out = { error, _refused: true };
    if (typeof opts.lastUserMessage === 'string' && opts.lastUserMessage.length > 0) {
        out.last_user_message = opts.lastUserMessage;
    }
    return out;
}

// Test seams.
export const _testing = {
    STRONG_THRESHOLD,
};
