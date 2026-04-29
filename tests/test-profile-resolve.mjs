/**
 * Tests for js/profiles/resolve.js — the role → compression-config
 * shim landed in 1.2.0.
 *
 * Runs under `node --test`. The resolver imports from compression and
 * profiles only; no DOM/Storage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveCompressionConfig } from '../js/profiles/index.js';
import {
    SUBSUMPTION_RULE,
    INVALIDATION_RULE,
    SUMMARIZATION_RULE,
} from '../js/intelligence/compression/index.js';

test('coder role → Rules 1, 2, 5 with preserve_recent 24', () => {
    const cfg = resolveCompressionConfig('coder');
    assert.equal(cfg.profileName, 'coder.v1');
    assert.equal(cfg.rules.length, 3);
    assert.equal(cfg.rules[0], SUBSUMPTION_RULE);
    assert.equal(cfg.rules[1], INVALIDATION_RULE);
    assert.equal(cfg.rules[2], SUMMARIZATION_RULE);
    assert.equal(cfg.preserve_recent, 24);
});

test('non-coder roles → Rule 5 only shim (preserves current behavior)', () => {
    for (const role of ['reviewer', 'pm', 'plugin-dev', 'full', null, undefined, '']) {
        const cfg = resolveCompressionConfig(role);
        assert.equal(cfg.profileName, 'rule5_only_shim', `role=${role}`);
        assert.equal(cfg.rules.length, 1);
        assert.equal(cfg.rules[0], SUMMARIZATION_RULE);
        assert.equal(cfg.preserve_recent, 24);
    }
});

test('unknown role → falls back to shim', () => {
    const cfg = resolveCompressionConfig('made-up-role');
    assert.equal(cfg.profileName, 'rule5_only_shim');
    assert.equal(cfg.rules.length, 1);
});
