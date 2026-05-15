// @ts-check
/**
 * `full.v1` — synthetic profile carrying the legacy `'full'` role's
 * "Full Access" bypass semantic.
 *
 * The `'*'` token in `tools.admit` is the bypass marker:
 * `Profiles.filterTools` short-circuits and returns every tool when it
 * sees `'*'` as a single entry in the admit array. 2.54.0 (gitea#438)
 * preserves the sentinel under the new `admit` field; the legacy
 * `allowed_groups` tag-intersection model is retired.
 *
 * **Synthetic** — registered in [`registry.js`](./registry.js) for lookup
 * (`Profiles.has`/`get` succeed) but excluded from `Profiles.list()`.
 * The picker UI in [`js/settings/roles-tab.js`](../settings/roles-tab.js)
 * sees only `chat.v1` + `coder.v1` + `kb.v1`. The 2.0.0 migration script
 * (slice 3) targets `full.v1` for users with `settings.role === 'full'`;
 * post-migration, every tool stays admitted.
 *
 * @module profiles/full-v1
 */

/**
 * @typedef {import('./profile-contract.js').Profile} Profile
 */

/**
 * Full-access overrides on top of `chat.v1`. Every subsystem inherits
 * unchanged from chat.v1 except `tools.admit`, which carries the `'*'`
 * bypass marker.
 *
 * @type {Profile}
 */
export const FULL_V1 = {
    name: 'full.v1',
    version: '1',
    base: 'chat.v1',

    budget: {},
    retrieval: {},
    memory: {},
    compression: {},

    tools: {
        // `'*'` short-circuits `Profiles.filterTools` to the unfiltered set.
        // Other `tools` fields inherit from chat.v1.
        admit: ['*'],
    },

    task_ledger: {},
};
