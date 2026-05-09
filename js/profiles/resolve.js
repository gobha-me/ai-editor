// @ts-check
/**
 * Profile resolver — bridges role-keyed callers to a profile-keyed
 * lookup over the resolved (`base`-chain merged) profile.
 *
 * Phase 2 (1.17.0) of the path-to-2.0.0 profile arc per ROADMAP §"2.X
 * path": `resolveCompressionConfig` now takes a profile name and reads
 * from a *resolved* profile (deep-merge consulted at lookup) rather than
 * branching on `role` and reading raw `CODER_V1`. The companion
 * `roleToProfileName` translator keeps the existing call site
 * role-keyed; the picker UI flips that at 1.21.0 and the role selector
 * retires at 2.0.0.
 *
 * The chat-side `rule5_only_shim` returned in 1.2.0–1.16.0 is retired
 * by this slice — `chat.v1.compression` (Rule 5 only,
 * `preserve_recent: 4`) supersedes it. Chat surfaces consequently drop
 * `preserve_recent` from `24` to `4`, reconciling the divergence noted
 * in `js/profiles/chat-v1.js`.
 *
 * 1.18.0 added `resolveMemoryConfig(profileName)` over the same
 * lookup pattern; 1.19.0 added `resolveTools(profileName)`; 1.20.0
 * adds `resolveRetrievalConfig(profileName)` — the last subsystem
 * rewire of the path-to-2.0.0 arc.
 *
 * @module profiles/resolve
 */

import { CODER_V1 } from './coder-v1.js';
import { CHAT_V1 } from './chat-v1.js';
import { resolveProfile } from './inheritance.js';
import { Profiles } from './registry.js';
import {
    SUBSUMPTION_RULE,
    INVALIDATION_RULE,
    SUMMARIZATION_RULE,
} from '../intelligence/compression/index.js';
import { MEMORY_SCOPES } from '../intelligence/memory/contracts.js';

/**
 * @typedef {import('./profile-contract.js').Profile} Profile
 * @typedef {import('../intelligence/compression/contracts.js').CompressionRule} RuntimeRule
 */

/**
 * Map a profile-side rule name (data-only) to the runtime rule object
 * (with `evaluate` function). When 1.4.0 adds `find_tool` etc., they
 * register here too.
 *
 * @type {Record<string, RuntimeRule>}
 */
const RUNTIME_RULES = {
    subsumption:   SUBSUMPTION_RULE,
    invalidation:  INVALIDATION_RULE,
    summarization: SUMMARIZATION_RULE,
};

/**
 * `resolveProfile`'s `base`-name lookup — delegates to the registry
 * extracted at 1.21.0 (`js/profiles/registry.js`). The pre-1.21.0
 * inline `PROFILE_REGISTRY` map lifted to that module so the picker
 * UI in `js/settings/roles-tab.js` can share it without circular-
 * importing `resolve.js`.
 *
 * @param {string} name
 * @returns {Profile|null}
 */
function profileLookup(name) {
    return Profiles.get(name);
}

/**
 * Translate a UI-side `role` value to the canonical profile name.
 *
 * 1.24.0 (slice 2 of path-to-2.0.0) — widened from the pre-1.24.0 narrow
 * `coder ? 'coder.v1' : 'chat.v1'` mapping to a 5-key table covering
 * every legacy role. The four synthetic profiles registered at 1.23.0
 * (`full.v1`, `plugin-dev.v1`, `pm.v1`, `reviewer.v1`) are now the
 * resolution targets for their matching legacy roles, so consumer call
 * sites that flow through this translator (the admission filter at
 * `Profiles.filterTools` and the `profile.systemPrompt` injection at
 * `js/prompts.js`) get byte-equivalent runtime behavior to the legacy
 * `Roles.filterTools` + `role.systemPrompt` paths. Cross-product
 * equivalence pinned by `tests/test-profile-filter-tools.mjs`; this
 * mapping mirrors that test's `ROLE_TO_PROFILE` table verbatim.
 *
 * Default fallback (null/undefined/unknown roles) resolves to `chat.v1`
 * unchanged. Retires at 2.0.0 when the role selector goes away
 * (callers will pass profile names directly).
 *
 * @param {string|null|undefined} role
 * @returns {'coder.v1' | 'chat.v1' | 'full.v1' | 'plugin-dev.v1' | 'pm.v1' | 'reviewer.v1'}
 */
