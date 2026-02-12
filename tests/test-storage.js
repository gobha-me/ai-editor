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
// Cleanup
// ============================================

for (const key of testKeys) {
    Storage.remove(key);
}
