/**
 * Conversation Persistence
 * 
 * Manages multiple chat conversations with save/load/switch/delete.
 * Each conversation stores its own messages, summary info, and prune stash.
 * 
 * Storage layout:
 *   'conversations'       → [{id, title, createdAt, updatedAt, messageCount, synced?}]
 *   'conv-{id}'           → {messages, summaryInfo, pruneStash}
 *   'activeConversation'  → string id
 *
 * The `synced` flag (1.3.2) is per-conversation opt-in for the
 * cross-device sync via `.aieditor/sessions/<id>.json` (see
 * `js/chat/sessions-sync.js`). Default-false; only conversations the
 * user explicitly flips on are projected to the repo. Sessions are
 * raw transcripts vs memory's curated facts, so the gate is
 * per-conversation rather than workspace-wide.
 */

import { State, Storage, EventBus } from '../core.js';
import { ChatSummarizer } from './summarizer.js';
import { ChatHistoryStore } from './history-store.js';
import { removeConvCost } from '../intelligence/cost/cost-store.js';
import { pickProfileName } from '../profiles/resolve.js';
import { cancelToolLoop, clearApprovedPlan } from './state.js';
import { clearAutoCommitted } from '../tools/_session-auto-commits.js';

/** 2.49.0 — DESIGN-sub-agents.md §Risks line 536: bound transcript
 *  bloat by capping `tool_result` content per turn on persistence.
 *  Same scale as the parent's `TOOL_RESULT_LIMIT`. The runtime
 *  transcript retains full content (re-runnable from the transcript
 *  panel); persistence is the bloat surface. */
const SUBAGENT_TRANSCRIPT_TURN_LIMIT = 12000;
const SUBAGENT_TRUNCATION_MARKER = '\n…(truncated for persistence; full content lost when the conversation reloads)';

/**
 * Truncate a single transcript's tool-result turns to ≤12K chars +
 * marker before persisting. Reads + writes deep copies to avoid
 * mutating the live `State.subagents.transcripts[id]` slot the
 * transcript panel reads from.
 *
 * @param {Object} transcript
 * @returns {Object}
 */
function _truncateTranscriptForPersistence(transcript) {
    if (!transcript || typeof transcript !== 'object') return transcript;
    const out = { ...transcript };
    if (Array.isArray(transcript.messages)) {
        out.messages = transcript.messages.map(msg => {
            if (msg && msg.role === 'tool' && typeof msg.content === 'string'
                && msg.content.length > SUBAGENT_TRANSCRIPT_TURN_LIMIT) {
                return {
                    ...msg,
                    content: msg.content.slice(0, SUBAGENT_TRANSCRIPT_TURN_LIMIT) + SUBAGENT_TRUNCATION_MARKER,
                };
            }
            return msg;
        });
    }
    return out;
}

/**
 * Serialize the in-memory transcripts map for persistence. Applies the
 * 12K-per-turn truncation. Empty input → empty object (the field is
 * always written so `load()` can clear stale state confidently).
 *
 * @param {Object} transcripts
 * @returns {Object}
 */
function _serializeSubAgentTranscripts(transcripts) {
    const out = {};
    if (!transcripts || typeof transcripts !== 'object') return out;
    for (const [id, t] of Object.entries(transcripts)) {
        out[id] = _truncateTranscriptForPersistence(t);
    }
    return out;
}

// Exported for the tests (`tests/test-subagent-transcript-truncation.mjs`).
export { _serializeSubAgentTranscripts, _truncateTranscriptForPersistence, SUBAGENT_TRANSCRIPT_TURN_LIMIT };

/** Max conversations kept in the index */
const MAX_CONVERSATIONS = 50;

/** Max title length */
const TITLE_MAX = 60;

// ============================================
// INDEX HELPERS
// ============================================

/**
 * Get the conversation metadata index.
 * @returns {Array<{id: string, title: string, createdAt: number, updatedAt: number, messageCount: number}>}
 */
function _getIndex() {
    return Storage.get('conversations') || [];
}

/**
 * Save the conversation index.
 * @param {Array} index
 */
