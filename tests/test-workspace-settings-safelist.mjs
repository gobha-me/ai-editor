/**
 * Workspace-settings safelist tests (1.4.4).
 *
 * Security boundary. The safelist is the contract for what's allowed to
 * round-trip through `.aieditor/settings.json`. Every credential-bearing
 * key MUST be denylisted; every workstation-personal key SHOULD be
 * denylisted. Tests assert both.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    SAFELIST,
    DENYLIST,
    isSafelisted,
    isDenylisted,
    filterToSafelisted,
} from '../js/intelligence/workspace-settings/index.js';

/* ---------------- Frozen contracts ---------------- */

test('SAFELIST is frozen', () => {
    assert.equal(Object.isFrozen(SAFELIST), true);
});

test('DENYLIST is frozen', () => {
    assert.equal(Object.isFrozen(DENYLIST), true);
});

test('SAFELIST and DENYLIST are disjoint', () => {
    const safe = new Set(SAFELIST);
    for (const key of DENYLIST) {
        assert.equal(safe.has(key), false, `key "${key}" appears on both lists`);
    }
});

/* ---------------- Credentials must be denylisted ---------------- */

test('credential keys are denylisted', () => {
    const credentialKeys = [
        'llmApiKey',
        'llmEndpoint',
        'embeddingApiKey',
        'embeddingEndpoint',
        'connections',
        'mcpServers',
        'veniceParameters',
        'openRouterParameters',
    ];
    for (const k of credentialKeys) {
        assert.equal(isDenylisted(k), true, `${k} must be denylisted`);
        assert.equal(isSafelisted(k), false, `${k} must NOT be safelisted`);
    }
});

test('workstation-personal keys are denylisted', () => {
    // Per Plan agent pushback (Q3): apiProvider / modelOverrides /
    // disabledModels / advancedProvider params are workstation-personal,
    // not workspace-shared. Sharing them silently breaks teammates.
    const personalKeys = [
        'apiProvider',
        'llmModel',
        'commitModel',
        'disabledModels',
        'modelOverrides',
        'advancedParams',
    ];
    for (const k of personalKeys) {
        assert.equal(isDenylisted(k), true, `${k} must be denylisted`);
        assert.equal(isSafelisted(k), false, `${k} must NOT be safelisted`);
    }
});

/* ---------------- Safelist sanity ---------------- */

test('safelisted keys round-trip through isSafelisted', () => {
    for (const k of SAFELIST) {
        assert.equal(isSafelisted(k), true, `${k} should be safelisted`);
        assert.equal(isDenylisted(k), false, `${k} should not be denylisted`);
    }
});

test('isSafelisted rejects non-string and empty input', () => {
    assert.equal(isSafelisted(null), false);
    assert.equal(isSafelisted(undefined), false);
    assert.equal(isSafelisted(''), false);
    assert.equal(isSafelisted(42), false);
    assert.equal(isSafelisted({}), false);
});

test('safelist contains expected user-facing knobs', () => {
    // Spot-check the keys the user is most likely to override in a
    // workspace settings file. Catches accidental removal.
    const expected = ['theme', 'uiScale', 'editorFontSize', 'showLineNumbers'];
    for (const k of expected) {
        assert.equal(SAFELIST.includes(k), true, `safelist missing expected key ${k}`);
    }
});

test('1.6.7 — role is denylisted (workstation-personal)', () => {
    // Pre-1.6.7 `role` sat on the SAFELIST under "Behavior", which let a
    // committed `.aieditor/settings.json` overwrite `State.settings.role`
    // on every `project:loaded` and silently revert UI role changes on
    // reload. Role is workstation-personal — same shape as apiProvider /
    // llmModel — and now sits on the DENYLIST.
    assert.equal(SAFELIST.includes('role'), false, 'role must NOT be safelisted');
    assert.equal(isSafelisted('role'), false);
    assert.equal(isDenylisted('role'), true);
});

/* ---------------- filterToSafelisted ---------------- */

test('filterToSafelisted accepts safelisted, rejects unsafe', () => {
    const { accepted, rejected } = filterToSafelisted({
        theme: 'editorial',
        uiScale: 110,
        llmApiKey: 'sk-evil',
        connections: [{ token: 'leaked' }],
        unknownKey: true,
    });
    assert.deepEqual(accepted, { theme: 'editorial', uiScale: 110 });
    assert.equal(rejected.includes('llmApiKey'), true);
    assert.equal(rejected.includes('connections'), true);
    assert.equal(rejected.includes('unknownKey'), true);
});

test('filterToSafelisted handles null / wrong type without throwing', () => {
    assert.deepEqual(filterToSafelisted(null), { accepted: {}, rejected: [] });
    assert.deepEqual(filterToSafelisted(undefined), { accepted: {}, rejected: [] });
    assert.deepEqual(filterToSafelisted('string'), { accepted: {}, rejected: [] });
    assert.deepEqual(filterToSafelisted(42), { accepted: {}, rejected: [] });
});

test('filterToSafelisted does not mutate input', () => {
    const input = { theme: 'editorial', llmApiKey: 'sk-x' };
    const before = JSON.stringify(input);
    filterToSafelisted(input);
    assert.equal(JSON.stringify(input), before);
});
