/**
 * Tests for 1.1.3 — Vim keybindings setting.
 *
 * Pure-logic checks that the new `editorKeybindingMode` setting:
 *   - Has the right default ('default') in fresh State.
 *   - Survives a Storage round-trip without coercion.
 *   - Falls back to 'default' when the saved blob omits it (legacy installs).
 *
 * Editor-level Vim behavior (mode transitions, motions, ex commands) needs
 * the DOM and is exercised in `tests/test-keybindings.js` under the
 * browser-driven T.suite() runner.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { State, Storage } from '../js/core.js';

test('integration: State.settings.editorKeybindingMode default is "default"', () => {
    assert.equal(State.settings.editorKeybindingMode, 'default');
});

test('round-trip: vim mode persists through Storage.set/get', () => {
    const key = 'settings-test-keybinding-roundtrip';
    Storage.set(key, { editorKeybindingMode: 'vim' });
    const back = Storage.get(key);
    assert.equal(back.editorKeybindingMode, 'vim');
});

test('legacy install: settings blob without editorKeybindingMode falls back to default at merge time', () => {
    // Simulate the merge spread used in loadSettings(): saved blob lacks the
    // key entirely (pre-1.1.3 install). The default-spread pattern guarantees
    // 'default' wins for legacy installs without an explicit migration step.
    const savedLegacy = { showLineNumbers: true, fontSize: 13 };
    const merged = { editorKeybindingMode: 'default', ...savedLegacy };
    assert.equal(merged.editorKeybindingMode, 'default');
});

test('explicit-set wins over default on merge', () => {
    const saved = { editorKeybindingMode: 'vim' };
    const merged = { editorKeybindingMode: 'default', ...saved };
    assert.equal(merged.editorKeybindingMode, 'vim');
});
