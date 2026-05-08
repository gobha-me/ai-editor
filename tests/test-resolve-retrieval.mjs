/**
 * 1.20.0 — Retrieval subsystem resolver: Removability proof.
 *
 * The slice replaces the direct `CODER_V1.retrieval.novelty_threshold`
 * read in `js/intelligence/retrieval/manager.js`'s `findRelevantFiles`
 * Composer call site with `resolveRetrievalConfig('coder.v1')` — a
 * profile-keyed lookup over the resolved (`base`-chain merged)
 * profile, mirroring 1.17.0's `resolveCompressionConfig`, 1.18.0's
 * `resolveMemoryConfig`, and 1.19.0's `resolveTools`. After this
 * slice every intelligence subsystem reads from a resolved profile,
 * so profiles are load-bearing internally even though the Settings
 * surface is still role-keyed.
 *
 * Per ROADMAP §Decisions 7 "Removability check," the rewire's exit
 * criterion is **zero behavior diff** against the pre-slice direct
 * reads. That's exactly what this file proves: every field returned
 * by `resolveRetrievalConfig('coder.v1')` is element-equal to the
 * matching `CODER_V1.retrieval.*` slot, and the `profileName` field
 * equals `CODER_V1.name`.
 *
 * Pure logic; no DOM/IDB/fetch. Runs under `node --test`. Imports stay
 * Node-safe — `resolve.js` does not transitively pull `core.js`'s
 * browser-only `window.addEventListener`.
 *
 * @module tests/test-resolve-retrieval
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveRetrievalConfig } from '../js/profiles/resolve.js';
import { CODER_V1 } from '../js/profiles/coder-v1.js';
import { CHAT_V1 } from '../js/profiles/chat-v1.js';

// ============================================
// Removability check — the load-bearing test
// ============================================

test("resolveRetrievalConfig('coder.v1') field-by-field equals CODER_V1.retrieval (zero diff vs pre-1.20.0 direct read)", () => {
    // The whole point of the §Decisions 7 check: replacing the
    // pre-slice direct read `CODER_V1.retrieval.novelty_threshold`
    // (and the forward-looking sibling fields) with this resolver
    // call must yield zero behavior diff at the Composer call site
    // in manager.js's findRelevantFiles. coder.v1 has
    // `base: 'chat.v1'` (1.14.1 trim) but the `retrieval` block
    // is an override — object/array values replace wholesale per
    // inheritance rules — so each resolved field is byte-equal to
    // the pre-trim coder retrieval slot.
    const cfg = resolveRetrievalConfig('coder.v1');
    assert.deepEqual(cfg.collections, CODER_V1.retrieval.collections);
    assert.deepEqual(cfg.memory_collections, CODER_V1.retrieval.memory_collections);
    assert.deepEqual(cfg.strategy_weights, CODER_V1.retrieval.strategy_weights);
    assert.equal(cfg.novelty_threshold, CODER_V1.retrieval.novelty_threshold);
});

test("resolveRetrievalConfig('coder.v1').profileName === CODER_V1.name (zero diff vs pre-1.20.0 surface read)", () => {
    // The other half of the Removability check — though manager.js
    // doesn't read profileName off the retrieval resolver today
    // (the ledger surface key still reads CODER_V1.name directly,
    // out of slice scope), the resolver returns it for parity with
    // the prior three resolvers and so a future task_ledger
    // resolver slice can consume it without shape churn.
    const cfg = resolveRetrievalConfig('coder.v1');
    assert.equal(cfg.profileName, CODER_V1.name);
});

// ============================================
// chat.v1 surface — forward-looking
// ============================================

test("resolveRetrievalConfig('chat.v1') matches CHAT_V1.retrieval (chat baseline)", () => {
    // Chat surfaces don't consume the resolver yet — manager.js's
    // findRelevantFiles is gated on the coder profile because chat
    // surfaces don't call `find_relevant_files` today. 1.21.0's
    // picker UI + 2.0.0's role-removal shift those gates. Pin the
    // chat baseline now so a future regression that widens chat's
    // retrieval slot lands here loudly rather than silently.
    const cfg = resolveRetrievalConfig('chat.v1');
    assert.deepEqual(cfg.collections, ['attached_docs']);
    assert.deepEqual(cfg.collections, CHAT_V1.retrieval.collections);
    assert.deepEqual(cfg.memory_collections, ['user', 'persona']);
    assert.deepEqual(cfg.memory_collections, CHAT_V1.retrieval.memory_collections);
    assert.equal(cfg.novelty_threshold, 0.5);
    assert.equal(cfg.novelty_threshold, CHAT_V1.retrieval.novelty_threshold);
});

test("resolveRetrievalConfig('chat.v1').profileName === 'chat.v1'", () => {
    const cfg = resolveRetrievalConfig('chat.v1');
    assert.equal(cfg.profileName, 'chat.v1');
    assert.equal(cfg.profileName, CHAT_V1.name);
});

// ============================================
// Defensive fallbacks — unknown / null / undefined
// ============================================

test("resolveRetrievalConfig('unknown.profile') falls back to chat.v1 with a warn", () => {
    // Defensive only — `roleToProfileName` never emits anything
    // outside {'coder.v1', 'chat.v1'}, so this path is unreachable
    // from production today. Pinning the fallback shape keeps the
    // safety net visible if a future caller passes the resolver a
    // raw string.
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...args) => warns.push(args.join(' '));
    try {
        const cfg = resolveRetrievalConfig('unknown.profile');
        assert.deepEqual(cfg.collections, CHAT_V1.retrieval.collections);
        assert.equal(cfg.novelty_threshold, CHAT_V1.retrieval.novelty_threshold);
        assert.equal(cfg.profileName, 'chat.v1');
        assert.equal(warns.length, 1);
        assert.match(warns[0], /unknown profileName/);
    } finally {
        console.warn = origWarn;
    }
});

test('resolveRetrievalConfig(null) and resolveRetrievalConfig(undefined) fall back to chat.v1 with a warn each', () => {
    // The resolver's fallback condition is `name !== profileName`,
    // and both null and undefined are not equal to the resolved
    // 'chat.v1' string, so they emit the warn. Pin that explicitly
    // — a future "silent fallback for null" optimization would
    // surface here.
    const origWarn = console.warn;
    let warnCount = 0;
    console.warn = () => warnCount++;
    try {
        assert.equal(resolveRetrievalConfig(null).profileName, 'chat.v1');
        assert.equal(resolveRetrievalConfig(undefined).profileName, 'chat.v1');
        assert.equal(warnCount, 2);
    } finally {
        console.warn = origWarn;
    }
});

// ============================================
// Sanity — coder.v1 inheritance over chat.v1
// ============================================

test("coder.v1 with base: 'chat.v1' resolves retrieval as a wholesale override (not a merge)", () => {
    // coder.v1 has `base: 'chat.v1'` per the 1.14.1 trim. Profile
    // inheritance treats arrays as wholesale replacements — the
    // resolved `retrieval.collections` for coder is the coder array
    // (length 3: workspace_code, workspace_docs, recent_tool_results),
    // not a merge of chat's `['attached_docs']` (length 1) with
    // coder's three. Pin this — a future inheritance tweak that
    // flipped arrays to deep-merge-with-concat would silently widen
    // the retrieval surface from 3 to 4 collections.
    const cfg = resolveRetrievalConfig('coder.v1');
    assert.equal(cfg.collections.length, 3);
    assert.equal(cfg.collections.length, CODER_V1.retrieval.collections.length);
    assert.ok(!cfg.collections.includes('attached_docs'),
        'coder.v1 retrieval.collections should not inherit chat.v1 attached_docs');
});
