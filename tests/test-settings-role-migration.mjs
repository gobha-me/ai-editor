// @ts-check
/**
 * 2.0.0 — slice 3 of path-to-2.0.0. Pins the one-shot
 * `settings.role` → `settings.profile` migration that
 * `loadSettings` runs against any pre-2.0.0 stored settings blob.
 *
 * **Slice 3, commit B** — `migrateRoleToProfile` writes `profile`
 * AND deletes `role`. Consumers throughout the codebase have all
 * flipped to `getActiveProfileName(State.settings)` (which only
 * reads `settings.profile` post-2.0.0); the legacy `role` read is
 * dead, so this helper retires it from the stored blob too.
 * The `else if` branch handles the rare 1.21.0+ picker users
 * whose blobs carry both `role` and `profile` — picker wins,
 * stale role quiet-drops.
 *
 * The 5-key mapping mirrors `tests/test-profile-filter-tools.mjs`'s
 * `ROLE_TO_PROFILE` constant verbatim. Divergence across the two is
 * the bug — the cross-product equivalence test pins what the
 * post-migration admission filter must admit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateRoleToProfile } from '../js/profiles/migration.js';

test("migrate role 'coder' → profile 'coder.v1'; role deleted", () => {
    const s = { role: 'coder' };
    const result = migrateRoleToProfile(s);
    assert.equal(result.migrated, true);
    assert.equal(result.fromRole, 'coder');
    assert.equal(result.toProfile, 'coder.v1');
    assert.equal(s.profile, 'coder.v1');
    assert.equal('role' in s, false, 'role retired post-2.0.0');
});

test("migrate role 'full' → profile 'full.v1'", () => {
    const s = { role: 'full' };
    const result = migrateRoleToProfile(s);
    assert.equal(result.migrated, true);
    assert.equal(s.profile, 'full.v1');
});

test("migrate role 'pm' → profile 'pm.v1'", () => {
    const s = { role: 'pm' };
    const result = migrateRoleToProfile(s);
    assert.equal(result.migrated, true);
    assert.equal(s.profile, 'pm.v1');
});

test("migrate role 'reviewer' → profile 'reviewer.v1'", () => {
    const s = { role: 'reviewer' };
    const result = migrateRoleToProfile(s);
    assert.equal(result.migrated, true);
    assert.equal(s.profile, 'reviewer.v1');
});

test("migrate role 'plugin-dev' → profile 'plugin-dev.v1'", () => {
    const s = { role: 'plugin-dev' };
    const result = migrateRoleToProfile(s);
    assert.equal(result.migrated, true);
    assert.equal(s.profile, 'plugin-dev.v1');
});

test("unknown role string falls back to 'chat.v1'", () => {
    const s = { role: 'unknown.legacy.value' };
    const result = migrateRoleToProfile(s);
    assert.equal(result.migrated, true);
    assert.equal(result.toProfile, 'chat.v1');
    assert.equal(s.profile, 'chat.v1');
});

test("empty-string role falls back to 'chat.v1'", () => {
    const s = { role: '' };
    const result = migrateRoleToProfile(s);
    assert.equal(result.migrated, true);
    assert.equal(s.profile, 'chat.v1');
});

test("settings without role are untouched (no migration)", () => {
    const s = { llmModel: 'gpt-4', uiScale: 100 };
    const result = migrateRoleToProfile(s);
    assert.equal(result.migrated, false);
    assert.equal('profile' in s, false);
    assert.deepEqual(s, { llmModel: 'gpt-4', uiScale: 100 });
});

test("picker already won (role + profile both set) → no migration; profile preserved; role quiet-dropped", () => {
    const s = { role: 'coder', profile: 'chat.v1' };
    const result = migrateRoleToProfile(s);
    assert.equal(result.migrated, false);
    assert.equal(result.fromRole, 'coder');
    assert.equal(result.toProfile, 'chat.v1');
    assert.equal(s.profile, 'chat.v1', 'picker choice wins over role-derived');
    assert.equal('role' in s, false, 'stale role retired');
});

test("idempotent: second migration on a migrated blob is a no-op", () => {
    const s = { role: 'coder' };
    migrateRoleToProfile(s);
    const after = { ...s };
    const result = migrateRoleToProfile(s);
    assert.equal(result.migrated, false);
    assert.deepEqual(s, after);
});

test("null/undefined input is a no-op", () => {
    assert.equal(migrateRoleToProfile(null).migrated, false);
    assert.equal(migrateRoleToProfile(undefined).migrated, false);
});

test("non-object input is a no-op", () => {
    assert.equal(migrateRoleToProfile('string-not-object').migrated, false);
    assert.equal(migrateRoleToProfile(42).migrated, false);
});
