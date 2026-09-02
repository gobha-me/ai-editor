/**
 * Tests for Storage cache layer (core.js).
 * Validates that the in-memory cache, keys(), and draft methods work correctly.
 * 
 * NOTE: These tests run AFTER core.js has been imported. The Storage object
 * may or may not have IDB available depending on the test environment.
 * We test the cache behavior regardless of backend.
 */
import { Storage } from '../js/core.js';

const { T } = window;

// Initialize Storage (IDB + cache hydration) — mirrors what app.js does
await Storage.init();

// ============================================
// Storage.keys() Tests
// ============================================

T.suite('Storage — keys() Method');

// Save current state for cleanup
const testKeys = ['_test_key_1', '_test_key_2', '_test_draft_a', '_test_draft_b', '_test_embed_x'];

// Seed test data
Storage.set('_test_key_1', 'value1');
Storage.set('_test_key_2', 'value2');
Storage.set('_test_draft_a', { content: 'a' });
Storage.set('_test_draft_b', { content: 'b' });
Storage.set('_test_embed_x', { files: [] });

const allKeys = Storage.keys();
T.assert(allKeys.length >= 5, `keys() returns at least test keys (got ${allKeys.length})`);

const draftKeys = Storage.keys('_test_draft_');
T.eq(draftKeys.length, 2, 'keys("_test_draft_") returns 2 draft keys');

const embedKeys = Storage.keys('_test_embed_');
T.eq(embedKeys.length, 1, 'keys("_test_embed_") returns 1 embedding key');

const noKeys = Storage.keys('_nonexistent_prefix_xyz_');
T.eq(noKeys.length, 0, 'keys() with unmatched prefix returns empty');

// ============================================
// Storage Cache Consistency
// ============================================

T.suite('Storage — Cache Consistency');

// set → get roundtrip
Storage.set('_test_roundtrip', { nested: { value: 42 } });
const rt = Storage.get('_test_roundtrip');
T.eq(rt.nested.value, 42, 'set/get roundtrip preserves nested objects');
testKeys.push('_test_roundtrip');

// Overwrite
Storage.set('_test_roundtrip', { replaced: true });
const ow = Storage.get('_test_roundtrip');
T.eq(ow.replaced, true, 'set() overwrites previous value in cache');
T.eq(ow.nested, undefined, 'Overwritten value has no old fields');

// remove → get returns default
Storage.remove('_test_roundtrip');
T.eq(Storage.get('_test_roundtrip'), null, 'get() returns null after remove');
T.eq(Storage.get('_test_roundtrip', 'fallback'), 'fallback', 'get() returns defaultValue after remove');

// Cache reflects remove in keys()
const keysAfterRemove = Storage.keys('_test_roundtrip');
T.eq(keysAfterRemove.length, 0, 'keys() excludes removed key');

// ============================================
// Storage.isIDBActive
// ============================================

T.suite('Storage — IDB Status');

T.assert(typeof Storage.isIDBActive === 'boolean', 'isIDBActive is a boolean');
// We can't guarantee IDB works in all test envs, but the property must exist
if (Storage.isIDBActive) {
    T.assert(Storage._idb !== null, 'IDB module loaded when isIDBActive=true');
    T.assert(Storage._cache.size > 0, 'Cache is populated when IDB is active');
} else {
    T.assert(true, 'IDB not active (incognito or unsupported — OK)');
}

// ============================================
// Draft Methods via Cache
// ============================================

T.suite('Storage — Draft Methods');

Storage.saveDraft('testowner', 'testrepo', 'main', 'src/app.js', 'console.log("test")');
const draft = Storage.getDraft('testowner', 'testrepo', 'main', 'src/app.js');
T.eq(draft, 'console.log("test")', 'saveDraft/getDraft roundtrip works');
testKeys.push('draft-testowner/testrepo/main/src/app.js');

const drafts = Storage.listDrafts();
const found = drafts.find(d => d.path === 'testowner/testrepo/main/src/app.js');
T.assert(found !== undefined, 'listDrafts() includes saved draft');
T.assert(found.content === 'console.log("test")', 'listDrafts() entry has correct content');
T.assert(typeof found.timestamp === 'number', 'listDrafts() entry has timestamp');