export function roleToProfileName(role) {
    switch (role) {
        case 'coder':       return 'coder.v1';
        case 'full':        return 'full.v1';
        case 'plugin-dev':  return 'plugin-dev.v1';
        case 'pm':          return 'pm.v1';
        case 'reviewer':    return 'reviewer.v1';
        default:            return 'chat.v1';
    }
}

/**
 * Pick the active profile name from a settings-shaped object — the
 * load-bearing semantic for 1.21.0's picker UI: *"the picker exists;
 * role still wins if untouched."*
 *
 * Precedence:
 *   1. If `settings.profile` is a known profile name (per
 *      `Profiles.has`), it wins — the user touched the picker.
 *   2. Otherwise fall through to `roleToProfileName(settings.role)` —
 *      pre-1.21.0 behavior, byte-for-byte.
 *
 * Validation is permissive: an *unknown* string in `settings.profile`
 * silently falls through to the role path rather than warning. The
 * picker UI only writes registry-known names + `null` (the "(use
 * role)" sentinel), so an unknown value implies a stale settings blob
 * (e.g. an export from a future version with a removed profile) — the
 * graceful degradation is to honor the role selector instead of
 * surfacing a noisy warning every turn.
 *
 * @param {{ profile?: string|null, role?: string|null } | null | undefined} settings
 * @returns {'coder.v1' | 'chat.v1' | 'full.v1' | 'plugin-dev.v1' | 'pm.v1' | 'reviewer.v1'}
 */
export function getActiveProfileName(settings) {
    const profile = settings && typeof settings.profile === 'string' ? settings.profile : null;
    if (profile && Profiles.has(profile)) {
        return /** @type {'coder.v1' | 'chat.v1' | 'full.v1' | 'plugin-dev.v1' | 'pm.v1' | 'reviewer.v1'} */ (profile);
    }
    return roleToProfileName(settings && settings.role);
}

/**
 * Resolve compression configuration for a given profile. Returns the
 * exact shape `Compactor.compress()` consumes for `rules` +
 * `preserve_recent` (the caller still supplies `history`,
 * `budget_tokens`, and an optional `summarizer`).
 *
 * Reads from the *resolved* profile (deep-merge of the named profile on
 * top of its `base` chain). Unknown profile names fall back to
 * `chat.v1` with a warn — defensive only; `roleToProfileName` never
 * emits anything else.
 *
 * @param {string|null|undefined} profileName
 * @returns {{ rules: RuntimeRule[], preserve_recent: number, profileName: string }}
 */
export function resolveCompressionConfig(profileName) {
    const name = typeof profileName === 'string' && Profiles.has(profileName)
        ? profileName
        : 'chat.v1';
    if (name !== profileName) {
        console.warn(`[profiles/resolve] unknown profileName '${profileName}'; falling back to chat.v1`);
    }

    const leaf = Profiles.get(name);
    const resolved = resolveProfile(leaf, profileLookup);
    const rules = (resolved.compression?.rules || [])
        .map(r => RUNTIME_RULES[r.name])
        .filter(r => r != null);

    return {
        rules,
        preserve_recent: resolved.compression?.preserve_recent ?? 4,
        profileName: resolved.name,
    };
}

/**
 * Resolve memory configuration for a given profile. Returns the
 * `profile.memory` slice — `default_scope`, `propose_after_n_turns`,
 * `capacity_warnings` — sourced from the *resolved* profile (deep-merge
 * of the named profile on top of its `base` chain).
 *
 * Mirrors `resolveCompressionConfig` byte-for-byte in shape; the only
 * surface that consumes it today is `js/tools/memory-tools.js`
 * (admit-default scope) — `propose_after_n_turns` and
 * `capacity_warnings` are exposed for the consent-UI / Settings tab
 * consumers that land in subsequent slices.
 *
 * Note that `default_scope` may be a value outside `MEMORY_SCOPES`
 * (e.g. coder.v1's `'session'`, which describes scratchpad rather than
 * the memory store). Callers that route to the memory store must
 * validate / fall back; the resolver returns the raw profile data
 * unchanged.
 *
 * Unknown profile names fall back to `chat.v1` with a warn — defensive
 * only; `roleToProfileName` never emits anything else.
 *
 * @param {string|null|undefined} profileName
 * @returns {{ default_scope: string, propose_after_n_turns: number|null, capacity_warnings: object, profileName: string }}
 */
