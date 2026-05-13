/**
 * Tests for js/settings/tab-activation-registry.js — 2.44.0.2 (sweep wave
 * slice 3). Validates the shape of the registry and the parity contract:
 * every tab that was a `tab.dataset.tab === 'tabX'` branch in the
 * pre-2.44.0.2 `populateSettingsForm()` switch is now self-registered by
 * its tab module at module-load time.
 *
 * Why parity matters — the slice's load-bearing claim is that swapping
 * the 11-branch switch for `dispatchOnActivate(tab.dataset.tab)` is
 * byte-equivalent at runtime. If a tab module skips its registration the
 * activation hook silently no-ops; the parity test pins the expected
 * coverage so a future contributor adding a 12th tab can't ship without
 * either registering it or explicitly amending this expected-set.
 *
 * Anti-regression on the call-site side: the test also greps
 * `js/settings-manager.js` for `tab.dataset.tab ===` literals so the old
 * inline switch can't reappear alongside the registry dispatch (would
 * silently double-fire handlers).
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Side-effect import — settings-manager.js transitively imports every
// tab module, which fires their `registerOnActivate(...)` side-effects at
// module-load. The parity tests below read the registry state populated
// by that load.
import '../js/settings-manager.js';

import {
    registerOnActivate,
    registerOnClose,
    dispatchOnActivate,
    dispatchAllOnClose,
    listActivationTabs,
    listCloseTabs,
    _resetForTests,
} from '../js/settings/tab-activation-registry.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// Tabs that carried per-activation refresh hooks in the pre-2.44.0.2
// switch statement (js/settings-manager.js#populateSettingsForm, deleted
// in 2.44.0.2). The slice's byte-equivalence claim is that this exact
// set still fires after the registry migration.
const EXPECTED_ACTIVATION_TABS = new Set([
    'tabEmbeddings',
    'tabModels',
    'tabPlugins',
    'tabIgnore',
    'tabStorage',
    'tabCost',
    'tabMemory',
    'tabWorkspaceSettings',
    'tabTestLoop',
    'tabTools',
    'tabRetrieval',
]);

// Tabs that need teardown on `closeSettings()`. Pre-2.44.0.2 this was a
// single explicit `unmountMemoryTab()` call; the registry generalizes to
// support future Preact-tree tabs.
const EXPECTED_CLOSE_TABS = new Set([
    'tabMemory',
]);

// ── Parity tests (run before unit tests so they observe the side-
//    effect-loaded state; subsequent _resetForTests() calls would
//    otherwise wipe the registrations) ──

test('parity: settings-manager.js triggers every expected tab activation', () => {
    const actual = new Set(listActivationTabs());
    assert.deepEqual(
        actual, EXPECTED_ACTIVATION_TABS,
        `tab-activation coverage drift — registry has ${[...actual].sort().join(',')}`
    );
});

test('parity: tabMemory is the only on-close registration', () => {
    const actual = new Set(listCloseTabs());
    assert.deepEqual(
        actual, EXPECTED_CLOSE_TABS,
        `tab-close coverage drift — registry has ${[...actual].sort().join(',')}`
    );
});

test('anti-regression: no inline `tab.dataset.tab === \'tabX\'` switch in settings-manager.js', () => {
    const src = readFileSync(join(REPO_ROOT, 'js', 'settings-manager.js'), 'utf8');
    // Strip block + line comments before scanning so doc comments that
    // mention the pre-2.44.0.2 pattern (the 2.44.0.2 comment block does)
    // don't trip the guard.
    const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
    const matches = stripped.match(/tab\.dataset\.tab\s*===\s*['"]/g) || [];
    assert.equal(
        matches.length, 0,
        `settings-manager.js reintroduced inline switch (${matches.length} match${matches.length === 1 ? '' : 'es'})`
    );
});

// ── Unit tests (use _resetForTests for isolation; runs after parity
//    tests so the codebase-loaded state is observed first) ──

test('shape: registerOnActivate + dispatchOnActivate fires handler', () => {
    _resetForTests();
    let fired = 0;
    registerOnActivate('tabUnitA', () => { fired++; });
    dispatchOnActivate('tabUnitA');
    assert.equal(fired, 1);
});

test('shape: dispatchOnActivate for unregistered tab is a no-op', () => {
    _resetForTests();
    // No-throw and no observable effect — explicitly assert nothing
    // crashes when an unknown tabId (e.g. a tab without a refresh hook,
    // like `tabAppearance`) is clicked.
    dispatchOnActivate('tabAppearance');
    dispatchOnActivate('totally-unknown');
});

test('shape: registerOnActivate rejects duplicate tabId', () => {
    _resetForTests();
    registerOnActivate('tabDup', () => {});
    assert.throws(
        () => registerOnActivate('tabDup', () => {}),
        /already registered/
    );
});

test('shape: registerOnActivate rejects non-string tabId', () => {
    _resetForTests();
    assert.throws(() => registerOnActivate(null, () => {}), /non-empty string/);
    assert.throws(() => registerOnActivate('', () => {}), /non-empty string/);
    assert.throws(() => registerOnActivate(42, () => {}), /non-empty string/);
});

test('shape: registerOnActivate rejects non-function handler', () => {
    _resetForTests();
    assert.throws(() => registerOnActivate('tabBad', null), /not a function/);
    assert.throws(() => registerOnActivate('tabBad', 'not-a-fn'), /not a function/);
});

test('shape: dispatchAllOnClose fires every registered on-close handler', () => {
    _resetForTests();
    const fired = [];
    registerOnClose('tabA', () => fired.push('A'));
    registerOnClose('tabB', () => fired.push('B'));
    registerOnClose('tabC', () => fired.push('C'));
    dispatchAllOnClose();
    assert.deepEqual(fired.sort(), ['A', 'B', 'C']);
});

test('shape: dispatchOnActivate catches handler errors (warn-and-continue)', () => {
    _resetForTests();
    // Capture console.warn so the test output isn't littered with the
    // expected warning. The handler error must not propagate out of
    // dispatchOnActivate — that's the contract.
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => { warnings.push(args); };
    try {
        registerOnActivate('tabBoom', () => { throw new Error('boom'); });
        // Should not throw:
        dispatchOnActivate('tabBoom');
        assert.equal(warnings.length, 1);
        assert.match(String(warnings[0][0]), /tabBoom/);
    } finally {
        console.warn = originalWarn;
    }
});

test('shape: dispatchAllOnClose isolates handler errors', () => {
    _resetForTests();
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        const fired = [];
        registerOnClose('tabOk1', () => fired.push('ok1'));
        registerOnClose('tabBoom', () => { throw new Error('boom'); });
        registerOnClose('tabOk2', () => fired.push('ok2'));
        dispatchAllOnClose();
        // Both non-throwing handlers ran despite tabBoom throwing.
        assert.deepEqual(fired.sort(), ['ok1', 'ok2']);
    } finally {
        console.warn = originalWarn;
    }
});

test('shape: listActivationTabs returns ids in registration order', () => {
    _resetForTests();
    registerOnActivate('tabFirst', () => {});
    registerOnActivate('tabSecond', () => {});
    registerOnActivate('tabThird', () => {});
    assert.deepEqual(listActivationTabs(), ['tabFirst', 'tabSecond', 'tabThird']);
});