function _setIndex(index) {
    Storage.set('conversations', index);
}

/**
 * Generate a short unique ID.
 * @returns {string}
 */
function _generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Derive a title from the first user message.
 * @param {Array} messages
 * @returns {string}
 */
function _deriveTitle(messages) {
    const first = messages.find(m => m.role === 'user');
    if (!first || !first.content) return 'New Chat';

    // Handle multimodal content (array with text + images)
    let text = first.content;
    if (Array.isArray(text)) {
        const textPart = text.find(p => p.type === 'text');
        text = textPart?.text || '';
    }

    // Clean up and truncate
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > TITLE_MAX) {
        text = text.slice(0, TITLE_MAX - 1) + '…';
    }
    return text || 'New Chat';
}

// ============================================
// MIGRATION
// ============================================

/**
 * One-time migration: move legacy chatHistory/chatSummaryInfo/chatPruneStash
 * into the first conversation entry.
 */
function _migrateIfNeeded() {
    const index = _getIndex();
    if (index.length > 0) return; // Already migrated

    const legacyMessages = Storage.get('chatHistory', []);
    if (legacyMessages.length === 0) return; // Nothing to migrate

    const id = _generateId();
    const now = Date.now();
    const summaryInfo = Storage.get('chatSummaryInfo', null);
    const pruneStash = Storage.get('chatPruneStash', null);

    // Save conversation payload
    Storage.set(`conv-${id}`, {
        messages: legacyMessages,
        summaryInfo,
        pruneStash
    });

    // Create index entry
    _setIndex([{
        id,
        title: _deriveTitle(legacyMessages),
        createdAt: legacyMessages[0]?.timestamp || now,
        updatedAt: now,
        messageCount: legacyMessages.length
    }]);

    // Set as active
    Storage.set('activeConversation', id);

    console.log(`[conversations] Migrated legacy chat → conversation ${id}`);
}

// ============================================
// PUBLIC API
// ============================================

