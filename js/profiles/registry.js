// @ts-check
/**
 * Profile registry — tiny lookup over the canonical profiles.
 *
 * Extracted at 1.21.0 from the inline `PROFILE_REGISTRY` map that lived
 * in [`resolve.js`](./resolve.js) since 1.17.0 (the comment there had
 * pinned this slice: *"a future `Profiles.get(name)` (1.21.0 picker UI)
 * will subsume it"*). The picker UI in [`js/settings/roles-tab.js`](../settings/roles-tab.js)
 * needs `list()` to populate its `<select>`; `resolve.js` and the new
 * `getActiveProfileName` helper need `get()`/`has()` for lookup +
 * validation. Lifting the map here lets both consumers share one source
 * of truth without `resolve.js` becoming the picker's import target.
 *
 * **1.23.0 — synthetic profiles + `filterTools`.** Four synthetic
 * profiles join the registry (`full.v1`, `plugin-dev.v1`, `pm.v1`,
 * `reviewer.v1`) so `Profiles.get` / `Profiles.has` succeed for them —
 * the 2.0.0 migration script (slice 3) maps each of the legacy roles
 * (`full`, `plugin-dev`, `pm`, `reviewer`) onto these targets. They are
 * deliberately excluded from `Profiles.list()`: the picker UI shows
 * only the user-facing chat / coder pair. New `Profiles.filterTools`
 * mirrors the legacy `Roles.filterTools` byte-for-byte over a profile-
 * keyed lookup; `tests/test-profile-filter-tools.mjs` pins the
 * cross-product equivalence so slice 2 (1.24.0) consumers can flip the
 * read site safely.
 *
 * Phase 2 (`chat_multi.v1`, `rp.v1`, `kb.v1`, per ROADMAP §"After 2.0.0")
 * registers here when those profiles ship.
 *
 * @module profiles/registry
 */

import { CHAT_V1 } from './chat-v1.js';
import { CODER_V1 } from './coder-v1.js';
import { FULL_V1 } from './full-v1.js';
import { PLUGIN_DEV_V1 } from './plugin-dev-v1.js';
import { PM_V1 } from './pm-v1.js';
import { REVIEWER_V1 } from './reviewer-v1.js';

/**
 * @typedef {import('./profile-contract.js').Profile} Profile
 *
 * @typedef {object} ProfileListEntry
 * @property {string} name         Canonical profile name (e.g. `'chat.v1'`).
 * @property {string} label        Short human-readable label for UI controls.
 * @property {string} description  One-line rationale for the picker tooltip.
 *
 * @typedef {{ type: 'function', _registeredRoles?: string[] }} ToolDefShape  Subset of `js/tools/registry.js`'s `ToolDefinition` consumed by `filterTools`.
 */

/**
 * Source of truth for `get` / `list` / `has`. Order is the order
 * `list()` returns — chat first (the base) so the picker's default
 * option ordering matches the inheritance hierarchy.
 *
 * @type {Array<{ profile: Profile, label: string, description: string }>}
 */
const ENTRIES = [
    {
        profile: CHAT_V1,
        label: 'Chat',
        description: 'Standard chat surface — Rule 5 compression only, attached_docs retrieval, user-scope memory.',
    },
    {
        profile: CODER_V1,
        label: 'Coder',
        description: 'Coder surface — Rules 1/2/5 compression, workspace_code retrieval, session-scope scratchpad, full coder tool catalog.',
    },
];

/**
 * Synthetic profiles — registered for `get` / `has` but excluded from
 * `list()`. Targeted by the 2.0.0 migration script (slice 3) for users
 * whose legacy `settings.role` was one of `full` / `plugin-dev` / `pm` /
 * `reviewer`. The picker UI does not surface them; users who want
 * coder-or-chat keep using the picker, and the migration preserves
 * granularity for everyone else without polluting the picker dropdown.
 *
 * @type {Profile[]}
 */
const SYNTHETIC_ENTRIES = [
    FULL_V1,
    PLUGIN_DEV_V1,
    PM_V1,
    REVIEWER_V1,
];

/** @type {Record<string, Profile>} */
const BY_NAME = Object.fromEntries([
    ...ENTRIES.map(e => [e.profile.name, e.profile]),
    ...SYNTHETIC_ENTRIES.map(p => [p.name, p]),
]);

/**
 * @param {string} name
 * @returns {Profile|null}
 */
export function get(name) {
    return BY_NAME[name] || null;
}

/**
 * @param {string} name
 * @returns {boolean}
 */
export function has(name) {
    return Object.prototype.hasOwnProperty.call(BY_NAME, name);
}

/**
 * Returns the user-facing profile list — synthetics intentionally omitted
 * (see `SYNTHETIC_ENTRIES` rationale above). The picker UI consumes this.
 *
 * @returns {ProfileListEntry[]}
 */
export function list() {
    return ENTRIES.map(({ profile, label, description }) => ({
        name: profile.name,
        label,
        description,
    }));
}

/**
 * Filter tool definitions by the active profile's `tools.allowed_groups`.
 * Mirrors the legacy `Roles.filterTools` semantics in [`js/core.js`](../core.js):
 *
 *   - `'*'` in the profile's `allowed_groups` short-circuits to the full
 *     unfiltered set (the legacy `'full'` role bypass).
 *   - Tools tagged `roles: ['all']` (i.e. `_registeredRoles` includes
 *     `'all'`) admit unconditionally.
 *   - Otherwise a tool admits when its `_registeredRoles` and the
 *     profile's `allowed_groups` overlap on at least one entry.
 *
 * Unknown profile names fall back to `chat.v1` with a warn — defensive
 * only; production `getActiveProfileName` never emits anything else.
 *
 * **Slice 1 (1.23.0)** — this helper exists alongside `Roles.filterTools`;
 * no consumer wires up to it yet. Cross-product equivalence vs.
 * `Roles.filterTools` is pinned by `tests/test-profile-filter-tools.mjs`
 * so slice 2 (1.24.0) can flip every consumer site safely.
 *
 * @param {ToolDefShape[]}        defs         Tool definitions (typically `ToolRegistry.definitions`).
 * @param {string|null|undefined} profileName  Active profile name (e.g. `'coder.v1'`).
 * @returns {ToolDefShape[]}                    Filtered subset (a fresh array; input is not mutated).
 */
export function filterTools(defs, profileName) {
    if (!Array.isArray(defs)) return [];

    let profile = typeof profileName === 'string' ? BY_NAME[profileName] : null;
    if (!profile) {
        profile = BY_NAME['chat.v1'];
        if (profileName != null && profileName !== 'chat.v1') {
            console.warn(`[profiles/registry] unknown profileName '${profileName}'; falling back to chat.v1`);
        }
    }

    const allowed = (profile.tools && profile.tools.allowed_groups) || [];
    if (allowed.includes('*')) return defs.slice();

    return defs.filter(def => {
        const groups = (def && def._registeredRoles) || [];
        if (groups.includes('all')) return true;
        for (let i = 0; i < groups.length; i++) {
            if (allowed.includes(groups[i])) return true;
        }
        return false;
    });
}

/**
 * Namespace export for callers that prefer `Profiles.get(...)` over
 * named imports — matches the established `Roles` / `Storage` / `State`
 * convention in `js/core.js`.
 */
export const Profiles = { get, has, list, filterTools };