export function resolveMemoryConfig(profileName) {
    const name = typeof profileName === 'string' && Profiles.has(profileName)
        ? profileName
        : 'chat.v1';
    if (name !== profileName) {
        console.warn(`[profiles/resolve] unknown profileName '${profileName}'; falling back to chat.v1`);
    }

    const leaf = Profiles.get(name);
    const resolved = resolveProfile(leaf, profileLookup);
    const memory = resolved.memory || {};

    return {
        default_scope: memory.default_scope ?? 'user',
        propose_after_n_turns: memory.propose_after_n_turns ?? null,
        capacity_warnings: memory.capacity_warnings ?? {},
        profileName: resolved.name,
    };
}

/**
 * Resolve tools configuration for a given profile. Returns the
 * `profile.tools` slice's `static` array — the always-loaded tool
 * names — sourced from the *resolved* profile (deep-merge of the named
 * profile on top of its `base` chain).
 *
 * Mirrors `resolveCompressionConfig` and `resolveMemoryConfig` byte-
 * for-byte in shape. Today the surfaces that consume it are
 * `js/chat/handlers.js`'s task-ledger record sites
 * (`recordToolInvocation`, `recordDiscoveryAdmissions`) — they need
 * the profile name (the ledger's `surface` key) and the static-
 * admission set so the ledger can tell static admissions from the
 * discovery-admitted ones. Other `tools` fields (`catalog`,
 * `discovery_strategies`, `budget_tokens`, `expansion_mode`) stay
 * reachable via `resolveProfile` directly when a future slice needs
 * them — the resolver doesn't widen its surface speculatively.
 *
 * Unknown profile names fall back to `chat.v1` with a warn — defensive
 * only; `roleToProfileName` never emits anything else.
 *
 * @param {string|null|undefined} profileName
 * @returns {{ static: string[], profileName: string }}
 */
export function resolveTools(profileName) {
    const name = typeof profileName === 'string' && Profiles.has(profileName)
        ? profileName
        : 'chat.v1';
    if (name !== profileName) {
        console.warn(`[profiles/resolve] unknown profileName '${profileName}'; falling back to chat.v1`);
    }

    const leaf = Profiles.get(name);
    const resolved = resolveProfile(leaf, profileLookup);
    const tools = resolved.tools || {};

    return {
        static: tools.static ?? [],
        profileName: resolved.name,
    };
}

/**
 * Resolve retrieval configuration for a given profile. Returns the
 * `profile.retrieval` slice's load-bearing fields — `collections`,
 * `memory_collections`, `strategy_weights`, `novelty_threshold` —
 * sourced from the *resolved* profile (deep-merge of the named profile
 * on top of its `base` chain).
 *
 * Mirrors `resolveCompressionConfig`, `resolveMemoryConfig`, and
 * `resolveTools` byte-for-byte in shape. The fourth and final consumer
 * rewire of the path-to-2.0.0 profile arc per ROADMAP §"2.X path":
 * after this slice ships, every intelligence subsystem reads from a
 * resolved profile, so profiles are load-bearing internally even
 * though the Settings surface is still role-keyed (the picker UI
 * lands at 1.21.0; the role selector retires at 2.0.0).
 *
 * Today the surface that consumes it is the retrieval Composer call
 * site at `js/intelligence/retrieval/manager.js:findRelevantFiles` —
 * specifically the `composeOpts.noveltyThreshold` thread (step 6.5
 * re-admission gating). The other three fields (`collections`,
 * `memory_collections`, `strategy_weights`) are returned for
 * forward-looking parity with the slice spec; today's call site
 * supplies a runtime collection ID directly and does not thread
 * strategy weights through this layer. Pinning them in the resolver
 * shape now keeps subsequent slices additive — same shape decision as
 * 1.18.0 returning `propose_after_n_turns` ahead of its consumer.
 *
 * Other `retrieval` fields (`chunkers`, `metadata_extensions`) stay
 * reachable via `resolveProfile` directly when a future slice needs
 * them — the resolver doesn't widen its surface speculatively.
 *
 * Unknown profile names fall back to `chat.v1` with a warn — defensive
 * only; `roleToProfileName` never emits anything else.
 *
 * @param {string|null|undefined} profileName
 * @returns {{ collections: string[], memory_collections: string[], strategy_weights: object, novelty_threshold: number, profileName: string }}
 */
