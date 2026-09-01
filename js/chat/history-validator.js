/**
 * Request-shape validator (1.6.2 PR 2 of 1.6.0 chat-stability).
 *
 * Asserts the no-orphan-tool invariant at the LLM boundary: every
 * `role: 'tool'` message must follow an `assistant` message whose
 * `tool_calls[]` contains a matching `id`. Strict providers reject the
 * request with `"messages with role 'tool' must follow a preceding
 * message with 'tool_calls'"` otherwise.
 *
 * 1.6.0 (truncation marker + pinned framing) and 1.6.1 (boundary-aware
 * prune) close the two known producers of orphan tool messages. This
 * validator is defense-in-depth: catches any future regression in
 * context construction by dropping orphans and warning, rather than
 * 400-ing the provider.
 *
 * Invalid history entries are dropped with a visible warning so malformed
 * local state cannot make the provider reject the entire request.
 */

/**
 * Walk `messages` left-to-right; drop any `role: 'tool'` message whose
 * `tool_call_id` does not match an id on the most recent preceding
 * `assistant.tool_calls[]`. Each new assistant turn closes the prior
 * pending-id set — once a new assistant arrives, any unanswered prior
 * ids are stale and a `tool` carrying one is orphan.
 *
 * @param {Array<object>} messages
 * @returns {{ messages: Array<object>, droppedCount: number, droppedIds: Array<string> }}
 *   On no drops, `messages` is the same array reference (no copy).
 */
export function validateAndCleanHistory(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return { messages, droppedCount: 0, droppedIds: [] };
    }

    let pendingIds = new Set();
    const dropIndexes = [];
    const droppedIds = [];

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg || typeof msg !== 'object') continue;

        if (msg.role === 'assistant') {
            // A new assistant turn closes the prior pending-id set.
            // The current turn's tool_calls (if any) become the new set.
            pendingIds = new Set();
            if (Array.isArray(msg.tool_calls)) {
                for (const tc of msg.tool_calls) {
                    if (tc && typeof tc.id === 'string' && tc.id) {
                        pendingIds.add(tc.id);
                    }
                }
            }
        } else if (msg.role === 'tool') {
            const tcid = msg.tool_call_id;
            if (typeof tcid !== 'string' || !tcid || !pendingIds.has(tcid)) {
                dropIndexes.push(i);
                droppedIds.push(tcid || '<missing>');
            }
        }
    }

    if (dropIndexes.length === 0) {
        return { messages, droppedCount: 0, droppedIds: [] };
    }

    const dropSet = new Set(dropIndexes);
    const cleaned = messages.filter((_, i) => !dropSet.has(i));
    console.warn(
        `[history-validator] Dropped ${dropIndexes.length} orphan tool message(s) ` +
        `with no preceding assistant.tool_calls match: [${droppedIds.join(', ')}]`
    );
    return { messages: cleaned, droppedCount: dropIndexes.length, droppedIds };
}
