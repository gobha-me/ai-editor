// @ts-check
/**
 * Memory consent queue — in-memory pending-consent buffer for
 * `agent_proposed` `memory_remember` calls (Memory PR #6).
 *
 * **Why a queue, not an immediate write.** Before PR #6, `memory_remember`
 * with `source: 'agent_proposed'` wrote directly to the IDB store. The
 * consent UX (Touch 1 Flow 1, `docs/design/touch-1-memory-ux/project/
 * flow1-consent.jsx`) requires that the user explicitly Accept / Edit /
 * Dismiss a proposal before the record becomes durable. Three concerns
 * argued against the cheaper "write-immediately, revise/softDelete on
 * action" alternative:
 *
 *   1. **Tool-result honesty.** The model needs to know whether its write
 *      durably landed — returning `{action: 'created'}` when the user
 *      might dismiss is a lie the next `memory_recall` exposes. With the
 *      queue, agent-proposed calls return
 *      `{status: 'pending_consent', candidate_id}` so the model can
 *      decide whether to re-mention the fact.
 *
 *   2. **File-layer thrash.** `js/intelligence/memory/file-layer.js`
 *      regenerates `.aieditor/memory/<cat>.md` on every CREATED/UPDATED/
 *      DELETED. Write-then-delete per dismissed proposal = git noise with
 *      repo-mode on. The queue holds the candidate off the file layer
 *      entirely until Accept.
 *
 *   3. **Audit cleanliness.** Dismissed proposals never became state and
 *      shouldn't appear in `audit.listForRecord()` (which the Settings →
 *      Memory tab consumes). The queue drops dismissed candidates with no
 *      audit entry.
 *
 * **Lifetime.** The queue lives only as long as the page session — there
 * is no IDB persistence. A page reload drops pending proposals; a
 * `chat:cleared` event drops them too (the conversational context that
 * produced them is gone). `js/app.js` wires the latter; reload is intrinsic.
 *
 * **Threading.** Single-threaded by virtue of the JS event loop. The queue
 * is a plain `Map<candidate_id, MemoryCandidate>` with no mutex needed —
 * Accept/Dismiss for the same candidate id are a one-shot operation
 * (subsequent calls return a "candidate not found" error).
 *
 * @module intelligence/memory/consent-queue
 */

import { EventBus } from '../../core.js';
import { MEMORY_EVENTS } from './contracts.js';
import { create, supersede, getByKey } from './store.js';
import { canonicalizeKey } from './validation.js';
import { embedRecord } from './embeddings.js';
import { newRecordId, now } from './utils.js';

/**
 * @typedef {import('./contracts.js').MemoryCandidate} MemoryCandidate
 * @typedef {import('./contracts.js').MemoryRecord}    MemoryRecord
 */

/* -------------------------------------------------------------------------- */
/* Storage                                                                    */
/* -------------------------------------------------------------------------- */

/** @type {Map<string, MemoryCandidate>} */
const _queue = new Map();

/* -------------------------------------------------------------------------- */
/* Test seams                                                                 */
/* -------------------------------------------------------------------------- */

/** @type {{ embed: (text: string) => Promise<number[]|null>, isEnabled?: () => boolean } | null} */
let _embeddingsOverride = null;

/**
 * Override the embeddings client used by `accept()`. Tests pass a stub so
 * dismissed candidates skip the network call and accepted candidates can
 * assert the embed-input shape. Production code path uses the
 * `EmbeddingsClient` injected via `accept()`'s `opts.embeddings` argument.
 *
 * @param {{ embed: (text: string) => Promise<number[]|null> }|null} stub
 */
export function _setEmbeddingsClientForTests(stub) { _embeddingsOverride = stub; }

/** Drop all pending candidates and any test overrides. */
export function _resetForTests() {
    _queue.clear();
    _embeddingsOverride = null;
}

/* -------------------------------------------------------------------------- */
/* Public surface                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Push a candidate onto the queue and emit `memory:consent_requested`.
 *
 * The caller (typically `js/tools/memory-tools.js` `memory_remember`)
 * supplies the validated candidate fields. The queue assigns the
 * `candidate_id` and `created_at` here; everything else passes through
 * untouched. `key` is canonicalized defensively even though the tool layer
 * already canonicalizes — `accept()` operates on what the queue holds, so
 * the canonical form must be the stored form.
 *
 * @param {{
 *   scope:                    "user"|"workspace",
 *   owner_id_or_workspace_id: string,
 *   key:                      string,
 *   value:                    string|Object,
 *   category:                 string,
 *   actor:                    string,
 *   reason?:                  string,
 * }} input
 * @returns {{ candidate_id: string }}
 */
export function enqueue(input) {
    if (!input || typeof input !== 'object') {
        throw new Error('consentQueue.enqueue: input must be an object');
    }
    const candidate = /** @type {MemoryCandidate} */ ({
        candidate_id: newRecordId(),
        scope: input.scope,
        owner_id_or_workspace_id: input.owner_id_or_workspace_id,
        key: canonicalizeKey(input.key),
        value: input.value,
        category: input.category,
        actor: input.actor,
        reason: typeof input.reason === 'string' ? input.reason : '',
        created_at: now(),
    });
    _queue.set(candidate.candidate_id, candidate);
    EventBus.emit(MEMORY_EVENTS.CONSENT_REQUESTED, { candidate });
    return { candidate_id: candidate.candidate_id };
}

