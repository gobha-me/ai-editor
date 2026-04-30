/**
 * Pure-data tests for js/intelligence/memory/ public surface (constants
 * and barrel exports). Mirrors the test-compression-contracts.mjs pattern:
 * exercise every exported factory once so missing exports fail at import
 * time, and assert frozen-constant shapes so accidental mutation is caught.
 *
 * Runs under `node --test`. Memory's public constants are pure data — no
 * DOM, no IDB. The shim is still imported because the barrel re-exports
 * from `store.js`, which imports `core.js` for `EventBus`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    MEMORY_EVENTS,
    MEMORY_LIMITS,
    MEMORY_SCOPES,
    MEMORY_CATEGORIES,
    MEMORY_SOURCES,
    AUDIT_ACTIONS,
    DELETED_SENTINEL,
    canonicalizeKey,
    canonicalEmbedText,
    validateScope,
    validateCategory,
    validateSource,
    validateKey,
    validateRecord,
    assertValid,
    create,
    update,
    supersede,
    softDelete,
    purgeExpired,
    getById,
    getByKey,
    list,
    searchSemantic,
    audit,
    _setIDBImpl,
    _resetIDBImpl,
    createMemoryFakeIDB,
    _resetMutexForTests,
} from '../js/intelligence/memory/index.js';

test('MEMORY_EVENTS exposes the three channel names and is frozen', () => {
    assert.equal(MEMORY_EVENTS.CREATED, 'memory:created');
    assert.equal(MEMORY_EVENTS.UPDATED, 'memory:updated');
    assert.equal(MEMORY_EVENTS.DELETED, 'memory:deleted');
    assert.ok(Object.isFrozen(MEMORY_EVENTS), 'MEMORY_EVENTS should be frozen');
});

test('MEMORY_LIMITS holds the documented size caps', () => {
    assert.equal(MEMORY_LIMITS.KEY_MAX_LENGTH, 256);
    assert.equal(MEMORY_LIMITS.ACTOR_MAX_LENGTH, 128);
    assert.equal(MEMORY_LIMITS.REASON_MAX_LENGTH, 1024);
    assert.ok(Object.isFrozen(MEMORY_LIMITS));
});

test('MEMORY_SCOPES is user|workspace only — persona dropped from 1.3.0', () => {
    assert.deepEqual([...MEMORY_SCOPES], ['user', 'workspace']);
    assert.ok(Object.isFrozen(MEMORY_SCOPES));
});

test('MEMORY_CATEGORIES covers the five DESIGN-memory.md values', () => {
    assert.deepEqual([...MEMORY_CATEGORIES], [
        'preferences',
        'decisions',
        'project_context',
        'domain_knowledge',
        'workflow',
    ]);
    assert.ok(Object.isFrozen(MEMORY_CATEGORIES));
});

test('MEMORY_SOURCES is the 3-value enum that replaced the confidence float', () => {
    assert.deepEqual([...MEMORY_SOURCES], ['user_explicit', 'agent_proposed', 'inferred']);
    assert.ok(Object.isFrozen(MEMORY_SOURCES));
});

test('AUDIT_ACTIONS lists the five mutation kinds', () => {
    assert.deepEqual([...AUDIT_ACTIONS], ['create', 'update', 'supersede', 'softDelete', 'expire']);
    assert.ok(Object.isFrozen(AUDIT_ACTIONS));
});

test('DELETED_SENTINEL is a stable, recognizable string', () => {
    assert.equal(DELETED_SENTINEL, '__deleted__');
});

test('barrel re-exports every public function (smoke-imports)', () => {
    // If any of these are undefined, the import at the top of this file
    // would have already thrown a TypeError-on-use; we still call typeof
    // here so a future barrel regression that exports undefined fails
    // loudly instead of at first use.
    for (const fn of [
        canonicalizeKey, canonicalEmbedText,
        validateScope, validateCategory, validateSource, validateKey,
        validateRecord, assertValid,
        create, update, supersede, softDelete, purgeExpired,
        getById, getByKey, list, searchSemantic,
        _setIDBImpl, _resetIDBImpl, createMemoryFakeIDB, _resetMutexForTests,
    ]) {
        assert.equal(typeof fn, 'function');
    }
    // audit is a namespace re-export.
    assert.equal(typeof audit, 'object');
    assert.equal(typeof audit.append, 'function');
    assert.equal(typeof audit.list, 'function');
    assert.equal(typeof audit.listForRecord, 'function');
});
