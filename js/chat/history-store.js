/**
 * ChatHistoryStore — single owner of `State.chatHistory` mutations + persistence.
 *
 * Every mutation routed through this module persists `State.chatHistory` to
 * `Storage` exactly once. Pre-1.11.0, fourteen call sites across five files
 * each independently called `Storage.set('chatHistory', ...)` after mutating;
 * three issue #16 patches in a row had to walk every site to change
 * persistence policy, and missing one (1.5.9 #16; 1.6.5 had to revisit) kept
 * the bug alive. Until one module owns the writes, the next persistence-policy
 * change pays the same 5-file walk and one site gets missed again.
 *
 * All methods mutate `State.chatHistory` in place to preserve any reference
 * the consumer code holds — `Array.length = 0` + `push(...arr)` rather than
 * `State.chatHistory = newArr` — so virtualizers, renderers, and metadata
 * probes that captured the array stay pointed at the same object.
 */

import { State, Storage } from '../core.js';

function _persist() {
    Storage.set('chatHistory', State.chatHistory);
}

export const ChatHistoryStore = {
    /**
     * Push a single message and persist.
     * @param {object} msg
     */
    append(msg) {
        State.chatHistory.push(msg);
        _persist();
    },

    /**
     * Splice messages out of the in-memory array and persist.
     * Mirrors `Array.prototype.splice` semantics for the args used by
     * existing callers (start with optional deleteCount; insertions not
     * exposed — the prune path is the only caller that inserts on undo,
     * and that uses `replace`).
     * @param {number} start
     * @param {number} [deleteCount]
     * @returns {Array} removed slice (matches Array.splice return)
     */
    splice(start, deleteCount) {
        const removed = (deleteCount === undefined)
            ? State.chatHistory.splice(start)
            : State.chatHistory.splice(start, deleteCount);
        _persist();
        return removed;
    },

    /**
     * Truncate to a target length. Used by the error-rollback path when a
     * tool-loop request fails mid-flight and the snapshot length needs to
     * be restored.
     * @param {number} n
     */
    setLength(n) {
        State.chatHistory.length = n;
        _persist();
    },

    /**
     * Replace the array contents with `arr` and persist. In-place so
     * existing references stay valid.
     * @param {Array} arr
     */
    replace(arr) {
        State.chatHistory.length = 0;
        if (Array.isArray(arr) && arr.length > 0) {
            State.chatHistory.push(...arr);
        }
        _persist();
    },

    /**
     * Reset to empty + persist.
     */
    clear() {
        State.chatHistory.length = 0;
        _persist();
    },
};
