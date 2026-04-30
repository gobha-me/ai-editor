/**
 * Conversation Persistence
 * 
 * Manages multiple chat conversations with save/load/switch/delete.
 * Each conversation stores its own messages, summary info, and prune stash.
 * 
 * Storage layout:
 *   'conversations'       → [{id, title, createdAt, updatedAt, messageCount}]
 *   'conv-{id}'           → {messages, summaryInfo, pruneStash}
 *   'activeConversation'  → string id
 */

import { State, Storage, EventBus } from '../core.js';
import { ChatSummarizer } from './summarizer.js';
import { removeConvCost } from '../intelligence/cost/cost-store.js';

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
        Storage.set(`conv-${id}`, {
            messages: messages.slice(-100),
            summaryInfo,
            pruneStash
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
                messageCount: messages.length
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
        State.chatHistory = payload.messages || [];
        Storage.set('chatHistory', State.chatHistory);
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

        EventBus.emit('conversation:loaded', { id });
        console.log(`[conversations] Loaded conversation ${id}`);
        return true;
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
        State.chatHistory = [];
        State.scratchpad = {};
        Storage.set('chatHistory', []);
        Storage.set('activeConversation', id);
        Storage.remove('chatSummaryInfo');
        Storage.remove('chatPruneStash');
        ChatSummarizer.clear();

        // Add to index (will get real title on first message)
        const index = _getIndex();
        index.push({
            id,
            title: 'New Chat',
            createdAt: now,
            updatedAt: now,
            messageCount: 0
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

        // Remove payload
        Storage.remove(`conv-${id}`);
        // Clear the matching cost record (1.2.1) so storage doesn't leak.
        removeConvCost(id);
        index.splice(idx, 1);
        _setIndex(index);

        // If we deleted the active conversation, switch
        if (this.getActiveId() === id) {
            if (index.length > 0) {
                const sorted = index.sort((a, b) => b.updatedAt - a.updatedAt);
                this.load(sorted[0].id);
            } else {
                // No conversations left — create a blank one
                State.chatHistory = [];
                State.scratchpad = {};
                Storage.set('chatHistory', []);
                Storage.remove('activeConversation');
                Storage.remove('chatSummaryInfo');
                Storage.remove('chatPruneStash');
                ChatSummarizer.clear();
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
    }
};

export { ConversationManager };
