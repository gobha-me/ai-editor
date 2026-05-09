// @ts-check
/**
 * `pm.v1` — synthetic profile carrying the legacy `'pm'` role's
 * "Project Manager" tool surface.
 *
 * `tools.allowed_groups: ['all', 'pm']` admits tools tagged
 * `roles: ['all']` or `roles: [..., 'pm', ...]`, byte-equivalent to the
 * pre-2.0.0 `Roles.filterTools` behavior when `State.settings.role === 'pm'`.
 * Cross-product equivalence pinned by `tests/test-profile-filter-tools.mjs`.
 *
 * **Synthetic** — registered in [`registry.js`](./registry.js) for lookup
 * (`Profiles.has`/`get` succeed) but excluded from `Profiles.list()`.
 * The picker UI shows only `chat.v1` + `coder.v1`; the 2.0.0 migration
 * script (slice 3) targets `pm.v1` for users with `settings.role === 'pm'`
 * to preserve granularity. Picking `chat.v1` from the picker post-migration
 * is intentionally wider (chat.v1's `allowed_groups` admits pm + reviewer
 * tools alongside its own surface).
 *
 * @module profiles/pm-v1
 */

/**
 * @typedef {import('./profile-contract.js').Profile} Profile
 */

/**
 * Project-manager overrides on top of `chat.v1`. Only `tools.allowed_groups`
 * is overridden; everything else inherits unchanged.
 *
 * @type {Profile}
 */
export const PM_V1 = {
    name: 'pm.v1',
    version: '1',
    base: 'chat.v1',

    budget: {},
    retrieval: {},
    memory: {},
    compression: {},

    tools: {
        allowed_groups: ['all', 'pm'],
    },

    task_ledger: {},
};
