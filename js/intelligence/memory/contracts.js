// @ts-check
/**
 * Memory contracts — the typedef surface for the curated-atomic-facts
 * subsystem landed in 1.3.0. Phase 1 ships the storage backbone (this PR);
 * subsequent PRs add the file layer, LLM tools, and UI.
 *
 * Sources:
 *   - `docs/DESIGN-memory.md` §"Data Model (Abstract)"
 *   - `docs/DESIGN-memory.md` §"Memory Lifecycle"
 *   - 1.3.0 kickoff decisions (memory file `project_design_engagement.md`,
 *     resolved 2026-04-30; DESIGN-memory.md updates with PR #8). The
 *     two kickoff decisions that shape these typedefs:
 *       1. `persona` scope dropped from 1.3.0 — `MemoryScope` is `user|workspace`.
 *       2. `confidence: float` dropped — `MemorySource` enum drives UI affordance.
 *
 * Why JSDoc and not real TS: project constraint
 * (`docs/ARCHITECTURE.md` §"Design Constraints") — no build step, no
 * transpiler. Type safety comes via `jsconfig.json` `checkJs: true`.
 *
 * @module intelligence/memory/contracts
 */

/**
 * Logical scope for a memory record. Phase 1 ships `user` + `workspace`
 * only. `persona` is deferred indefinitely (kickoff 2026-04-30); revisit
 * only if `user`-scoped memories cluster around persona-shaped patterns.
 *
 * @typedef {"user"|"workspace"} MemoryScope
 */

/**
 * Curation category. Free-form within the enum — UI groups records by
 * category in the Memory tab (PR #5). Empty/unknown values fail validation.
 *
 * @typedef {"preferences"|"decisions"|"project_context"|"domain_knowledge"|"workflow"} MemoryCategory
 */

/**
 * Provenance of a record. Replaces the original `confidence: float` field
 * (kickoff 2026-04-30). UI affordances ("this might be wrong") read this
 * enum directly — `agent_proposed` and `inferred` get a "may be stale" pill.
 *
 *   - `user_explicit`  — User created or confirmed via Settings or chat slash command.
 *   - `agent_proposed` — Agent proposed during conversation; user accepted via consent card (PR #6).
 *   - `inferred`       — Low-confidence, TTL-bounded fact from observable signals
 *                        (e.g., active workspace, auth method). Minimal admission weight.
 *
 * @typedef {"user_explicit"|"agent_proposed"|"inferred"} MemorySource
 */

/**
 * The atomic memory record. Persisted in IDB store `memory_records`.
 *
 * Schema notes:
 *   - `embedding` is `number[]` (not `Float32Array`) for IDB
 *     structured-clone safety. Callers wrap with `Float32Array.from()` only
 *     for cosine-similarity math; the persistent shape is plain array.
 *   - `superseded_by` chains older records to newer ones (soft delete).
 *     The "head" of a chain has `superseded_by === null`; semantic search
 *     and default `list()` return only heads.
 *   - `owner_id_or_workspace_id` is a single discriminator field. For
 *     `scope: "user"` records it stores the owner id; for
 *     `scope: "workspace"` records it stores the workspace id (typically
 *     `connectionId/owner/repo`). One column → one compound index
 *     (`by_scope_owner_key`).
 *   - `md_path` is the future `.aieditor/memory/*.md` projection target.
 *     PR #2 preserves the field through round-trips; PR #3 reads/writes it.
 *
 * @typedef {Object} MemoryRecord
 * @property {string}            id                          UUID via `crypto.randomUUID()`.
 * @property {MemoryScope}       scope
 * @property {string}            owner_id_or_workspace_id    Discriminator for the chosen scope.
 * @property {string}            key                         Canonicalized (lowercase, trimmed, ≤256 chars).
 * @property {string|Object}     value                       JSON-serializable.
 * @property {MemoryCategory}    category
 * @property {MemorySource}      source
 * @property {number[]|null}     embedding                   `null` while indexing lags; semantic search filters these out.
 * @property {string}            embedding_model_id          Versioning for vector reconciliation.
 * @property {number}            created_at                  Epoch ms.
 * @property {number}            updated_at                  Epoch ms.
 * @property {string}            created_by                  Free-form actor (e.g., user id, "system").
 * @property {string}            actor                       Last-mutation actor. PR #4/#6 pin format ("agent:<model>", "user:<id>").
 * @property {string|null}       superseded_by               Record id of the supersedent, or null if this is the head.
 * @property {number|null}       expires_at                  Epoch ms TTL; null = no expiry.
 * @property {string|null}       md_path                     Reserved for PR #3 file layer; preserved by PR #2.
 */

/**
 * Mutation kinds recorded in the audit log. The store layer emits one
 * audit entry per state-changing operation.
 *
 *   - `create`     — New record (no prior state).
 *   - `update`     — In-place update of fields other than supersession.
 *   - `supersede`  — Old record marked superseded_by; new record created.
 *   - `softDelete` — Record marked as deleted (a sentinel supersession with no replacement).
 *   - `expire`     — Background TTL reaper purged the record.
 *
 * @typedef {"create"|"update"|"supersede"|"softDelete"|"expire"} AuditAction
 */

/**
 * One audit-log entry. Persisted in IDB store `memory_audit` with
 * autoIncrement keyPath `seq`. `before` and `after` are full record
 * snapshots so the audit log can reconstruct state at any seq.
 *
 * @typedef {Object} AuditEntry
 * @property {number}                 seq            AutoIncrement primary key. Asserts global ordering.
 * @property {number}                 ts             Epoch ms.
 * @property {string}                 actor          Free-form (e.g., user id, agent identifier).
 * @property {AuditAction}            action
 * @property {string}                 record_id      The MemoryRecord.id this entry pertains to.
 * @property {MemoryRecord|null}      before         State before the mutation; null on `create`.
 * @property {MemoryRecord|null}      after          State after the mutation; null on `softDelete`/`expire`.
 * @property {string}                 reason         Free-form annotation from the caller.
 */

