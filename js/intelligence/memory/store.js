// @ts-check
/**
 * Memory store — CRUD surface over the IDB-backed `memory_records` and
 * `memory_audit` stores. Every mutation is serialized by `KeyMutex` on
 * `(scope, owner_or_workspace_id, key)` so concurrent calls on the same
 * logical record interleave safely; mutations on different keys proceed
 * in parallel.
 *
 * What this layer does NOT do (deferred to later Memory PRs):
 *   - File-layer reconciliation (`.aieditor/memory/*.md`) → PR #3
 *   - LLM tools (`memory_remember` / `memory_recall` / `memory_revise`) → PR #4
 *   - Settings UI (Memory tab) → PR #5
 *   - Auto-embedding on write — caller passes a precomputed embedding (or
 *     null) via `create()`/`update()`. The store never calls into
 *     `EmbeddingsClient`. PR #4's `memory_remember` will queue the embed
 *     after the record is persisted.
 *   - Capacity enforcement — `MemoryConfig.capacity_warnings` is a UI
 *     concern (PR #5). The store accepts all writes; the UI surfaces the
 *     warning.
 *
 * @module intelligence/memory/store
 */

import { EventBus } from '../../core.js';
import {
    MEMORY_EVENTS,
    DELETED_SENTINEL,
} from './contracts.js';
import { assertValid, canonicalizeKey } from './validation.js';
import {
    KeyMutex,
    chainKey,
    newRecordId,
    now,
} from './utils.js';
import {
    putRecord,
    getRecord,
    getRecordsByOwner,
    getRecordsByKey,
    getRecordsByCategory,
    getExpiredRecords,
} from './idb-schema.js';
import { append as appendAudit } from './audit.js';

const _mutex = new KeyMutex();

/**
 * Default fields applied to records on `create()`. Callers override any of
 * these, but reasonable defaults keep boilerplate down.
 */
const RECORD_DEFAULTS = Object.freeze({
    embedding: null,
    embedding_model_id: '',
    superseded_by: null,
    expires_at: null,
    md_path: null,
});

/* -------------------------------------------------------------------------- */
/* Mutation surface                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Create a new memory record. Generates `id`, `created_at`, `updated_at`
 * automatically; canonicalizes `key`. The caller supplies the rest of the
 * record (scope, owner, value, category, source, actor, optional embedding,
 * optional expires_at, optional md_path).
 *
 * Emits `memory:created` on `EventBus` after a successful write.
 *
 * @param {{
 *   scope:                    "user"|"workspace",
 *   owner_id_or_workspace_id: string,
 *   key:                      string,
 *   value:                    string|Object|null,
 *   category:                 string,
 *   source:                   "user_explicit"|"agent_proposed"|"inferred",
 *   created_by:               string,
 *   actor:                    string,
 *   embedding?:               number[]|null,
 *   embedding_model_id?:      string,
 *   expires_at?:              number|null,
 *   md_path?:                 string|null,
 * }} input
 * @param {{ reason?: string }} [opts]
 * @returns {Promise<any>} The persisted record.
 */
export async function create(input, opts) {
    if (!input || typeof input !== 'object') {
        throw new Error('store.create: input must be an object');
    }

    const ts = now();
    const record = {
        ...RECORD_DEFAULTS,
        ...input,
        id: newRecordId(),
        key: canonicalizeKey(input.key),
        created_at: ts,
        updated_at: ts,
    };

    assertValid(record);

    const lock = chainKey(record.scope, record.owner_id_or_workspace_id, record.key);
    return _mutex.withLock(lock, async () => {
        await putRecord(record);
        await appendAudit({
            actor: record.actor,
            action: 'create',
            record_id: record.id,
            before: null,
            after: record,
            reason: opts?.reason ?? '',
        });
        EventBus.emit(MEMORY_EVENTS.CREATED, { record });
        return record;
    });
}

/**
 * Update an existing record in place. The identity-bearing fields
 * (`id`, `scope`, `owner_id_or_workspace_id`, `key`) cannot change — use
 * `supersede()` for those. Other fields including `value`, `category`,
 * `source`, `embedding`, `expires_at`, `md_path`, and `actor` may be
 * patched by passing them in `partial`.
 *
 * Emits `memory:updated` with `{before, after}` on success.
 *
 * @param {string} id
 * @param {Object} partial
 * @param {{ actor: string, reason?: string }} opts
 * @returns {Promise<any>} The new record state.
 */
