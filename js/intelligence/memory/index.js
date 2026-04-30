// @ts-check
/**
 * Memory module barrel — single entry point for the curated-atomic-facts
 * subsystem landed in 1.3.0. Phase 1 (this PR) ships the storage backbone:
 * contracts, IDB-backed structured store, audit log, embedding glue,
 * validators. UI, LLM tools, and the `.aieditor/memory/*.md` file layer
 * arrive in subsequent Memory-track PRs.
 *
 * Track sequence (memory file `project_design_engagement.md`):
 *   - PR #1 (#185 ✅) — Preact + htm vendor wiring + slot-mount integration
 *   - PR #2 (this) — subsystem core (store, audit, contracts)
 *   - PR #3 — `.aieditor/memory/*.md` file layer
 *   - PR #4 — `memory_remember` / `memory_recall` / `memory_revise` LLM tools
 *   - PR #5 — Settings → Memory tab (first Preact consumer)
 *   - PR #6 — Chat consent card (Flow 1)
 *   - PR #7 — Commit-modal "Memory updates" section (Flow 3A/3B)
 *   - PR #8 — Inline `@memory` chip + DESIGN-memory.md update + 1.3.0 release
 *
 * @module intelligence/memory
 */

/* Constants */
export {
    MEMORY_EVENTS,
    MEMORY_LIMITS,
    MEMORY_SCOPES,
    MEMORY_CATEGORIES,
    MEMORY_SOURCES,
    AUDIT_ACTIONS,
    DELETED_SENTINEL,
} from './contracts.js';

/* Validation */
export {
    validateScope,
    validateCategory,
    validateSource,
    validateKey,
    validateRecord,
    canonicalizeKey,
    assertValid,
} from './validation.js';

/* Store CRUD */
export {
    create,
    update,
    supersede,
    softDelete,
    purgeExpired,
    getById,
    getByKey,
    list,
    searchSemantic,
} from './store.js';

/* Audit log */
export * as audit from './audit.js';

/* Embedding glue (single owner of canonical-embed-text format) */
export {
    canonicalEmbedText,
    embedRecord,
} from './embeddings.js';

/* Test seams — production code should never import these */
export { _setIDBImpl, _resetIDBImpl, createMemoryFakeIDB } from './idb-schema.js';
export { _resetMutexForTests } from './store.js';

/**
 * Re-export typedefs so consumers can `import('./intelligence/memory')`
 * and pick up the type aliases without importing each file individually.
 *
 * @typedef {import('./contracts.js').MemoryScope}        MemoryScope
 * @typedef {import('./contracts.js').MemoryCategory}     MemoryCategory
 * @typedef {import('./contracts.js').MemorySource}       MemorySource
 * @typedef {import('./contracts.js').MemoryRecord}       MemoryRecord
 * @typedef {import('./contracts.js').AuditEntry}         AuditEntry
 * @typedef {import('./contracts.js').AuditAction}        AuditAction
 * @typedef {import('./contracts.js').MemoryListOptions}  MemoryListOptions
 * @typedef {import('./contracts.js').MemoryQuery}        MemoryQuery
 * @typedef {import('./contracts.js').MemoryEvent}        MemoryEvent
 */
