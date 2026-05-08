/**
 * 1.19.0 — Tools subsystem resolver: Removability proof.
 *
 * The slice replaces the direct `CODER_V1` import + three reads in
 * `js/chat/handlers.js` (`CODER_V1.name`, `CODER_V1.tools.static`)
 * with `resolveTools('coder.v1')` — a profile-keyed lookup over the
 * resolved (`base`-chain merged) profile, mirroring 1.17.0's
 * `resolveCompressionConfig` and 1.18.0's `resolveMemoryConfig`.
 *
 * Per ROADMAP §Decisions 7 "Removability check," the rewire's exit
 * criterion is **zero behavior diff** against the pre-slice direct
 * reads. That's exactly what this file proves: the `static` array
 * returned by `resolveTools('coder.v1')` is element-equal to
 * `CODER_V1.tools.static` (which is what handlers.js used to read
 * directly), and the `profileName` field equals `CODER_V1.name`.
 *
 * Pure logic; no DOM/IDB/fetch. Runs under `node --test`. Imports stay
 * Node-safe — `resolve.js` does not transitively pull `core.js`'s
 * browser-only `window.addEventListener`.
 *
 * @module tests/test-resolve-tools
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveTools } from '../js/profiles/resolve.js';
import { CODER_V1 } from '../js/profiles/coder-v1.js';
import { CHAT_V1 } from '../js/profiles/chat-v1.js';

// ============================================
// Removability check — the load-bearing test
// ============================================

test("resolveTools('coder.v1').static element-equals CODER_V1.tools.static (zero diff vs pre-1.19.0 direct read)", () => {
    // The whole point of the §Decisions 7 check: replacing the
    // pre-slice direct read `CODER_V1.tools.static` with this
    // resolver call must yield zero behavior diff at the
    // recordToolInvocation / recordDiscoveryAdmissions sites in
    // handlers.js. coder.v1 has `base: 'chat.v1'` (1.14.1 trim) but
    // the `tools` block is an override — array values replace
    // wholesale per inheritance rules — so the resolved static set
    // is byte-equal to the pre-trim coder static set.
    const cfg = resolveTools('coder.v1');
    assert.deepEqual(cfg.static, CODER_V1.tools.static);
});

test("resolveTools('coder.v1').profileName === CODER_V1.name (zero diff vs pre-1.19.0 surface read)", () => {
    // The other half of the Removability check — handlers.js used
    // `CODER_V1.name` as the task ledger's `surface` key. The
    // resolver must return the same string so ledger entries don't
    // suddenly land under a different surface bucket.
    const cfg = resolveTools('coder.v1');
    assert.equal(cfg.profileName, CODER_V1.name);
});

// ============================================
// chat.v1 surface — forward-looking
// ============================================

test("resolveTools('chat.v1').static is ['ask_user'] (chat baseline)", () => {
    // Chat surfaces don't consume the resolver yet (handlers.js's
    // record sites are gated on `role === 'coder'`), but 1.21.0's
    // picker UI + 2.0.0's role-removal shift those gates. Pin the
    // chat baseline now so a future regression that widens chat's
    // static set lands here loudly rather than silently.
    const cfg = resolveTools('chat.v1');
    assert.deepEqual(cfg.static, ['ask_user']);
    assert.deepEqual(cfg.static, CHAT_V1.tools.static);
});

test("resolveTools('chat.v1').profileName === 'chat.v1'", () => {
    const cfg = resolveTools('chat.v1');
    assert.equal(cfg.profileName, 'chat.v1');
    assert.equal(cfg.profileName, CHAT_V1.name);
});

// ============================================
// Defensive fallbacks — unknown / null / undefined
// ============================================

test("resolveTools('unknown.profile') falls back to chat.v1 with a warn", () => {
    // Defensive only — `roleToProfileName` never emits anything
    // outside {'coder.v1', 'chat.v1'}, so this path is unreachable
    // from production today. Pinning the fallback shape keeps the
    // safety net visible if a future caller passes the resolver a
    // raw string.
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...args) => warns.push(args.join(' '));
    try {
        const cfg = resolveTools('unknown.profile');
        assert.deepEqual(cfg.static, CHAT_V1.tools.static);
        assert.equal(cfg.profileName, 'chat.v1');
        assert.equal(warns.length, 1);
        assert.match(warns[0], /unknown profileName/);
    } finally {
        console.warn = origWarn;
    }
});

test('resolveTools(null) and resolveTools(undefined) fall back to chat.v1 silently? no — they warn too', () => {
    // The resolver's fallback condition is `name !== profileName`,
    // and both null and undefined are not equal to the resolved
    // 'chat.v1' string, so they emit the warn. Pin that explicitly
    // — a future "silent fallback for null" optimization would
    // surface here.
    const origWarn = console.warn;
    let warnCount = 0;
    console.warn = () => warnCount++;
    try {
        assert.equal(resolveTools(null).profileName, 'chat.v1');
        assert.equal(resolveTools(undefined).profileName, 'chat.v1');
        assert.equal(warnCount, 2);
    } finally {
        console.warn = origWarn;
    }
});

// ============================================
// Sanity — coder.v1 inheritance over chat.v1
// ============================================

test("coder.v1 with base: 'chat.v1' resolves tools as a wholesale override (not a merge)", () => {
    // coder.v1 has `base: 'chat.v1'` per the 1.14.1 trim. Profile
    // inheritance treats arrays as wholesale replacements — the
    // resolved `tools.static` for coder is the coder array, not
    // a merge of chat's `['ask_user']` with coder's 20-tool set.
    // (`ask_user` *is* in coder's static set, but as an explicit
    // entry, not via inheritance.) Pin this — a future inheritance
    // tweak that flipped arrays to deep-merge-with-concat would
    // double-admit `ask_user` and silently widen the surface.
    const cfg = resolveTools('coder.v1');
    const askUserCount = cfg.static.filter(t => t === 'ask_user').length;
    assert.equal(askUserCount, 1);
    assert.equal(cfg.static.length, CODER_V1.tools.static.length);
});
