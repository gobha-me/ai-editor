// @ts-check
/**
 * `kb.v1` — single-purpose knowledge-base assistant. The minimal profile.
 * Inherits from `chat.v1` (per `docs/DESIGN-profiles.md` §"Canonical
 * Profiles" → "kb.v1").
 *
 * Phase 2 of the profiles arc per ROADMAP §"After 2.0.0" line 111. From
 * the design (line 307): *"The KB profile is a useful demonstration that
 * the architecture is opt-in at the profile level. A surface that doesn't
 * need compression pays no cost for it. A surface that doesn't need a
 * task ledger pays no cost for it."*
 *
 * Field provenance: overrides mirror the kb.v1 row at
 * `docs/DESIGN-profiles.md` lines 292–306. The "minimal (citation lookup)"
 * tools row is realized as `allowed_groups: ['all']` — universal-tagged
 * tools only (drops the `'pm'` / `'reviewer'` baselines chat.v1 carries).
 * No standalone `citation_lookup` tool exists today; reserved for a
 * follow-up slice.
 *
 * @module profiles/kb-v1
 */

/**
 * @typedef {import('./profile-contract.js').Profile} Profile
 */

/**
 * KB overrides on top of `chat.v1`. Disables compression and task-ledger
 * subsystems entirely; narrows retrieval to `kb_documents`; drops memory.
 *
 * @type {Profile}
 */
export const KB_V1 = {
    name: 'kb.v1',
    version: '1',
    base: 'chat.v1',

    budget: {},

    retrieval: {
        // DESIGN-profiles.md §kb.v1: *"kb_documents only"*. Replaces
        // chat.v1's `attached_docs` wholesale (array semantics).
        collections: ['kb_documents'],
        // *"Memory collections: none"*.
        memory_collections: [],
        // DESIGN-profiles.md §kb.v1: *"semantic 1.0, thematic 0.4 (for
        // overview queries), structural 0.6"*.
        strategy_weights: {
            semantic: 1.0,
            structural: 0.6,
            thematic: 0.4,
        },
        // chunkers / metadata_extensions / novelty_threshold — inherited.
    },

    memory: {},

    compression: {
        // DESIGN-profiles.md §kb.v1: *"Compression rules: none — sessions
        // too short to compress"*. Empty array replaces chat.v1's Rule-5
        // entry wholesale. Resolver in `js/profiles/resolve.js` returns
        // an empty `rules` list for kb.v1; the chat loop's compression
        // pass becomes a no-op.
        rules: [],
        // preserve_recent: irrelevant when rules is empty, but keep
        // chat.v1's `4` inherited rather than emitting a divergent literal.
    },

    tools: {
        // DESIGN-profiles.md §kb.v1: *"Tools: minimal (citation lookup)"*.
        // chat.v1's `['all', 'pm', 'reviewer']` is the wider chat baseline;
        // narrow to `['all']` only — universal-tagged tools (ask_user etc.)
        // still admit, but pm/reviewer-tagged tools are dropped. A
        // dedicated citation_lookup tool would land in a follow-up.
        allowed_groups: ['all'],
    },

    task_ledger: {
        // DESIGN-profiles.md §kb.v1: *"Task ledger disabled — short-session
        // pattern doesn't benefit"*.
        enabled: false,
    },
};
