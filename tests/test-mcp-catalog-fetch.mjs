/**
 * Tests for `js/mcp/catalog-fetch.js` — IO orchestrator with cache.
 *
 * Drives the full 3-tier fallback (cache → fresh → stale → bundled) via
 * injected `idb` (in-memory Map shim) and `fetchImpl` (controllable
 * mock). Real IndexedDB and the network are never touched here — the
 * `js/storage/idb.js` paths are exercised by browser tests.
 *
 * Key invariants this file gates:
 *   • A fresh cache short-circuits — fetch is NOT called.
 *   • A stale cache triggers a fetch; success writes both keys back.
 *   • Network failure with stale cache → return cached, source: 'cache'.
 *   • Network failure with no cache → return [], source: 'bundled'
 *     (the merge layer folds in the bundled MCP_CATALOG separately).
 *   • IDB read/write failures don't crash; degrade with console.warn.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getRemoteCatalog, clearRemoteCatalogCache, __test_keys } from '../js/mcp/catalog-fetch.js';

function makeIdbShim() {
    const store = new Map();
    return {
        store,
        get: async (k) => store.get(k),
        set: async (k, v) => { store.set(k, v); },
        remove: async (k) => { store.delete(k); },
    };
}

function mockFetch(payload, { status = 200 } = {}) {
    let calls = 0;
    const fn = async () => {
        calls++;
        return {
            ok: status >= 200 && status < 300,
            status,
            async json() { return payload; },
        };
    };
    fn.calls = () => calls;
    return fn;
}

function makeFailingFetch(message = 'network down') {
    let calls = 0;
    const fn = async () => {
        calls++;
        throw new Error(message);
    };
    fn.calls = () => calls;
    return fn;
}

const SAMPLE_PAYLOAD = {
    servers: [
        { qualifiedName: 'exa', displayName: 'Exa', description: 'd', remote: true, useCount: 100 },
        { qualifiedName: 'gmail', displayName: 'Gmail', description: 'd', remote: true, useCount: 50 },
    ],
};

// ============================================
// Cache hit (fresh)
// ============================================

test('fresh cache short-circuits — no fetch call', async () => {
    const idb = makeIdbShim();
    const cached = [{ id: 'exa', name: 'Exa', source: 'remote' }];
    idb.store.set(__test_keys.CACHE_KEY, cached);
    idb.store.set(__test_keys.META_KEY, { fetchedAt: 5000 });
    const fetchImpl = mockFetch(SAMPLE_PAYLOAD);

    const out = await getRemoteCatalog({
        fetchImpl,
        idb,
        ttlMs: 10_000,
        now: () => 7000, // 2s ago, well within ttl
    });

    assert.equal(out.source, 'cache');
    assert.equal(out.entries.length, 1);
    assert.equal(out.entries[0].id, 'exa');
    assert.equal(fetchImpl.calls(), 0, 'fresh cache must not call fetch');
});

// ============================================
// Cache miss → fresh fetch
// ============================================

test('empty cache triggers fetch + writes both keys', async () => {
    const idb = makeIdbShim();
    const fetchImpl = mockFetch(SAMPLE_PAYLOAD);

    const out = await getRemoteCatalog({
        fetchImpl,
        idb,
        ttlMs: 10_000,
        now: () => 12345,
    });

    assert.equal(out.source, 'fresh');
    assert.equal(out.entries.length, 2);
    assert.equal(out.fetchedAt, 12345);
    assert.equal(fetchImpl.calls(), 1);

    const writtenEntries = idb.store.get(__test_keys.CACHE_KEY);
    const writtenMeta = idb.store.get(__test_keys.META_KEY);
    assert.ok(Array.isArray(writtenEntries));
    assert.equal(writtenEntries.length, 2);
    assert.equal(writtenMeta.fetchedAt, 12345);
});

test('stale cache triggers refetch (cache age > ttl)', async () => {
    const idb = makeIdbShim();
    idb.store.set(__test_keys.CACHE_KEY, [{ id: 'old', name: 'Old' }]);
    idb.store.set(__test_keys.META_KEY, { fetchedAt: 1000 });
    const fetchImpl = mockFetch(SAMPLE_PAYLOAD);

    const out = await getRemoteCatalog({
        fetchImpl,
        idb,
        ttlMs: 5000,
        now: () => 100_000, // way past ttl
    });

    assert.equal(out.source, 'fresh');
    assert.equal(out.entries.length, 2);
    assert.equal(fetchImpl.calls(), 1);
});

// ============================================
// Network failure paths
// ============================================

test('fetch failure with stale cache → cache fallback (source: cache)', async () => {
    const idb = makeIdbShim();
    const stale = [{ id: 'old', name: 'Old' }];
    idb.store.set(__test_keys.CACHE_KEY, stale);
    idb.store.set(__test_keys.META_KEY, { fetchedAt: 1000 });
    const fetchImpl = makeFailingFetch();

    const out = await getRemoteCatalog({
        fetchImpl,
        idb,
        ttlMs: 5000,
        now: () => 100_000,
    });

    assert.equal(out.source, 'cache');
    assert.equal(out.entries.length, 1);
    assert.equal(out.entries[0].id, 'old');
    assert.equal(fetchImpl.calls(), 1);
});

test('fetch failure with empty cache → bundled fallback (source: bundled)', async () => {
    const idb = makeIdbShim();
    const fetchImpl = makeFailingFetch();

    const out = await getRemoteCatalog({
        fetchImpl,
        idb,
        ttlMs: 5000,
        now: () => 100_000,
    });

    assert.equal(out.source, 'bundled');
    assert.equal(out.entries.length, 0);
    assert.equal(out.fetchedAt, 0);
});

test('fetch returns non-2xx → falls back like a thrown error', async () => {
    const idb = makeIdbShim();
    const fetchImpl = mockFetch({}, { status: 500 });

    const out = await getRemoteCatalog({
        fetchImpl,
        idb,
        ttlMs: 5000,
        now: () => 100_000,
    });

    assert.equal(out.source, 'bundled');
    assert.equal(out.entries.length, 0);
});

// ============================================
// IDB failure resilience
// ============================================

test('IDB read failure does not crash; treats as cache miss', async () => {
    const idb = {
        get: async () => { throw new Error('idb read busted'); },
        set: async () => {},
    };
    const fetchImpl = mockFetch(SAMPLE_PAYLOAD);
    const out = await getRemoteCatalog({ fetchImpl, idb, now: () => 1 });
    assert.equal(out.source, 'fresh');
    assert.equal(out.entries.length, 2);
});

test('IDB write failure does not crash; still returns the fresh entries', async () => {
    const idb = {
        get: async () => undefined,
        set: async () => { throw new Error('quota exceeded'); },
    };
    const fetchImpl = mockFetch(SAMPLE_PAYLOAD);
    const out = await getRemoteCatalog({ fetchImpl, idb, now: () => 1 });
    assert.equal(out.source, 'fresh');
    assert.equal(out.entries.length, 2);
});

// ============================================
// Defensive cases
// ============================================

test('empty array in cache is treated as miss (regression guard)', async () => {
    const idb = makeIdbShim();
    idb.store.set(__test_keys.CACHE_KEY, []);
    idb.store.set(__test_keys.META_KEY, { fetchedAt: 7000 });
    const fetchImpl = mockFetch(SAMPLE_PAYLOAD);

    const out = await getRemoteCatalog({
        fetchImpl,
        idb,
        ttlMs: 10_000,
        now: () => 8000, // would be fresh by time
    });

    assert.equal(out.source, 'fresh', 'empty cache should not short-circuit');
    assert.equal(fetchImpl.calls(), 1);
});

test('non-array in cache is treated as miss (defensive against schema drift)', async () => {
    const idb = makeIdbShim();
    idb.store.set(__test_keys.CACHE_KEY, { not: 'an array' });
    idb.store.set(__test_keys.META_KEY, { fetchedAt: 1 });
    const fetchImpl = mockFetch(SAMPLE_PAYLOAD);

    const out = await getRemoteCatalog({ fetchImpl, idb, now: () => 2 });
    assert.equal(out.source, 'fresh');
});

test('clearRemoteCatalogCache removes both keys', async () => {
    const idb = makeIdbShim();
    idb.store.set(__test_keys.CACHE_KEY, [{ id: 'a' }]);
    idb.store.set(__test_keys.META_KEY, { fetchedAt: 1 });
    await clearRemoteCatalogCache({ idb });
    assert.equal(idb.store.has(__test_keys.CACHE_KEY), false);
    assert.equal(idb.store.has(__test_keys.META_KEY), false);
});

test('clearRemoteCatalogCache survives an idb failure (no throw)', async () => {
    const idb = { remove: async () => { throw new Error('idb broke'); } };
    await clearRemoteCatalogCache({ idb }); // does not throw
});
