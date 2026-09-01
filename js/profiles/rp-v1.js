// @ts-check
/**
 * `rp.v1` — role-play / personas. Inherits from `chat.v1` (per
 * `docs/DESIGN-profiles.md` §"Canonical Profiles" → "rp.v1").
 *
 * Ships the overrides whose runtime consumers exist today (retrieval
 * collections, memory scope, retrieval strategy weights, compression
 * `preserve_recent`). Deferred to a follow-up slice:
 *
 *   - **Rule 4 (Resolution) keyed off `scene_id` boundaries** — rp.v1
 *     inherits chat.v1's Rule-5-only behavior until Rule 4 exists.
 *   - **Voice-preserving Rule 5 prompt** — `summarizer.promptTemplate`
 *     plumbing isn't there; profile inherits chat.v1's `null` template.
 *   - **Chunker metadata fields** (`persona_id`, `in_character`, `scene_id`)
 *     — profile-side custom metadata registration isn't wired yet.
 *
 * Field provenance: every override mirrors the rp.v1 row at
 * `docs/DESIGN-profiles.md` lines 262–272 trimmed to the realized subset.
 *
 * @module profiles/rp-v1
 */

/**
 * @typedef {import('./profile-contract.js').Profile} Profile
 */

/**
 * Role-play overrides on top of `chat.v1`.
 *
 * @type {Profile}
 */
export const RP_V1 = {
    name: 'rp.v1',
    version: '1',
    base: 'chat.v1',

    budget: {},

    retrieval: {
        // Adds `lore` (per-world) to chat.v1's `attached_docs`.
        collections: ['attached_docs', 'lore'],
        // Adds `per_persona` to chat.v1's `['user', 'persona']`.
        memory_collections: ['user', 'persona', 'per_persona'],
        // DESIGN-profiles.md §rp.v1: structural 0.8 (hierarchies matter
        // for lore), thematic 0.3. Semantic stays at chat.v1's 1.0.
        strategy_weights: {
            semantic: 1.0,
            structural: 0.8,
            thematic: 0.3,
        },
        // chunkers / metadata_extensions / novelty_threshold — inherited.
    },

    memory: {
        // DESIGN-profiles.md §rp.v1: *"default scope for new memories is
        // persona"*. Overrides chat.v1's `'user'`. Other memory fields
        // (propose_after_n_turns, capacity_warnings) — inherited.
        default_scope: 'persona',
    },

    compression: {
        // DESIGN-profiles.md §rp.v1: *"preserve_recent raised to 8 (preserve
        // more in-character continuity)"*. Overrides chat.v1's `4`. Rules
        // array stays inherited (Rule 5 only) until Rule 4 lands.
        preserve_recent: 8,
    },

    tools: {
        // 2.54.0 (gitea#438) — inherits chat.v1.admit unchanged.
        // Role-play surfaces are chat-shaped; no need to narrow the
        // admission set.
    },

    task_ledger: {},
};
