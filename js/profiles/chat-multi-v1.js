// @ts-check
/**
 * `chat_multi.v1` — multi-user chat with @-mention / shared-conversation
 * semantics. Inherits from `chat.v1` (per `docs/DESIGN-profiles.md`
 * §"Canonical Profiles" → "chat_multi.v1").
 *
 * Phase 2 of the profiles arc per ROADMAP §"After 2.0.0" line 111: surface
 * count goes from 1 to 4 (chat-family). The chunker / metadata extension
 * fields (`speaker_id`) and the speaker-attribution Rule 5 prompt remain
 * deferred until the corresponding pipes exist; this slice ships the data
 * fields whose runtime consumers already exist (retrieval collections +
 * memory collections).
 *
 * Field provenance: every override mirrors the chat_multi.v1 row at
 * `docs/DESIGN-profiles.md` lines 252–260 trimmed to the realized subset.
 *
 * @module profiles/chat-multi-v1
 */

/**
 * @typedef {import('./profile-contract.js').Profile} Profile
 */

/**
 * Chat-multi overrides on top of `chat.v1`. Empty object blocks
 * (`budget: {}` etc.) preserve `chat.v1`'s defaults under `mergeDeep`
 * — same posture as `full-v1.js`'s synthetic structure.
 *
 * @type {Profile}
 */
export const CHAT_MULTI_V1 = {
    name: 'chat_multi.v1',
    version: '1',
    base: 'chat.v1',

    budget: {},

    retrieval: {
        // Adds `shared_conversation` to chat.v1's `attached_docs`. Arrays
        // replace wholesale per `inheritance.js`, so the full list is
        // declared here even though `attached_docs` carries through
        // unchanged.
        collections: ['attached_docs', 'shared_conversation'],
        // Adds `per_speaker` scope to chat.v1's `['user', 'persona']`.
        memory_collections: ['user', 'persona', 'per_speaker'],
        // strategy_weights / chunkers / metadata_extensions / novelty_threshold
        // — inherited from chat.v1.
    },

    memory: {},
    compression: {},

    tools: {
        // chat.v1's `['all', 'pm', 'reviewer']` is the right baseline:
        // multi-user chat surfaces still cover the historical pm + reviewer
        // shape (chat with full issue access). Inherit unchanged.
    },

    task_ledger: {},
};
