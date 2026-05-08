/**
 * 1.21.0 — `getActiveProfileName(settings)` Removability check.
 *
 * The 1.21.0 slice surfaces a profile picker alongside the role
 * selector. The load-bearing semantic is *"the picker exists; role
 * still wins if untouched."* `getActiveProfileName` is the helper
 * that encodes that semantic — when `settings.profile` is set and
 * registered, it wins; otherwise fall through to `roleToProfileName`.
 *
 * Per ROADMAP §Decisions 7 "Removability check," the slice's exit
 * criterion is **zero behavior diff** against the pre-1.21.0 direct
 * `roleToProfileName(role)` reads at the call sites that flipped
 * (compression, memory default-scope). With `settings.profile === null`
 * (the picker untouched), `getActiveProfileName(settings)` must equal
 * `roleToProfileName(settings.role)` for every role the editor emits.
 * The `picker-untouched` test below pins that.
 *
 * Pure logic; no DOM/IDB/fetch. Runs under `node --test`.
 *
 * @module tests/test-resolve-active-profile
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    getActiveProfileName,
    roleToProfileName,
} from '../js/profiles/resolve.js';

// ============================================
// Picker-wins precedence — picker-set, registered name
// ============================================

test("getActiveProfileName({ profile: 'coder.v1', role: 'reviewer' }) === 'coder.v1' (picker wins over role)", () => {
    assert.equal(
        getActiveProfileName({ profile: 'coder.v1', role: 'reviewer' }),
        'coder.v1'
    );
});

test("getActiveProfileName({ profile: 'chat.v1', role: 'coder' }) === 'chat.v1' (picker wins over role)", () => {
    // The interesting case — user with role=coder picks chat.v1 in the
    // picker. This is the only knob today that lets a coder pick chat
    // surfaces' compression rules at runtime.
    assert.equal(
        getActiveProfileName({ profile: 'chat.v1', role: 'coder' }),
        'chat.v1'
    );
});

// ============================================
// Picker-untouched fallback — the Removability check
// ============================================

test("getActiveProfileName({ profile: null, role: 'coder' }) === 'coder.v1' (role fallback when picker null)", () => {
    assert.equal(
        getActiveProfileName({ profile: null, role: 'coder' }),
        'coder.v1'
    );
});

test("getActiveProfileName({ profile: null, role: 'reviewer' }) === 'chat.v1'", () => {
    assert.equal(
        getActiveProfileName({ profile: null, role: 'reviewer' }),
        'chat.v1'
    );
});

test("getActiveProfileName({ profile: undefined, role: undefined }) === 'chat.v1'", () => {
    assert.equal(
        getActiveProfileName({ profile: undefined, role: undefined }),
        'chat.v1'
    );
});

test("getActiveProfileName({}) === 'chat.v1'", () => {
    assert.equal(getActiveProfileName({}), 'chat.v1');
});

test("getActiveProfileName(null) === 'chat.v1'", () => {
    // The chat handlers + memory-tools paths dereference `State?.settings`
    // optionally; if it's absent the helper must still return a usable
    // default rather than throw.
    assert.equal(getActiveProfileName(null), 'chat.v1');
});

test("getActiveProfileName(undefined) === 'chat.v1'", () => {
    assert.equal(getActiveProfileName(undefined), 'chat.v1');
});

// ============================================
// Removability check (load-bearing) — picker-untouched ≡ roleToProfileName
// ============================================

test("§Decisions 7 Removability — picker untouched: getActiveProfileName(s) === roleToProfileName(s.role) for every role", () => {
    // The whole point of the §Decisions 7 check: the call-site flip
    // from `resolveCompressionConfig(roleToProfileName(role))` to
    // `resolveCompressionConfig(getActiveProfileName(State.settings))`
    // must yield zero behavior diff when the picker is untouched
    // (`profile: null`). Replace one with the other; if these aren't
    // byte-equal for every role the editor emits, that flip silently
    // changed compression/memory behavior for every existing user.
    const roles = ['coder', 'reviewer', 'pm', 'plugin-dev', 'full', null, undefined, 'unknown.role.string'];
    for (const role of roles) {
        const fromHelper = getActiveProfileName({ profile: null, role });
        const fromTranslator = roleToProfileName(role);
        assert.equal(
            fromHelper,
            fromTranslator,
            `picker-untouched mismatch at role=${JSON.stringify(role)}: helper=${fromHelper} translator=${fromTranslator}`
        );
    }
});

// ============================================
// Defensive — unknown / non-string picker values
// ============================================

test("getActiveProfileName({ profile: 'unknown.profile', role: 'coder' }) === 'coder.v1' (unknown picker silently falls through)", () => {
    // The picker UI only writes registry-known names + null, but a
    // stale settings blob (e.g. an export from a future version with a
    // removed profile) might carry an unknown string. The graceful
    // degradation is to honor the role selector instead of warning
    // every turn.
    assert.equal(
        getActiveProfileName({ profile: 'unknown.profile', role: 'coder' }),
        'coder.v1'
    );
});

test("getActiveProfileName({ profile: 42, role: 'coder' }) === 'coder.v1' (non-string picker rejected, falls through)", () => {
    // Same defensive posture as `resolveCompressionConfig` — only
    // string profile names are honored; everything else falls through.
    assert.equal(
        getActiveProfileName({ profile: /** @type {any} */ (42), role: 'coder' }),
        'coder.v1'
    );
});

test("getActiveProfileName({ profile: '', role: 'coder' }) === 'coder.v1' (empty string is the picker sentinel)", () => {
    // The picker UI's "(use role)" option has value=''; persistence
    // converts that to `null` before storing. A direct '' read (in case
    // the storage layer drops the conversion) must still fall through.
    assert.equal(
        getActiveProfileName({ profile: '', role: 'coder' }),
        'coder.v1'
    );
});

// ============================================
// Picker-without-role — picker valid, role missing
// ============================================

test("getActiveProfileName({ profile: 'coder.v1' }) === 'coder.v1' (picker valid, role absent)", () => {
    assert.equal(getActiveProfileName({ profile: 'coder.v1' }), 'coder.v1');
});

test("getActiveProfileName({ profile: 'chat.v1' }) === 'chat.v1'", () => {
    assert.equal(getActiveProfileName({ profile: 'chat.v1' }), 'chat.v1');
});
