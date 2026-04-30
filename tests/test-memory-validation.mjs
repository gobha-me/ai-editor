/**
 * Pure-function tests for js/intelligence/memory/validation.js. Validators
 * are side-effect-free over the typedefs in `contracts.js` — they don't
 * touch IDB, EventBus, or core.js, so the shim is still imported only
 * because the barrel re-exports from `store.js` (which does).
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    canonicalizeKey,
    validateScope,
    validateCategory,
    validateSource,
    validateKey,
    validateRecord,
    assertValid,
    MEMORY_LIMITS,
} from '../js/intelligence/memory/index.js';

/* ============================================================ */
/* canonicalizeKey                                              */
/* ============================================================ */

test('canonicalizeKey lowercases and trims', () => {
    assert.equal(canonicalizeKey('  Foo  '), 'foo');
    assert.equal(canonicalizeKey('PREFER_TABS'), 'prefer_tabs');
    assert.equal(canonicalizeKey('alreadyok'), 'alreadyok');
});

test('canonicalizeKey is idempotent', () => {
    const once = canonicalizeKey('  Mixed_CASE  ');
    const twice = canonicalizeKey(once);
    assert.equal(once, twice);
});

test('canonicalizeKey returns "" for non-string input', () => {
    assert.equal(canonicalizeKey(null), '');
    assert.equal(canonicalizeKey(undefined), '');
    assert.equal(canonicalizeKey(42), '');
});

/* ============================================================ */
/* validateScope                                                */
/* ============================================================ */

test('validateScope accepts user|workspace only', () => {
    assert.deepEqual(validateScope('user'), { ok: true });
    assert.deepEqual(validateScope('workspace'), { ok: true });
});

test('validateScope rejects persona — kickoff dropped it', () => {
    const r = validateScope('persona');
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /scope must be one of/);
});

test('validateScope rejects garbage and missing values', () => {
    assert.equal(validateScope('').ok, false);
    assert.equal(validateScope(null).ok, false);
    assert.equal(validateScope(undefined).ok, false);
    assert.equal(validateScope({}).ok, false);
});

/* ============================================================ */
/* validateCategory                                             */
/* ============================================================ */

test('validateCategory accepts the five DESIGN values', () => {
    for (const c of ['preferences', 'decisions', 'project_context', 'domain_knowledge', 'workflow']) {
        assert.deepEqual(validateCategory(c), { ok: true }, `category=${c}`);
    }
});

test('validateCategory rejects unknown categories', () => {
    assert.equal(validateCategory('rituals').ok, false);
    assert.equal(validateCategory('').ok, false);
});

/* ============================================================ */
/* validateSource                                               */
/* ============================================================ */

test('validateSource accepts the three-value enum', () => {
    for (const s of ['user_explicit', 'agent_proposed', 'inferred']) {
        assert.deepEqual(validateSource(s), { ok: true });
    }
});

test('validateSource rejects "system_inferred" — DESIGN had it; kickoff renamed to "inferred"', () => {
    assert.equal(validateSource('system_inferred').ok, false);
});

test('validateSource rejects a confidence float — kickoff dropped that surface', () => {
    assert.equal(validateSource(0.85).ok, false);
});

/* ============================================================ */
/* validateKey                                                   */
/* ============================================================ */

test('validateKey requires a non-empty canonical string', () => {
    assert.equal(validateKey('hello').ok, true);
    assert.equal(validateKey('').ok, false);
    assert.equal(validateKey(42).ok, false);
});

test('validateKey requires canonicalization (lowercase + trimmed)', () => {
    const r1 = validateKey(' notCanon ');
    assert.equal(r1.ok, false);
    assert.match(r1.errors[0], /canonical/);
    const r2 = validateKey('UPPER');
    assert.equal(r2.ok, false);
});

