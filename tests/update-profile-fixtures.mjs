/**
 * Regenerate the profile-snapshot fixtures consumed by
 * `tests/test-profiles-fixtures.mjs`.
 *
 *   Run: node tests/update-profile-fixtures.mjs
 *
 * Use this script — and only this script — when an *intentional* profile
 * change has landed and the regression harness fails. Inspect the diff
 * output the harness rendered, decide it's correct, run this script, and
 * commit the regenerated fixtures in the same PR. The PR review then shows
 * the exact resolved-behavior change as a JSON diff.
 *
 * --- Serialization invariants pinned by this script ---
 *
 * 1. `subsystem_dispatch.compression.rules[*].evaluate` cannot round-trip
 *    through JSON (it's a live function). `serializeRules` replaces every
 *    `evaluate` with the literal string `'[Function]'`. This is the ONLY
 *    place that substitution happens; do not duplicate it elsewhere.
 *
 * 2. JSON does not represent `undefined`. Today no profile field is
 *    explicitly `undefined` (the resolver treats `undefined` as "skip"),
 *    so this is not a constraint we hit. If a profile ever needs the
 *    undefined-vs-missing distinction, fixture format must change.
 *
 * 3. `resolveScriptAutomationConfig` / `resolvePreviewConfig` short-
 *    circuit on profile name (only `coder.v1` enables either) — every
 *    other profile gets the chat.v1 fallback. The fixture captures what
 *    the resolver actually returns, not what the raw profile literal
 *    contains.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    Profiles,
    resolveProfile,
    resolveCompressionConfig,
    resolveMemoryConfig,
    resolveTools,
    resolveRetrievalConfig,
    resolveScriptAutomationConfig,
    resolvePreviewConfig,
} from '../js/profiles/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, 'fixtures', 'profiles');

/**
 * The full snapshot population. Add a profile name here when the
 * registry grows (e.g. Phase 2: `chat_multi.v1`, `rp.v1`, `kb.v1`).
 */
const PROFILE_NAMES = [
    'chat.v1',
    'coder.v1',
    'full.v1',
    'plugin-dev.v1',
    'pm.v1',
    'reviewer.v1',
];

/**
 * Replace every `evaluate` function on a list of runtime rules with the
 * literal `'[Function]'` so the snapshot survives `JSON.stringify`. The
 * function attachment is a wiring detail — the data contract (`name`,
 * `priority`) is what we want to pin.
 *
 * @param {Array<Record<string, unknown>>} rules
 */
function serializeRules(rules) {
    if (!Array.isArray(rules)) return rules;
    return rules.map(r => {
        const copy = { ...r };
        if (typeof copy.evaluate === 'function') copy.evaluate = '[Function]';
        return copy;
    });
}

/**
 * Build the snapshot payload for one profile.
 * @param {string} name
 */
function snapshotFor(name) {
    const leaf = Profiles.get(name);
    if (!leaf) throw new Error(`Unknown profile: ${name}`);

    const resolved = resolveProfile(leaf, Profiles.get);

    const compression = resolveCompressionConfig(name);
    const dispatchCompression = {
        ...compression,
        rules: serializeRules(/** @type {any} */ (compression.rules)),
    };

    return {
        resolved,
        subsystem_dispatch: {
            compression: dispatchCompression,
            memory: resolveMemoryConfig(name),
            tools: resolveTools(name),
            retrieval: resolveRetrievalConfig(name),
            script_automation: resolveScriptAutomationConfig(name),
            preview: resolvePreviewConfig(name),
        },
    };
}

mkdirSync(FIXTURE_DIR, { recursive: true });

for (const name of PROFILE_NAMES) {
    const snapshot = snapshotFor(name);
    const out = join(FIXTURE_DIR, `${name}.snapshot.json`);
    writeFileSync(out, JSON.stringify(snapshot, null, 2) + '\n');
    console.log(`  wrote ${out}`);
}

console.log(`\nWrote ${PROFILE_NAMES.length} profile snapshots to ${FIXTURE_DIR}`);
