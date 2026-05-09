// @ts-check
/**
 * `reviewer.v1` — synthetic profile carrying the legacy `'reviewer'`
 * role's "Reviewer" tool surface (read-only code access + issue
 * commenting; no editing or issue creation).
 *
 * `tools.allowed_groups: ['all', 'reviewer']` admits tools tagged
 * `roles: ['all']` or `roles: [..., 'reviewer', ...]`, byte-equivalent
 * to the pre-2.0.0 `Roles.filterTools` behavior when
 * `State.settings.role === 'reviewer'`. Cross-product equivalence
 * pinned by `tests/test-profile-filter-tools.mjs`.
 *
 * **Synthetic** — same posture as `pm.v1` and `full.v1`: registered for
 * lookup, excluded from `Profiles.list()`, targeted by the 2.0.0
 * migration script (slice 3) for users with `settings.role === 'reviewer'`.
 *
 * @module profiles/reviewer-v1
 */

/**
 * @typedef {import('./profile-contract.js').Profile} Profile
 */

/**
 * Reviewer overrides on top of `chat.v1`. Only `tools.allowed_groups`
 * is overridden; everything else inherits unchanged.
 *
 * @type {Profile}
 */
export const REVIEWER_V1 = {
    name: 'reviewer.v1',
    version: '1',
    base: 'chat.v1',

    budget: {},
    retrieval: {},
    memory: {},
    compression: {},

    tools: {
        allowed_groups: ['all', 'reviewer'],
    },

    task_ledger: {},
};
