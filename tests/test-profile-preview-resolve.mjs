/**
 * Tests for `js/profiles/resolve.js#resolvePreviewConfig` — the
 * profile-keyed in-editor preview (Tier 1 sandboxed iframe) resolver.
 *
 * 2.68.0 (ICD #8 finding #1) rewired this helper from a short-circuit
 * (`profileName === 'coder.v1' ? CODER_V1 : CHAT_V1`) to the same
 * `resolveProfile`-routed lookup pattern as the other eight
 * `resolve*Config` helpers. The synthetic-profile inheritance-walk
 * subtest is the pin the roadmap explicitly called for.
 *
 * Pins:
 *   - `coder.v1` returns `enabled: true` (value-case per DESIGN-preview.md).
 *   - `chat.v1` returns `enabled: false` (declared block, gated off).
 *   - Every other registered profile inherits chat.v1's block via
 *     `base: 'chat.v1'` and resolves to `enabled: false`.
 *   - Unknown profile name falls back to `chat.v1` with a warn.
 *   - The `profileName` field reflects the leaf, not the inheritance
 *     base.
 *
 * Runs under `node --test`. Imports from profiles only; no DOM/Storage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolvePreviewConfig, Profiles } from '../js/profiles/index.js';

test('coder.v1 → enabled=true (DESIGN-preview value-case)', () => {
    const cfg = resolvePreviewConfig('coder.v1');
    assert.equal(cfg.profileName, 'coder.v1');
    assert.equal(cfg.enabled, true);
});

test('chat.v1 → enabled=false (block present; gated off)', () => {
    const cfg = resolvePreviewConfig('chat.v1');
    assert.equal(cfg.profileName, 'chat.v1');
    assert.equal(cfg.enabled, false);
});

test('synthetic profiles inherit chat.v1 enabled=false via base: chat.v1 (inheritance-walk pin)', () => {
    // Pre-2.68.0 the short-circuit returned `CHAT_V1.preview` for every
    // non-coder profile (its `: CHAT_V1` branch). Post-2.68.0 the
    // resolver walks the `base` chain; chat.v1's declared block flows
    // through for any profile inheriting from it with no `preview`
    // override. `profileName` reflects the leaf, not the chain root.
    for (const leaf of ['pm.v1', 'reviewer.v1', 'plugin-dev.v1', 'full.v1', 'kb.v1', 'subagent.v1']) {
        assert.ok(Profiles.has(leaf), `expected '${leaf}' registered`);
        const cfg = resolvePreviewConfig(leaf);
        assert.equal(cfg.profileName, leaf, `${leaf} profileName`);
        assert.equal(cfg.enabled, false, `${leaf} enabled`);
    }
});

test('every registered profile resolves cleanly', () => {
    // Only `coder.v1` has the value-case (`preview.enabled: true`);
    // every other profile inherits chat.v1's `enabled: false`.
    const enabledProfiles = new Set(['coder.v1']);
    for (const name of [
        'chat.v1', 'coder.v1', 'kb.v1',
        'chat_multi.v1', 'rp.v1',
        'full.v1', 'plugin-dev.v1', 'pm.v1', 'reviewer.v1',
        'subagent.v1',
    ]) {
        assert.ok(Profiles.has(name), `expected '${name}' to be a registered profile`);
        const cfg = resolvePreviewConfig(name);
        assert.equal(cfg.profileName, name);
        assert.equal(cfg.enabled, enabledProfiles.has(name),
            `${name} preview.enabled mismatch`);
    }
});

test('unknown profile name falls back to chat.v1 (defensive)', () => {
    const origWarn = console.warn;
    console.warn = () => {};
    try {
        const cfg = resolvePreviewConfig('made-up.v1');
        assert.equal(cfg.profileName, 'chat.v1');
        assert.equal(cfg.enabled, false);
    } finally {
        console.warn = origWarn;
    }
});

test('null / undefined / empty profile name falls back to chat.v1', () => {
    const origWarn = console.warn;
    console.warn = () => {};
    try {
        for (const arg of [null, undefined, '', 0]) {
            const cfg = resolvePreviewConfig(/** @type {any} */ (arg));
            assert.equal(cfg.profileName, 'chat.v1', `arg=${JSON.stringify(arg)}`);
            assert.equal(cfg.enabled, false);
        }
    } finally {
        console.warn = origWarn;
    }
});
