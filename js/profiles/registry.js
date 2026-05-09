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
 * **2.6.0 — Phase 2 lands as data + harness coverage.** `chat_multi.v1`,
 * `rp.v1`, `kb.v1` join the registry for `get` / `has` lookup but
 * **deliberately not** the picker `ENTRIES` list. Their declared overrides
 * reference runtime infrastructure that doesn't exist (chunker metadata,
 * Rule 4, voice-preserving Rule 5 prompts), so picking one today would
 * behave indistinguishably from `chat.v1` for the user. Promoting them
 * back into `ENTRIES` is gated on profile-specific `systemPrompt` addenda
 * (per the 1.23.x `plugin-dev.v1` precedent) — that's the lift that makes
 * picking each one observable. See `SYNTHETIC_ENTRIES` rationale below
 * and ROADMAP §"After 2.0.0" for the promotion trigger.
 *
 * @module profiles/registry
 */

import { CHAT_V1 } from './chat-v1.js';
import { CHAT_MULTI_V1 } from './chat-multi-v1.js';
import { CODER_V1 } from './coder-v1.js';
import { FULL_V1 } from './full-v1.js';
import { KB_V1 } from './kb-v1.js';
import { PLUGIN_DEV_V1 } from './plugin-dev-v1.js';
import { PM_V1 } from './pm-v1.js';
import { REVIEWER_V1 } from './reviewer-v1.js';
import { RP_V1 } from './rp-v1.js';

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
 * Lookup-only profiles — registered for `get` / `has` but excluded from
 * `list()`. Two flavors share this list today:
 *
 *   1. **Legacy-role migration targets** — `full.v1` / `plugin-dev.v1` /
 *      `pm.v1` / `reviewer.v1`. The 2.0.0 migration script (slice 3) maps
 *      legacy `settings.role` strings onto these. Hidden from the picker
 *      so the dropdown stays simple; the migration preserves granularity
 *      for everyone whose role didn't fit `chat` or `coder`.
 *
 *   2. **Phase 2 architectural surfaces** — `chat_multi.v1` / `rp.v1` /
 *      `kb.v1`. Shipped as data + harness coverage at 2.6.0; *deliberately
 *      not* surfaced in the picker yet. Their declared overrides
 *      (shared_conversation / per_speaker / lore / per_persona / kb_documents
 *      collections, Rule 4, voice-preserving Rule 5) reference runtime
 *      infrastructure that doesn't exist. Picking one today would behave
 *      indistinguishably from `chat.v1` in most respects, which is worse
 *      than not offering it at all.
 *
 *      **Promotion gate** — move back to `ENTRIES` when each profile has
 *      *something a user can observe choosing it for*. The natural lever
 *      is per-profile `systemPrompt` addenda mirroring 1.23.x's
 *      `plugin-dev.v1` precedent: a `kb.v1` that prompts *"answer only
 *      from attached_docs, cite line ranges, no edits"* actually behaves
 *      differently. See ROADMAP §"After 2.0.0" → "Profiles Phase 2 picker
 *      promotion" for the trigger spec. Custom plugin profiles inheriting
 *      `base: 'rp.v1'` etc. unlock with the Phase 4 authoring API.
 *
 * @type {Profile[]}
 */
const SYNTHETIC_ENTRIES = [
    CHAT_MULTI_V1,
    FULL_V1,
    KB_V1,
    PLUGIN_DEV_V1,
    PM_V1,
    REVIEWER_V1,
    RP_V1,
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
