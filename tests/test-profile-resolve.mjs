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

test('roleToProfileName: coder → coder.v1; everything else → chat.v1', () => {
    assert.equal(roleToProfileName('coder'), 'coder.v1');
    for (const role of ['reviewer', 'pm', 'plugin-dev', 'full', null, undefined, '', 'made-up']) {
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

test('translator + resolver compose: every non-coder role lands on chat.v1 / preserve_recent 4', () => {
    for (const role of ['reviewer', 'pm', 'plugin-dev', 'full', null, undefined, '']) {
        const cfg = resolveCompressionConfig(roleToProfileName(role));
        assert.equal(cfg.profileName, 'chat.v1', `role=${role}`);
        assert.equal(cfg.rules.length, 1);
        assert.equal(cfg.rules[0], SUMMARIZATION_RULE);
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
