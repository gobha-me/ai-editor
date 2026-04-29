// @ts-check
/**
 * Chat History Summarizer
 * Compresses older chat messages into LLM-generated summaries.
 *
 * Modes (percentage of context window to fill before summarizing):
 *   - aggressive:   30% — summarize early, keep context lean
 *   - balanced:     50% — default middle ground
 *   - conservative: 75% — preserve more history, still safe from overflow
 *   - custom:       user-specified manual values
 *
 * All non-custom modes derive params from the loaded model's actual context
 * window size. No tiers, no cliffs — smooth linear scaling with min/max clamps.
 *
 * @module chat/summarizer
 */

/**
 * @typedef {import('../core.js').ChatMessage} ChatMessage
 * @typedef {import('../core.js').SummarizerMode} SummarizerMode
 * @typedef {import('../core.js').SummarizerConfig} SummarizerConfig
 */

/**
 * @typedef {Object} SummarizerParams
 * @property {number} recentCountBase
 * @property {number} recentCountTools
 * @property {number} threshold
 * @property {number} interval
 * @property {number} maxChars
 */

/**
 * @typedef {Object} SummaryInfo
 * @property {string} summary
 * @property {number} coveredCount
 * @property {number} compressedMessages
 * @property {number} keptMessages
 * @property {number} timestamp
 */

/**
 * @typedef {Object} AutoParams
 * @property {string}           label          - Human-readable description (e.g. "50% of 128K")
 * @property {number|null}      contextTokens  - Model's context window (null if unknown)
 * @property {number}           fillPct        - Fill percentage used (0.30 / 0.50 / 0.75)
 * @property {SummarizerParams} params         - Computed summarizer parameters
 * @property {SummarizerMode}   mode           - Active mode name
 */

import { State, EventBus, Storage } from '../core.js';
import { LLM, getContextScale } from '../llm.js';

// ============================================
// PERCENTAGE-BASED SCALING CONSTANTS
// ============================================

/** Average tokens per chat message (user + assistant + tool mix). */
const AVG_TOKENS_PER_MSG = 800;

/**
 * Mode → fraction of context window to fill before triggering summarization.
 * @type {Object.<string, number>}
 */
const MODE_FILL = {
    aggressive:   0.30,
    balanced:     0.50,
    conservative: 0.75,
};

/**
 * Clamp a value between min and max.
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Compresses older chat messages into LLM-generated summaries.
 * Keeps last N messages in full, summarizes everything older.
 * Uses the utility model (commitModel) to avoid burning tokens on the primary model.
 */