/**
 * Options for `MemoryStore.list()`.
 *
 * @typedef {Object} MemoryListOptions
 * @property {MemoryScope}                  scope
 * @property {string}                       owner_id_or_workspace_id
 * @property {MemoryCategory}               [category]            Optional filter.
 * @property {boolean}                      [includeSuperseded]   Default false.
 * @property {boolean}                      [includeExpired]      Default false.
 * @property {number}                       [limit]
 * @property {number}                       [offset]
 */

/**
 * Options for `MemoryStore.searchSemantic()`.
 *
 * @typedef {Object} MemoryQuery
 * @property {MemoryScope}      scope
 * @property {string}           owner_id_or_workspace_id
 * @property {number[]}         queryEmbedding        Precomputed via the caller's `EmbeddingsClient.embed()`.
 * @property {number}           [topK]                Default 10.
 * @property {MemoryCategory}   [category]            Optional filter.
 */

/**
 * In-memory candidate for an `agent_proposed` `memory_remember` call held
 * pending user consent (PR #6). Never persisted — the queue lives only as
 * long as the page session. On Accept the consent queue converts a
 * candidate to a real `MemoryRecord` via `create()`/`supersede()`; on
 * Dismiss it is dropped silently with no audit entry (dismissed proposals
 * never became state).
 *
 * `actor` and `reason` are forwarded to whichever store call resolves the
 * candidate so the audit log of the *accepted* record reflects the agent
 * that proposed it.
 *
 * @typedef {Object} MemoryCandidate
 * @property {string}            candidate_id   Local UUID; not the eventual record id.
 * @property {MemoryScope}       scope
 * @property {string}            owner_id_or_workspace_id
 * @property {string}            key                          Already canonicalized (lowercase, trimmed).
 * @property {string|Object}     value
 * @property {MemoryCategory}    category
 * @property {string}            actor                        Proposing agent ("agent:<model>").
 * @property {string}            reason                       Audit annotation forwarded on accept.
 * @property {number}            created_at                   Epoch ms.
 */

/**
 * Event payloads emitted on `EventBus`. Strings are stable across versions
 * so consumers (Settings UI, chat consent card) can subscribe by name.
 *
 * @typedef {Object} MemoryCreatedEvent
 * @property {MemoryRecord}  record
 *
 * @typedef {Object} MemoryUpdatedEvent
 * @property {MemoryRecord}  before
 * @property {MemoryRecord}  after
 *
 * @typedef {Object} MemoryDeletedEvent
 * @property {string}        recordId
 * @property {MemoryRecord}  before
 *
 * @typedef {Object} MemoryConsentRequestedEvent
 * @property {MemoryCandidate}  candidate
 *
 * @typedef {Object} MemoryConsentResolvedEvent
 * @property {string}                  candidate_id
 * @property {"accepted"|"dismissed"}  outcome
 * @property {string}                  [record_id]    Set on `accepted` outcome.
 *
 * @typedef {MemoryCreatedEvent
 *   |MemoryUpdatedEvent
 *   |MemoryDeletedEvent
 *   |MemoryConsentRequestedEvent
 *   |MemoryConsentResolvedEvent} MemoryEvent
 */

/**
 * EventBus channel names. Listeners subscribe via `EventBus.on(name, fn)`
 * (see `js/core.js`). Strings are part of the public API.
 *
 * Consent channels (PR #6) are separate from the durable mutation channels
 * — `CONSENT_REQUESTED` fires for every `agent_proposed` `memory_remember`
 * call; `CONSENT_RESOLVED` fires on Accept (with `record_id`) or Dismiss.
 * Dismissed proposals never produce a `CREATED` event because they never
 * become records.
 */
export const MEMORY_EVENTS = Object.freeze({
    CREATED: 'memory:created',
    UPDATED: 'memory:updated',
    DELETED: 'memory:deleted',
    CONSENT_REQUESTED: 'memory:consent_requested',
    CONSENT_RESOLVED: 'memory:consent_resolved',
});

/**
 * Schema constants. Centralized so validation, store, and tests agree.
 */
export const MEMORY_LIMITS = Object.freeze({
    KEY_MAX_LENGTH: 256,
    ACTOR_MAX_LENGTH: 128,
    REASON_MAX_LENGTH: 1024,
});

/**
 * Sentinel value for `superseded_by` indicating the record was deleted
 * (`softDelete` or `expire`) with no replacement. Distinct from a real
 * record id (which is always a UUID), so no collision risk. The store's
 * default `list()`, `getByKey()`, and `searchSemantic()` filter records
 * with `superseded_by !== null`, so deleted records are naturally excluded
 * from active queries while remaining in the audit chain.
 */
export const DELETED_SENTINEL = '__deleted__';

/**
 * Allowed enum values. Re-exported so consumers can iterate without
 * duplicating the lists.
 */
export const MEMORY_SCOPES = Object.freeze(['user', 'workspace']);
export const MEMORY_CATEGORIES = Object.freeze([
    'preferences',
    'decisions',
    'project_context',
    'domain_knowledge',
    'workflow',
]);
export const MEMORY_SOURCES = Object.freeze(['user_explicit', 'agent_proposed', 'inferred']);
export const AUDIT_ACTIONS = Object.freeze(['create', 'update', 'supersede', 'softDelete', 'expire']);
