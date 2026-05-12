/**
 * Tests for `Storage.migrateLegacyKey()` — the 2.40.0 storage-discipline
 * sweep helper that copies an unprefixed legacy localStorage key onto the
 * Storage wrapper (cache + IDB + prefixed localStorage) and removes the
 * legacy entry.
 *
 * Background — pre-2.40.0 a handful of modules wrote to bare localStorage
 * with ad-hoc unprefixed keys (`chat.planMode`, `aieditor.help.platform`,
 * `searchHistory`, `pr-review.drafts.${N}`, etc.). Memory note
 * `feedback_storage_idb_authoritative.md` flagged the recurring incident
 * shape (1.5.9 #16, 1.6.5): on a localStorage quota event raw keys die
 * where Storage-wrapped keys survive (Storage's IDB shadow + in-memory
 * `_cache` outlast localStorage). The 2.40.0 sweep routes every call site
 * through `Storage.migrateLegacyKey` so existing user data lifts onto the
 * IDB-backed layer instead of orphaning under the `ai-editor-` prefix.
 *
 * Pure-logic; runs under `node --test` via the `_node-shim.mjs`
 * Map-backed localStorage stub.
 */
import './_node-shim.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Storage } from '../js/core.js';

// Reset Storage's in-memory cache + raw localStorage between cases so each
// test starts from a clean slate. _idbReady stays false (no IDB under Node);
// the prefixed-localStorage write-through inside Storage.set is the
// observable persistence path here.
beforeEach(() => {
    Storage._cache.clear();
    globalThis.localStorage.clear();
});

test('migrateLegacyKey — no-op when legacy key absent', () => {
    const ran = Storage.migrateLegacyKey('nope.legacy', 'nope.target');
    assert.equal(ran, false);
    assert.equal(Storage.get('nope.target', null), null);
});

test('migrateLegacyKey — copies legacy → Storage and removes legacy (JSON.parse default transform)', () => {
    globalThis.localStorage.setItem('legacy.list', JSON.stringify([{ a: 1 }, { a: 2 }]));

    const ran = Storage.migrateLegacyKey('legacy.list', 'target.list');
    assert.equal(ran, true);

    // Storage cache + prefixed localStorage hold the parsed value
    assert.deepEqual(Storage.get('target.list'), [{ a: 1 }, { a: 2 }]);
    assert.equal(globalThis.localStorage.getItem('ai-editor-target.list'),
        JSON.stringify([{ a: 1 }, { a: 2 }]));

    // Legacy entry gone
    assert.equal(globalThis.localStorage.getItem('legacy.list'), null);
});

test('migrateLegacyKey — transform applied for the bool-as-string-flag pattern', () => {
    globalThis.localStorage.setItem('plan.mode.legacy', '1');

    Storage.migrateLegacyKey('plan.mode.legacy', 'plan.mode', { transform: (s) => s === '1' });

    assert.equal(Storage.get('plan.mode'), true);
    assert.equal(globalThis.localStorage.getItem('plan.mode.legacy'), null);
});

test('migrateLegacyKey — transform: identity preserves bare-string values (no quote-wrapping)', () => {
    globalThis.localStorage.setItem('plat.legacy', 'mac');

    Storage.migrateLegacyKey('plat.legacy', 'plat.target', { transform: (s) => s });

    assert.equal(Storage.get('plat.target'), 'mac');
    // Storage.set serializes with JSON, so the prefixed value is `"mac"`
    assert.equal(globalThis.localStorage.getItem('ai-editor-plat.target'), JSON.stringify('mac'));
});

test('migrateLegacyKey — drops legacy without overwrite when storageKey already populated', () => {
    // Simulate a freshly-written Storage value before migration runs
    Storage.set('coexists', { keep: 'me' });
    globalThis.localStorage.setItem('coexists.legacy', JSON.stringify({ keep: 'stale' }));

    const ran = Storage.migrateLegacyKey('coexists.legacy', 'coexists');
    assert.equal(ran, true);

    // Storage value preserved (the legacy stale value did NOT overwrite)
    assert.deepEqual(Storage.get('coexists'), { keep: 'me' });
    // Legacy removed regardless
    assert.equal(globalThis.localStorage.getItem('coexists.legacy'), null);
});

test('migrateLegacyKey — corrupt JSON: legacy removed, no Storage write', () => {
    globalThis.localStorage.setItem('bad.json', '{ this is not json');

    const ran = Storage.migrateLegacyKey('bad.json', 'bad.target');
    assert.equal(ran, false);

    // Legacy removed (avoid trying again on every read)
    assert.equal(globalThis.localStorage.getItem('bad.json'), null);
    // Nothing written to Storage
    assert.equal(Storage.get('bad.target', null), null);
});

test('migrateLegacyKey — corrupt value with non-throwing transform: writes whatever transform returns', () => {
    // A transform that swallows errors and returns a default — write goes through.
    globalThis.localStorage.setItem('soft.legacy', 'not-a-number-but-thats-ok');
    Storage.migrateLegacyKey('soft.legacy', 'soft.target', {
        transform: (s) => (Number.isFinite(parseFloat(s)) ? parseFloat(s) : 0),
    });
    assert.equal(Storage.get('soft.target'), 0);
    assert.equal(globalThis.localStorage.getItem('soft.legacy'), null);
});

test('migrateLegacyKey — idempotent: second call after migration is a no-op', () => {
    globalThis.localStorage.setItem('once.legacy', JSON.stringify({ v: 42 }));

    const first = Storage.migrateLegacyKey('once.legacy', 'once.target');
    assert.equal(first, true);
    assert.deepEqual(Storage.get('once.target'), { v: 42 });

    // Second call: legacy is gone, Storage holds value — return false.
    const second = Storage.migrateLegacyKey('once.legacy', 'once.target');
    assert.equal(second, false);
    assert.deepEqual(Storage.get('once.target'), { v: 42 });
});