export async function update(id, partial, opts) {
    if (typeof id !== 'string' || id.length === 0) {
        throw new Error('store.update: id must be a non-empty string');
    }
    if (!partial || typeof partial !== 'object') {
        throw new Error('store.update: partial must be an object');
    }
    if (!opts || typeof opts.actor !== 'string') {
        throw new Error('store.update: opts.actor must be a string');
    }

    // Identity guards — caller cannot rename a record by update.
    for (const forbidden of ['id', 'scope', 'owner_id_or_workspace_id', 'key', 'created_at', 'created_by']) {
        if (forbidden in partial) {
            throw new Error(`store.update: cannot change ${forbidden} via update; use supersede() if scope/owner/key must change`);
        }
    }

    // Snapshot before reading: we need the chain key to pick the lock.
    // Chicken-and-egg: we don't know scope/owner/key until we read. Read
    // outside the lock, then take the lock and re-read inside to commit.
    const initial = await getRecord(id);
    if (!initial) {
        throw new Error(`store.update: record ${id} not found`);
    }
    if (initial.superseded_by !== null) {
        throw new Error(`store.update: record ${id} is superseded or deleted (superseded_by=${initial.superseded_by}); update its successor`);
    }

    const lock = chainKey(initial.scope, initial.owner_id_or_workspace_id, initial.key);
    return _mutex.withLock(lock, async () => {
        const before = await getRecord(id);
        if (!before) {
            throw new Error(`store.update: record ${id} disappeared between snapshot and lock`);
        }
        if (before.superseded_by !== null) {
            throw new Error(`store.update: record ${id} was superseded under contention; retry against the new head`);
        }
        const after = {
            ...before,
            ...partial,
            id: before.id,
            scope: before.scope,
            owner_id_or_workspace_id: before.owner_id_or_workspace_id,
            key: before.key,
            created_at: before.created_at,
            created_by: before.created_by,
            actor: opts.actor,
            updated_at: now(),
        };

        assertValid(after);

        await putRecord(after);
        await appendAudit({
            actor: opts.actor,
            action: 'update',
            record_id: id,
            before,
            after,
            reason: opts.reason ?? '',
        });
        EventBus.emit(MEMORY_EVENTS.UPDATED, { before, after });
        return after;
    });
}

/**
 * Replace `oldId` with a new record. The old record's `superseded_by`
 * field is set to the new record's id; the new record is created via
 * the same path as `create()` (with `id`/`created_at`/`updated_at`
 * generated). Use this when the identity-bearing fields change OR when
 * a higher-priority source (e.g., `user_explicit`) overrides a lower one
 * for the same `(scope, owner, key)`.
 *
 * Emits `memory:updated` with `{before: old, after: new}`.
 *
 * @param {string} oldId
 * @param {Object} replacement  Same shape as `create()` input minus generated fields.
 * @param {{ reason?: string }} [opts]
 * @returns {Promise<{ old: any, new: any }>}
 */
export async function supersede(oldId, replacement, opts) {
    if (typeof oldId !== 'string' || oldId.length === 0) {
        throw new Error('store.supersede: oldId must be a non-empty string');
    }
    if (!replacement || typeof replacement !== 'object') {
        throw new Error('store.supersede: replacement must be an object');
    }

    const initial = await getRecord(oldId);
    if (!initial) {
        throw new Error(`store.supersede: record ${oldId} not found`);
    }
    if (initial.superseded_by !== null) {
        throw new Error(`store.supersede: record ${oldId} is already superseded or deleted`);
    }

    // Lock on the *new* record's chain key (which may differ from the old
    // when scope/owner/key changes). We also need to lock the old chain
    // when they differ to avoid a concurrent update racing the supersession.
    const oldLock = chainKey(initial.scope, initial.owner_id_or_workspace_id, initial.key);
    const newKey = canonicalizeKey(replacement.key ?? initial.key);
    const newScope = replacement.scope ?? initial.scope;
    const newOwner = replacement.owner_id_or_workspace_id ?? initial.owner_id_or_workspace_id;
    const newLock = chainKey(newScope, newOwner, newKey);

    // To prevent deadlock when both locks are needed, acquire in
    // lexicographic order. If they're identical, just lock once.
    const locks = oldLock === newLock ? [oldLock] : [oldLock, newLock].sort();

    return acquireMany(_mutex, locks, async () => {
        const before = await getRecord(oldId);
        if (!before) {
            throw new Error(`store.supersede: record ${oldId} disappeared`);
        }
        if (before.superseded_by !== null) {
            throw new Error(`store.supersede: record ${oldId} was superseded under contention`);
        }

        const ts = now();
        const newRecord = {
            ...RECORD_DEFAULTS,
            ...replacement,
            key: newKey,
            scope: newScope,
            owner_id_or_workspace_id: newOwner,
            id: newRecordId(),
            created_at: ts,
            updated_at: ts,
        };
        assertValid(newRecord);

        const updatedOld = { ...before, superseded_by: newRecord.id, updated_at: ts };

        await putRecord(newRecord);
        await putRecord(updatedOld);

        await appendAudit({
            actor: newRecord.actor,
            action: 'supersede',
            record_id: oldId,
            before,
            after: updatedOld,
            reason: opts?.reason ?? '',
        });
        await appendAudit({
            actor: newRecord.actor,
            action: 'create',
            record_id: newRecord.id,
            before: null,
            after: newRecord,
            reason: opts?.reason ? `supersedes:${oldId} ${opts.reason}` : `supersedes:${oldId}`,
        });

        EventBus.emit(MEMORY_EVENTS.UPDATED, { before, after: newRecord });
        return { old: updatedOld, new: newRecord };
    });
}

