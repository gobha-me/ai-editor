// @ts-check
/**
 * Anti-regression tests for the public-export shape of the profiles
 * registry + resolver bank: `Profiles` namespace, the `registry.js` named
 * exports, the `ENTRIES` picker-visible profile list (via `Profiles.list()`),
 * the `BY_NAME` membership (via `Profiles.has(...)`), the `resolve.js`
 * module-level exports (13 names), and the `PLUGIN_TOOL_NAMES` capability-
 * overlay membership.
 *
 * Origin: `RE-EVAL following 2.61.0` ICD #8 code-aware finding #2 — no test
 * pins `Object.keys(Profiles).sort()` or the resolver-bank module shape. A
 * renamed method on the registry surface would only surface at production
 * call sites (`js/tools/registry.js`, `js/prompts.js`, `js/chat/handlers.js`
 * all read by name). Same gap ICD #6 finding #3 cited for `MCPServerRegistry`
 * (resolved at 2.63.0 via `tests/test-mcp-public-surface-shape.mjs`); same
 * idiom applies here.
 *
 * The 2.62.0 row's seam-idiom (validator at a producer seam + frozen-key
 * constants) does NOT apply here — this is a public-export shape pin, not
 * a cross-module payload contract. The right precedent is the
 * `test-mcp-public-surface-shape.mjs` / `test-provider-capabilities-shape.mjs`
 * capabilities pattern: read `Object.keys(module).sort()` and deepEqual it
 * against a frozen expected list. Zero production-file edits — the modules
 * under test stay the source of truth for their own shape.
 *
 * @since 2.67.0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as registryModule from '../js/profiles/registry.js';
import { Profiles } from '../js/profiles/registry.js';
import * as resolveModule from '../js/profiles/resolve.js';
import { PLUGIN_TOOL_NAMES } from '../js/profiles/resolve.js';

// ----- module-level export shape ------------------------------------------

test('public-surface-shape: registry module exports exactly the six-name surface', () => {
    const keys = Object.keys(registryModule).sort();
    assert.deepEqual(keys, [
        'Profiles',
        'filterTools',
        'findAdmittingProfiles',
        'get',
        'has',
        'list',
    ]);
});

test('public-surface-shape: resolve module exports exactly the thirteen-name surface', () => {
    const keys = Object.keys(resolveModule).sort();
    assert.deepEqual(keys, [
        'PLUGIN_TOOL_NAMES',
        'getActiveProfileName',
        'pickProfileName',
        'resolveCompressionConfig',
        'resolveDefaultRememberScope',
        'resolveMemoryConfig',
        'resolvePluginConfig',
        'resolvePreviewConfig',
        'resolveRetrievalConfig',
        'resolveScriptAutomationConfig',
        'resolveSubAgentConfig',
        'resolveTaskLedgerConfig',
        'resolveTools',
    ]);
});

// ----- Profiles namespace shape -------------------------------------------

test('public-surface-shape: Profiles exposes exactly the five-method namespace', () => {
    const keys = Object.keys(Profiles).sort();
    assert.deepEqual(keys, [
        'filterTools',
        'findAdmittingProfiles',
        'get',
        'has',
        'list',
    ]);
});

test('public-surface-shape: every Profiles method is a function', () => {
    for (const key of ['get', 'has', 'list', 'filterTools', 'findAdmittingProfiles']) {
        assert.equal(typeof Profiles[key], 'function', `Profiles.${key} must be a function`);
    }
});

// ----- BY_NAME membership (10 profiles, via Profiles.has) -----------------
//
// `BY_NAME` is not exported directly. Probe membership via the public
// `Profiles.has` surface so the pin survives any future internal-storage
// refactor that keeps the namespace contract intact.

test('public-surface-shape: BY_NAME membership covers exactly the ten known profile names', () => {
    const known = [
        'chat.v1',
        'coder.v1',
        'kb.v1',
        'chat_multi.v1',
        'full.v1',
        'plugin-dev.v1',
        'pm.v1',
        'reviewer.v1',
        'rp.v1',
        'subagent.v1',
    ];
    for (const name of known) {
        assert.equal(Profiles.has(name), true, `Profiles.has('${name}') must be true`);
    }
    // Negative pin: an unregistered name returns false (not the prototype-
    // chain false positive that motivated the `Object.prototype.hasOwnProperty`
    // guard in registry.js).
    assert.equal(Profiles.has('unknown.v1'), false);
    assert.equal(Profiles.has('__proto__'), false);
});

// ----- Profiles.list() — picker-visible order + entry shape ---------------

test('public-surface-shape: Profiles.list() order is exactly [chat.v1, coder.v1, kb.v1]', () => {
    const names = Profiles.list().map(e => e.name);
    assert.deepEqual(names, ['chat.v1', 'coder.v1', 'kb.v1']);
});

test('public-surface-shape: every Profiles.list() entry has exactly {description, label, name}', () => {
    for (const entry of Profiles.list()) {
        const keys = Object.keys(entry).sort();
        assert.deepEqual(keys, ['description', 'label', 'name'], `entry for ${entry.name}`);
        assert.equal(typeof entry.name, 'string');
        assert.equal(typeof entry.label, 'string');
        assert.equal(typeof entry.description, 'string');
    }
});

// ----- PLUGIN_TOOL_NAMES — frozen, exact membership -----------------------

test('public-surface-shape: PLUGIN_TOOL_NAMES is frozen', () => {
    assert.equal(Object.isFrozen(PLUGIN_TOOL_NAMES), true);
});

test('public-surface-shape: PLUGIN_TOOL_NAMES membership is exactly the five-tool plugin-dev cohort', () => {
    assert.deepEqual([...PLUGIN_TOOL_NAMES].sort(), [
        'list_user_plugins',
        'read_docs',
        'read_plugin_source',
        'run_plugin',
        'write_plugin_source',
    ]);
});
