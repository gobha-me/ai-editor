/**
 * Profile regression harness — pins resolved-profile and per-subsystem
 * dispatch outputs against on-disk JSON snapshots so any drift in the
 * profile registry, the inheritance resolver, or the subsystem
 * resolvers raises a loud failure with a structured diff.
 *
 * Companion script:
 *   `tests/update-profile-fixtures.mjs` — regenerates all six fixtures
 *   when a profile change is intentional. Failure messages here include
 *   the regen command so the workflow is one read away.
 *
 * Two `test()` blocks per profile:
 *   - Layer 1 (resolved): catches changes in the raw profile literal *or*
 *     in `resolveProfile` deep-merge semantics.
 *   - Layer 2 (subsystem dispatch): catches changes in any of the six
 *     resolvers in `js/profiles/resolve.js`.
 *
 * Adding a profile to the harness: append its name to PROFILE_NAMES and
 * to the matching list in `tests/update-profile-fixtures.mjs`, then run
 * the regen script to land its snapshot.
 *
 * Runs under `node --test`. Pure logic; no DOM/Storage/fetch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    Profiles,
    resolveProfile,
    diffProfiles,
    formatProfileDiff,
    resolveCompressionConfig,
    resolveMemoryConfig,
    resolveTools,
    resolveRetrievalConfig,
    resolveScriptAutomationConfig,
    resolvePreviewConfig,
} from '../js/profiles/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, 'fixtures', 'profiles');

const PROFILE_NAMES = [
    'chat.v1',
    'chat_multi.v1',
    'coder.v1',
    'full.v1',
    'kb.v1',
    'plugin-dev.v1',
    'pm.v1',
    'reviewer.v1',
    'rp.v1',
];

/**
 * Mirror of `serializeRules` in `tests/update-profile-fixtures.mjs`.
 * Both must agree byte-for-byte on the function-stripping convention or
 * the harness will produce a false-positive on every run. If the regen
 * script's serializer changes, this one must change too.
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
 * Build the live snapshot for one profile in the same shape the regen
 * script writes to disk.
 *
 * @param {string} name
 */
function liveSnapshot(name) {
    const leaf = Profiles.get(name);
    if (!leaf) throw new Error(`Unknown profile: ${name}`);
    const compression = resolveCompressionConfig(name);
    return {
        resolved: resolveProfile(leaf, Profiles.get),
        subsystem_dispatch: {
            compression: {
                ...compression,
                rules: serializeRules(/** @type {any} */ (compression.rules)),
            },
            memory: resolveMemoryConfig(name),
            tools: resolveTools(name),
            retrieval: resolveRetrievalConfig(name),
            script_automation: resolveScriptAutomationConfig(name),
            preview: resolvePreviewConfig(name),
        },
    };
}

/**
 * Load the snapshot fixture for a profile from disk.
 * @param {string} name
 */
function loadFixture(name) {
    const path = join(FIXTURE_DIR, `${name}.snapshot.json`);
    return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Round-trip the live snapshot through JSON.stringify+parse so the diff
 * is run between two structurally-identical shapes. Without this, the
 * fixture (which has no `undefined` values, since JSON drops them) would
 * appear to have "removed" any field that the live resolved profile
 * carries as `undefined`. mergeDeep treats undefined as absent; the
 * fixture format does too — round-tripping makes the diff faithful to
 * both invariants.
 *
 * @param {unknown} v
 */
function jsonClone(v) {
    return JSON.parse(JSON.stringify(v));
}

const REGEN_HINT = 'If intentional, regenerate with: node tests/update-profile-fixtures.mjs';

for (const name of PROFILE_NAMES) {
    test(`${name} — resolved snapshot matches fixture`, () => {
        const fixture = loadFixture(name);
        const live = jsonClone(liveSnapshot(name).resolved);
        const diff = diffProfiles(
            /** @type {any} */ (fixture.resolved),
            /** @type {any} */ (live),
            { mode: 'raw' },
        );
        assert.equal(
            diff.equal,
            true,
            `Profile drift detected for '${name}' (resolved layer):\n\n${formatProfileDiff(diff)}\n\n${REGEN_HINT}`,
        );
    });

    test(`${name} — subsystem dispatch matches fixture`, () => {
        const fixture = loadFixture(name);
        const live = jsonClone(liveSnapshot(name).subsystem_dispatch);
        // Wrap both sides under a `name` key so diffProfiles' name-extraction
        // doesn't fall back to '<unknown>' (cosmetic — failure messages
        // surface the profile we're testing).
        const diff = diffProfiles(
            /** @type {any} */ ({ name, ...fixture.subsystem_dispatch }),
            /** @type {any} */ ({ name, ...live }),
            { mode: 'raw', ignorePaths: ['name'] },
        );
        assert.equal(
            diff.equal,
            true,
            `Profile drift detected for '${name}' (subsystem_dispatch layer):\n\n${formatProfileDiff(diff)}\n\n${REGEN_HINT}`,
        );
    });
}