/**
 * Soft-delete a record by marking `superseded_by = DELETED_SENTINEL`. The
 * record stays in IDB (audit chain preserved) but is filtered out of all
 * default queries. Hard purge is a compliance concern, not in PR #2.
 *
 * Emits `memory:deleted` with `{recordId, before}`.
 *
 * @param {string} id
 * @param {{ actor: string, reason?: string }} opts
 * @returns {Promise<any>} The post-delete record state.
 */
export async function softDelete(id, opts) {
    if (typeof id !== 'string' || id.length === 0) {
        throw new Error('store.softDelete: id must be a non-empty string');
    }
    if (!opts || typeof opts.actor !== 'string') {
        throw new Error('store.softDelete: opts.actor must be a string');
    }

    const initial = await getRecord(id);
    if (!initial) {
        throw new Error(`store.softDelete: record ${id} not found`);
    }
    if (initial.superseded_by !== null) {
        throw new Error(`store.softDelete: record ${id} already superseded or deleted`);
    }

    const lock = chainKey(initial.scope, initial.owner_id_or_workspace_id, initial.key);
    return _mutex.withLock(lock, async () => {
        const before = await getRecord(id);
        if (!before || before.superseded_by !== null) {
            throw new Error(`store.softDelete: record ${id} state changed under contention`);
        }
        const after = { ...before, superseded_by: DELETED_SENTINEL, updated_at: now(), actor: opts.actor };
        await putRecord(after);
        await appendAudit({
            actor: opts.actor,
            action: 'softDelete',
            record_id: id,
            before,
            after,
            reason: opts.reason ?? '',
        });
        EventBus.emit(MEMORY_EVENTS.DELETED, { recordId: id, before });
        return after;
    });
}

/**
 * Soft-delete every record whose `expires_at` is in the past. Emits one
 * `memory:deleted` per expired record. Background-task callers (the
 * future scheduler in 1.3.x) own when to invoke this.
 *
 * @param {number} [beforeTs] Defaults to `now()`.
 * @returns {Promise<number>} Count of records expired.
 */
export async function purgeExpired(beforeTs) {
    const cutoff = typeof beforeTs === 'number' && Number.isFinite(beforeTs) ? beforeTs : now();
    const candidates = await getExpiredRecords(cutoff);
    let count = 0;
    for (const cand of candidates) {
        if (cand.superseded_by !== null) continue; // already deleted/superseded
        const lock = chainKey(cand.scope, cand.owner_id_or_workspace_id, cand.key);
        await _mutex.withLock(lock, async () => {
            const fresh = await getRecord(cand.id);
            if (!fresh || fresh.superseded_by !== null) return;
            const after = { ...fresh, superseded_by: DELETED_SENTINEL, updated_at: now(), actor: 'system:expire' };
            await putRecord(after);
            await appendAudit({
                actor: 'system:expire',
                action: 'expire',
                record_id: fresh.id,
                before: fresh,
                after,
                reason: `expires_at=${fresh.expires_at} cutoff=${cutoff}`,
            });
            EventBus.emit(MEMORY_EVENTS.DELETED, { recordId: fresh.id, before: fresh });
            count++;
        });
    }
    return count;
}

/* -------------------------------------------------------------------------- */
/* Query surface                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Get a record by primary id. Does NOT walk the supersession chain — the
 * raw record is returned even if superseded or deleted, so audit-trail
 * callers can inspect any historical state.
 *
 * @param {string} id
 * @returns {Promise<any|null>}
 */
export async function getById(id) {
    return getRecord(id);
}

/**
 * Get the active head record for a `(scope, owner, key)` tuple. Walks
 * the supersession chain. Returns `null` when no active record exists
 * (every record in the chain is superseded or deleted).
 *
 * @param {{ scope: string, owner_id_or_workspace_id: string, key: string }} q
 * @returns {Promise<any|null>}
 */
