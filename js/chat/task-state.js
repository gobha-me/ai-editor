// @ts-check
/**
 * Task state — per-conversation `TaskLedger` registry for the chat surface.
 *
 * Owns a `Map<conversationId, TaskLedger>`. The Composer reads this ledger
 * (additively, on top of the profile's static set) so a tool the model
 * discovered + invoked once stays admitted on subsequent turns. The
 * invocation hook in `js/chat/handlers.js` writes to it after every
 * successful tool call.
 *
 * **1.3.17 scope (PR 4 of 1.4.0 Tools Phase 1).** One ledger per
 * conversation; `taskId === conversationId`. ROADMAP §1.4.0 explicitly
 * defers auto-detected task boundaries to 2.0 ("explicit `/task` markers
 * in 1.4.0; auto-detection in 2.0"). Ledgers live only in memory — no
 * IDB, no persistence across reload — matching `task-ledger.js` lifecycle:
 * *"Ledgers do not survive session end by default."*
 *
 * Wiring:
 *   - `js/llm/api.js#_runComposer()` calls `getActiveLedger()` and threads
 *     it into `composeAdmission(...)` instead of `null`.
 *   - `js/chat/handlers.js` (post-`executeToolCall()`) calls
 *     `recordInvocation()` to log the call and (if not already admitted)
 *     auto-admit the tool with `source: 'discovery'`.
 *   - `js/chat/index.js` subscribes to `conversation:loaded` /
 *     `conversation:created` / `conversation:deleted` and calls
 *     `dropLedger()` to reclaim memory when a conversation is removed.
 *
 * Pure module, browser- and node-safe. No DOM, no Storage. Conversation IDs
 * are sourced from `ConversationManager.getActiveId()` at call-time by the
 * caller — this module does not import core/conversations to avoid a cycle
 * with `js/llm/api.js`.
 *
 * @module chat/task-state
 */

import { createTaskLedger } from '../profiles/task-ledger.js';

/**
 * @typedef {import('../profiles/task-ledger.js').TaskLedger} TaskLedger
 * @typedef {import('../profiles/task-ledger.js').ToolAdmissionRecord} ToolAdmissionRecord
 * @typedef {import('../profiles/task-ledger.js').ToolInvocationRecord} ToolInvocationRecord
 */

/** @type {Map<string, TaskLedger>} */
const _ledgers = new Map();

/**
 * Default profile capacity for chat conversations (mirrors
 * `coder-v1.js#task_ledger.capacity`). The chat surface uses one cap for
 * now; per-profile lookup arrives when the profile resolver wires up.
 */
const DEFAULT_CAPACITY = 500;

/**
 * Truncate a value to `args_summary`'s 200-char ledger budget.
 *
 * @param {unknown} args
 * @returns {string}
 */
function _summarizeArgs(args) {
    if (args == null) return '';
    let s;
    try {
        s = typeof args === 'string' ? args : JSON.stringify(args);
    } catch {
        s = String(args);
    }
    return s.length > 200 ? s.slice(0, 197) + '…' : s;
}

/**
 * Get or create the ledger for a given conversation. Idempotent — repeated
 * calls with the same id return the same instance, so callers can use this
 * as both lookup and lazy-init. Pass `null` / empty id to short-circuit
 * (returns `null`); the Composer treats a null ledger as "no sticky set."
 *
 * @param {string|null} conversationId
 * @param {string}      surface         Profile name, e.g. "coder.v1".
 * @param {Object}     [opts]
 * @param {number}     [opts.capacity]  Override default cap (tests).
 * @param {number}     [opts.now]       Override clock (tests).
 * @returns {TaskLedger|null}
 */
export function getOrCreateLedger(conversationId, surface, opts = {}) {
    if (typeof conversationId !== 'string' || conversationId.length === 0) {
        return null;
    }
    const existing = _ledgers.get(conversationId);
    if (existing) return existing;
    const ledger = createTaskLedger({
        taskId: conversationId,
        surface,
        capacity: typeof opts.capacity === 'number' ? opts.capacity : DEFAULT_CAPACITY,
        startedAt: typeof opts.now === 'number' ? opts.now : undefined,
    });
    _ledgers.set(conversationId, ledger);
    return ledger;
}

