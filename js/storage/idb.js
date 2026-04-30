/**
 * AI Editor — IndexedDB Wrapper
 *
 * Low-level async key-value store backed by IndexedDB.
 * Used by Storage in core.js as the primary persistence backend.
 *
 * Object stores:
 *   - `kv` (v1)              — generic JSON-serializable kv store used by Storage.
 *   - `memory_records` (v2)  — Memory subsystem records (1.3.0). Owned by `js/intelligence/memory/`.
 *   - `memory_audit` (v2)    — Memory subsystem audit log. Append-only, autoIncrement seq.
 *
 * Keys in `kv` are stored WITHOUT the 'ai-editor-' prefix — the prefix is a
 * localStorage artifact and doesn't belong in IDB's own namespace. The two
 * memory stores use their own keyPaths (`id` for records, autoIncrement
 * `seq` for audit), so prefix conventions don't apply.
 *
 * @since 0.9.11 (v1: kv store)
 * @since 1.3.0  (v2: memory_records + memory_audit)
 */

const IDB = {
    /** @type {IDBDatabase|null} */
    _db: null,

    DB_NAME: 'ai-editor',
    DB_VERSION: 2,
    STORE_NAME: 'kv',

    // Memory subsystem stores (v2). Names are also re-exported by
    // `js/intelligence/memory/idb-schema.js` so the memory module never
    // hardcodes them at multiple sites.
    MEMORY_RECORDS_STORE: 'memory_records',
    MEMORY_AUDIT_STORE: 'memory_audit',

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

                // v1: kv store. Created on fresh install or upgrade from v0.
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    db.createObjectStore(this.STORE_NAME);
                }

                // v2: Memory subsystem stores. Additive — kv data preserved.
                if (!db.objectStoreNames.contains(this.MEMORY_RECORDS_STORE)) {
                    const records = db.createObjectStore(this.MEMORY_RECORDS_STORE, { keyPath: 'id' });
                    // Compound lookup: scope+owner+key resolves a record (or supersession chain) directly.
                    records.createIndex('by_scope_owner_key', ['scope', 'owner_id_or_workspace_id', 'key'], { unique: false });
                    records.createIndex('by_scope_category', ['scope', 'category'], { unique: false });
                    records.createIndex('by_superseded_by', 'superseded_by', { unique: false });
                    records.createIndex('by_expires_at', 'expires_at', { unique: false });
                }

                if (!db.objectStoreNames.contains(this.MEMORY_AUDIT_STORE)) {
                    const audit = db.createObjectStore(this.MEMORY_AUDIT_STORE, { keyPath: 'seq', autoIncrement: true });
                    audit.createIndex('by_record_id', 'record_id', { unique: false });
                    audit.createIndex('by_ts', 'ts', { unique: false });
                }
            };

            req.onsuccess = (e) => {
                this._db = e.target.result;

                // Cross-tab upgrade coordination. When ANOTHER tab opens
                // this database at a higher version, the browser fires
                // `versionchange` on this connection. If we don't close
                // here, the other tab's upgrade hangs in `onblocked`
                // indefinitely — the failure mode that surfaced during
                // the v1→v2 deploy: old tabs held v1 connections and
                // new tabs couldn't upgrade. Without this handler, users
                // in browsers without a visible dev console see "the UI
                // is broken" with no way to diagnose.
                this._db.onversionchange = () => {
                    console.warn('[IDB] Another tab requested a database upgrade — closing this connection. Reload to use the new version.');
                    try { this._db.close(); } catch {}
                    this._db = null;
                    // Surface a user-visible toast on the OLD tab so the
                    // user knows to reload. window.showToast is wired
                    // during boot (js/app.js); fall back to a deferred
                    // alert if it isn't available yet.
                    try {
                        if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
                            window.showToast('A newer version of the editor is open in another tab. Reload this tab to use it.', 'warning');
                        }
                    } catch {}
                };

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
                // The other tab(s) hold an older version connection and
                // ignored `versionchange` (typically: pre-fix code from
                // a previous deploy). We can't proceed until they close.
                // Surface a *visible* warning — locked-down browsers
                // (managed Edge, Chromebook kiosk) hide the console, so
                // a console.warn alone leaves users with a silently
                // broken UI. Try toast first; fall back to alert.
                console.warn('[IDB] Database upgrade BLOCKED — another tab has an older version of the editor open. Close other tabs and reload.');
                try {
                    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
                        window.showToast('Database upgrade blocked — close other editor tabs and reload.', 'warning');
                        return;
                    }
                } catch {}
                // Toast not available (boot hasn't completed). Defer the
                // alert past the current microtask so it doesn't fire
                // before the page renders.
                try {
                    setTimeout(() => {
                        try {
                            alert('AI Editor: database upgrade is blocked because another tab has an older version open. Close other tabs of this editor and reload.');
                        } catch {}
                    }, 0);
                } catch {}
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
