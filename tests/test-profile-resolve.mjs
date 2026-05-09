/**
 * Tests for js/profiles/resolve.js — the profile-keyed compression
 * config resolver and the `roleToProfileName` translator.
 *
 * 1.2.0 shipped this as a role → config switch with a `rule5_only_shim`
 * fallback. 1.17.0 rewires it to look up a *resolved* profile (deep-
 * merge over the `base` chain) and read `compression.rules` +
 * `compression.preserve_recent` from there. The shim is retired;
 * chat surfaces consequently drop `preserve_recent` from 24 → 4 to
 * match `chat.v1.compression`.
 *
 * Runs under `node --test`. Imports from compression and profiles
 * only; no DOM/Storage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveCompressionConfig,
    roleToProfileName,
} from '../js/profiles/index.js';
import {
    SUBSUMPTION_RULE,
    INVALIDATION_RULE,
    SUMMARIZATION_RULE,
} from '../js/intelligence/compression/index.js';

test('roleToProfileName: 5-key table mapping legacy roles to synthetic profiles (1.24.0 widening)', () => {
    // 1.24.0 (slice 2 of path-to-2.0.0) — pre-1.24.0 was a narrow
    // `coder ? 'coder.v1' : 'chat.v1'` mapping; widened to a 5-key table
    // so consumer-flipped admission filter + system-prompt injection get
    // byte-equivalent behavior for every legacy role. Mirrors the
    // `ROLE_TO_PROFILE` constant in `tests/test-profile-filter-tools.mjs`.
    assert.equal(roleToProfileName('coder'), 'coder.v1');
    assert.equal(roleToProfileName('full'), 'full.v1');
    assert.equal(roleToProfileName('plugin-dev'), 'plugin-dev.v1');
    assert.equal(roleToProfileName('pm'), 'pm.v1');
    assert.equal(roleToProfileName('reviewer'), 'reviewer.v1');
    // Default fallback unchanged — null / undefined / empty / unknown
    // strings resolve to chat.v1.
    for (const role of [null, undefined, '', 'made-up']) {
        assert.equal(roleToProfileName(role), 'chat.v1', `role=${role}`);
    }
});

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

test('translator + resolver compose: non-coder legacy roles get chat.v1 compression behavior via inheritance (1.24.0)', () => {
    // 1.24.0 — synthetic profiles inherit `base: 'chat.v1'` with empty
    // `compression: {}`, so the resolved compression slice for
    // pm.v1/reviewer.v1/plugin-dev.v1/full.v1 comes through chat.v1's
    // compression byte-for-byte (Rule 5 only, preserve_recent 4). The
    // `profileName` field reflects the leaf (the synthetic profile)
    // rather than the inheritance base — this is the documented shape
    // of `resolveCompressionConfig`'s return at `js/profiles/resolve.js:165`.
    const ROLE_TO_LEAF = {
        reviewer:     'reviewer.v1',
        pm:           'pm.v1',
        'plugin-dev': 'plugin-dev.v1',
        full:         'full.v1',
    };
    for (const [role, leaf] of Object.entries(ROLE_TO_LEAF)) {
        const cfg = resolveCompressionConfig(roleToProfileName(role));
        assert.equal(cfg.profileName, leaf, `role=${role}`);
        assert.equal(cfg.rules.length, 1, `role=${role}`);
        assert.equal(cfg.rules[0], SUMMARIZATION_RULE, `role=${role}`);
        assert.equal(cfg.preserve_recent, 4, `role=${role}`);
    }
    // Default fallback (null/undefined/empty) still resolves to chat.v1
    // directly — `roleToProfileName` returns 'chat.v1' for those.
    for (const role of [null, undefined, '']) {
        const cfg = resolveCompressionConfig(roleToProfileName(role));
        assert.equal(cfg.profileName, 'chat.v1', `role=${role}`);
        assert.equal(cfg.preserve_recent, 4);
    }
});

test('coder role → coder.v1 via translator', () => {
    const cfg = resolveCompressionConfig(roleToProfileName('coder'));
    assert.equal(cfg.profileName, 'coder.v1');
    assert.equal(cfg.preserve_recent, 24);
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
