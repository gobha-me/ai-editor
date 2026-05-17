/**
 * Regression tests for ICD #7 finding #3 (shipped 2.65.0).
 *
 * Pre-2.65.0, the invisible-Unicode scan ran on `installPlugin` but its
 * findings were discarded once the user bypassed the warning band — the
 * `InstalledPlugin` record on storage had no record of the bypass decision,
 * leaving an operator auditing Settings → Plugins blind to which externals
 * had been flagged.
 *
 * 2.65.0 adds `invisibleUnicodeFindings?: Array<{codepoint, name, line, col}>`
 * to the persisted record as an opt-in field (omitted on clean installs +
 * absent on pre-2.65.0 records, so back-compat is automatic).
 *
 * The persistence-completeness contract is tested via the pure-helper export
 * `_buildInstalledRecord` — the rejection-path shape is tested via a
 * full `installPlugin` call with `fetch` stubbed. The bypass-install
 * persistence path can't be exercised under Node (dynamic `import()` of a
 * blob URL doesn't work), which is why the helper extraction exists.
 *
 * See [`docs/ICD-plugin-lifecycle.md`](../docs/ICD-plugin-lifecycle.md)
 * §"Code-aware findings #3" for the failure-mode analysis.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    installPlugin,
    getInstalledPlugins,
    _buildInstalledRecord,
} from '../js/plugin-loader.js';
import { Storage } from '../js/core.js';

const STORAGE_KEY = 'installedPlugins';

/* ============================================================ */
/* _buildInstalledRecord helper                                 */
/* ============================================================ */

test('_buildInstalledRecord omits invisibleUnicodeFindings on a clean install', () => {
    const rec = _buildInstalledRecord({
        url: 'https://example.com/p.js',
        pluginId: 'p',
        name: 'Plugin P',
        installedAt: '2026-05-17T00:00:00.000Z',
        invisibleFindings: [],
    });
    assert.deepEqual(rec, {
        url: 'https://example.com/p.js',
        pluginId: 'p',
        name: 'Plugin P',
        installedAt: '2026-05-17T00:00:00.000Z',
        error: null,
    });
    assert.equal('invisibleUnicodeFindings' in rec, false, 'field is opt-in — absent on clean install');
});

test('_buildInstalledRecord omits the field when invisibleFindings is undefined', () => {
    const rec = _buildInstalledRecord({
        url: 'https://example.com/p.js',
        pluginId: 'p',
        name: 'Plugin P',
        installedAt: '2026-05-17T00:00:00.000Z',
    });
    assert.equal('invisibleUnicodeFindings' in rec, false);
});

test('_buildInstalledRecord persists findings with the four-key shape (strips index/char)', () => {
    const rec = _buildInstalledRecord({
        url: 'https://example.com/p.js',
        pluginId: 'p',
        name: 'Plugin P',
        installedAt: '2026-05-17T00:00:00.000Z',
        invisibleFindings: [
            {
                index: 12,
                char: String.fromCodePoint(0x200B),
                codepoint: 0x200B,
                name: 'Zero Width Space',
                line: 1,
                col: 13,
            },
            {
                index: 45,
                char: String.fromCodePoint(0x2066),
                codepoint: 0x2066,
                name: 'Left-To-Right Isolate',
                line: 3,
                col: 7,
            },
        ],
    });

    assert.ok(Array.isArray(rec.invisibleUnicodeFindings));
    assert.equal(rec.invisibleUnicodeFindings.length, 2);

    // Audit-relevant subset only — `index` + `char` deliberately stripped.
    for (const f of rec.invisibleUnicodeFindings) {
        assert.deepEqual(
            Object.keys(f).sort(),
            ['codepoint', 'col', 'line', 'name'],
            'persisted finding has exactly {codepoint, name, line, col}',
        );
    }

    assert.deepEqual(rec.invisibleUnicodeFindings[0], {
        codepoint: 0x200B,
        name: 'Zero Width Space',
        line: 1,
        col: 13,
    });
});

test('_buildInstalledRecord round-trips via Storage / getInstalledPlugins (back-compat)', () => {
    // Mixed list: one pre-2.65.0 record (no field) + one with findings.
    const list = [
        {
            url: 'https://old.example.com/legacy.js',
            pluginId: 'legacy',
            name: 'Legacy',
            installedAt: '2026-04-01T00:00:00.000Z',
            error: null,
        },
        _buildInstalledRecord({
            url: 'https://example.com/flagged.js',
            pluginId: 'flagged',
            name: 'Flagged',
            installedAt: '2026-05-17T00:00:00.000Z',
            invisibleFindings: [
                { codepoint: 0xFEFF, name: 'Zero Width No-Break Space (BOM)', line: 1, col: 1 },
            ],
        }),
    ];
    Storage.set(STORAGE_KEY, list);

    try {
        const roundtripped = getInstalledPlugins();
        assert.equal(roundtripped.length, 2);
        assert.equal('invisibleUnicodeFindings' in roundtripped[0], false, 'legacy entry preserved unchanged');
        assert.equal(roundtripped[1].invisibleUnicodeFindings.length, 1);
        assert.equal(roundtripped[1].invisibleUnicodeFindings[0].codepoint, 0xFEFF);
    } finally {
        Storage.set(STORAGE_KEY, []);
    }
});

/* ============================================================ */
/* installPlugin — rejection path returns findings shape        */
/* ============================================================ */

test('installPlugin rejects with findings when source contains invisible Unicode', async () => {
    const origFetch = globalThis.fetch;
    Storage.set(STORAGE_KEY, []);
    try {
        // Construct via String.fromCodePoint so the lint that scans test files
        // for invisible Unicode (see .gitea/workflows/ci.yaml) doesn't fire.
        const zwsp = String.fromCodePoint(0x200B);
        const tampered = `Plugins.register({ id: 'tampered', name: 'Tampered${zwsp}' });`;
        globalThis.fetch = async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => tampered,
        });

        const result = await installPlugin('https://example.com/tampered.js');

        assert.equal(result.success, false);
        assert.equal(result.requiresConfirmation, true);
        assert.ok(Array.isArray(result.invisibleUnicodeFindings));
        assert.equal(result.invisibleUnicodeFindings.length, 1);
        assert.equal(result.invisibleUnicodeFindings[0].codepoint, 0x200B);
        assert.equal(result.invisibleUnicodeFindings[0].line, 1);

        // Bypass path NOT exercised — nothing persisted on the rejection path.
        assert.equal(getInstalledPlugins().length, 0, 'rejection persists nothing');
    } finally {
        globalThis.fetch = origFetch;
        Storage.set(STORAGE_KEY, []);
    }
});