export async function getByKey(q) {
    if (!q) throw new Error('store.getByKey: query is required');
    const key = canonicalizeKey(q.key);
    const matches = await getRecordsByKey(q.scope, q.owner_id_or_workspace_id, key);
    if (matches.length === 0) return null;
    // The head is the record with superseded_by === null. Multiple records
    // can share the same (scope, owner, key) if a chain exists; only one
    // is ever the active head. Pick the one with the most recent updated_at
    // to be defensive against split-brain across tabs (last-writer-wins).
    const heads = matches.filter((r) => r.superseded_by === null);
    if (heads.length === 0) return null;
    heads.sort((a, b) => b.updated_at - a.updated_at);
    return heads[0];
}

/**
 * List records matching a scope + owner. Optional `category` filter.
 * Default behavior excludes superseded/deleted/expired records;
 * `includeSuperseded`/`includeExpired` flip those filters off.
 *
 * @param {{
 *   scope: string,
 *   owner_id_or_workspace_id: string,
 *   category?: string,
 *   includeSuperseded?: boolean,
 *   includeExpired?: boolean,
 *   limit?: number,
 *   offset?: number,
 * }} opts
 * @returns {Promise<any[]>}
 */
export async function list(opts) {
    if (!opts) throw new Error('store.list: opts.scope and owner are required');
    const all = opts.category
        ? (await getRecordsByCategory(opts.scope, opts.category)).filter((r) => r.owner_id_or_workspace_id === opts.owner_id_or_workspace_id)
        : await getRecordsByOwner(opts.scope, opts.owner_id_or_workspace_id);

    const ts = now();
    let out = all;
    if (!opts.includeSuperseded) {
        out = out.filter((r) => r.superseded_by === null);
    }
    if (!opts.includeExpired) {
        out = out.filter((r) => r.expires_at === null || r.expires_at === undefined || r.expires_at > ts);
    }
    out.sort((a, b) => b.updated_at - a.updated_at);
    const offset = typeof opts.offset === 'number' ? Math.max(0, opts.offset) : 0;
    const limit = typeof opts.limit === 'number' ? Math.max(0, opts.limit) : Infinity;
    return out.slice(offset, offset + limit);
}

/**
 * Semantic search via cosine similarity. Caller computes the query
 * embedding (typically via `EmbeddingsClient.embed()`); the store
 * filters to active records of the requested scope/owner with non-null
 * embeddings, computes similarities, and returns the top-K.
 *
 * Records with `embedding === null` are skipped — those are records
 * pending embedding (write-then-embed flow in PR #4) or whose embedder
 * was offline at write time. Exact-key lookup via `getByKey()` still
 * sees them.
 *
 * @param {{
 *   scope: string,
 *   owner_id_or_workspace_id: string,
 *   queryEmbedding: number[],
 *   topK?: number,
 *   category?: string,
 * }} q
 * @returns {Promise<Array<{ record: any, similarity: number }>>}
 */
export async function searchSemantic(q) {
    if (!q || !Array.isArray(q.queryEmbedding) || q.queryEmbedding.length === 0) {
        throw new Error('store.searchSemantic: queryEmbedding must be a non-empty number[]');
    }
    const candidates = await list({
        scope: q.scope,
        owner_id_or_workspace_id: q.owner_id_or_workspace_id,
        category: q.category,
    });
    const topK = typeof q.topK === 'number' && q.topK > 0 ? q.topK : 10;
    const queryVec = q.queryEmbedding;

    const scored = [];
    for (const rec of candidates) {
        if (!Array.isArray(rec.embedding) || rec.embedding.length === 0) continue;
        const sim = cosineSimilarity(queryVec, rec.embedding);
        scored.push({ record: rec, similarity: sim });
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Cosine similarity between two equal-length number arrays. Local
 * implementation (instead of importing `EmbeddingsClient.cosineSimilarity`)
 * because the store should run under node:test without pulling the
 * embeddings client's whole module-eval-time setup. Numerically identical.
 */
function cosineSimilarity(a, b) {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < a.length; i++) {
        const x = a[i];
        const y = b[i];
        dot += x * y;
        magA += x * x;
        magB += y * y;
    }
    if (magA === 0 || magB === 0) return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Acquire a list of mutex keys in order, run `fn`, release in reverse.
 * Used by `supersede()` when the old and new chain keys differ.
 *
 * @template T
 * @param {KeyMutex} mutex
 * @param {string[]} keys
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function acquireMany(mutex, keys, fn) {
    if (keys.length === 0) return fn();
    if (keys.length === 1) return mutex.withLock(keys[0], fn);
    // Nest: outer locks before inner. With keys sorted lexicographically by
    // the caller, deadlock between two callers wanting the same pair is
    // avoided.
    const [head, ...rest] = keys;
    return mutex.withLock(head, () => acquireMany(mutex, rest, fn));
}

/**
 * Test seam — reset the mutex's internal state. Production code should
 * never call this. Used by `tests/test-memory-races.mjs` for isolation.
 */
export function _resetMutexForTests() {
    _mutex._resetForTests();
}
