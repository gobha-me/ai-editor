/**
 * Chat History Summarizer
 * Compresses older chat messages into LLM-generated summaries.
 * 
 * Modes:
 *   - aggressive:   Summarize early & often — smaller recent windows, lower thresholds
 *   - balanced:     Default middle ground — matches context window tier directly
 *   - conservative: Preserve history — larger recent windows, higher thresholds
 *   - custom:       User-specified manual values
 * 
 * All non-custom modes are context-window-aware: detected tier is shifted
 * up/down depending on mode aggressiveness.
 */

import { State, EventBus, Storage } from '../core.js';
import { LLM } from '../llm.js';

/**
 * Context-window tiers (ordered largest → smallest).
 * Matched top-down — first tier whose threshold the model meets is used.
 * Tier index is then shifted by mode: aggressive shifts toward smaller,
 * conservative shifts toward larger.
 */
const TIERS = [
    {
        label: 'Huge (500K+)',
        minContext: 500_000,
        params: { recentCountBase: 60, recentCountTools: 100, threshold: 200, interval: 80, maxChars: 4000 }
    },
    {
        label: 'Large (128K+)',
        minContext: 128_000,
        params: { recentCountBase: 30, recentCountTools: 50, threshold: 80, interval: 40, maxChars: 3000 }
    },
    {
        label: 'Medium (32K+)',
        minContext: 32_000,
        params: { recentCountBase: 16, recentCountTools: 32, threshold: 50, interval: 25, maxChars: 2500 }
    },
    {
        label: 'Small (<32K)',
        minContext: 0,
        params: { recentCountBase: 10, recentCountTools: 24, threshold: 30, interval: 15, maxChars: 2000 }
    }
];

/** Mode → tier index shift. Positive = shift toward smaller (more aggressive). */
const MODE_SHIFT = {
    aggressive:   +1,
    balanced:      0,
    conservative: -1,
};

/**
 * Compresses older chat messages into LLM-generated summaries.
 * Keeps last N messages in full, summarizes everything older.
 * Uses the utility model (commitModel) to avoid burning tokens on the primary model.
 */
export const ChatSummarizer = {
    // Defaults — fallback for custom mode when values aren't set
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
     * Get the detected tier index for a context window size.
     * @param {number|null} contextTokens
     * @returns {number} Index into TIERS array
     */
    _getDetectedTierIndex(contextTokens) {
        if (!contextTokens) return TIERS.length - 1; // smallest
        const idx = TIERS.findIndex(t => contextTokens >= t.minContext);
        return idx >= 0 ? idx : TIERS.length - 1;
    },

    /**
     * Get the effective tier after applying mode shift.
     * @returns {{ label: string, params: Object, tierIndex: number }}
     */
    _getEffectiveTier() {
        const ctx = this._getContextWindow();
        const detected = this._getDetectedTierIndex(ctx);
        const mode = this.mode;
        const shift = MODE_SHIFT[mode] ?? 0;
        // Clamp shifted index to valid range
        const effective = Math.max(0, Math.min(TIERS.length - 1, detected + shift));
        return { ...TIERS[effective], tierIndex: effective, detectedIndex: detected };
    },

    /**
     * Get the effective parameters and metadata for the current model + mode.
     * @returns {{ label: string, contextTokens: number|null, params: Object, mode: string }}
     */
    getAutoParams() {
        const ctx = this._getContextWindow();
        const tier = this._getEffectiveTier();
        return { label: tier.label, contextTokens: ctx, params: { ...tier.params }, mode: this.mode };
    },

    /** @returns {'aggressive'|'balanced'|'conservative'|'custom'} */
    get mode() {
        const m = State.settings.summarizerMode || 'balanced';
        // Migrate old values
        if (m === 'auto') return 'balanced';
        if (m === 'manual') return 'custom';
        return m;
    },

    /** Read a summarizer setting with fallback: custom overrides → tier → hardcoded defaults */
    _cfg(key) {
        if (this.mode === 'custom') {
            const s = State.settings.summarizer;
            return (s && s[key] != null) ? s[key] : this._defaults[key];
        }
        // Named mode: use shifted tier params
        const tier = this._getEffectiveTier();
        return tier.params[key] ?? this._defaults[key];
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
     * Preserves file paths, line counts, and key identifiers
     * instead of discarding the entire content.
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
     * Used to preserve searchable identifiers in compressed tool results.
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

    /** Fallback: extract topic snippets without LLM */
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
     * Stores result in localStorage under 'chatSummaryInfo'.
     */
    async generateAndStore() {
        if (!this.shouldSummarize()) return null;

        const history = State.chatHistory;
        const older = history.slice(0, -this.RECENT_COUNT);
        if (older.length < 5) return null;

        console.log(`[ChatSummarizer] Mode: ${this.mode} | Recent: ${this.RECENT_COUNT} | Threshold: ${this.SUMMARY_THRESHOLD} | Compressing ${older.length} messages`);
        if (this.mode !== 'custom') {
            const info = this.getAutoParams();
            console.log(`[ChatSummarizer] Tier: ${info.label} (${info.contextTokens ? (info.contextTokens/1000).toFixed(0) + 'K' : 'unknown'} ctx) · Mode: ${this.mode}`);
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