export function resolveRetrievalConfig(profileName) {
    const name = typeof profileName === 'string' && Profiles.has(profileName)
        ? profileName
        : 'chat.v1';
    if (name !== profileName) {
        console.warn(`[profiles/resolve] unknown profileName '${profileName}'; falling back to chat.v1`);
    }

    const leaf = Profiles.get(name);
    const resolved = resolveProfile(leaf, profileLookup);
    const retrieval = resolved.retrieval || {};

    return {
        collections: retrieval.collections ?? [],
        memory_collections: retrieval.memory_collections ?? [],
        strategy_weights: retrieval.strategy_weights ?? {},
        novelty_threshold: retrieval.novelty_threshold ?? 0.4,
        profileName: resolved.name,
    };
}

/**
 * Resolve the default scope for `memory_remember` admits when the
 * model omits `scope`. Reads `profile.memory.default_scope` via the
 * resolver; falls back to `'workspace'` when the profile's value
 * isn't a memory-store scope (e.g. coder.v1's `'session'`, which
 * describes scratchpad rather than the memory store). The fallback
 * preserves pre-1.18.0 behavior for coder — the Removability check
 * (§Decisions 7) verifies this in `tests/test-memory-resolve.mjs`.
 *
 * Lives in `resolve.js` rather than `memory-tools.js` so the helper
 * is Node-importable for tests (memory-tools transitively pulls
 * `core.js`'s browser-only `window.addEventListener`).
 *
 * **1.21.0 — polymorphic argument.** Accepts either a role string
 * (pre-1.21.0 callers / existing tests — `resolveDefaultRememberScope('coder')`)
 * or a settings-shaped object with `{ role, profile }` keys
 * (`resolveDefaultRememberScope(State.settings)`). The settings form
 * threads the picker via `getActiveProfileName`; the string form
 * preserves the legacy `roleToProfileName` path so the existing
 * memory-resolve test suite passes byte-identical.
 *
 * @param {string|null|undefined|{ role?: string|null, profile?: string|null }} input
 * @returns {'user'|'workspace'}
 */
export function resolveDefaultRememberScope(input) {
    let profileName;
    if (input && typeof input === 'object') {
        profileName = getActiveProfileName(input);
    } else {
        profileName = roleToProfileName(/** @type {string|null|undefined} */ (input));
    }
    const cfg = resolveMemoryConfig(profileName);
    return MEMORY_SCOPES.includes(cfg.default_scope) ? cfg.default_scope : 'workspace';
}

/**
 * Resolve the LLM-authored automation (Tier-0 Worker) config for the
 * active role. Coder gets the value-case `enabled: true`; every other
 * role inherits chat.v1's `enabled: false`. Settings overlay can flip
 * either direction at runtime via `State.settings.scriptAutomation`
 * (see `js/settings/tools-tab.js` row).
 *
 * Phase 1 — kept role-keyed because the Tier-0 sandbox shipped before
 * the broader profile-keyed rewire; gets its own slice when the
 * automation track resumes.
 *
 * @param {string|null|undefined} role  Value from `State.settings.role`.
 * @returns {{ enabled: boolean, timeout_ms: number, max_output_bytes: number, profileName: string }}
 */
export function resolveScriptAutomationConfig(role) {
    const profile = role === 'coder' ? CODER_V1 : CHAT_V1;
    const cfg = profile.scriptAutomation || {};
    return {
        enabled: cfg.enabled === true,
        timeout_ms: Number.isInteger(cfg.timeout_ms) && cfg.timeout_ms > 0
            ? cfg.timeout_ms
            : 30000,
        max_output_bytes: Number.isInteger(cfg.max_output_bytes) && cfg.max_output_bytes > 0
            ? cfg.max_output_bytes
            : 262144,
        profileName: profile.name,
    };
}

/**
 * Resolve the in-editor preview (Tier 1 sandboxed iframe) config for the
 * active role. Coder gets the value-case `enabled: true`; every other
 * role inherits chat.v1's `enabled: false`. Settings overlay can flip
 * either direction at runtime via `State.settings.preview`
 * (see `js/settings/tools-tab.js` row).
 *
 * Mirrors `resolveScriptAutomationConfig` byte-for-byte in shape — same
 * Phase-1 escape hatch (kept role-keyed for now; gets folded into the
 * profile-keyed rewire when the preview track ships Tier 2/3 and the
 * config slice grows past a single boolean).
 *
 * @param {string|null|undefined} role  Value from `State.settings.role`.
 * @returns {{ enabled: boolean, profileName: string }}
 */
export function resolvePreviewConfig(role) {
    const profile = role === 'coder' ? CODER_V1 : CHAT_V1;
    const cfg = profile.preview || {};
    return {
        enabled: cfg.enabled === true,
        profileName: profile.name,
    };
}
