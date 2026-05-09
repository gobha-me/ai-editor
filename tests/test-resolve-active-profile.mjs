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
 * **1.24.0 (slice 2 of path-to-2.0.0)** — `roleToProfileName` widened
 * from `coder ? 'coder.v1' : 'chat.v1'` to a 5-key table that maps
 * every legacy role to its canonical profile (synthetic profiles for
 * `full` / `plugin-dev` / `pm` / `reviewer` registered at 1.23.0).
 * The `roleToProfileName` direct-mapping block + the per-role
 * fallback assertions below pin that 5-way mapping. The Removability
 * check survives the widening because both helpers shift in lockstep
 * — picker-untouched equivalence is preserved by construction.
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

test("getActiveProfileName({ profile: null, role: 'reviewer' }) === 'reviewer.v1' (1.24.0 — synthetic profile)", () => {
    // Pre-1.24.0 returned 'chat.v1' (narrow `roleToProfileName`); slice 2
    // widens the translator to map `reviewer` → `reviewer.v1`. The
    // synthetic profile inherits `base: 'chat.v1'` with empty subsystem
    // overrides except `tools.allowed_groups: ['all', 'reviewer']`, so
    // downstream resolvers (compression/memory) resolve byte-identically.
    assert.equal(
        getActiveProfileName({ profile: null, role: 'reviewer' }),
        'reviewer.v1'
    );
});

test("getActiveProfileName({ profile: null, role: 'pm' }) === 'pm.v1' (1.24.0 — synthetic profile)", () => {
    assert.equal(
        getActiveProfileName({ profile: null, role: 'pm' }),
        'pm.v1'
    );
});

test("getActiveProfileName({ profile: null, role: 'plugin-dev' }) === 'plugin-dev.v1' (1.24.0 — synthetic profile)", () => {
    // Carries `systemPrompt: PLUGIN_DEV_SYSTEM_PROMPT` so
    // `js/prompts.js`'s slice-2 flip from `role.systemPrompt` to
    // `profile.systemPrompt` keeps the SDK addendum injecting for users
    // with `role: 'plugin-dev'` and the picker untouched.
    assert.equal(
        getActiveProfileName({ profile: null, role: 'plugin-dev' }),
        'plugin-dev.v1'
    );
});

test("getActiveProfileName({ profile: null, role: 'full' }) === 'full.v1' (1.24.0 — synthetic profile)", () => {
    // `full.v1` carries `tools.allowed_groups: ['*']` — the legacy
    // `'full'` bypass marker. Without the slice-2 widening, role=full
    // users would fall back to `chat.v1` and lose the bypass; with it,
    // tool admission for full-role users is byte-equivalent to
    // pre-2.0.0 `Roles.filterTools(toolDefinitions)` short-circuit.
    assert.equal(
        getActiveProfileName({ profile: null, role: 'full' }),
        'full.v1'
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

// ============================================
// 1.24.0 — `roleToProfileName` direct mapping (slice 2 widening)
// ============================================
//
// Pre-1.24.0 mapping: `coder ? 'coder.v1' : 'chat.v1'`. Slice 2 widens
// to a 5-key table mirroring `tests/test-profile-filter-tools.mjs`'s
// `ROLE_TO_PROFILE` constant verbatim — same target the 2.0.0 migration
// script (slice 3) writes into `settings.profile` for each user. Any
// divergence between this mapping, the cross-product equivalence test,
// and the migration script is the bug.

test("1.24.0 — roleToProfileName('coder') === 'coder.v1'", () => {
    assert.equal(roleToProfileName('coder'), 'coder.v1');
});

test("1.24.0 — roleToProfileName('full') === 'full.v1'", () => {
    assert.equal(roleToProfileName('full'), 'full.v1');
});

test("1.24.0 — roleToProfileName('plugin-dev') === 'plugin-dev.v1'", () => {
    assert.equal(roleToProfileName('plugin-dev'), 'plugin-dev.v1');
});

test("1.24.0 — roleToProfileName('pm') === 'pm.v1'", () => {
    assert.equal(roleToProfileName('pm'), 'pm.v1');
});

test("1.24.0 — roleToProfileName('reviewer') === 'reviewer.v1'", () => {
    assert.equal(roleToProfileName('reviewer'), 'reviewer.v1');
});

test("1.24.0 — roleToProfileName(null|undefined|unknown) === 'chat.v1' (default fallback)", () => {
    assert.equal(roleToProfileName(null), 'chat.v1');
    assert.equal(roleToProfileName(undefined), 'chat.v1');
    assert.equal(roleToProfileName('chat'), 'chat.v1');
    assert.equal(roleToProfileName('unknown.role.string'), 'chat.v1');
    assert.equal(roleToProfileName(''), 'chat.v1');
});
