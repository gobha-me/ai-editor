// @ts-check
/**
 * Memory utilities — clock seam, id generation, and the per-key mutex
 * that serializes concurrent mutations on the same logical record.
 *
 * The mutex is the load-bearing race-safety mechanism. Issue #188
 * showed that fire-and-forget IDB writes race when two mutations touch
 * the same logical key. IDB serializes overlapping readwrite transactions
 * on the same store, but each transaction reads its own snapshot — so two
 * concurrent `update(id)` calls land in two transactions, both read the
 * same `before` state, and both write a divergent `after`. The audit log
 * loses the intermediate state. `KeyMutex` makes the read-modify-write
 * sequence atomic *per key*, with different keys still proceeding in
 * parallel.
 *
 * Cross-tab races are not addressed here — `KeyMutex` is in-process. Two
 * tabs mutating the same `(scope, owner, key)` race; last writer wins; both
 * audit entries persist. BroadcastChannel coordination is post-PR #2.
 *
 * @module intelligence/memory/utils
 */

/**
 * Compose the mutex key for a logical record. Records that supersede each
 * other share a chain key, so create-then-supersede on the same `key`
 * serializes through one lock.
 *
 * @param {string} scope
 * @param {string} ownerOrWorkspaceId
 * @param {string} key
 * @returns {string}
 */
export function chainKey(scope, ownerOrWorkspaceId, key) {
    return `${scope}::${ownerOrWorkspaceId}::${key}`;
}

/**
 * Per-key mutex. Each `withLock(key, fn)` call is queued behind any prior
 * call for the same key; different keys proceed concurrently. `fn` is
 * awaited inside the locked region; the lock is released on resolve OR
 * reject so a thrown caller doesn't deadlock the queue.
 */
export class KeyMutex {
    constructor() {
        /** @type {Map<string, Promise<unknown>>} */
        this._chains = new Map();
    }

    /**
     * Run `fn()` with exclusive access to `key`. The returned promise
     * resolves to `fn`'s return value (or rejects with its error).
     *
     * @template T
     * @param {string} key
     * @param {() => T | Promise<T>} fn
     * @returns {Promise<T>}
     */
    async withLock(key, fn) {
        const prior = this._chains.get(key) ?? Promise.resolve();
        // Build the next link in the chain. We always proceed (even if
        // the prior link rejected) so a single failure doesn't stall the
        // queue — `await prior.catch(() => {})` swallows for sequencing
        // only; the real result still propagates via `result`.
        const next = (async () => {
            await prior.catch(() => {});
            return fn();
        })();

        // Track the *settled* version so subsequent waiters don't
        // accidentally observe a failed promise as pending.
        const tracking = next.then(() => undefined, () => undefined);
        this._chains.set(key, tracking);

        try {
            return await next;
        } finally {
            // Pop the chain entry only if we're still the tail. If a later
            // caller queued behind us, leave their tracking promise in place.
            if (this._chains.get(key) === tracking) {
                this._chains.delete(key);
            }
        }
    }

    /**
     * Test seam — drop all queued chains. Production code should never
     * call this; it's only for unit-test isolation.
     */
    _resetForTests() {
        this._chains.clear();
    }
}

/**
 * Clock seam. Tests can monkey-patch this export; production reads
 * `Date.now()`.
 *
 * @returns {number}
 */
export function now() {
    return Date.now();
}

/**
 * UUID generator. Uses the platform-native `crypto.randomUUID()` when
 * available (browser + Node ≥18); falls back to a v4-shaped string for
 * test environments without it (the shim's `crypto` may be absent).
 *
 * @returns {string}
 */
export function newRecordId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    // RFC 4122 v4 fallback. Math.random is fine for test fixtures; the
    // production path always hits crypto.randomUUID.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}
