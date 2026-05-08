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
 * Today's registered set is exactly what `roleToProfileName` can emit —
 * `chat.v1`, `coder.v1` — matching the design's Phase-1 surface count.
 * Phase 2 (`chat_multi.v1`, `rp.v1`, `kb.v1`, per ROADMAP §"After 2.0.0")
 * registers here when those profiles ship.
 *
 * @module profiles/registry
 */

import { CHAT_V1 } from './chat-v1.js';
import { CODER_V1 } from './coder-v1.js';

/**
 * @typedef {import('./profile-contract.js').Profile} Profile
 *
 * @typedef {object} ProfileListEntry
 * @property {string} name         Canonical profile name (e.g. `'chat.v1'`).
 * @property {string} label        Short human-readable label for UI controls.
 * @property {string} description  One-line rationale for the picker tooltip.
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

/** @type {Record<string, Profile>} */
const BY_NAME = Object.fromEntries(ENTRIES.map(e => [e.profile.name, e.profile]));

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
 * Namespace export for callers that prefer `Profiles.get(...)` over
 * named imports — matches the established `Roles` / `Storage` / `State`
 * convention in `js/core.js`.
 */
export const Profiles = { get, has, list };
