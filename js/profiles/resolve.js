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
 * Other subsystem resolvers (memory, tools, retrieval) follow this
 * shape in 1.18.0 / 1.19.0 / 1.20.0.
 *
 * @module profiles/resolve
 */

import { CODER_V1 } from './coder-v1.js';
import { CHAT_V1 } from './chat-v1.js';
import { resolveProfile } from './inheritance.js';
import {
    SUBSUMPTION_RULE,
    INVALIDATION_RULE,
    SUMMARIZATION_RULE,
} from '../intelligence/compression/index.js';

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
 * Profile registry — the inputs `resolveProfile` walks for `base`
 * names. Kept local to this module; a future `Profiles.get(name)`
 * (1.21.0 picker UI) will subsume it.
 *
 * @type {Record<string, Profile>}
 */
const PROFILE_REGISTRY = {
    'chat.v1':  CHAT_V1,
    'coder.v1': CODER_V1,
};

/** @param {string} name */
function profileLookup(name) {
    return PROFILE_REGISTRY[name] || null;
}

/**
 * Translate a UI-side `role` value to the canonical profile name.
 * Coder is the only role with its own profile today; everything else
 * (Reviewer, PM, plugin-dev, full, null/undefined, unknown strings)
 * resolves to `chat.v1`. Retires at 2.0.0 when the role selector goes
 * away (callers will pass profile names directly).
 *
 * @param {string|null|undefined} role
 * @returns {'coder.v1' | 'chat.v1'}
 */
export function roleToProfileName(role) {
    return role === 'coder' ? 'coder.v1' : 'chat.v1';
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
    const name = typeof profileName === 'string' && PROFILE_REGISTRY[profileName]
        ? profileName
        : 'chat.v1';
    if (name !== profileName) {
        console.warn(`[profiles/resolve] unknown profileName '${profileName}'; falling back to chat.v1`);
    }

    const leaf = PROFILE_REGISTRY[name];
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
