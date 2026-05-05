// @ts-check
/**
 * Minimal LRU cache backed by `Map` insertion order.
 *
 * Map iteration order is insertion order in every supported runtime, so
 * `delete + set` on a hit promotes the entry to the most-recently-used
 * position. When the cache exceeds `capacity`, the oldest entry (the
 * first key returned by `keys().next()`) is evicted. Reads return
 * `undefined` on miss — the caller is expected to distinguish "miss"
 * from "stored a falsy value" via the wrapper if needed.
 *
 * Pure data, sync, no I/O. Used by the retrieval manager to short-
 * circuit `findRelevantFiles()` repeats and by the structural strategy
 * to memoize ancestor walks. Both call sites bump an external
 * fingerprint to invalidate the whole cache rather than per-key
 * invalidation — keeps this module trivial.
 *
 * @template V
 */
export class LRU {
    /**
     * @param {number} capacity
     */
    constructor(capacity) {
        if (!Number.isFinite(capacity) || capacity <= 0) {
            throw new TypeError('LRU: capacity must be a positive number');
        }
        this._capacity = Math.floor(capacity);
        /** @type {Map<string, V>} */
        this._map = new Map();
    }

    /**
     * @param {string} key
     * @returns {V|undefined}
     */
    get(key) {
        if (!this._map.has(key)) return undefined;
        const value = /** @type {V} */ (this._map.get(key));
        this._map.delete(key);
        this._map.set(key, value);
        return value;
    }

    /**
     * @param {string} key
     * @param {V} value
     */
    set(key, value) {
        if (this._map.has(key)) {
            this._map.delete(key);
        } else if (this._map.size >= this._capacity) {
            const oldest = this._map.keys().next().value;
            if (oldest !== undefined) this._map.delete(oldest);
        }
        this._map.set(key, value);
    }

    /**
     * @param {string} key
     * @returns {boolean}
     */
    has(key) {
        return this._map.has(key);
    }

    clear() {
        this._map.clear();
    }

    get size() {
        return this._map.size;
    }
}
