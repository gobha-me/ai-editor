/**
 * Anti-regression CI guard: the `tab:switched` profile-mutation listener
 * that lived at [`js/plugin-editor.js`](../js/plugin-editor.js) pre-2.66.0
 * must stay retired under the plugin lifecycle contract, and the in-tab
 * overlay-banner replacement must keep reading the 2.58.0
 * `State.settings.plugin` shape.
 *
 * Why source-scan — the auto-switch was a runtime side effect with no
 * exported entry point. The post-2.66.0 plugin-editor still exports the
 * same surface (`openPluginEditor` / `getUserPlugins` /
 * `setPluginEditorSource` / `loadUserPlugins`). Pinning by source idiom
 * mirrors the [`tests/test-chat-tool-name-literals.mjs`](test-chat-tool-name-literals.mjs)
 * + [`tests/test-no-raw-localstorage.mjs`](test-no-raw-localstorage.mjs)
 * approach: read the file, strip comments, regex-match for the patterns
 * that must be absent (negative-shape) and the patterns that must be
 * present (positive-shape).
 *
 * Runs under `node --test`. No DOM, no `_node-shim.mjs` needed — pure
 * filesystem read.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PLUGIN_EDITOR_PATH = join(__dirname, '..', 'js', 'plugin-editor.js');

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

const RAW_SOURCE = readFileSync(PLUGIN_EDITOR_PATH, 'utf8');
const CODE = stripComments(RAW_SOURCE);

test('auto-profile-switch retired: no `tab:switched` listener subscribes in plugin-editor.js', () => {
    assert.ok(
        !/EventBus\.on\s*\(\s*['"]tab:switched['"]/.test(CODE),
        'plugin-editor.js must not subscribe to tab:switched — see docs/PLUGIN.md'
    );
});

test('auto-profile-switch retired: no `State.settings.profile =` assignment in plugin-editor.js', () => {
    assert.ok(
        !/State\.settings\.profile\s*=/.test(CODE),
        'plugin-editor.js must not mutate State.settings.profile — overlay (State.settings.plugin) is the sole admission path post-2.66.0'
    );
});

test('auto-profile-switch retired: no `_savedProfile` identifier in plugin-editor.js', () => {
    assert.ok(
        !/\b_savedProfile\b/.test(CODE),
        'plugin-editor.js must not retain the _savedProfile module state — the restore-target-staleness failure mode is gone with auto-switch'
    );
});

test('overlay-banner replacement reads State.settings.plugin + resolvePluginConfig (positive-shape pin)', () => {
    assert.ok(
        /State\.settings\.plugin/.test(CODE),
        'plugin-editor.js must read State.settings.plugin for the overlay banner — see _readPluginOverlayEnabled'
    );
    assert.ok(
        /resolvePluginConfig/.test(CODE),
        'plugin-editor.js must import + call resolvePluginConfig from js/profiles/resolve.js — single source for the overlay-vs-profile-default read'
    );
    assert.ok(
        /pluginEditorOverlayBanner/.test(RAW_SOURCE) && /pluginEditorOverlayEnable/.test(RAW_SOURCE),
        'plugin-editor.js must render the overlay banner with the documented IDs (pluginEditorOverlayBanner + pluginEditorOverlayEnable)'
    );
});
