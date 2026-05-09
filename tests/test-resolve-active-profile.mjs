/**
 * `getActiveProfileName(settings)` — the picker is the only surface.
 *
 * **2.0.0 (slice 3 of path-to-2.0.0).** The pre-2.0.0 fallthrough to
 * `roleToProfileName(settings.role)` retired alongside the role
 * selector. The helper now reads only `settings.profile`; unknown /
 * unset values default to `'chat.v1'` (the lowest-config baseline +
 * the new 2.0.0 fresh-install default).
 *
 * Pre-2.0.0 the load-bearing semantic was *"the picker exists; role
 * still wins if untouched."* The §Decisions 7 Removability check
 * pinned that picker-untouched ≡ `roleToProfileName(role)` for every
 * legacy role. That equivalence retired with the role selector — the
 * tests below now pin the simpler invariant: **role is no longer
 * consulted; only `settings.profile` decides**. Stored settings blobs
 * pre-dating 2.0.0 are migrated by `migrateRoleToProfile` at
 * `loadSettings` time.
 *
 * Pure logic; no DOM/IDB/fetch. Runs under `node --test`.
 *
 * @module tests/test-resolve-active-profile
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getActiveProfileName } from '../js/profiles/resolve.js';

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
// Picker-untouched / unset → 'chat.v1' default
// ============================================
//
// 2.0.0 — slice 3: role is no longer consulted. The pre-2.0.0
// per-role fallback (coder→coder.v1, reviewer→reviewer.v1, etc.)
// retired with the role selector. Any settings shape without a
// known `profile` resolves to `'chat.v1'` — the lowest-config
// baseline + the new 2.0.0 fresh-install default. Stored blobs
// pre-dating 2.0.0 are migrated at `loadSettings` time, so
// production never reaches these fallbacks with a `role` field.

test("getActiveProfileName({ profile: null }) === 'chat.v1' (post-2.0.0 default)", () => {
    assert.equal(getActiveProfileName({ profile: null }), 'chat.v1');
});

test("getActiveProfileName({ profile: null, role: 'coder' }) === 'chat.v1' (role no longer consulted post-2.0.0)", () => {
    // Defensive — production never reaches this state because
    // `migrateRoleToProfile` deletes role + writes profile at load.
    // If a test or a stale fixture seeds State.settings directly with
    // role still present, the helper must ignore role.
    assert.equal(
        getActiveProfileName({ profile: null, role: 'coder' }),
        'chat.v1'
    );
});

test("getActiveProfileName({ profile: null, role: 'full' }) === 'chat.v1' (role no longer consulted post-2.0.0)", () => {
    assert.equal(
        getActiveProfileName({ profile: null, role: 'full' }),
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
// Defensive — unknown / non-string picker values
// ============================================

test("getActiveProfileName({ profile: 'unknown.profile' }) === 'chat.v1' (unknown picker silently falls through)", () => {
    // The picker UI only writes registry-known names, but a stale
    // settings blob (e.g. an export from a future version with a
    // removed profile) might carry an unknown string. The graceful
    // degradation is to fall back to the chat.v1 baseline rather
    // than warning every turn.
    assert.equal(
        getActiveProfileName({ profile: 'unknown.profile' }),
        'chat.v1'
    );
});

test("getActiveProfileName({ profile: 42 }) === 'chat.v1' (non-string picker rejected, falls through)", () => {
    // Same defensive posture as `resolveCompressionConfig` — only
    // string profile names are honored; everything else falls through.
    assert.equal(
        getActiveProfileName({ profile: /** @type {any} */ (42) }),
        'chat.v1'
    );
});

test("getActiveProfileName({ profile: '' }) === 'chat.v1' (empty string falls through)", () => {
    assert.equal(
        getActiveProfileName({ profile: '' }),
        'chat.v1'
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
