/**
 * Tests for `js/profiles/resolve.js#resolvePluginConfig` — the profile-
 * keyed `plugin.enabled` capability-overlay resolver (gitea#442 / 2.58.0).
 *
 * 2.68.0 (ICD #8 finding #1) rewired this helper from a short-circuit
 * (`profileName === 'coder.v1' ? CODER_V1 : CHAT_V1`) to the same
 * `resolveProfile`-routed lookup pattern as the other eight
 * `resolve*Config` helpers. No production profile carries a `plugin`
 * block today — every profile resolves to `enabled: false`. The
 * Settings overlay (`State.settings.plugin`) is the only flip surface
 * per the gitea#442 decision: plugin-dev is a capability anyone can
 * engage as needed, not a role someone takes on for a session.
 *
 * Pins:
 *   - Every registered profile (incl. `coder.v1`) resolves to
 *     `enabled: false` — no profile carries the block.
 *   - Future-proofing: when a profile inherits via `base: 'X.v1'` from
 *     a base that declares `plugin: { enabled: true }`, the inheritance
 *     walk picks it up. That post-condition is asserted indirectly by
 *     the inheritance-walk subtest (all-inheritors-from-chat.v1 resolve
 *     to false because chat.v1 declares no block — same outcome the
 *     short-circuit produced, but via the right path).
 *   - Unknown profile name falls back to `chat.v1` with a warn.
 *
 * Runs under `node --test`. Imports from profiles only; no DOM/Storage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolvePluginConfig, Profiles } from '../js/profiles/index.js';

test('coder.v1 → enabled=false (no profile carries the block today)', () => {
    const cfg = resolvePluginConfig('coder.v1');
    assert.equal(cfg.profileName, 'coder.v1');
    assert.equal(cfg.enabled, false);
});

test('chat.v1 → enabled=false (no block declared)', () => {
    const cfg = resolvePluginConfig('chat.v1');
    assert.equal(cfg.profileName, 'chat.v1');
    assert.equal(cfg.enabled, false);
});

test('synthetic profiles resolve to enabled=false via inheritance walk', () => {
    // All synthetic profiles inherit `base: 'chat.v1'` and chat.v1
    // carries no `plugin` block, so the inheritance walk produces
    // `{}` everywhere and `enabled === true` fails — same outcome the
    // 2.58.0–2.67.0 short-circuit produced, but via the inheritance
    // walk rather than a hardcoded `: CHAT_V1` branch. This is the
    // shape that future profiles inheriting `plugin: { enabled: true }`
    // depend on.
    for (const leaf of ['pm.v1', 'reviewer.v1', 'plugin-dev.v1', 'full.v1', 'kb.v1', 'subagent.v1']) {
        assert.ok(Profiles.has(leaf), `expected '${leaf}' registered`);
        const cfg = resolvePluginConfig(leaf);
        assert.equal(cfg.profileName, leaf, `${leaf} profileName`);
        assert.equal(cfg.enabled, false, `${leaf} enabled`);
    }
});

test('every registered profile resolves cleanly to enabled=false', () => {
    // No registered profile carries a `plugin` block per gitea#442;
    // every profile resolves to `enabled: false`. Settings overlay
    // (`State.settings.plugin`) is the only flip surface — verified
    // separately at the consumer call site.
    for (const name of [
        'chat.v1', 'coder.v1', 'kb.v1',
        'chat_multi.v1', 'rp.v1',
        'full.v1', 'plugin-dev.v1', 'pm.v1', 'reviewer.v1',
        'subagent.v1',
    ]) {
        assert.ok(Profiles.has(name), `expected '${name}' to be a registered profile`);
        const cfg = resolvePluginConfig(name);
        assert.equal(cfg.profileName, name);
        assert.equal(cfg.enabled, false, `${name} plugin.enabled should be false`);
    }
});

test('unknown profile name falls back to chat.v1 (defensive)', () => {
    const origWarn = console.warn;
    console.warn = () => {};
    try {
        const cfg = resolvePluginConfig('made-up.v1');
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
            const cfg = resolvePluginConfig(/** @type {any} */ (arg));
            assert.equal(cfg.profileName, 'chat.v1', `arg=${JSON.stringify(arg)}`);
            assert.equal(cfg.enabled, false);
        }
    } finally {
        console.warn = origWarn;
    }
});
