// @ts-check
/**
 * Anti-regression test for the `ChunkStore` typedef shape contract.
 *
 * Origin: `RE-EVAL following 2.52.0` ICD #5 code-aware finding (b1) —
 * the typedef at `js/intelligence/retrieval/store.js` declared 8 methods
 * while the runtime factory exposed 9 (the 1.5.10-added
 * `getAllChunksForCollection` was never reflected in the typedef). The
 * gap survived to 2.58.0 as 12 `@ts-ignore` annotations across
 * `manager.js` at the call sites that read the un-declared method.
 *
 * This test asserts that the runtime store handle exposes every method
 * the typedef declares, and no extras — so a future drift between the
 * factory's return shape and the typedef surfaces immediately as a test
 * failure rather than as a creeping band of `@ts-ignore` annotations.
 *
 * Mirrors `tests/test-provider-capabilities-shape.mjs` in idiom: pure
 * import-and-assert; zero EventBus, zero DOM, zero mocks.
 *
 * @since 2.59.0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInMemoryChunkStore } from '../js/intelligence/retrieval/store.js';

/**
 * Methods declared in the `ChunkStore` typedef at
 * [`js/intelligence/retrieval/store.js`](../js/intelligence/retrieval/store.js).
 * Update this list in lockstep with the typedef.
 */
const CHUNK_STORE_METHODS = [
    'getChunkByID',
    'chunkVectorSearch',
    'getSourceHash',
    'setSourceHash',
    'chunkIdsForSource',
    'getAllChunksForCollection',
    'upsert',
    'markStale',
    'stats',
];

test('chunk-store-shape: runtime store exposes every typedef method', () => {
    const store = createInMemoryChunkStore();
    for (const method of CHUNK_STORE_METHODS) {
        assert.equal(
            typeof store[method],
            'function',
            `ChunkStore.${method} must be a function (got ${typeof store[method]}) — typedef and runtime are out of sync`
        );
    }
});

test('chunk-store-shape: runtime store exposes no methods beyond the typedef', () => {
    const store = createInMemoryChunkStore();
    const runtimeMethods = Object.keys(store).filter((k) => typeof store[k] === 'function');
    const extras = runtimeMethods.filter((m) => !CHUNK_STORE_METHODS.includes(m));
    assert.deepEqual(
        extras,
        [],
        `runtime store exposes methods not in the ChunkStore typedef: ${extras.join(', ')} — either add them to the typedef at js/intelligence/retrieval/store.js or remove from the factory`
    );
});

test('chunk-store-shape: stats() returns the documented three-field shape', () => {
    // Pin the typedef'd return shape so a future widening of `stats()` doesn't silently break
    // the `manager.js#getStats` consumer that reads `.sources` and the dashboard
    // consumers that read `.chunks` / `.collections`.
    const store = createInMemoryChunkStore();
    const s = store.stats();
    assert.equal(typeof s.chunks, 'number', 'stats().chunks must be a number');
    assert.equal(typeof s.collections, 'number', 'stats().collections must be a number');
    assert.equal(typeof s.sources, 'number', 'stats().sources must be a number');
    const extras = Object.keys(s).filter((k) => !['chunks', 'collections', 'sources'].includes(k));
    assert.deepEqual(extras, [], `stats() return shape adds unexpected keys: ${extras.join(', ')}`);
});

test('chunk-store-shape: getAllChunksForCollection returns a Promise<ChunkRef[]>', () => {
    // Pin the newly-typed-in-2.59.0 method's contract so the typedef widening
    // can't drift from runtime behavior (e.g. flipping to a sync ChunkRef[]).
    const store = createInMemoryChunkStore();
    const result = store.getAllChunksForCollection('nonexistent-collection');
    assert.ok(result instanceof Promise, 'getAllChunksForCollection must return a Promise');
    return result.then((chunks) => {
        assert.ok(Array.isArray(chunks), 'resolved value must be an array');
        assert.equal(chunks.length, 0, 'unknown collection must resolve to []');
    });
});
