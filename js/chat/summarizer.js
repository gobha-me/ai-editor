/**
 * Chat History Summarizer
 * Compresses older chat messages into LLM-generated summaries
 */

import { State, EventBus, Storage } from '../core.js';
import { LLM } from '../llm.js';

/**
 * Compresses older chat messages into LLM-generated summaries.
 * Keeps last N messages in full, summarizes everything older.
 * Uses the utility model (commitModel) to avoid burning tokens on the primary model.
 */
export const ChatSummarizer = {
    // Defaults — overridden by State.settings.summarizer when present
    _defaults: {
        recentCountBase: 10,
        recentCountTools: 24,
        threshold: 30,
        interval: 15,
        maxChars: 2000
    },

    /** Read a summarizer setting with fallback to defaults */
    _cfg(key) {
        const s = State.settings.summarizer;
        return (s && s[key] != null) ? s[key] : this._defaults[key];
    },

    get RECENT_COUNT_BASE()  { return this._cfg('recentCountBase'); },
    get RECENT_COUNT_TOOLS() { return this._cfg('recentCountTools'); },
    get SUMMARY_THRESHOLD()  { return this._cfg('threshold'); },
    get SUMMARY_INTERVAL()   { return this._cfg('interval'); },
    get SUMMARY_MAX_CHARS()  { return this._cfg('maxChars'); },

    /** Dynamic recent count — expand window when tool calls are in recent history */
    get RECENT_COUNT() {
        const history = State.chatHistory;
        // Check if any of the last 15 messages are tool-related
        const recentSlice = history.slice(-15);
        const hasToolActivity = recentSlice.some(m => 
            m.role === 'tool' || (m.role === 'assistant' && m.tool_calls?.length > 0)
        );
        return hasToolActivity ? this.RECENT_COUNT_TOOLS : this.RECENT_COUNT_BASE;
    },

    /** @returns {boolean} true when enough new messages have accumulated */
    shouldSummarize() {
        const total = State.chatHistory.length;
        if (total < this.SUMMARY_THRESHOLD) return false;

        const info = Storage.get('chatSummaryInfo', null);
        if (!info) return true;

        return (total - (info.coveredCount || 0)) >= this.SUMMARY_INTERVAL;
    },

    /** Pick cheapest available model (utility model → auto-detect cheap → fallback to primary) */
    _pickModel() {
        // Prefer dedicated utility model
        if (State.settings.commitModel) return State.settings.commitModel;

        // Scan State.models for known cheap models
        const cheap = ['mini', 'haiku', 'flash', 'lite'];
        const hit = (State.models || []).find(m =>
            cheap.some(p => m.id.toLowerCase().includes(p))
        );
        if (hit) return hit.id;

        return State.settings.llmModel; // last resort
    },

    /** Build the summarization prompt */
    _buildPrompt(messages) {
        const convo = messages
            .filter(m => m.role !== 'system')
            .map(m => {
                const who = m.role === 'user' ? 'User' : 'Assistant';
                const text = (typeof m.content === 'string'
                    ? m.content : JSON.stringify(m.content)).slice(0, 500);
                return `${who}: ${text}`;
            })
            .join('\n\n');

        return `Summarize this coding-assistant conversation concisely. Include:
1. Project/branch context
2. User goals and key decisions
3. Files created or modified
4. Where the conversation left off

Keep under 400 words. Output ONLY the summary, no preamble.

CONVERSATION:
${convo}

SUMMARY:`;
    },

    /** Fallback: extract topic snippets without LLM */
    _basicSummary(messages) {
        const user = messages.filter(m => m.role === 'user');
        const asst = messages.filter(m => m.role === 'assistant');
        const topics = user.map(m =>
            (typeof m.content === 'string' ? m.content : 'complex request').slice(0, 80)
        );
        return `${user.length} user / ${asst.length} assistant messages. Topics: ${topics.join('; ')}`;
    },

    /**
     * Generate summary via LLM (non-blocking, fire-and-forget safe).
     * Stores result in localStorage under 'chatSummaryInfo'.
     */
    async generateAndStore() {
        if (!this.shouldSummarize()) return null;

        const history = State.chatHistory;
        const older = history.slice(0, -this.RECENT_COUNT);
        if (older.length < 5) return null;

        let summary;
        try {
            const model = this._pickModel();
            // Use configurable summary timeout (default 60s)
            const summaryTimeout = State.settings.summaryTimeout || 60000;
            
            const result = await Promise.race([
                LLM.chat(
                    [{ role: 'user', content: this._buildPrompt(older) }],
                    { model, stream: false, temperature: 0.3, maxTokens: 500 }
                ),
                new Promise((_, rej) =>
                    setTimeout(() => rej(new Error('summary timeout')), summaryTimeout)
                )
            ]);
            summary = (result.content || '').trim();
            if (summary.length > this.SUMMARY_MAX_CHARS) {
                summary = summary.slice(0, this.SUMMARY_MAX_CHARS) + '…';
            }
        } catch (err) {
            console.warn('[ChatSummarizer] LLM failed, using basic:', err.message);
            summary = this._basicSummary(older);
        }

        const info = {
            summary,
            coveredCount: history.length,
            compressedMessages: older.length,
            keptMessages: this.RECENT_COUNT,
            timestamp: Date.now()
        };
        Storage.set('chatSummaryInfo', info);

        // Prune old messages — stash them for one-turn undo
        this._pruneHistory(older.length);

        // Update coveredCount to reflect post-prune state so next
        // summary triggers after SUMMARY_INTERVAL new messages, not
        // SUMMARY_INTERVAL + pruned_count.
        info.coveredCount = State.chatHistory.length;
        Storage.set('chatSummaryInfo', info);

        EventBus.emit('chat:pruned', info);
        return info;
    },

    /**
     * Splice old messages from State.chatHistory and stash them for undo.
     * After this call, State.chatHistory contains only the recent window.
     *
     * Order of operations matters when localStorage is near-full:
     *   1. Splice messages from in-memory array
     *   2. Save the SMALLER chatHistory first (frees localStorage space)
     *   3. THEN attempt to save the stash (now there may be room)
     *
     * @param {number} pruneCount - Number of messages to remove from the front
     */
    _pruneHistory(pruneCount) {
        if (pruneCount <= 0) return;

        // 1. Splice old messages out of in-memory array
        const pruned = State.chatHistory.splice(0, pruneCount);

        // 2. Persist the now-smaller chatHistory FIRST to free localStorage space
        //    Remove before set — if localStorage is already full, set() would fail
        //    because the OLD big chatHistory is still consuming space.
        Storage.remove('chatHistory');
        Storage.set('chatHistory', State.chatHistory.slice(-100));

        // 3. Try to stash pruned messages for undo — may fail if still tight on space
        Storage.set('chatPruneStash', pruned);
        if (Storage.get('chatPruneStash', null)) {
            console.log(`[ChatSummarizer] Pruned ${pruned.length} messages (stashed for undo)`);
        } else {
            // Stash didn't persist — prune still happened, just no undo
            console.warn(`[ChatSummarizer] Pruned ${pruned.length} messages (stash failed — no undo)`);
        }
    },

    /**
     * Permanently delete the prune stash.
     * Called on the first user query after pruning.
     */
    flushStash() {
        if (Storage.get('chatPruneStash', null)) {
            Storage.remove('chatPruneStash');
            console.log('[ChatSummarizer] Stash flushed — prune is permanent');
            EventBus.emit('chat:stashFlushed');
        }
    },

    /**
     * Undo a prune — restore stashed messages to the front of chatHistory.
     * Only works before the stash is flushed (i.e., before the next user query).
     * @returns {boolean} true if undo succeeded
     */
    undoPrune() {
        const stash = Storage.get('chatPruneStash', null);
        if (!stash || !Array.isArray(stash)) return false;

        // Restore: prepend stash to current history
        State.chatHistory.unshift(...stash);
        Storage.remove('chatPruneStash');
        Storage.remove('chatSummaryInfo');
        Storage.set('chatHistory', State.chatHistory.slice(-100));
        console.log(`[ChatSummarizer] Undo prune — restored ${stash.length} messages`);
        EventBus.emit('chat:pruneUndone');
        return true;
    },

    /** @returns {boolean} true if a prune stash exists (undo is available) */
    hasStash() {
        return !!Storage.get('chatPruneStash', null);
    },

    /**
     * Build the message array to send to the LLM.
     * Prepends stored summary as a system message, then appends recent messages.
     * 
     * CRITICAL: Ensures tool call sequences remain intact.
     * If recent messages include 'tool' role messages, we MUST include their
     * corresponding 'assistant' message with tool_calls, even if it falls
     * outside the RECENT_COUNT window.
     */
    getContextMessages() {
        const history = State.chatHistory;
        if (history.length === 0) return [];

        const info = Storage.get('chatSummaryInfo', null);
        
        // Start with the naive slice of recent messages
        let startIndex = Math.max(0, history.length - this.RECENT_COUNT);
        let recent = history.slice(startIndex);
        
        // CRITICAL FIX: Scan backwards from startIndex to find any assistant message
        // with tool_calls that has corresponding tool results in our recent window
        for (let i = startIndex - 1; i >= 0; i--) {
            const msg = history[i];
            
            // Found an assistant message with tool_calls
            if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
                // Check if any of the subsequent messages in our recent window are tool results
                const hasToolResultsInRecent = recent.some(m => m.role === 'tool');
                
                if (hasToolResultsInRecent) {
                    // Include this assistant message and everything after it
                    startIndex = i;
                    recent = history.slice(startIndex);
                    console.log(`[ChatSummarizer] Expanded context to include assistant+tool_calls at index ${i}`);
                }
                
                // Stop searching - we found the most recent tool call sequence
                break;
            }
        }
        
        // Filter out summary markers, system messages, and remap 'error' role
        // (which is UI-only and not a valid API role) to prevent 400 errors.
        recent = recent
            .filter(m => !m.isSummary && m.role !== 'system')
            .map(m => m.role === 'error' 
                ? { ...m, role: 'user', content: `[Error from editor]: ${m.content}` }
                : m
            );

        if (info?.summary && history.length > this.RECENT_COUNT) {
            return [
                {
                    role: 'system',
                    content: `CONVERSATION SUMMARY (earlier messages):\n\n${info.summary}\n\n---\nRecent messages follow.`,
                    isSummary: true
                },
                ...recent
            ];
        }

        return recent;
    },

    clear() {
        Storage.remove('chatSummaryInfo');
        Storage.remove('chatPruneStash');
    }
};