const ConversationManager = {

    /**
     * Initialize — migrate legacy data if needed.
     */
    init() {
        _migrateIfNeeded();
    },

    /**
     * Get the active conversation ID.
     * @returns {string|null}
     */
    getActiveId() {
        return Storage.get('activeConversation', null);
    },

    /**
     * List all conversations, sorted by updatedAt desc.
     * @returns {Array<{id, title, createdAt, updatedAt, messageCount}>}
     */
    list() {
        const index = _getIndex();
        return index.sort((a, b) => b.updatedAt - a.updatedAt);
    },

    /**
     * Get the profile bound to the active conversation, or `null` when
     * the conversation has no per-chat binding (legacy conversations or
     * fresh-blank ones the user hasn't picked for yet). Callers must
     * fall back to `State.settings.profile` when this returns null —
     * see `pickProfileName` in `js/profiles/resolve.js`.
     *
     * **2.8.0** — added alongside the new-chat picker chip in
     * `.chat-welcome`. Per-conversation `profile` field mirrors the
     * `synced` flag's per-conversation opt-in pattern (1.3.2).
     *
     * @returns {string|null}
     */
    getActiveProfile() {
        const id = this.getActiveId();
        if (!id) return null;
        const index = _getIndex();
        const entry = index.find(c => c.id === id);
        return (entry && typeof entry.profile === 'string') ? entry.profile : null;
    },

    /**
     * Bind a profile to the active conversation for its life. Idempotent
     * after first message — but the chip selector only renders on the
     * empty-chat welcome surface, so the natural lock is "before the
     * first message is sent". Profile rebinds via this method are
     * permitted (a deliberate user action via the chip) and don't
     * retroactively rewrite past turns.
     *
     * @param {string} profileName  Must be a registered profile name; the
     *   caller is responsible for validating against `Profiles.has()`.
     */
    setActiveProfile(profileName) {
        const id = this.getActiveId();
        if (!id) return;
        const index = _getIndex();
        const entry = index.find(c => c.id === id);
        if (!entry) return;
        entry.profile = profileName;
        entry.updatedAt = Date.now();
        _setIndex(index);
        EventBus.emit('conversation:profileLocked', { id, profile: profileName });
    },

    /**
     * Resolve the profile name in effect for the active conversation —
     * the per-chat binding wins over `State.settings.profile`. This is
     * the canonical read for system-prompt assembly, tool admission,
     * compression config, and the model status-bar badge.
     *
     * **2.8.0 — load-bearing across the chat surface.** Six call sites
     * flipped to consult this helper so the lifetime contract ("one
     * profile for the life of a chat") holds across all subsystems —
     * not just the systemPrompt addendum.
     *
     * @returns {string}
     */
    getEffectiveProfileName() {
        return pickProfileName(this.getActiveProfile(), State.settings);
    },

    /**
     * Save the current in-memory conversation to storage.
     * Creates a new conversation entry if none is active.
     */
    save() {
        let id = this.getActiveId();
        const messages = State.chatHistory;

        // If no messages and no active conversation, nothing to save
        if (messages.length === 0 && !id) return;

        // Auto-create if no active conversation
        if (!id) {
            id = _generateId();
            Storage.set('activeConversation', id);
        }

        // Save payload
        const summaryInfo = Storage.get('chatSummaryInfo', null);
        const pruneStash = Storage.get('chatPruneStash', null);
        const toolActionLog = State.toolActionLog || [];
        const todos = State.todo || [];
        // Scratchpad rides per-conversation from 1.11.0 — pre-1.11.0 it was
        // memory-only and reset on every refresh / new chat. Shallow copy so
        // future mutations to State.scratchpad don't bleed into the payload
        // already in IDB before the next save.
        const scratchpad = { ...(State.scratchpad || {}) };
        // Snapshot `messages` so the cached payload doesn't alias
        // `State.chatHistory`. ChatHistoryStore mutates that array in place
        // (length=0 + push), so without the copy a later `load(otherId)` call
        // would clear the previously-saved conversation's cached messages —
        // and the queued async IDB write would persist the corrupted state.
        // 2.49.0 — Sub-agent transcripts persist per-conversation
        // (DESIGN-sub-agents.md §Phasing Phase 1, §Risks line 536 —
        // 12K-per-tool-result truncation on persistence). Cross-session
        // promotion is Phase 5; for Phase 1 the transcripts live with
        // their originating conversation and discard on delete().
        const subagentTranscripts = _serializeSubAgentTranscripts(
            State.subagents?.transcripts || {}
        );

        Storage.set(`conv-${id}`, {
            messages: messages.slice(),
            summaryInfo,
            pruneStash,
            toolActionLog: toolActionLog.slice(-50),
            todos,
            scratchpad,
            subagentTranscripts,
        });
        // Update index
        const index = _getIndex();
        const entry = index.find(c => c.id === id);
        const now = Date.now();

        if (entry) {
            entry.title = entry.title === 'New Chat' ? _deriveTitle(messages) : entry.title;
            entry.updatedAt = now;
            entry.messageCount = messages.length;
        } else {
            index.push({
                id,
                title: _deriveTitle(messages),
                createdAt: now,
                updatedAt: now,
                messageCount: messages.length,
                synced: false
            });
        }

        // Enforce max conversations — remove oldest
        if (index.length > MAX_CONVERSATIONS) {
            const sorted = index.sort((a, b) => a.updatedAt - b.updatedAt);
            const toRemove = sorted.slice(0, index.length - MAX_CONVERSATIONS);
            for (const old of toRemove) {
                Storage.remove(`conv-${old.id}`);
            }
            index.splice(0, toRemove.length);
        }

        _setIndex(index);

        // 1.3.2 — let the sync layer pick up the change. The listener
        // ignores conversations without `synced: true`, so this is a
        // no-op for unflagged conversations.
        EventBus.emit('conversation:saved', { id });
    },

    /**
     * Load a conversation by ID into State and render.
     * Saves the current conversation first.
     * @param {string} id
     * @returns {boolean} success
     */
    load(id) {
        // Save current first
        if (State.chatHistory.length > 0) {
            this.save();
        }

        const payload = Storage.get(`conv-${id}`);
        if (!payload) {
            console.warn(`[conversations] No data for ${id}`);
            return false;
        }

        // Load into State
        ChatHistoryStore.replace(payload.messages || []);
        State.lastExchangeTokens = null;
        Storage.set('activeConversation', id);

        // Restore summarizer state
        if (payload.summaryInfo) {
            Storage.set('chatSummaryInfo', payload.summaryInfo);
        } else {
            Storage.remove('chatSummaryInfo');
        }
        if (payload.pruneStash) {
            Storage.set('chatPruneStash', payload.pruneStash);
        } else {
            Storage.remove('chatPruneStash');
        }

        // Restore tool action log
        State.toolActionLog = payload.toolActionLog || [];

        // Restore todo list (github#26)
        State.todo = Array.isArray(payload.todos) ? payload.todos : [];
        EventBus.emit('todo:changed', { action: 'restored' });

        // Restore scratchpad (1.11.0 — per-conversation persistence).
        // Pre-1.11.0 payloads have no `scratchpad` field; treat as empty.
        State.scratchpad = (payload.scratchpad && typeof payload.scratchpad === 'object')
            ? payload.scratchpad
            : {};
        EventBus.emit('scratchpad:changed', { action: 'restored' });

        // gitea#424 (2.52.0) — the approved-plan slot is not persisted
        // to the payload; a different conversation starts without the
        // prior thread's approved plan.
        clearApprovedPlan();
        // gitea#486 (2.80.0) — drop the auto-committed tracker too.
        clearAutoCommitted();

        // 2.49.0 — Sub-agent transcripts restore from per-conversation
        // payload. Pre-2.49.0 payloads have no `subagentTranscripts` field;
        // treat as empty. Replace wholesale so a load() doesn't leak the
        // outgoing conversation's transcripts into the incoming view.
        if (!State.subagents) {
            State.subagents = { tree: {}, transcripts: {}, session_cost: { dollars: 0, tokens: 0 } };
        }
        State.subagents.transcripts = (payload.subagentTranscripts && typeof payload.subagentTranscripts === 'object')
            ? { ...payload.subagentTranscripts }
            : {};
        // Reset session_cost — running aggregate is per-conversation.
        State.subagents.session_cost = { dollars: 0, tokens: 0 };

        EventBus.emit('conversation:loaded', { id });
        console.log(`[conversations] Loaded conversation ${id}`);
    },

    /**
     * Create a new blank conversation.
     * Saves the current one first if it has messages.
     * @returns {string} new conversation ID
     */
    create() {
        // Save current if it has content
        if (State.chatHistory.length > 0) {
            this.save();
        }

        const id = _generateId();
        const now = Date.now();

        // Clear in-memory state
        ChatHistoryStore.clear();
        State.lastExchangeTokens = null;
        State.scratchpad = {};
        State.toolActionLog = [];
        State.todo = [];
        // gitea#424 (2.52.0) — drop the approved-plan slot so a new chat
        // doesn't inherit the prior conversation's plan body.
        clearApprovedPlan();
        // gitea#486 (2.80.0) — drop the auto-committed tracker too.
        clearAutoCommitted();
        // 2.49.0 — clear sub-agent transcripts for the new conversation.
        if (State.subagents) {
            State.subagents.transcripts = {};
            State.subagents.session_cost = { dollars: 0, tokens: 0 };
        }
        Storage.set('activeConversation', id);
        Storage.remove('chatSummaryInfo');
        Storage.remove('chatPruneStash');
        ChatSummarizer.clear();
        EventBus.emit('scratchpad:changed', { action: 'cleared' });
        EventBus.emit('todo:changed', { action: 'cleared' });

        // Add to index (will get real title on first message)
        const index = _getIndex();
        index.push({
            id,
            title: 'New Chat',
            createdAt: now,
            updatedAt: now,
            messageCount: 0,
            synced: false
        });
        _setIndex(index);

        EventBus.emit('conversation:created', { id });
        console.log(`[conversations] Created conversation ${id}`);
        return id;
    },

    /**
     * Delete a conversation by ID.
     * If deleting the active one, switches to the most recent remaining or creates new.
     * @param {string} id
     * @returns {boolean}
     */
    delete(id) {
        const index = _getIndex();
        const idx = index.findIndex(c => c.id === id);
        if (idx === -1) return false;

        const wasActive = this.getActiveId() === id;

        // 2.49.0 — Cancel any in-flight sub-agent loop bound to this
        // conversation before tearing down its state. `cancelToolLoop`
        // releases the parent's awaited Promise via the slice-1
        // `cancelSubAgentApproval()` path; the sub-agent runner's
        // cancelSignal flips to true on the next round boundary.
        // Only fires when deleting the active conversation (sub-agents
        // are conversation-scoped and only one runs at a time in
        // Phase 1 — see DESIGN §Phasing). Inactive deletes have no
        // in-flight sub-agent by construction.
        if (wasActive) {
            try { cancelToolLoop(); } catch { /* best-effort */ }
        }

        // Remove payload
        Storage.remove(`conv-${id}`);
        // Clear the matching cost record (1.2.1) so storage doesn't leak.
        removeConvCost(id);
        index.splice(idx, 1);
        _setIndex(index);

        // If we deleted the active conversation, switch
        if (wasActive) {
            if (index.length > 0) {
                const sorted = index.sort((a, b) => b.updatedAt - a.updatedAt);
                this.load(sorted[0].id);
            } else {
                // No conversations left — create a blank one
                ChatHistoryStore.clear();
                State.lastExchangeTokens = null;
                State.scratchpad = {};
                State.todo = [];
                // gitea#424 (2.52.0) — drop the approved-plan slot too.
                clearApprovedPlan();
                // gitea#486 (2.80.0) — drop the auto-committed tracker too.
                clearAutoCommitted();
                // 2.49.0 — clear in-memory sub-agent transcripts so the
                // panel doesn't surface stale data from the deleted
                // conversation.
                if (State.subagents) {
                    State.subagents.transcripts = {};
                    State.subagents.session_cost = { dollars: 0, tokens: 0 };
                }
                Storage.remove('activeConversation');
                Storage.remove('chatSummaryInfo');
                Storage.remove('chatPruneStash');
                ChatSummarizer.clear();
                EventBus.emit('scratchpad:changed', { action: 'cleared' });
                EventBus.emit('todo:changed', { action: 'cleared' });
                EventBus.emit('conversation:loaded', { id: null });
            }
        }

        EventBus.emit('conversation:deleted', { id });
        console.log(`[conversations] Deleted conversation ${id}`);
        return true;
    },

    /**
     * Rename a conversation.
     * @param {string} id
     * @param {string} title
     */
    rename(id, title) {
        const index = _getIndex();
        const entry = index.find(c => c.id === id);
        if (!entry) return;
        entry.title = title.slice(0, TITLE_MAX);
        _setIndex(index);
        EventBus.emit('conversation:renamed', { id, title: entry.title });
    },

    /**
     * 1.3.2 — Set the per-conversation sync flag. Toggling on opts the
     * conversation in to `.aieditor/sessions/<id>.json` projection;
     * toggling off stops future syncs (the already-committed remote
     * file persists until the user removes it manually). Returns the
     * resolved boolean (false if the id isn't in the index).
     *
     * @param {string} id
     * @param {boolean} synced
     * @returns {boolean}
     */
    setSynced(id, synced) {
        const index = _getIndex();
        const entry = index.find(c => c.id === id);
        if (!entry) return false;
        const next = Boolean(synced);
        if (entry.synced === next) return next;
        entry.synced = next;
        entry.updatedAt = Date.now();
        _setIndex(index);
        EventBus.emit('conversation:syncToggled', { id, synced: next });
        return next;
    },

    /**
     * 1.3.2 — Get the per-conversation sync flag. Returns false for
     * unknown ids and for conversations without the flag (default off).
     *
     * @param {string} id
     * @returns {boolean}
     */
    isSynced(id) {
        const entry = _getIndex().find(c => c.id === id);
        return Boolean(entry && entry.synced);
    }
};

export { ConversationManager };