export const ChatSummarizer = {
    /** @type {SummarizerParams} */
    _defaults: {
        recentCountBase: 10,
        recentCountTools: 24,
        threshold: 30,
        interval: 15,
        maxChars: 2000
    },

    /**
     * Resolve the active context window size (tokens) from model metadata.
     * Checks State.models for the currently selected llmModel.
     * @returns {number|null}
     */
    _getContextWindow() {
        const modelId = State.settings.llmModel;
        if (!modelId || !State.models?.length) return null;
        const model = State.models.find(m => m.id === modelId);
        return model?.meta?.contextTokens || null;
    },

    /**
     * Compute summarizer params from context window size and mode fill percentage.
     * Capacity = contextTokens × fillPct / AVG_TOKENS_PER_MSG.
     * Upper clamp bounds scale with the context tier so 256K+ models
     * aren't artificially constrained to small-model ceilings.
     * @returns {SummarizerParams}
     */
    _computeParams() {
        const ctx = this._getContextWindow();
        const fillPct = MODE_FILL[this.mode] ?? MODE_FILL.balanced;

        // No context info → use defaults (safe small-model behavior)
        if (!ctx) return { ...this._defaults };

        // Scale upper bounds with context tier (1× / 2× / 4× / 8×)
        const { scale } = getContextScale();

        const capacity = clamp(
            Math.floor(ctx * fillPct / AVG_TOKENS_PER_MSG),
            20, 250 * scale
        );

        return {
            recentCountBase:  clamp(Math.round(capacity * 0.35),  8,  60 * scale),
            recentCountTools: clamp(Math.round(capacity * 0.60), 16, 100 * scale),
            threshold:        clamp(capacity,                     20, 200 * scale),
            interval:         clamp(Math.round(capacity * 0.45), 10,  80 * scale),
            maxChars:         clamp(
                Math.round(1500 + (capacity / (250 * scale)) * (2500 * scale)),
                1500, 4000 * scale
            ),
        };
    },

    /**
     * Get the effective parameters and metadata for the current model + mode.
     * @returns {AutoParams}
     */
    getAutoParams() {
        const ctx = this._getContextWindow();
        const mode = this.mode;
        const fillPct = MODE_FILL[mode] ?? MODE_FILL.balanced;
        const params = this._computeParams();
        const ctxLabel = ctx ? `${(ctx / 1000).toFixed(0)}K` : 'unknown';
        const label = `${(fillPct * 100).toFixed(0)}% of ${ctxLabel}`;
        return { label, contextTokens: ctx, fillPct, params, mode };
    },

    /** @returns {'aggressive'|'balanced'|'conservative'|'custom'} */
    get mode() {
        const m = State.settings.summarizerMode || 'balanced';
        // Migrate old values
        if (m === 'auto') return 'balanced';
        if (m === 'manual') return 'custom';
        return m;
    },

    /**
     * Read a summarizer setting with fallback: custom overrides → computed → hardcoded defaults.
     * @param {keyof SummarizerParams} key
     * @returns {number}
     */
    _cfg(key) {
        if (this.mode === 'custom') {
            const s = State.settings.summarizer;
            return (s && s[key] != null) ? s[key] : this._defaults[key];
        }
        // Named mode: percentage-based computation
        const params = this._computeParams();
        return params[key] ?? this._defaults[key];
    },

    /** @returns {number} */ get RECENT_COUNT_BASE()  { return this._cfg('recentCountBase'); },
    /** @returns {number} */ get RECENT_COUNT_TOOLS() { return this._cfg('recentCountTools'); },
    /** @returns {number} */ get SUMMARY_THRESHOLD()  { return this._cfg('threshold'); },
    /** @returns {number} */ get SUMMARY_INTERVAL()   { return this._cfg('interval'); },
    /** @returns {number} */ get SUMMARY_MAX_CHARS()  { return this._cfg('maxChars'); },

    /**
     * Dynamic recent count — expand window when tool calls are in recent history.
     * @returns {number}
     */
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

    /**
     * Estimate how many user messages until next summary triggers.
     * Returns null if summarization is not yet relevant (below threshold).
     * Used to inject a heads-up into the system prompt.
     * @returns {number|null}
     */
    messagesUntilSummary() {
        const total = State.chatHistory.length;
        if (total < this.SUMMARY_THRESHOLD - this.SUMMARY_INTERVAL) return null; // too early

        const info = Storage.get('chatSummaryInfo', null);
        const coveredCount = info?.coveredCount || 0;
        const messagesSinceLast = total - coveredCount;

        if (total < this.SUMMARY_THRESHOLD) {
            // Haven't hit initial threshold yet
            // Rough estimate: ~2 messages per user query (user + assistant)
            return Math.max(0, Math.ceil((this.SUMMARY_THRESHOLD - total) / 2));
        }

        // After threshold: count down to next interval
        const remaining = this.SUMMARY_INTERVAL - messagesSinceLast;
        return Math.max(0, Math.ceil(remaining / 2)); // /2 because each query ≈ 2 messages
    },

    /**
     * Pick cheapest available model for summarization.
     * @returns {string} Model ID
     */
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

    /**
     * Build the summarization prompt.
     * @param {ChatMessage[]} messages
     * @returns {string}
     */
    _buildPrompt(messages) {
        const convo = messages
            .filter(m => m.role !== 'system')
            .map(m => {
                // User messages
                if (m.role === 'user') {
                    const text = (typeof m.content === 'string'
                        ? m.content : JSON.stringify(m.content)).slice(0, 500);
                    return `User: ${text}`;
                }

                // Tool results — extract structured info instead of raw content
                if (m.role === 'tool') {
                    return this._summarizeToolResult(m);
                }

                // Assistant messages — include tool_calls info
                if (m.role === 'assistant') {
                    const parts = [];

                    // List which tools were called
                    if (m.tool_calls?.length > 0) {
                        const calls = m.tool_calls.map(tc => {
                            const name = tc.function?.name || tc.name || 'unknown';
                            const args = tc.function?.arguments;
                            let argSummary = '';
                            try {
                                const parsed = typeof args === 'string' ? JSON.parse(args) : args;
                                if (parsed?.path) argSummary = ` → ${parsed.path}`;
                                else if (parsed?.query) argSummary = ` → "${parsed.query}"`;
                                else if (parsed?.paths) argSummary = ` → [${parsed.paths.length} files]`;
                            } catch { /* ignore */ }
                            return `${name}${argSummary}`;
                        });
                        parts.push(`[Tools called: ${calls.join(', ')}]`);
                    }

                    // Include text content if present
                    const text = (typeof m.content === 'string'
                        ? m.content : (m.content ? JSON.stringify(m.content) : ''));
                    if (text && text !== 'null') {
                        parts.push(text.slice(0, 600));
                    }

                    return parts.length > 0 ? `Assistant: ${parts.join('\n')}` : null;
                }

                // Error/other roles
                const text = (typeof m.content === 'string'
                    ? m.content : JSON.stringify(m.content)).slice(0, 300);
                return `[${m.role}]: ${text}`;
            })
            .filter(Boolean)
            .join('\n\n');

        return `Summarize this coding-assistant conversation concisely. Include:
1. Project/branch context
2. User goals and key decisions
3. Files read, created, or modified (with paths)
4. Tool results that contained important data (file contents, search results)
5. Where the conversation left off

Keep under 400 words. Output ONLY the summary, no preamble.

CONVERSATION:
${convo}

SUMMARY:`;
    },

    /**
     * Compress a tool result message into a structured summary.
     * @param {ChatMessage} msg
     * @returns {string|null}
     */
    _summarizeToolResult(msg) {
        const content = typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content);
        
        if (!content || content === 'null') return null;

        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch {
            // Plain text tool result — truncate
            return `[Tool result]: ${content.slice(0, 300)}`;
        }

        // Error results — keep full
        if (parsed.error) {
            return `[Tool error]: ${parsed.error}`;
        }

        const parts = [];

        // File read results — extract path, line count, key symbols
        if (parsed.path && (parsed.content || parsed.lines)) {
            const lineCount = parsed.lines?.length 
                || (parsed.content?.split?.('\n')?.length) 
                || 'unknown';
            parts.push(`[File: ${parsed.path} — ${lineCount} lines`);

            // Extract key symbols (function/class/export names) from first ~2000 chars
            const src = parsed.content || parsed.lines?.join?.('\n') || '';
            const symbols = this._extractSymbols(src.slice(0, 2000));
            if (symbols.length > 0) {
                parts.push(`. Key symbols: ${symbols.join(', ')}`);
            }
            parts.push(']');
            return parts.join('');
        }

        // File tree results
        if (parsed.files && Array.isArray(parsed.files)) {
            const count = parsed.files.length;
            const sample = parsed.files.slice(0, 8).map(f => f.path || f).join(', ');
            return `[File tree: ${count} files. Sample: ${sample}]`;
        }

        // Search results
        if (parsed.matches && Array.isArray(parsed.matches)) {
            const count = parsed.matches.length;
            const files = [...new Set(parsed.matches.map(m => m.path || m.file).filter(Boolean))];
            return `[Search: ${count} matches in ${files.length} files: ${files.slice(0, 5).join(', ')}]`;
        }

        // Commit results
        if (parsed.committed || parsed.success) {
            return `[Tool result]: ${JSON.stringify(parsed).slice(0, 300)}`;
        }

        // Generic — structured truncation
        return `[Tool result]: ${JSON.stringify(parsed).slice(0, 400)}`;
    },

    /**
     * Extract key symbols (function names, class names, exports) from source code.
     * @param {string} src
     * @returns {string[]}
     */
    _extractSymbols(src) {
        if (!src) return [];
        const symbols = new Set();
        const patterns = [
            /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
            /(?:export\s+)?class\s+(\w+)/g,
            /(?:export\s+)?const\s+(\w+)\s*=/g,
            /(?:export\s+)?(?:let|var)\s+(\w+)\s*=/g,
            /(\w+)\s*:\s*(?:async\s+)?function/g,
            /def\s+(\w+)\s*\(/g,   // Python
            /fn\s+(\w+)\s*[<(]/g,  // Rust
        ];
        for (const pat of patterns) {
            let match;
            while ((match = pat.exec(src)) !== null) {
                const name = match[1];
                // Skip common noise
                if (name.length > 2 && !['use', 'var', 'let', 'for', 'new', 'try', 'get', 'set'].includes(name)) {
                    symbols.add(name);
                }
            }
            if (symbols.size >= 15) break;
        }
        return [...symbols].slice(0, 15);
    },

    /**
     * Fallback: extract topic snippets without LLM.
     * @param {ChatMessage[]} messages
     * @returns {string}
     */
    _basicSummary(messages) {
        const user = messages.filter(m => m.role === 'user');
        const asst = messages.filter(m => m.role === 'assistant');
        const tool = messages.filter(m => m.role === 'tool');
        const topics = user.map(m =>
            (typeof m.content === 'string' ? m.content : 'complex request').slice(0, 80)
        );
        // Include file paths from tool results
        const filePaths = new Set();
        tool.forEach(m => {
            try {
                const c = typeof m.content === 'string' ? JSON.parse(m.content) : m.content;
                if (c?.path) filePaths.add(c.path);
            } catch { /* ignore */ }
        });
        const fileNote = filePaths.size > 0 ? ` Files touched: ${[...filePaths].slice(0, 10).join(', ')}.` : '';
        return `${user.length} user / ${asst.length} assistant / ${tool.length} tool messages. Topics: ${topics.join('; ')}.${fileNote}`;
    },

    /**
     * Generate summary via LLM (non-blocking, fire-and-forget safe).
     * @returns {Promise<SummaryInfo|null>}
     */
    async generateAndStore() {
        if (!this.shouldSummarize()) return null;

        const history = State.chatHistory;
        const older = history.slice(0, -this.RECENT_COUNT);
        if (older.length < 5) return null;

        console.log(`[ChatSummarizer] Mode: ${this.mode} | Recent: ${this.RECENT_COUNT} | Threshold: ${this.SUMMARY_THRESHOLD} | Compressing ${older.length} messages`);
        if (this.mode !== 'custom') {
            const info = this.getAutoParams();
            console.log(`[ChatSummarizer] Fill: ${info.label} · Mode: ${this.mode}`);
        }

        let summary;
        try {
            const model = this._pickModel();
            // Use configurable summary timeout (default 60s)
            const summaryTimeout = State.settings.summaryTimeout || 60000;
            
            const result = await Promise.race([
                LLM.chat(
                    [{ role: 'user', content: this._buildPrompt(older) }],
                    { model, stream: false, temperature: 0.3, maxTokens: Math.ceil(this.SUMMARY_MAX_CHARS / 3.5) }
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
     * Prepends stored summary + recent messages. Ensures tool call sequences stay intact.
     *
     * @param {ChatMessage[]} [historyOverride] Optional pre-compressed history (1.2.0 Compactor integration). When provided, overrides State.chatHistory for window selection only — the summary prefix and tool-pair safety logic still run.
     * @returns {ChatMessage[]}
     */
    getContextMessages(historyOverride) {
        const history = Array.isArray(historyOverride) ? historyOverride : State.chatHistory;
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
