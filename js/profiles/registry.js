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
 * **2.8.0 — first granular promotion: `kb.v1`.** `kb.v1` carries a
 * `systemPrompt` addendum (*"answer only from attached docs, cite line
 * ranges, no edits"*) that makes picking it user-observable without
 * depending on unbuilt infrastructure. Moves to `ENTRIES` alongside
 * `chat.v1` / `coder.v1`. `chat_multi.v1` and `rp.v1` stay in
 * `SYNTHETIC_ENTRIES` until they earn their own addenda — granular
 * promotion is fine.
 *
 * **2.49.0.0 — `subagent.v1` joins as lookup-only (slice 1 of
 * github#24 Phase 1).** Per `docs/DESIGN-sub-agents.md` §"Gap 7", the
 * sub-agent profile is invoked by the parent agent via the
 * `delegate_task` tool (slice 2), not picked by the user — so it
 * registers for `get` / `has` but stays out of `ENTRIES`. Same posture
 * as `chat_multi.v1` / `rp.v1`, different rationale: those are
 * deferred-picker-promotion candidates; `subagent.v1` is structurally
 * never going into the picker.
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
import { SUBAGENT_V1 } from './subagent-v1.js';
import { resolveProfile } from './inheritance.js';

/**
 * @typedef {import('./profile-contract.js').Profile} Profile
 *
 * @typedef {object} ProfileListEntry
 * @property {string} name         Canonical profile name (e.g. `'chat.v1'`).
 * @property {string} label        Short human-readable label for UI controls.
 * @property {string} description  One-line rationale for the picker tooltip.
 *
 * @typedef {{ type: 'function', function?: { name?: string } }} ToolDefShape  Subset of `js/tools/registry.js`'s `ToolDefinition` consumed by `filterTools`.
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
    {
        profile: KB_V1,
        label: 'KB',
        description: 'Knowledge-base assistant — answers strictly from attached docs with line-range citations; refuses edits and code generation. No compression, no memory, minimal tools.',
    },
];

/**
 * Lookup-only profiles — registered for `get` / `has` but excluded from
 * `list()`. Three flavors share this list today:
 *
 *   1. **Legacy-role migration targets** — `full.v1` / `plugin-dev.v1` /
 *      `pm.v1` / `reviewer.v1`. The 2.0.0 migration script (slice 3) maps
 *      legacy `settings.role` strings onto these. Hidden from the picker
 *      so the dropdown stays simple; the migration preserves granularity
 *      for everyone whose role didn't fit `chat` or `coder`.
 *
 *   2. **Phase 2 architectural surfaces** — `chat_multi.v1` / `rp.v1`.
 *      Shipped as data + harness coverage at 2.6.0; *deliberately not*
 *      surfaced in the picker yet. Their declared overrides
 *      (shared_conversation / per_speaker / lore / per_persona collections,
 *      Rule 4, voice-preserving Rule 5) reference runtime infrastructure
 *      that doesn't exist. Picking one today would behave indistinguishably
 *      from `chat.v1` in most respects, which is worse than not offering
 *      it at all.
 *
 *      **Promotion gate** — move back to `ENTRIES` when each profile has
 *      *something a user can observe choosing it for*. The natural lever
 *      is per-profile `systemPrompt` addenda mirroring 1.23.x's
 *      `plugin-dev.v1` precedent. `kb.v1` graduated this way at 2.8.0
 *      (*"answer only from attached docs, cite line ranges, no edits"*)
 *      and now lives in `ENTRIES`. See ROADMAP §"After 2.0.0" → "Profiles
 *      Phase 2 picker promotion" for the trigger spec. Custom plugin
 *      profiles inheriting `base: 'rp.v1'` etc. unlock with the Phase 4
 *      authoring API.
 *
 *   3. **Sub-agent trust-boundary profile** — `subagent.v1` (2.49.0.0,
 *      slice 1 of github#24 Phase 1). Read-only-by-default; bounds a
 *      `delegate_task`-spawned child agent's reach. Structurally never
 *      goes into the picker — sub-agents are invoked by the parent
 *      agent, not selected by the user. See
 *      [`docs/DESIGN-sub-agents.md`](../../docs/DESIGN-sub-agents.md)
 *      §"Gap 7" for the registration rationale and §"Load-Bearing
 *      Decision" for why the profile (not a runtime knob) names the
 *      trust boundary.
 *
 * @type {Profile[]}
 */
const SYNTHETIC_ENTRIES = [
    CHAT_MULTI_V1,
    FULL_V1,
    PLUGIN_DEV_V1,
    PM_V1,
    REVIEWER_V1,
    RP_V1,
    SUBAGENT_V1,
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
 * Filter tool definitions by the active profile's `tools.admit` list
 * (gitea#438 / 2.54.0 — replaces the legacy `allowed_groups`
 * tag-intersection model).
 *
 * Resolution rules, in order:
 *
 *   - `'*'` as a single entry in the profile's resolved admit array
 *     short-circuits to the full unfiltered set (full.v1's bypass).
 *   - Otherwise a tool admits when its `function.name` either:
 *       (a) appears literally in the admit array, OR
 *       (b) matches a `'<prefix>__*'` glob entry by name prefix
 *           (used for MCP-bridge tools whose names are formed as
 *           `mcp__<serverId>__<toolName>` — see `js/mcp/bridge.js`).
 *
 * Unknown profile names fall back to `chat.v1` with a warn — defensive
 * only; production `getActiveProfileName` never emits anything else.
 *
 * Profiles are resolved via `resolveProfile` so inherited admit lists
 * (and `admit_add` / `admit_remove` operators) are honored.
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

    const resolved = resolveProfile(profile, name => BY_NAME[name] || null);
    const admit = (resolved.tools && resolved.tools.admit) || [];
    if (admit.includes('*')) return defs.slice();

    /** @type {Set<string>} */
    const literal = new Set();
    /** @type {string[]} */
    const globPrefixes = [];
    for (const entry of admit) {
        if (typeof entry !== 'string') continue;
        if (entry.endsWith('__*')) {
            globPrefixes.push(entry.slice(0, -1)); // keep the trailing '__'
        } else {
            literal.add(entry);
        }
    }

    return defs.filter(def => {
        const name = def && def.function && def.function.name;
        if (typeof name !== 'string') return false;
        if (literal.has(name)) return true;
        for (const p of globPrefixes) if (name.startsWith(p)) return true;
        return false;
    });
}

/**
 * Return the names of every profile whose resolved `tools.admit` admits
 * `toolName` (literal match or `'<prefix>__*'` glob match). Powers the
 * registry-side default-OFF dev warning (gitea#439): `ToolRegistry.register`
 * calls this after the store updates and emits a `console.warn` if the
 * returned list is empty.
 *
 * Differs from `filterTools` in two ways:
 *
 *   1. Queries by `toolName`, not by a defs array. Used at registration
 *      time before the new tool is visible to any caller.
 *   2. The `'*'` sentinel does NOT count as admission. A tool reachable
 *      only via `full.v1`'s `['*']` bypass is invisible to picker
 *      profiles — exactly the silent-vanish failure mode the warning
 *      catches. Picker-side admission must be explicit (literal or glob).
 *
 * @param {string} toolName Tool name (matches `function.name` in
 *   `ToolDefinition`).
 * @param {{ overlayNames?: string[] }} [opts] Optional capability-overlay
 *   name list (e.g. `PLUGIN_TOOL_NAMES` from the gitea#442
 *   `plugin.enabled` flag). When `toolName` appears in `overlayNames`,
 *   the synthetic name `'<overlay>'` joins the returned list — gitea#442
 *   wires real overlay ids through here without further surface change.
 * @returns {string[]} Profile names (e.g. `['chat.v1', 'coder.v1']`).
 *   Empty array means no profile admits `toolName` and no overlay names
 *   the tool; the caller should warn.
 */
export function findAdmittingProfiles(toolName, opts) {
    if (typeof toolName !== 'string' || !toolName) return [];
    const overlayNames = (opts && Array.isArray(opts.overlayNames)) ? opts.overlayNames : [];
    /** @type {string[]} */
    const admitters = [];
    for (const profileName of Object.keys(BY_NAME)) {
        const profile = BY_NAME[profileName];
        const resolved = resolveProfile(profile, name => BY_NAME[name] || null);
        const admit = (resolved.tools && resolved.tools.admit) || [];
        let matched = false;
        for (const entry of admit) {
            if (typeof entry !== 'string') continue;
            if (entry === '*') continue;  // sentinel does not count — silent-vanish guard
            if (entry === toolName) { matched = true; break; }
            if (entry.endsWith('__*') && toolName.startsWith(entry.slice(0, -1))) {
                matched = true; break;
            }
        }
        if (matched) admitters.push(profileName);
    }
    if (overlayNames.includes(toolName)) admitters.push('<overlay>');
    return admitters;
}

/**
 * Namespace export for callers that prefer `Profiles.get(...)` over
 * named imports — matches the established `Roles` / `Storage` / `State`
 * convention in `js/core.js`.
 */
export const Profiles = { get, has, list, filterTools, findAdmittingProfiles };
