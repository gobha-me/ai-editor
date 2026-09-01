// @ts-check
/**
 * Settings migration — `settings.role` (pre-2.0.0) → `settings.profile`.
 *
 * This module runs the one-shot rewrite of stored settings. Current consumers
 * read profile-keyed configuration through `getActiveProfileName`.
 *
 * The 5-key table mirrors `tests/test-profile-filter-tools.mjs`'s
 * `ROLE_TO_PROFILE` constant verbatim. Divergence across the two is a
 * bug — the cross-product equivalence test pins what the migration must
 * write for the post-migration admission filter to admit the same set as
 * the pre-2.0.0 `Roles.filterTools`.
 *
 * Extracted from inline `loadSettings` to a separate helper so it's
 * Node-importable for `tests/test-settings-role-migration.mjs` (the
 * `loadSettings` body transitively pulls browser-only globals via
 * `core.js` imports).
 *
 * @module profiles/migration
 */

const ROLE_TO_PROFILE = {
    coder:        'coder.v1',
    full:         'full.v1',
    pm:           'pm.v1',
    reviewer:     'reviewer.v1',
    'plugin-dev': 'plugin-dev.v1',
};

/**
 * @typedef {object} MigrationResult
 * @property {boolean}             migrated     Whether `profile` was just
 *                                              written. `false` for
 *                                              already-migrated, no-op,
 *                                              or fresh-install settings
 *                                              that didn't carry `role`.
 * @property {string}  [fromRole]               Source `role` value if the
 *                                              caller wants to audit-log.
 * @property {string}  [toProfile]              Resolved profile name.
 */

/**
 * Mutate `saved` in place: set `profile` from `role` if missing, then
 * `delete saved.role`.
 *
 * Two branches:
 *
 *  1. **Migration path** — `saved.role !== undefined && saved.profile == null`.
 *     Writes `saved.profile` from the 5-key table; deletes `saved.role`.
 *     Returns `{ migrated: true, fromRole, toProfile }` for the audit log.
 *  2. **Picker-already-won path** — `saved.role !== undefined &&
 *     saved.profile != null`. The user touched the picker pre-2.0.0,
 *     so their explicit choice wins; quiet-drop the stale `role` so
 *     subsequent loads idle through this block. Returns
 *     `{ migrated: false, fromRole, toProfile: saved.profile }`.
 *
 * Idempotent: subsequent calls on a settings blob without `role` are
 * no-ops.
 *
 * Unknown / null / undefined / empty `role` values fall through to
 * `chat.v1` — the lowest-config baseline + the new 2.0.0 default for
 * fresh installs.
 *
 * Rollback caveat: this migration is irreversible by load-time
 * detection alone. Downgrading to a 1.x build with a settings blob
 * that has `profile` but no `role` will see `Roles.get(undefined)` and
 * fall back to whatever the legacy default was. Users with workspace-
 * saved settings should re-export before downgrading. Documented at
 * CHANGELOG §2.0.0 "Breaking".
 *
 * @param {Record<string, any>} saved  Parsed settings blob (pre-merge).
 * @returns {MigrationResult}
 */
export function migrateRoleToProfile(saved) {
    if (!saved || typeof saved !== 'object') {
        return { migrated: false };
    }
    if (saved.role !== undefined && saved.profile == null) {
        const fromRole = saved.role;
        const toProfile = ROLE_TO_PROFILE[fromRole] || 'chat.v1';
        saved.profile = toProfile;
        delete saved.role;
        return { migrated: true, fromRole, toProfile };
    }
    if (saved.role !== undefined) {
        // Picker already won pre-2.0.0; quiet-drop the stale role.
        const fromRole = saved.role;
        delete saved.role;
        return { migrated: false, fromRole, toProfile: saved.profile };
    }
    return { migrated: false };
}
