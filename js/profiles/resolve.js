// @ts-check
/**
 * Profile resolver — bridges `State.settings.role` to the runtime
 * compression configuration consumed by
 * `js/intelligence/compression/compactor.js`.
 *
 * Phase 1 (1.2.0) implementation per ROADMAP §1.2.0:
 *   "Coder profile registers Rules 1, 2 + existing Rule 5. Other roles
 *    (Reviewer, PM) keep current Rule-5-only behavior via the profile
 *    shim."
 *
 * 1.4.0 will replace this with a richer resolver that handles the full
 * `Profile` contract for tools and budgets; 2.0.0 makes profiles the
 * load-bearing surface and roles a UI shim. Keep this file deliberately
 * thin so those replacements drop in cleanly.
 *
 * @module profiles/resolve
 */

import { CODER_V1 } from './coder-v1.js';
import {
    SUBSUMPTION_RULE,
    INVALIDATION_RULE,
    SUMMARIZATION_RULE,
} from '../intelligence/compression/index.js';

/**
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
 * Resolve compression configuration for the active role. Returns the
 * exact shape `Compactor.compress()` consumes for `rules` +
 * `preserve_recent` (the caller still supplies `history`,
 * `budget_tokens`, and an optional `summarizer`).
 *
 * @param {string|null|undefined} role  Value from `State.settings.role`.
 * @returns {{ rules: RuntimeRule[], preserve_recent: number, profileName: string }}
 */
export function resolveCompressionConfig(role) {
    if (role === 'coder') {
        const rules = CODER_V1.compression.rules
            .map(r => RUNTIME_RULES[r.name])
            .filter(r => r != null);
        return {
            rules,
            preserve_recent: CODER_V1.compression.preserve_recent,
            profileName: CODER_V1.name,
        };
    }
    // Non-coder roles preserve current behavior — Rule 5 only. The
    // existing `js/chat/summarizer.js` is what users on these roles
    // already see; this resolver returns the matching profile shim so
    // the Compactor's pipeline runs as a no-op pass-through (no
    // eviction rules, summarizer wires up via Rule 5 like before).
    return {
        rules: [SUMMARIZATION_RULE],
        preserve_recent: 24,
        profileName: 'rule5_only_shim',
    };
}
