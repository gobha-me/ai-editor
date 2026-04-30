// @ts-check
/**
 * Memory audit log — append-only. Every state-changing operation on a
 * `MemoryRecord` writes one entry; entries are never updated or deleted
 * in PR #2 (compliance/retention policy is post-1.3.0).
 *
 * Ordering is provided by the store's autoIncrement `seq` keyPath, so no
 * external mutex is needed for appends — IDB serializes overlapping
 * readwrite transactions on `memory_audit` automatically. The
 * `KeyMutex` in `utils.js` is for `memory_records`, not for `audit`.
 *
 * @module intelligence/memory/audit
 */

import { addAudit, getAllAudit, getAuditByRecord } from './idb-schema.js';
import { AUDIT_ACTIONS, MEMORY_LIMITS } from './contracts.js';
import { now } from './utils.js';

/**
 * Append one audit entry. Returns the assigned `seq`.
 *
 * Validation here is intentionally light — `store.js` calls into this
 * with already-validated record snapshots, and the audit log must accept
 * the entry even when the corresponding record is in an unusual state
 * (e.g., a softDelete with no `after`). Bad input throws synchronously
 * before any IDB write so callers get a clear error.
 *
 * @param {{
 *   actor:     string,
 *   action:    "create"|"update"|"supersede"|"softDelete"|"expire",
 *   record_id: string,
 *   before:    any|null,
 *   after:     any|null,
 *   reason:    string,
 *   ts?:       number,
 * }} entry
 * @returns {Promise<number>}  Assigned seq.
 */
export async function append(entry) {
    if (!entry || typeof entry !== 'object') {
        throw new Error('audit.append: entry must be an object');
    }
    if (typeof entry.record_id !== 'string' || entry.record_id.length === 0) {
        throw new Error('audit.append: record_id must be a non-empty string');
    }
    if (!AUDIT_ACTIONS.includes(entry.action)) {
        throw new Error(`audit.append: action must be one of ${AUDIT_ACTIONS.join('|')}; got ${JSON.stringify(entry.action)}`);
    }
    if (typeof entry.actor !== 'string') {
        throw new Error('audit.append: actor must be a string');
    }
    if (entry.actor.length > MEMORY_LIMITS.ACTOR_MAX_LENGTH) {
        throw new Error(`audit.append: actor must be ≤${MEMORY_LIMITS.ACTOR_MAX_LENGTH} chars`);
    }
    if (typeof entry.reason !== 'string') {
        throw new Error('audit.append: reason must be a string (use "" if no reason)');
    }
    if (entry.reason.length > MEMORY_LIMITS.REASON_MAX_LENGTH) {
        throw new Error(`audit.append: reason must be ≤${MEMORY_LIMITS.REASON_MAX_LENGTH} chars`);
    }

    const ts = typeof entry.ts === 'number' && Number.isFinite(entry.ts) ? entry.ts : now();

    return addAudit({
        ts,
        actor: entry.actor,
        action: entry.action,
        record_id: entry.record_id,
        before: entry.before ?? null,
        after: entry.after ?? null,
        reason: entry.reason,
    });
}

/**
 * List audit entries, optionally filtered. Returned in chronological
 * order (ascending by `seq`).
 *
 * @param {{ recordId?: string, sinceTs?: number, limit?: number }} [opts]
 * @returns {Promise<any[]>}
 */
export async function list(opts) {
    const { recordId, sinceTs, limit } = opts ?? {};
    const all = recordId ? await getAuditByRecord(recordId) : await getAllAudit();
    let filtered = all;
    if (typeof sinceTs === 'number' && Number.isFinite(sinceTs)) {
        filtered = filtered.filter((e) => e.ts >= sinceTs);
    }
    if (typeof limit === 'number' && Number.isFinite(limit) && limit >= 0) {
        filtered = filtered.slice(0, limit);
    }
    return filtered;
}

/**
 * Convenience for `list({ recordId })`. Surface kept narrow because most
 * UI use cases want "all entries for record X" with no other filtering.
 *
 * @param {string} recordId
 * @returns {Promise<any[]>}
 */
export async function listForRecord(recordId) {
    return getAuditByRecord(recordId);
}