/**
 * Read a pending candidate without removing it. Returns `null` for
 * unknown ids (already accepted, already dismissed, or never enqueued).
 * The Preact consent card calls this once on mount to populate its
 * initial render.
 *
 * @param {string} candidate_id
 * @returns {MemoryCandidate|null}
 */
export function get(candidate_id) {
    return _queue.get(candidate_id) || null;
}

/**
 * Snapshot of every pending candidate. The snapshot is a fresh array; the
 * underlying Map is not exposed. `messages.js` calls this on
 * `renderMessages()` to re-mount cards for any candidate still pending
 * after a chat re-render.
 *
 * @returns {MemoryCandidate[]}
 */
export function list() {
    return Array.from(_queue.values());
}

/**
 * Drop every pending candidate without emitting `CONSENT_RESOLVED`.
 *
 * Wired to `EventBus.on('chat:cleared', clearAll)` in `js/app.js`: a "new
 * chat" means the conversational context that produced these proposals is
 * gone, so they shouldn't survive. The deliberate silence (no
 * `CONSENT_RESOLVED` emission) keeps observers from reacting to a queue
 * drain as if it were per-candidate dismissals.
 */
export function clearAll() {
    _queue.clear();
}

/**
 * Resolve a candidate to a real `MemoryRecord`. Routes through the same
 * `getByKey` → `create` / `supersede` branch the tool used pre-PR-#6, just
 * deferred to the moment the user clicks Accept (or Save edit).
 *
 * The candidate is dropped from the queue *before* the store call so a
 * caller that double-clicks Accept doesn't double-write. If the store call
 * throws after drop, the candidate is gone — the consent card surfaces the
 * error and the agent can re-propose. (Re-queueing on error would let a
 * persistent-store failure pin the queue forever.)
 *
 * `source` defaults to `'user_explicit'` per Touch 1 Flow 1 copy ("Stored
 * as `user_explicit` if you accept"). Passing a different `source` is
 * supported for non-UI callers but the consent card always uses the default.
 *
 * @param {string} candidate_id
 * @param {{
 *   value?:               string|Object,
 *   source?:              "user_explicit"|"agent_proposed"|"inferred",
 *   reason?:              string,
 *   actor?:               string,
 *   embeddings?:          { embed: (text: string) => Promise<number[]|null> },
 *   embedding_model_id?:  string,
 * }} [opts]
 * @returns {Promise<MemoryRecord>}
 */
export async function accept(candidate_id, opts) {
    const candidate = _queue.get(candidate_id);
    if (!candidate) {
        throw new Error(`consentQueue.accept: candidate ${candidate_id} not found (already resolved?)`);
    }
    _queue.delete(candidate_id);

    const o = opts || {};
    const value = o.value !== undefined ? o.value : candidate.value;
    const source = o.source || 'user_explicit';
    const actor = typeof o.actor === 'string' && o.actor.length > 0 ? o.actor : `user:consent`;
    const reason = typeof o.reason === 'string' ? o.reason : candidate.reason;
    const client = o.embeddings || _embeddingsOverride;
    const embedding_model_id = typeof o.embedding_model_id === 'string' ? o.embedding_model_id : '';

    /** @type {number[]|null} */
    let embedding = null;
    if (client && typeof client.embed === 'function') {
        try {
            embedding = await embedRecord(client, { key: candidate.key, value });
        } catch (e) {
            console.warn('[consent-queue] embedding failed:', /** @type {Error} */ (e)?.message || e);
            embedding = null;
        }
    }

    let record;
    const existing = await getByKey({
        scope: candidate.scope,
        owner_id_or_workspace_id: candidate.owner_id_or_workspace_id,
        key: candidate.key,
    });
    if (existing) {
        const result = await supersede(existing.id, {
            scope: candidate.scope,
            owner_id_or_workspace_id: candidate.owner_id_or_workspace_id,
            key: candidate.key,
            value,
            category: candidate.category,
            source,
            created_by: actor,
            actor,
            embedding,
            embedding_model_id,
        }, { reason });
        record = result.new;
    } else {
        record = await create({
            scope: candidate.scope,
            owner_id_or_workspace_id: candidate.owner_id_or_workspace_id,
            key: candidate.key,
            value,
            category: candidate.category,
            source,
            created_by: actor,
            actor,
            embedding,
            embedding_model_id,
        }, { reason });
    }

    EventBus.emit(MEMORY_EVENTS.CONSENT_RESOLVED, {
        candidate_id,
        outcome: 'accepted',
        record_id: record.id,
    });
    return record;
}

/**
 * Drop a pending candidate with no store write and no audit entry. Emits
 * `memory:consent_resolved` with `outcome: 'dismissed'`.
 *
 * `reason` is currently informational — there is no audit log for
 * dismissed proposals (see module preamble). Future consumers (e.g., a
 * "frequency dial" that adapts to dismissal patterns) may sample
 * dismissals via the event payload.
 *
 * @param {string} candidate_id
 * @param {{ reason?: string }} [opts]
 * @returns {void}
 */
export function dismiss(candidate_id, opts) {
    const candidate = _queue.get(candidate_id);
    if (!candidate) {
        // Idempotent: dismissing an already-resolved candidate is a no-op.
        return;
    }
    _queue.delete(candidate_id);
    EventBus.emit(MEMORY_EVENTS.CONSENT_RESOLVED, {
        candidate_id,
        outcome: 'dismissed',
        reason: opts?.reason ?? '',
    });
}
