/**
 * Tests for `js/profiles/resolve.js#resolveScriptAutomationConfig` — the
 * profile-keyed Tier-0 Worker config resolver.
 *
 * 2.68.0 (ICD #8 finding #1) rewired this helper from a short-circuit
 * (`profileName === 'coder.v1' ? CODER_V1 : CHAT_V1`) to the same
 * `resolveProfile`-routed lookup pattern as the other eight
 * `resolve*Config` helpers. The short-circuit worked at the time
 * because the `scriptAutomation` block lived only on `coder.v1` /
 * `chat.v1` and no production profile inherited via `base: 'coder.v1'`.
 * The fix is pre-emptive — when the 2.0.x advanced-view picker
 * introduces such inheritance, the inheritance walk now picks the
 * block up automatically. The "synthetic profiles inherit chat.v1
 * defaults via `base: 'chat.v1'`" subtest is the inheritance-walk pin
 * the roadmap explicitly called for.
 *
 * Pins:
 *   - `coder.v1` returns `enabled: true` with explicit timeout / cap.
 *   - `chat.v1` returns `enabled: false` with the same timeout / cap
 *     defaults (chat.v1 declares the block with `enabled: false`).
 *   - Every other registered profile inherits chat.v1's block via
 *     `base: 'chat.v1'` and resolves to `enabled: false`.
 *   - Unknown profile name falls back to `chat.v1` with a warn.
 *   - The `profileName` field reflects the leaf, not the inheritance
 *     base (mirrors `resolveCompressionConfig`'s shape).
 *
 * Runs under `node --test`. Imports from profiles only; no DOM/Storage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveScriptAutomationConfig, Profiles } from '../js/profiles/index.js';

test('coder.v1 → enabled=true with explicit DESIGN defaults', () => {
    const cfg = resolveScriptAutomationConfig('coder.v1');
    assert.equal(cfg.profileName, 'coder.v1');
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.timeout_ms, 30000);         // coder-v1.js:367
    assert.equal(cfg.max_output_bytes, 262144);  // coder-v1.js:368 (DESIGN line 188)
});

test('chat.v1 → enabled=false (block present; just gated off)', () => {
    const cfg = resolveScriptAutomationConfig('chat.v1');
    assert.equal(cfg.profileName, 'chat.v1');
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.timeout_ms, 30000);
    assert.equal(cfg.max_output_bytes, 262144);
});

test('synthetic profiles inherit chat.v1 defaults via base: chat.v1 (inheritance-walk pin)', () => {
    // Pre-2.68.0 the short-circuit returned `CHAT_V1`'s block directly
    // for every non-coder profile (its short-circuit `: CHAT_V1`
    // branch). Post-2.68.0 the resolver walks the `base` chain and
    // picks up `chat.v1`'s declared block for any profile inheriting
    // from chat.v1 with no `scriptAutomation` override. The
    // `profileName` reflects the leaf, not the chain root — same shape
    // as `resolveCompressionConfig`.
    for (const leaf of ['pm.v1', 'reviewer.v1', 'plugin-dev.v1', 'full.v1', 'kb.v1', 'subagent.v1']) {
        assert.ok(Profiles.has(leaf), `expected '${leaf}' registered`);
        const cfg = resolveScriptAutomationConfig(leaf);
        assert.equal(cfg.profileName, leaf, `${leaf} profileName`);
        assert.equal(cfg.enabled, false, `${leaf} enabled`);
        assert.equal(cfg.timeout_ms, 30000, `${leaf} timeout_ms`);
        assert.equal(cfg.max_output_bytes, 262144, `${leaf} max_output_bytes`);
    }
});

test('every registered profile resolves cleanly', () => {
    // Walks every registry entry (ENTRIES + SYNTHETIC_ENTRIES); if any
    // profile resolution throws, this test fails. Catches accidental
    // breakage from future profile additions whose `base` chain
    // confuses the resolver. Only `coder.v1` has the value-case
    // (`enabled: true`); everything else inherits chat.v1's
    // `enabled: false`.
    const enabledProfiles = new Set(['coder.v1']);
    for (const name of [
        'chat.v1', 'coder.v1', 'kb.v1',
        'chat_multi.v1', 'rp.v1',
        'full.v1', 'plugin-dev.v1', 'pm.v1', 'reviewer.v1',
        'subagent.v1',
    ]) {
        assert.ok(Profiles.has(name), `expected '${name}' to be a registered profile`);
        const cfg = resolveScriptAutomationConfig(name);
        assert.equal(cfg.profileName, name);
        assert.equal(cfg.enabled, enabledProfiles.has(name),
            `${name} scriptAutomation.enabled mismatch`);
    }
});

test('unknown profile name falls back to chat.v1 (defensive)', () => {
    const origWarn = console.warn;
    console.warn = () => {};
    try {
        const cfg = resolveScriptAutomationConfig('made-up.v1');
        assert.equal(cfg.profileName, 'chat.v1');
        assert.equal(cfg.enabled, false);
        assert.equal(cfg.timeout_ms, 30000);
        assert.equal(cfg.max_output_bytes, 262144);
    } finally {
        console.warn = origWarn;
    }
});

test('null / undefined / empty profile name falls back to chat.v1', () => {
    const origWarn = console.warn;
    console.warn = () => {};
    try {
        for (const arg of [null, undefined, '', 0]) {
            const cfg = resolveScriptAutomationConfig(/** @type {any} */ (arg));
            assert.equal(cfg.profileName, 'chat.v1', `arg=${JSON.stringify(arg)}`);
            assert.equal(cfg.enabled, false);
        }
    } finally {
        console.warn = origWarn;
    }
});
