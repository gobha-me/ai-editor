/**
 * AI Editor — IndexedDB Wrapper
 * 
 * Low-level async key-value store backed by IndexedDB.
 * Used by Storage in core.js as the primary persistence backend.
 * 
 * Single object store ('kv') with string keys and JSON-serializable values.
 * Keys are stored WITHOUT the 'ai-editor-' prefix — the prefix is a
 * localStorage artifact and doesn't belong in IDB's own namespace.
 * 
 * @since 0.9.11
 */

const IDB = {
    /** @type {IDBDatabase|null} */
    _db: null,

    DB_NAME: 'ai-editor',
    DB_VERSION: 1,
    STORE_NAME: 'kv',

    /**
     * Open (or create) the database. Idempotent — returns cached handle.
     * @returns {Promise<IDBDatabase>}
     */
    async open() {
        if (this._db) return this._db;

        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);

            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    db.createObjectStore(this.STORE_NAME);
                }
            };

            req.onsuccess = (e) => {
                this._db = e.target.result;

                // Handle unexpected close (browser cleanup, quota revoked)
                this._db.onclose = () => {
                    console.warn('[IDB] Database connection closed unexpectedly');
                    this._db = null;
                };

                resolve(this._db);
            };

            req.onerror = (e) => {
                reject(new Error(`IndexedDB open failed: ${e.target.error?.message || 'unknown'}`));
            };

            req.onblocked = () => {
                console.warn('[IDB] Database open blocked — close other tabs');
            };
        });
    },

    /**
     * Get a value by key.
     * @param {string} key
     * @returns {Promise<*>} Resolved value or undefined if not found
     */
    async get(key) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readonly');
            const req = tx.objectStore(this.STORE_NAME).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    },

    /**
     * Store a value. Overwrites existing.
     * @param {string} key
     * @param {*} value — Must be structured-cloneable (no functions, DOM nodes)
     * @returns {Promise<void>}
     */
    async set(key, value) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readwrite');
            const req = tx.objectStore(this.STORE_NAME).put(value, key);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    },

    /**
     * Delete a key.
     * @param {string} key
     * @returns {Promise<void>}
     */
    async remove(key) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readwrite');
            const req = tx.objectStore(this.STORE_NAME).delete(key);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    },

    /**
     * List all keys, optionally filtered by prefix.
     * @param {string} [prefix='']
     * @returns {Promise<string[]>}
     */
    async keys(prefix = '') {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readonly');
            const store = tx.objectStore(this.STORE_NAME);
            const allKeys = [];

            // Use IDBKeyRange when prefix is provided for efficiency
            let req;
            if (prefix) {
                // Keys starting with prefix up to prefix + max char
                const range = IDBKeyRange.bound(prefix, prefix + '\uffff', false, false);
                req = store.openKeyCursor(range);
            } else {
                req = store.openKeyCursor();
            }

            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    allKeys.push(cursor.key);
                    cursor.continue();
                } else {
                    resolve(allKeys);
                }
            };
            req.onerror = () => reject(req.error);
        });
    },

    /**
     * Load every key-value pair. Used for cache hydration on startup.
     * @returns {Promise<Map<string, *>>}
     */
    async getAll() {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readonly');
            const store = tx.objectStore(this.STORE_NAME);
            const map = new Map();

            const req = store.openCursor();
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    map.set(cursor.key, cursor.value);
                    cursor.continue();
                } else {
                    resolve(map);
                }
            };
            req.onerror = () => reject(req.error);
        });
    },

    /**
     * Bulk-write multiple key-value pairs in a single transaction.
     * Used during migration from localStorage.
     * @param {Array<[string, *]>} entries — Array of [key, value] pairs
     * @returns {Promise<number>} Number of entries written
     */
    async setMany(entries) {
        if (!entries.length) return 0;

        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            let written = 0;

            for (const [key, value] of entries) {
                const req = store.put(value, key);
                req.onsuccess = () => written++;
                req.onerror = () => {
                    console.warn(`[IDB] Failed to write key "${key}":`, req.error);
                };
            }

            tx.oncomplete = () => resolve(written);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(new Error(`IDB batch write aborted: ${tx.error?.message || 'unknown'}`));
        });
    },

    /**
     * Delete all data. Use with caution.
     * @returns {Promise<void>}
     */
    async clear() {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readwrite');
            const req = tx.objectStore(this.STORE_NAME).clear();
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    },

    /**
     * Estimate IDB storage usage via the Storage API.
     * @returns {Promise<{usage: number, quota: number}|null>}
     */
    async estimate() {
        if (navigator.storage && navigator.storage.estimate) {
            try {
                const est = await navigator.storage.estimate();
                return { usage: est.usage || 0, quota: est.quota || 0 };
            } catch {
                return null;
            }
        }
        return null;
    },

    /**
     * Close the database connection. Primarily for testing.
     */
    close() {
        if (this._db) {
            this._db.close();
            this._db = null;
        }
    }
};

export { IDB };