test('validateKey enforces KEY_MAX_LENGTH', () => {
    const ok = 'a'.repeat(MEMORY_LIMITS.KEY_MAX_LENGTH);
    assert.equal(validateKey(ok).ok, true);
    const tooLong = 'a'.repeat(MEMORY_LIMITS.KEY_MAX_LENGTH + 1);
    const r = validateKey(tooLong);
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /≤256/);
});

/* ============================================================ */
/* validateRecord                                                */
/* ============================================================ */

function validRecord(over = {}) {
    return {
        id: 'a-uuid',
        scope: 'user',
        owner_id_or_workspace_id: 'jeff',
        key: 'preferred_language',
        value: 'rust',
        category: 'preferences',
        source: 'user_explicit',
        embedding: null,
        embedding_model_id: '',
        created_at: 1000,
        updated_at: 1000,
        created_by: 'jeff',
        actor: 'jeff',
        superseded_by: null,
        expires_at: null,
        md_path: null,
        ...over,
    };
}

test('validateRecord accepts a minimally complete record', () => {
    assert.deepEqual(validateRecord(validRecord()), { ok: true });
});

test('validateRecord rejects null/undefined/non-object', () => {
    assert.equal(validateRecord(null).ok, false);
    assert.equal(validateRecord(undefined).ok, false);
    assert.equal(validateRecord('string').ok, false);
});

test('validateRecord aggregates multiple errors instead of failing fast', () => {
    const bad = validRecord({ scope: 'persona', source: 'high', category: '???', actor: 42 });
    const r = validateRecord(bad);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length >= 3, `got ${r.errors.length} errors`);
});

test('validateRecord rejects superseded_by === id (self-supersession)', () => {
    const r = validateRecord(validRecord({ superseded_by: 'a-uuid' }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /no self-supersession/.test(e)));
});

test('validateRecord requires created_at <= updated_at', () => {
    const r = validateRecord(validRecord({ created_at: 2000, updated_at: 1000 }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /<= updated_at/.test(e)));
});

test('validateRecord rejects Float32Array embedding (must be number[])', () => {
    const r = validateRecord(validRecord({ embedding: new Float32Array([1, 2, 3]) }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /structured-clone-safe/.test(e)));
});

test('validateRecord accepts null embedding (indexing-lag valid state)', () => {
    assert.deepEqual(validateRecord(validRecord({ embedding: null })), { ok: true });
});

test('validateRecord rejects non-finite numbers in embedding', () => {
    const r = validateRecord(validRecord({ embedding: [1, NaN, 3] }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /finite number/.test(e)));
});

test('validateRecord accepts md_path null or string', () => {
    assert.equal(validateRecord(validRecord({ md_path: null })).ok, true);
    assert.equal(validateRecord(validRecord({ md_path: '.aieditor/memory/preferences.md' })).ok, true);
    assert.equal(validateRecord(validRecord({ md_path: 42 })).ok, false);
});

test('validateRecord requires non-canonical keys to be rejected', () => {
    const r = validateRecord(validRecord({ key: '  WRONGCASE ' }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /canonical/.test(e)));
});

test('validateRecord enforces actor max length', () => {
    const r = validateRecord(validRecord({ actor: 'a'.repeat(MEMORY_LIMITS.ACTOR_MAX_LENGTH + 1) }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => new RegExp(`≤${MEMORY_LIMITS.ACTOR_MAX_LENGTH}`).test(e)));
});

/* ============================================================ */
/* assertValid                                                  */
/* ============================================================ */

test('assertValid throws on invalid records with errors attached', () => {
    let caught;
    try {
        assertValid(validRecord({ scope: 'persona' }));
    } catch (e) {
        caught = e;
    }
    assert.ok(caught instanceof Error);
    assert.match(caught.message, /Invalid memory record/);
    assert.ok(Array.isArray(caught.errors));
    assert.ok(caught.errors.length > 0);
});

test('assertValid is a no-op on valid records', () => {
    assert.doesNotThrow(() => assertValid(validRecord()));
});