Storage.clearDraft('testowner', 'testrepo', 'main', 'src/app.js');
const cleared = Storage.getDraft('testowner', 'testrepo', 'main', 'src/app.js');
T.eq(cleared, null, 'clearDraft removes draft');

// ============================================
// Quota Recovery (regression for 1.6.5)
// ============================================
//
// Regression: a `QuotaExceededError` on the localStorage write of
// `chatHistory` must NOT prune/truncate the localStorage backup copy and
// must NOT emit `[Storage] Quota exceeded — pruned chat history`. IDB and
// the in-memory _cache are authoritative; the backup copy is best-effort.

T.suite('Storage — Quota Recovery (regression for 1.6.5)');

{
    const resolvedChatKey = Storage._resolveKey('chatHistory');
    const fullChatLsKey = Storage._prefix + resolvedChatKey;
    const priorCacheValue = Storage._cache.get(resolvedChatKey);
    const priorLsValue = (() => {
        try { return localStorage.getItem(fullChatLsKey); } catch { return null; }
    })();

    const messages = Array.from({ length: 59 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `quota-recovery test message ${i}`,
        timestamp: 1_700_000_000_000 + i,
    }));

    const originalBackend = Storage._localStorageBackend;
    const originalSetItem = localStorage.setItem.bind(localStorage);
    const originalRemoveItem = localStorage.removeItem.bind(localStorage);
    let threwOnce = false;
    Storage._localStorageBackend = {
        setItem(k, v) {
            if (!threwOnce && k === fullChatLsKey) {
                threwOnce = true;
                const err = new Error('synthetic quota');
                err.name = 'QuotaExceededError';
                throw err;
            }
            return originalSetItem(k, v);
        },
        removeItem(k) {
            return originalRemoveItem(k);
        },
    };

    const idbCalls = [];
    const originalIdbSet = (Storage._idb && typeof Storage._idb.set === 'function')
        ? Storage._idb.set.bind(Storage._idb)
        : null;
    if (originalIdbSet) {
        Storage._idb.set = function (k, v) {
            if (k === resolvedChatKey) idbCalls.push({ key: k, length: Array.isArray(v) ? v.length : null });
            return originalIdbSet(k, v);
        };
    }

    const warnCalls = [];
    const originalWarn = console.warn;
    console.warn = function (...args) { warnCalls.push(args); return originalWarn.apply(console, args); };

    let setError = null;
    try {
        Storage.set('chatHistory', messages);
    } catch (e) {
        setError = e;
    }

    // Restore stubs/spies before assertions so a failed assertion doesn't
    // leak into the rest of the suite.
    Storage._localStorageBackend = originalBackend;
    if (originalIdbSet) Storage._idb.set = originalIdbSet;
    console.warn = originalWarn;

    T.assert(threwOnce, 'stub fired exactly once for the chatHistory key');
    T.eq(setError, null, 'Storage.set did not propagate the QuotaExceededError');

    const cachedAfter = Storage._cache.get(resolvedChatKey);
    T.assert(Array.isArray(cachedAfter), '_cache holds an array after quota recovery');
    T.eq(cachedAfter.length, 59, '_cache.chatHistory has all 59 messages (a)');

    if (Storage.isIDBActive) {
        T.assert(idbCalls.length >= 1, 'IDB.set was invoked for chatHistory (b)');
        T.eq(idbCalls[idbCalls.length - 1].length, 59, 'IDB.set received the full 59-message array (b)');
    } else {
        T.assert(true, 'IDB inactive — skipping IDB-write assertion (b)');
    }

    const prunedWarn = warnCalls.find(args =>
        typeof args[0] === 'string' && args[0].startsWith('[Storage] Quota exceeded — pruned chat history')
    );
    T.assert(!prunedWarn, 'no "pruned chat history" warning emitted (c)');

    // Cleanup: restore prior chatHistory state in cache + localStorage.
    if (priorCacheValue === undefined) {
        Storage._cache.delete(resolvedChatKey);
    } else {
        Storage._cache.set(resolvedChatKey, priorCacheValue);
    }
    try {
        if (priorLsValue === null) localStorage.removeItem(fullChatLsKey);
        else localStorage.setItem(fullChatLsKey, priorLsValue);
    } catch { /* best-effort cleanup */ }
}

// ============================================
// Cleanup
// ============================================

for (const key of testKeys) {
    Storage.remove(key);
}
