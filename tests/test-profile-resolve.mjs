/**
 * Tests for js/profiles/resolve.js — the profile-keyed compression
 * config resolver.
 *
 * 1.2.0 shipped this as a role → config switch with a `rule5_only_shim`
 * fallback. 1.17.0 rewired it to look up a *resolved* profile (deep-
 * merge over the `base` chain) and read `compression.rules` +
 * `compression.preserve_recent` from there. The shim retired; chat
 * surfaces consequently drop `preserve_recent` from 24 → 4 to match
 * `chat.v1.compression`. **2.0.0 — slice 3** retired the
 * `roleToProfileName` translator alongside the role selector; tests
 * now address profiles directly.
 *
 * Runs under `node --test`. Imports from compression and profiles
 * only; no DOM/Storage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveCompressionConfig } from '../js/profiles/index.js';
import {
    SUBSUMPTION_RULE,
    INVALIDATION_RULE,
    SUMMARIZATION_RULE,
} from '../js/intelligence/compression/index.js';

test('coder.v1 → Rules 1, 2, 5 with preserve_recent 24', () => {
    const cfg = resolveCompressionConfig('coder.v1');
    assert.equal(cfg.profileName, 'coder.v1');
    assert.equal(cfg.rules.length, 3);
    assert.equal(cfg.rules[0], SUBSUMPTION_RULE);
    assert.equal(cfg.rules[1], INVALIDATION_RULE);
    assert.equal(cfg.rules[2], SUMMARIZATION_RULE);
    assert.equal(cfg.preserve_recent, 24);
});

test('chat.v1 → Rule 5 only with preserve_recent 4 (1.17.0 reconciliation)', () => {
    const cfg = resolveCompressionConfig('chat.v1');
    assert.equal(cfg.profileName, 'chat.v1');
    assert.equal(cfg.rules.length, 1);
    assert.equal(cfg.rules[0], SUMMARIZATION_RULE);
    assert.equal(cfg.preserve_recent, 4);
});

test('synthetic profiles get chat.v1 compression behavior via inheritance', () => {
    // The four synthetic profiles inherit `base: 'chat.v1'` with empty
    // `compression: {}`, so the resolved compression slice for
    // pm.v1/reviewer.v1/plugin-dev.v1/full.v1 comes through chat.v1's
    // compression byte-for-byte (Rule 5 only, preserve_recent 4). The
    // `profileName` field reflects the leaf (the synthetic profile)
    // rather than the inheritance base — this is the documented shape
    // of `resolveCompressionConfig`'s return at `js/profiles/resolve.js`.
    for (const leaf of ['pm.v1', 'reviewer.v1', 'plugin-dev.v1', 'full.v1']) {
        const cfg = resolveCompressionConfig(leaf);
        assert.equal(cfg.profileName, leaf);
        assert.equal(cfg.rules.length, 1);
        assert.equal(cfg.rules[0], SUMMARIZATION_RULE);
        assert.equal(cfg.preserve_recent, 4);
    }
});

test('unknown profile name falls back to chat.v1 (defensive)', () => {
    // Suppress the expected console.warn so the test output stays clean.
    const origWarn = console.warn;
    console.warn = () => {};
    try {
        const cfg = resolveCompressionConfig('made-up.v1');
        assert.equal(cfg.profileName, 'chat.v1');
        assert.equal(cfg.preserve_recent, 4);
        assert.equal(cfg.rules.length, 1);
    } finally {
        console.warn = origWarn;
    }
});
