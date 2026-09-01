/**
 * Memory subsystem resolver: Removability proof.
 *
 * The 1.18.0 slice replaced a hardcoded literal in
 * `js/tools/memory-tools.js` (`a.scope || 'workspace'`) with a
 * profile-keyed lookup (`a.scope || resolveDefaultRememberScope(...)`).
 * The the rewire's exit
 * criterion is **zero behavior diff** against the pre-slice literal
 * for the surface that actually exercises memory tools (coder).
 *
 * **2.0.0 — slice 3 collapse.** The pre-2.0.0 polymorphic shape
 * (string-arg legacy role / object-arg settings) collapsed to a
 * single settings-shape input. Tests below pass `{ profile: 'X.v1' }`
 * directly. The clamp semantic is unchanged: `coder.v1.memory.default_scope
 * === 'session'` falls outside `MEMORY_SCOPES`, so the helper
 * returns `'workspace'`. For chat surfaces, `'user'` passes through.
 *
 * Pure logic; no DOM/IDB/fetch. Runs under `node --test`. Helper
 * lives in `js/profiles/resolve.js` (not `memory-tools.js`) so
 * imports stay Node-safe — `memory-tools.js` transitively pulls
 * `core.js`'s browser-only `window.addEventListener`.
 *
 * @module tests/test-memory-resolve
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveMemoryConfig,
    resolveDefaultRememberScope,
} from '../js/profiles/resolve.js';
import { MEMORY_SCOPES } from '../js/intelligence/memory/contracts.js';

// ============================================
// Removability check — the load-bearing test
// ============================================

test("resolveDefaultRememberScope({ profile: 'coder.v1' }) === 'workspace' (zero diff vs pre-1.18.0 literal)", () => {
    // The whole point of the §Decisions 7 check: replacing the
    // pre-slice literal `'workspace'` with this call must yield zero
    // behavior diff for coder, the surface that actually exercises
    // memory_remember today. coder.v1.memory.default_scope is
    // 'session' (intentional — describes scratchpad, see
    // js/profiles/coder-v1.js), which falls outside MEMORY_SCOPES,
    // so the clamp inside resolveDefaultRememberScope returns 'workspace'.
    assert.equal(resolveDefaultRememberScope({ profile: 'coder.v1' }), 'workspace');
});

test("resolveDefaultRememberScope({ profile: 'chat.v1' }) === 'user' (chat baseline)", () => {
    // chat.v1.memory.default_scope === 'user', and 'user' is in
    // MEMORY_SCOPES, so no clamp.
    assert.equal(resolveDefaultRememberScope({ profile: 'chat.v1' }), 'user');
});

test('synthetic profiles (pm/full/plugin-dev/reviewer) inherit chat.v1 default', () => {
    // The four synthetic profiles inherit `base: 'chat.v1'` with
    // empty `memory` overrides → resolve to chat.v1's `'user'`.
    assert.equal(resolveDefaultRememberScope({ profile: 'pm.v1' }), 'user');
    assert.equal(resolveDefaultRememberScope({ profile: 'full.v1' }), 'user');
    assert.equal(resolveDefaultRememberScope({ profile: 'plugin-dev.v1' }), 'user');
    assert.equal(resolveDefaultRememberScope({ profile: 'reviewer.v1' }), 'user');
});

test('unknown / null / undefined settings shapes fall through to chat.v1 → user', () => {
    assert.equal(resolveDefaultRememberScope({ profile: 'unknown.profile' }), 'user');
    assert.equal(resolveDefaultRememberScope({}), 'user');
    assert.equal(resolveDefaultRememberScope(null), 'user');
    assert.equal(resolveDefaultRememberScope(undefined), 'user');
});

// ============================================
// Sanity — the clamp's premise stays valid
// ============================================

test("coder.v1's raw memory.default_scope is intentionally outside MEMORY_SCOPES", () => {
    // The clamp inside resolveDefaultRememberScope is only correct if this
    // mismatch keeps holding. If a future change adds 'session' to
    // MEMORY_SCOPES, this test fires — and the clamp becomes a bug.
    const cfg = resolveMemoryConfig('coder.v1');
    assert.equal(cfg.default_scope, 'session');
    assert.equal(MEMORY_SCOPES.includes('session'), false);
});

test("chat.v1's raw memory.default_scope is in MEMORY_SCOPES (no clamp needed)", () => {
    const cfg = resolveMemoryConfig('chat.v1');
    assert.equal(cfg.default_scope, 'user');
    assert.equal(MEMORY_SCOPES.includes('user'), true);
});
