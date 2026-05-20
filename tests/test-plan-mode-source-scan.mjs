/**
 * Catalog-parity lint for `side_effects` classification (gitea#480, 2.76.0).
 *
 * Why this exists — gitea#480 root cause was a two-sided whack-a-mole:
 * `write_file` and `create_pull_request` registered without the legacy
 * `readOnly: true` flag, the dispatch gate didn't check anything else,
 * and they slipped through plan mode against a real Gitea repo.
 *
 * The 2.76.0 fix shifted the source of truth to `SIDE_EFFECTS_BY_NAME`
 * in `js/intelligence/tools/side-effects.js`. This lint enforces parity
 * between the live registration sites (`js/tools/*.js`) and the catalog
 * map. Failure modes it catches:
 *
 *   1. **New registration without classification** — a `register('foo', ...)`
 *      call site exists in `js/tools/*.js` with no matching entry in
 *      `SIDE_EFFECTS_BY_NAME`. The new tool would fail-closed to
 *      `'external'` and be blocked everywhere plan mode applies; that
 *      is the correct security posture, but it's silent. The lint
 *      forces the author to consciously classify (and review the
 *      classification on PR).
 *
 *   2. **Stale catalog entry** — `SIDE_EFFECTS_BY_NAME` has a name with
 *      no matching `register()` site. Either the tool was removed
 *      without cleaning the catalog (stale knowledge) or the catalog
 *      name has drifted from the registration name (typo). Either way,
 *      the entry can never be consulted.
 *
 * Shape: source-scan, mirrors `tests/test-chat-tool-name-literals.mjs`
 * and `tests/test-tool-cache-classifications.mjs`. Walks the on-disk
 * sources at `js/tools/*.js`, extracts `register('NAME',` literals
 * (comment-stripped), and asserts the resulting name set matches the
 * static-keys of `SIDE_EFFECTS_BY_NAME`. No DOM/State boot required.
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SIDE_EFFECTS_BY_NAME } from '../js/intelligence/tools/side-effects.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const TOOLS_DIR = join(REPO_ROOT, 'js', 'tools');

/**
 * Tools that legitimately exist in `js/tools/*.js` as `register('NAME', ...)`
 * literals but should NOT be in `SIDE_EFFECTS_BY_NAME`. Empty in 2.76.0;
 * kept as a documented escape hatch for future cases like generated
 * registrations or test-only stubs that ride in source files.
 *
 * @type {Set<string>}
 */
const REGISTRATION_ONLY_ALLOWLIST = new Set([]);

/**
 * Catalog entries that don't have a static `register('NAME', ...)` literal.
 * Empty in 2.76.0. Future MCP-bridged or runtime-only tool classifications
 * (if we ever pre-populate them) would land here with justification.
 *
 * @type {Set<string>}
 */
const CATALOG_ONLY_ALLOWLIST = new Set([]);

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/**
 * Walk `js/tools/*.js` and collect every `register('NAME',` literal.
 * @returns {Set<string>}
 */
function readRegisteredNames() {
    const names = new Set();
    const startRe = /(?:ToolRegistry|registry)\.register\s*\(\s*['"]([a-z_][a-z0-9_]*)['"]/g;
    for (const entry of readdirSync(TOOLS_DIR)) {
        if (!entry.endsWith('.js')) continue;
        const raw = readFileSync(join(TOOLS_DIR, entry), 'utf8');
        const src = stripComments(raw);
        startRe.lastIndex = 0;
        let m;
        while ((m = startRe.exec(src)) !== null) {
            names.add(m[1]);
        }
    }
    return names;
}

// ============================================================================
// Case A — every registered tool has a side_effects classification
// ============================================================================

test('every register() literal in js/tools/*.js has a SIDE_EFFECTS_BY_NAME entry', () => {
    const registered = readRegisteredNames();
    const missing = [];
    for (const name of registered) {
        if (REGISTRATION_ONLY_ALLOWLIST.has(name)) continue;
        if (!(name in SIDE_EFFECTS_BY_NAME)) missing.push(name);
    }
    assert.deepEqual(
        missing.sort(),
        [],
        `Registered tools are missing a side_effects classification:\n  ${missing.sort().join('\n  ')}\n\n` +
        `Add each entry to \`js/intelligence/tools/side-effects.js\` SIDE_EFFECTS_BY_NAME with the\n` +
        `appropriate "read" / "write" / "external" / "irreversible" class. Plan-mode admission\n` +
        `(gitea#480, 2.76.0) reads this map; an unclassified tool fails closed and is silently\n` +
        `blocked while planning — better than a bypass, but the author should choose the class\n` +
        `consciously rather than relying on the fail-closed default.`,
    );
});

// ============================================================================
// Case B — every catalog entry corresponds to a real registration
// ============================================================================

test('every SIDE_EFFECTS_BY_NAME entry corresponds to a register() literal in js/tools/*.js', () => {
    const registered = readRegisteredNames();
    const stale = [];
    for (const name of Object.keys(SIDE_EFFECTS_BY_NAME)) {
        if (CATALOG_ONLY_ALLOWLIST.has(name)) continue;
        if (!registered.has(name)) stale.push(name);
    }
    assert.deepEqual(
        stale.sort(),
        [],
        `SIDE_EFFECTS_BY_NAME contains entries with no matching register() literal:\n  ${stale.sort().join('\n  ')}\n\n` +
        `These tools may have been removed or renamed. Either delete the catalog entry, fix the\n` +
        `name to match the registration, or add the name to CATALOG_ONLY_ALLOWLIST with a\n` +
        `justification (e.g. runtime-only registrations the lint can't see).`,
    );
});

// ============================================================================
// Case C — gitea#480 fix lock-in: write_file + create_pull_request classified
// ============================================================================

test('gitea#480 regression: write_file and create_pull_request are classified', () => {
    // The exact two tools from the gitea#480 incident. Pin their
    // classifications so a regression that re-deletes the entries (or a
    // catalog-side rename that loses them) fails this lint with a
    // pointed message rather than a generic "missing entry" failure.
    assert.equal(SIDE_EFFECTS_BY_NAME['write_file'], 'external',
        'write_file must be classified to prevent the gitea#480 bypass');
    assert.equal(SIDE_EFFECTS_BY_NAME['create_pull_request'], 'external',
        'create_pull_request must be classified to prevent the gitea#480 bypass');
});