/**
 * Lookup without creation. Returns `null` if no ledger exists for the id.
 *
 * @param {string|null} conversationId
 * @returns {TaskLedger|null}
 */
export function getLedger(conversationId) {
    if (typeof conversationId !== 'string' || conversationId.length === 0) {
        return null;
    }
    return _ledgers.get(conversationId) || null;
}

/**
 * Drop a ledger (and its records). Called from `js/chat/index.js` when a
 * conversation is deleted; not called on conversation switch — switching
 * just leaves the prior ledger in place so going back to the conversation
 * preserves its sticky set.
 *
 * @param {string|null} conversationId
 * @returns {boolean}   True if a ledger was actually removed.
 */
export function dropLedger(conversationId) {
    if (typeof conversationId !== 'string' || conversationId.length === 0) {
        return false;
    }
    return _ledgers.delete(conversationId);
}

/**
 * Test seam — wipe the registry between tests. Not part of the public
 * surface; product code should not call this.
 */
export function _resetForTests() {
    _ledgers.clear();
}

/**
 * Record one successful tool invocation against the conversation's ledger
 * and, if the tool isn't in the static set or already-admitted, auto-admit
 * it with `source: 'discovery'`. The Composer will read these records on
 * the next turn and re-admit the tool with `source: 'sticky'`.
 *
 * Failed tool calls (`toolResult.error` truthy) are skipped — a tool that
 * blew up isn't evidence the model meant to use it; sticky admission of
 * broken tools clutters the budget.
 *
 * `staticNames` is passed in by the caller (already-known) rather than
 * resolved here, both to avoid importing `coder-v1` from this module
 * (cycle risk via `profiles/index.js`) and so the wiring stays explicit
 * about which profile's static set is in scope.
 *
 * @param {Object}            params
 * @param {string|null}       params.conversationId
 * @param {string}            params.toolName
 * @param {unknown}           params.args
 * @param {Object|null}       params.toolResult     ToolRegistry.execute return value.
 * @param {string|null}       params.turnId         Opaque turn id (timestamp ok in 1.3.17).
 * @param {string}            params.surface        Profile name (e.g. "coder.v1").
 * @param {string[]}          params.staticNames    Profile's static-set names.
 * @param {number}           [params.toolCost]      ToolDef.metadata.cost_estimate (admission cost).
 * @param {number}           [params.now]           Clock override for tests.
 * @returns {{ recorded: boolean, admitted: boolean }}
 */
export function recordInvocation({
    conversationId,
    toolName,
    args,
    toolResult,
    turnId,
    surface,
    staticNames,
    toolCost,
    now,
}) {
    if (typeof toolName !== 'string' || toolName.length === 0) {
        return { recorded: false, admitted: false };
    }
    if (toolResult && toolResult.error) {
        return { recorded: false, admitted: false };
    }
    const ledger = getOrCreateLedger(conversationId, surface, { now });
    if (!ledger) return { recorded: false, admitted: false };

    const t = typeof now === 'number' ? now : Date.now();

    /** @type {ToolInvocationRecord} */
    const inv = {
        tool_id: toolName,
        invoked_at: t,
        turn_id: typeof turnId === 'string' ? turnId : String(t),
        args_summary: _summarizeArgs(args),
        succeeded: true,
    };
    ledger.tool_invocations.push(inv);

    const isStatic = Array.isArray(staticNames) && staticNames.includes(toolName);
    let admitted = false;
    if (!isStatic) {
        const existing = ledger.tool_admissions.find(a => a.tool_id === toolName);
        if (existing) {
            existing.last_used_at = t;
        } else {
            /** @type {ToolAdmissionRecord} */
            const adm = {
                tool_id: toolName,
                admitted_at: t,
                form: 'full',
                source: 'discovery',
                cost: typeof toolCost === 'number' ? toolCost : 0,
                last_used_at: t,
            };
            ledger.tool_admissions.push(adm);
            admitted = true;
        }
    }

    return { recorded: true, admitted };
}
