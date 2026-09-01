/**
 * 2.53.0 — Task-ledger subsystem resolver: Removability proof.
 *
 * The slice replaces the direct `CODER_V1.task_ledger.capacity` (and
 * `CODER_V1.name`) reads in `js/intelligence/retrieval/manager.js`'s
 * findRelevantFiles Composer call site with
 * `resolveTaskLedgerConfig('coder.v1')` — a profile-keyed lookup over
 * the resolved (`base`-chain merged) profile, mirroring 1.17.0's
 * `resolveCompressionConfig`, 1.18.0's `resolveMemoryConfig`, 1.19.0's
 * `resolveTools`, and 1.20.0's `resolveRetrievalConfig`. After this
 * slice the retrieval manager has zero direct `CODER_V1` imports
 * (ICD #5 finding #1).
 *
 * The the rewire's exit
 * criterion is **zero behavior diff** against the pre-slice direct
 * reads. That's exactly what this file proves: every field returned
 * by `resolveTaskLedgerConfig('coder.v1')` is element-equal to the
 * matching `CODER_V1.task_ledger.*` slot, and the `profileName` field
 * equals `CODER_V1.name`.
 *
 * Pure logic; no DOM/IDB/fetch. Runs under `node --test`. Imports stay
 * Node-safe — `resolve.js` does not transitively pull `core.js`'s
 * browser-only `window.addEventListener`.
 *
 * @module tests/test-resolve-task-ledger
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveTaskLedgerConfig } from '../js/profiles/resolve.js';
import { CODER_V1 } from '../js/profiles/coder-v1.js';
import { CHAT_V1 } from '../js/profiles/chat-v1.js';

// ============================================
// Removability check — the load-bearing test
// ============================================

test("resolveTaskLedgerConfig('coder.v1') field-by-field equals CODER_V1.task_ledger (zero diff vs pre-2.53.0 direct read)", () => {
    // The whole point of the §Decisions 7 check: replacing the
    // pre-slice direct read
    // `(CODER_V1.task_ledger && CODER_V1.task_ledger.capacity) || 500`
    // (and the `CODER_V1.name` ledger surface key) with this resolver
    // call must yield zero behavior diff at the manager.js call site
    // in findRelevantFiles. coder.v1 has `base: 'chat.v1'` (1.14.1
    // trim); the `task_ledger` object deep-merges so each coder field
    // overrides the chat.v1 baseline wholesale at the field level.
    const cfg = resolveTaskLedgerConfig('coder.v1');
    assert.equal(cfg.enabled, CODER_V1.task_ledger.enabled);
    assert.equal(cfg.capacity, CODER_V1.task_ledger.capacity);
    assert.equal(cfg.novelty_threshold, CODER_V1.task_ledger.novelty_threshold);
});

test("resolveTaskLedgerConfig('coder.v1').profileName === CODER_V1.name (ledger surface-key match)", () => {
    // The other half of the Removability check — the ledger's
    // per-conversation registry keys by `profileName` (the manager.js
    // call site previously passed `CODER_V1.name`). Pin that the
    // resolver returns the same string so existing ledger lookups
    // continue to match.
    const cfg = resolveTaskLedgerConfig('coder.v1');
    assert.equal(cfg.profileName, CODER_V1.name);
});

test("resolveTaskLedgerConfig('coder.v1').capacity === 500 (literal pin)", () => {
    // Belt-and-braces pin against the literal that drives the Composer's
    // step 6.5 sizing. If a future profile edit drops coder's capacity,
    // this test catches the regression even if CODER_V1.task_ledger.capacity
    // is moved.
    const cfg = resolveTaskLedgerConfig('coder.v1');
    assert.equal(cfg.capacity, 500);
});

// ============================================
// chat.v1 surface — baseline pin
// ============================================

test("resolveTaskLedgerConfig('chat.v1') matches CHAT_V1.task_ledger (chat baseline)", () => {
    // chat.v1 is the fallback profile + the source of inherited values
    // for kb.v1 / chat_multi.v1 / pm.v1 / rp.v1 / plugin-dev.v1 /
    // full.v1 / reviewer.v1, all of which carry empty or partial
    // task_ledger blocks. Pin the baseline so a regression here surfaces
    // loudly across every dependent profile.
    const cfg = resolveTaskLedgerConfig('chat.v1');
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.enabled, CHAT_V1.task_ledger.enabled);
    assert.equal(cfg.capacity, 100);
    assert.equal(cfg.capacity, CHAT_V1.task_ledger.capacity);
    assert.equal(cfg.novelty_threshold, 0.5);
    assert.equal(cfg.novelty_threshold, CHAT_V1.task_ledger.novelty_threshold);
});

test("resolveTaskLedgerConfig('chat.v1').profileName === 'chat.v1'", () => {
    const cfg = resolveTaskLedgerConfig('chat.v1');
    assert.equal(cfg.profileName, 'chat.v1');
    assert.equal(cfg.profileName, CHAT_V1.name);
});

// ============================================
// kb.v1 inheritance — partial override
// ============================================

test("resolveTaskLedgerConfig('kb.v1') yields enabled:false with chat.v1's capacity + novelty_threshold inherited", () => {
    // kb.v1 sets only `{ enabled: false }` (DESIGN-profiles.md
    // §kb.v1 *"Task ledger disabled — short-session pattern doesn't
    // benefit"*). With `base: 'chat.v1'`, object deep-merge fills in
    // capacity (100) and novelty_threshold (0.5) from chat. Pin this
    // so a future inheritance tweak that flipped object deep-merge to
    // wholesale-replace would surface as a kb.v1 ledger that lost its
    // baseline capacity/novelty fallbacks.
    const cfg = resolveTaskLedgerConfig('kb.v1');
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.capacity, 100, 'kb.v1 should inherit chat.v1 capacity via deep-merge');
    assert.equal(cfg.novelty_threshold, 0.5, 'kb.v1 should inherit chat.v1 novelty_threshold via deep-merge');
    assert.equal(cfg.profileName, 'kb.v1');
});

// ============================================
// Defensive fallbacks — unknown / null / undefined
// ============================================

test("resolveTaskLedgerConfig('unknown.profile') falls back to chat.v1 with a warn", () => {
    // Defensive only — production callers in manager.js pass
    // `'coder.v1'` literally. Pinning the fallback shape keeps the
    // safety net visible if a future caller passes the resolver a
    // raw string from settings.
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...args) => warns.push(args.join(' '));
    try {
        const cfg = resolveTaskLedgerConfig('unknown.profile');
        assert.equal(cfg.enabled, CHAT_V1.task_ledger.enabled);
        assert.equal(cfg.capacity, CHAT_V1.task_ledger.capacity);
        assert.equal(cfg.novelty_threshold, CHAT_V1.task_ledger.novelty_threshold);
        assert.equal(cfg.profileName, 'chat.v1');
        assert.equal(warns.length, 1);
        assert.match(warns[0], /unknown profileName/);
    } finally {
        console.warn = origWarn;
    }
});

test('resolveTaskLedgerConfig(null) and resolveTaskLedgerConfig(undefined) fall back to chat.v1 with a warn each', () => {
    // The resolver's fallback condition is `name !== profileName`,
    // and both null and undefined are not equal to the resolved
    // 'chat.v1' string, so they emit the warn. Pin that explicitly
    // — a future "silent fallback for null" optimization would
    // surface here.
    const origWarn = console.warn;
    let warnCount = 0;
    console.warn = () => warnCount++;
    try {
        assert.equal(resolveTaskLedgerConfig(null).profileName, 'chat.v1');
        assert.equal(resolveTaskLedgerConfig(undefined).profileName, 'chat.v1');
        assert.equal(warnCount, 2);
    } finally {
        console.warn = origWarn;
    }
});

// ============================================
// Sanity — coder.v1 inheritance over chat.v1
// ============================================

test("coder.v1 with base: 'chat.v1' resolves task_ledger as a field-level deep-merge (each declared coder field overrides chat)", () => {
    // coder.v1 declares all three fields (enabled:true, capacity:500,
    // novelty_threshold:0.3). Object inheritance is deep-merge so each
    // coder field replaces its chat counterpart; the resolved values
    // are exactly coder's values (not chat's). Pin this — a future
    // inheritance tweak that flipped object deep-merge to wholesale-
    // replace would still pass this test (since coder declares all
    // three), but the kb.v1 test above would fail loudly.
    const cfg = resolveTaskLedgerConfig('coder.v1');
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.capacity, 500);
    assert.notEqual(cfg.capacity, CHAT_V1.task_ledger.capacity);
    assert.equal(cfg.novelty_threshold, 0.3);
    assert.notEqual(cfg.novelty_threshold, CHAT_V1.task_ledger.novelty_threshold);
});
