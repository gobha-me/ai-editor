// @ts-check
/**
 * Memory IDB plumbing — store/index name constants, raw IDB operation
 * primitives that `store.js` and `audit.js` call into, and a test seam
 * for swapping the IDB layer with an in-memory Map-backed fake.
 *
 * The schema upgrade itself lives in `js/storage/idb.js` (v1 → v2 in 1.3.0
 * adds the two memory stores additively). This file just re-exports the
 * store names and provides operation helpers — the surface that the rest of
 * `js/intelligence/memory/` consumes.
 *
 * @module intelligence/memory/idb-schema
 */

import { IDB } from '../../storage/idb.js';

/**
 * Store + index names. Re-exported from `IDB` so memory code never
 * hardcodes them at multiple sites.
 */
export const STORES = Object.freeze({
    RECORDS: IDB.MEMORY_RECORDS_STORE,
    AUDIT: IDB.MEMORY_AUDIT_STORE,
});

export const RECORD_INDEXES = Object.freeze({
    BY_SCOPE_OWNER_KEY: 'by_scope_owner_key',
    BY_SCOPE_CATEGORY: 'by_scope_category',
    BY_SUPERSEDED_BY: 'by_superseded_by',
    BY_EXPIRES_AT: 'by_expires_at',
});

export const AUDIT_INDEXES = Object.freeze({
    BY_RECORD_ID: 'by_record_id',
    BY_TS: 'by_ts',
});

/* -------------------------------------------------------------------------- */
/* Adapter surface                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The operation surface that the rest of the memory subsystem consumes.
 * Production wires this to real IDB; node:test injects a Map-backed fake
 * (`createMemoryFakeIDB()`).
 *
 * Method shapes are intentionally narrow — only the operations memory
 * actually performs, no more. Adding an operation here means adding it
 * to both the real impl and the fake.
 *
 * @typedef {Object} MemoryIDBImpl
 * @property {(record: any) => Promise<void>}                                              putRecord
 * @property {(id: string) => Promise<any|null>}                                            getRecord
 * @property {(id: string) => Promise<void>}                                                deleteRecord
 * @property {() => Promise<any[]>}                                                         getAllRecords
 * @property {(scope: string, owner: string) => Promise<any[]>}                             getRecordsByOwner
 * @property {(scope: string, owner: string, key: string) => Promise<any[]>}                getRecordsByKey
 * @property {(scope: string, category: string) => Promise<any[]>}                          getRecordsByCategory
 * @property {(beforeTs: number) => Promise<any[]>}                                         getExpiredRecords
 * @property {(entry: any) => Promise<number>}                                              addAudit
 * @property {() => Promise<any[]>}                                                         getAllAudit
 * @property {(recordId: string) => Promise<any[]>}                                         getAuditByRecord
 * @property {() => Promise<void>}                                                          clearAll
 */

/* -------------------------------------------------------------------------- */
/* Real IDB implementation                                                    */
/* -------------------------------------------------------------------------- */

