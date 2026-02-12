/**
 * Tests for Storage IDB backend and Storage cache layer.
 * IndexedDB is available in browser test pages.
 */
import { IDB } from '../js/storage/idb.js';

const { T } = window;

// ============================================
// IDB Low-Level Tests
// ============================================

T.suite('IDB — Open & Basic Operations');

// Clean slate — IDB persists across page reloads, so prior runs leave data
try { IDB.close(); } catch {}

const db = await IDB.open();
await IDB.clear();  // Ensure no stale data from previous test runs

T.assert(db !== null, 'IDB.open() returns a database handle');
T.assert(db instanceof IDBDatabase, 'Handle is an IDBDatabase instance');
T.assert(db.objectStoreNames.contains('kv'), 'Database has "kv" object store');

// Idempotent open
const db2 = await IDB.open();
T.eq(db, db2, 'Second open() returns same handle');

T.suite('IDB — Set, Get, Remove');

await IDB.set('test-key-1', { name: 'hello', count: 42 });
const val1 = await IDB.get('test-key-1');
T.eq(val1.name, 'hello', 'get() returns stored object');
T.eq(val1.count, 42, 'get() preserves number types');

await IDB.set('test-key-1', { name: 'updated' });
const val2 = await IDB.get('test-key-1');
T.eq(val2.name, 'updated', 'set() overwrites existing key');

await IDB.remove('test-key-1');
const val3 = await IDB.get('test-key-1');
T.eq(val3, undefined, 'remove() deletes the key');

T.suite('IDB — Keys & Prefix Filtering');

// Seed test data
await IDB.set('draft-file1.js', { content: 'a' });
await IDB.set('draft-file2.js', { content: 'b' });
await IDB.set('settings', { theme: 'dark' });
await IDB.set('embeddings-index-proj1', { files: [] });

const allKeys = await IDB.keys();
T.assert(allKeys.length >= 4, `keys() returns all keys (got ${allKeys.length})`);

const draftKeys = await IDB.keys('draft-');
T.eq(draftKeys.length, 2, 'keys("draft-") returns only draft keys');
T.assert(draftKeys.includes('draft-file1.js'), 'Draft keys include file1');
T.assert(draftKeys.includes('draft-file2.js'), 'Draft keys include file2');

const embKeys = await IDB.keys('embeddings-');
T.eq(embKeys.length, 1, 'keys("embeddings-") returns only embedding keys');

const noMatch = await IDB.keys('nonexistent-prefix-');
T.eq(noMatch.length, 0, 'keys() with no matching prefix returns empty array');

T.suite('IDB — getAll');

const all = await IDB.getAll();
T.assert(all instanceof Map, 'getAll() returns a Map');
T.assert(all.size >= 4, `getAll() has all entries (got ${all.size})`);
T.eq(all.get('settings').theme, 'dark', 'getAll() values are correct');

T.suite('IDB — setMany (Bulk Write)');

const bulkEntries = [
    ['bulk-1', { v: 1 }],
    ['bulk-2', { v: 2 }],
    ['bulk-3', { v: 3 }],
];
const written = await IDB.setMany(bulkEntries);
T.eq(written, 3, 'setMany() writes all entries');

const b1 = await IDB.get('bulk-1');
const b3 = await IDB.get('bulk-3');
T.eq(b1.v, 1, 'setMany entry 1 readable');
T.eq(b3.v, 3, 'setMany entry 3 readable');

// Empty batch
const emptyWritten = await IDB.setMany([]);
T.eq(emptyWritten, 0, 'setMany([]) returns 0');

T.suite('IDB — Clear');

await IDB.clear();
const afterClear = await IDB.keys();
T.eq(afterClear.length, 0, 'clear() removes all keys');

const afterClearGet = await IDB.get('settings');
T.eq(afterClearGet, undefined, 'get() returns undefined after clear');

T.suite('IDB — Estimate');

const est = await IDB.estimate();
// Storage API might not be available in all environments
if (est !== null) {
    T.assert(typeof est.usage === 'number', 'estimate().usage is a number');
    T.assert(typeof est.quota === 'number', 'estimate().quota is a number');
    T.assert(est.quota > 0, 'estimate().quota is positive');
} else {
    T.assert(true, 'estimate() returns null (Storage API unavailable — OK)');
}

// Final cleanup
await IDB.clear();
IDB.close();