/** @returns {MemoryIDBImpl} */
function createRealIDBImpl() {
    async function tx(storeName, mode) {
        const db = await IDB.open();
        const transaction = db.transaction(storeName, mode);
        return transaction.objectStore(storeName);
    }

    function awaitReq(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    function awaitCursor(req) {
        return new Promise((resolve, reject) => {
            const out = [];
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    out.push(cursor.value);
                    cursor.continue();
                } else {
                    resolve(out);
                }
            };
            req.onerror = () => reject(req.error);
        });
    }

    return {
        async putRecord(record) {
            const store = await tx(STORES.RECORDS, 'readwrite');
            await awaitReq(store.put(record));
        },
        async getRecord(id) {
            const store = await tx(STORES.RECORDS, 'readonly');
            const r = await awaitReq(store.get(id));
            return r ?? null;
        },
        async deleteRecord(id) {
            const store = await tx(STORES.RECORDS, 'readwrite');
            await awaitReq(store.delete(id));
        },
        async getAllRecords() {
            const store = await tx(STORES.RECORDS, 'readonly');
            return awaitCursor(store.openCursor());
        },
        async getRecordsByOwner(scope, owner) {
            const store = await tx(STORES.RECORDS, 'readonly');
            const idx = store.index(RECORD_INDEXES.BY_SCOPE_OWNER_KEY);
            // Compound prefix scan: lower [scope, owner] → upper [scope, owner, []].
            // The empty array sorts after any string per IDB key ordering.
            const range = IDBKeyRange.bound([scope, owner], [scope, owner, []]);
            return awaitCursor(idx.openCursor(range));
        },
        async getRecordsByKey(scope, owner, key) {
            const store = await tx(STORES.RECORDS, 'readonly');
            const idx = store.index(RECORD_INDEXES.BY_SCOPE_OWNER_KEY);
            const range = IDBKeyRange.only([scope, owner, key]);
            return awaitCursor(idx.openCursor(range));
        },
        async getRecordsByCategory(scope, category) {
            const store = await tx(STORES.RECORDS, 'readonly');
            const idx = store.index(RECORD_INDEXES.BY_SCOPE_CATEGORY);
            const range = IDBKeyRange.only([scope, category]);
            return awaitCursor(idx.openCursor(range));
        },
        async getExpiredRecords(beforeTs) {
            const store = await tx(STORES.RECORDS, 'readonly');
            const idx = store.index(RECORD_INDEXES.BY_EXPIRES_AT);
            // Sparse index — null/undefined expires_at not enumerated. Range = [-inf, beforeTs).
            const range = IDBKeyRange.upperBound(beforeTs, true);
            return awaitCursor(idx.openCursor(range));
        },
        async addAudit(entry) {
            const store = await tx(STORES.AUDIT, 'readwrite');
            // Store has autoIncrement keyPath 'seq' — passing the entry without seq
            // assigns one. The request result is the assigned seq number.
            const seq = await awaitReq(store.add(entry));
            return /** @type {number} */ (seq);
        },
        async getAllAudit() {
            const store = await tx(STORES.AUDIT, 'readonly');
            return awaitCursor(store.openCursor());
        },
        async getAuditByRecord(recordId) {
            const store = await tx(STORES.AUDIT, 'readonly');
            const idx = store.index(AUDIT_INDEXES.BY_RECORD_ID);
            const range = IDBKeyRange.only(recordId);
            return awaitCursor(idx.openCursor(range));
        },
        async clearAll() {
            const records = await tx(STORES.RECORDS, 'readwrite');
            await awaitReq(records.clear());
            const audit = await tx(STORES.AUDIT, 'readwrite');
            await awaitReq(audit.clear());
        },
    };
}

/* -------------------------------------------------------------------------- */
/* Test seam                                                                  */
/* -------------------------------------------------------------------------- */

/** @type {MemoryIDBImpl|null} */
let _impl = null;

/** @returns {MemoryIDBImpl} */
function getImpl() {
    if (_impl === null) {
        _impl = createRealIDBImpl();
    }
    return _impl;
}

/**
 * Test seam — swap the IDB implementation. Production code must never
 * call this; only `tests/test-memory-*.mjs` does, and only at suite
 * setup. Mirrors `embeddings-client.js:_setLoaderForTests`.
 *
 * @param {MemoryIDBImpl} impl
 */
export function _setIDBImpl(impl) {
    _impl = impl;
}

/** Restore the real IDB implementation. Test-only. */
export function _resetIDBImpl() {
    _impl = null;
}

/* -------------------------------------------------------------------------- */
/* Public surface — operation helpers that route through the active impl     */
/* -------------------------------------------------------------------------- */

export const putRecord            = (record)               => getImpl().putRecord(record);
export const getRecord            = (id)                   => getImpl().getRecord(id);
export const deleteRecord         = (id)                   => getImpl().deleteRecord(id);
export const getAllRecords        = ()                     => getImpl().getAllRecords();
export const getRecordsByOwner    = (scope, owner)         => getImpl().getRecordsByOwner(scope, owner);
export const getRecordsByKey      = (scope, owner, key)    => getImpl().getRecordsByKey(scope, owner, key);
export const getRecordsByCategory = (scope, category)      => getImpl().getRecordsByCategory(scope, category);
export const getExpiredRecords    = (beforeTs)             => getImpl().getExpiredRecords(beforeTs);
export const addAudit             = (entry)                => getImpl().addAudit(entry);
export const getAllAudit          = ()                     => getImpl().getAllAudit();
export const getAuditByRecord     = (recordId)             => getImpl().getAuditByRecord(recordId);
export const clearAll             = ()                     => getImpl().clearAll();

/* -------------------------------------------------------------------------- */
/* Map-backed fake — for node:test                                            */
/* -------------------------------------------------------------------------- */

/**
 * In-memory IDB fake. Implements `MemoryIDBImpl` with `Map`-backed stores.
 * Exposes the same surface as the real impl so `store.js` and `audit.js`
 * can run under node:test without needing real IndexedDB.
 *
 * This fake does NOT model real IDB transaction semantics (no rollback, no
 * isolation between concurrent mutations). The `KeyMutex` in `utils.js`
 * provides the per-key serialization that the real-IDB indirection would
 * also enforce; the fake is correct *because* the mutex sits in front of it.
 *
 * Real-IDB transaction edge cases (auto-close on microtask exit, abort
 * cascades, version-change races) are exercised in the browser test suite
 * (PR #5+).
 *
 * @returns {MemoryIDBImpl & { _records: Map<string, any>, _audit: Map<number, any>, _nextSeq: number }}
 */
export function createMemoryFakeIDB() {
    /** @type {Map<string, any>} */
    const records = new Map();
    /** @type {Map<number, any>} */
    const audit = new Map();
    let nextSeq = 1;

    const fake = {
        _records: records,
        _audit: audit,
        get _nextSeq() { return nextSeq; },

        async putRecord(record) {
            // Structured-clone shallow — copy so callers can't mutate stored state.
            records.set(record.id, JSON.parse(JSON.stringify(record)));
        },
        async getRecord(id) {
            const r = records.get(id);
            return r ? JSON.parse(JSON.stringify(r)) : null;
        },
        async deleteRecord(id) {
            records.delete(id);
        },
        async getAllRecords() {
            return Array.from(records.values()).map((r) => JSON.parse(JSON.stringify(r)));
        },
        async getRecordsByOwner(scope, owner) {
            const out = [];
            for (const r of records.values()) {
                if (r.scope === scope && r.owner_id_or_workspace_id === owner) {
                    out.push(JSON.parse(JSON.stringify(r)));
                }
            }
            return out;
        },
        async getRecordsByKey(scope, owner, key) {
            const out = [];
            for (const r of records.values()) {
                if (r.scope === scope && r.owner_id_or_workspace_id === owner && r.key === key) {
                    out.push(JSON.parse(JSON.stringify(r)));
                }
            }
            return out;
        },
        async getRecordsByCategory(scope, category) {
            const out = [];
            for (const r of records.values()) {
                if (r.scope === scope && r.category === category) {
                    out.push(JSON.parse(JSON.stringify(r)));
                }
            }
            return out;
        },
        async getExpiredRecords(beforeTs) {
            const out = [];
            for (const r of records.values()) {
                if (typeof r.expires_at === 'number' && r.expires_at < beforeTs) {
                    out.push(JSON.parse(JSON.stringify(r)));
                }
            }
            return out;
        },
        async addAudit(entry) {
            const seq = nextSeq++;
            const stored = { ...entry, seq };
            audit.set(seq, JSON.parse(JSON.stringify(stored)));
            return seq;
        },
        async getAllAudit() {
            // Sorted by seq ascending.
            const seqs = Array.from(audit.keys()).sort((a, b) => a - b);
            return seqs.map((s) => JSON.parse(JSON.stringify(audit.get(s))));
        },
        async getAuditByRecord(recordId) {
            const seqs = Array.from(audit.keys()).sort((a, b) => a - b);
            const out = [];
            for (const s of seqs) {
                const e = audit.get(s);
                if (e && e.record_id === recordId) out.push(JSON.parse(JSON.stringify(e)));
            }
            return out;
        },
        async clearAll() {
            records.clear();
            audit.clear();
            nextSeq = 1;
        },
    };

    return fake;
}
