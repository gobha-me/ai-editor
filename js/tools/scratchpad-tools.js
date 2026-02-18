/**
 * AI Editor - Scratchpad Tools
 * 
 * A lightweight key-value notepad the LLM uses to persist important details
 * across conversation exchanges. Survives summarization because it lives
 * outside chat history. Cleared on new chat.
 * 
 * Limits scale with summarizer mode (tied to model context capability):
 *   aggressive:   8 keys,  400 chars/value,  1.5K auto-inject (30% fill)
 *   balanced:     15 keys, 1000 chars/value,  4K auto-inject  (50% fill)
 *   conservative: 20 keys, 2000 chars/value,  8K auto-inject  (75% fill)
 *   custom:       15 keys, 1000 chars/value,  4K auto-inject  (user values)
 */

import { State } from '../core.js';

/**
 * Scratchpad limits per summarizer mode (scaled to context capability).
 * Duplicated here to avoid circular dependency (summarizer → llm → prompts → scratchpad).
 */
const SCRATCHPAD_LIMITS = {
    aggressive:   { maxKeys: 8,  maxValueLen: 400,  autoInjectChars: 1500 },
    balanced:     { maxKeys: 15, maxValueLen: 1000, autoInjectChars: 4000 },
    conservative: { maxKeys: 20, maxValueLen: 2000, autoInjectChars: 8000 },
    custom:       { maxKeys: 15, maxValueLen: 1000, autoInjectChars: 4000 },
};

/** Get current limits based on summarizer mode */
function _limits() {
    let mode = State.settings.summarizerMode || 'balanced';
    // Migrate legacy
    if (mode === 'auto') mode = 'balanced';
    if (mode === 'manual') mode = 'custom';
    return SCRATCHPAD_LIMITS[mode] || SCRATCHPAD_LIMITS.balanced;
}

/**
 * Register scratchpad tools.
 * @param {Object} registry - ToolRegistry instance
 */
export function registerScratchpadTools(registry) {

    // ========================================
    // scratchpad_write
    // ========================================
    registry.register('scratchpad_write', async ({ key, content }) => {
        if (!key || typeof key !== 'string') {
            return { error: 'Key is required and must be a string' };
        }

        const k = key.trim().slice(0, 60);
        if (!k) return { error: 'Key cannot be empty' };

        const lim = _limits();
        const pad = State.scratchpad || {};
        const existingKeys = Object.keys(pad);

        // Enforce max keys (allow overwrite of existing key)
        if (!pad.hasOwnProperty(k) && existingKeys.length >= lim.maxKeys) {
            return {
                error: `Scratchpad full (${lim.maxKeys} entries max). Remove an entry first or overwrite an existing key.`,
                keys: existingKeys
            };
        }

        const val = (content || '').slice(0, lim.maxValueLen);
        const wasTruncated = (content || '').length > lim.maxValueLen;
        pad[k] = val;
        State.scratchpad = pad;

        const result = {
            success: true,
            key: k,
            length: val.length,
            max_length: lim.maxValueLen,
            total_entries: Object.keys(pad).length,
            max_entries: lim.maxKeys,
            message: `Wrote "${k}" (${val.length}/${lim.maxValueLen} chars)`
        };
        if (wasTruncated) {
            result.truncated = true;
            result.original_length = (content || '').length;
            result.hint = `Content was truncated from ${(content || '').length} to ${lim.maxValueLen} chars. Split across multiple keys if you need to store more.`;
        }
        return result;
    }, {
        type: 'function',
        function: {
            name: 'scratchpad_write',
            description: 'Write a note to the scratchpad. Use this to persist important details you\'ll need later — file paths, decisions, architecture notes, issue details, function signatures. Notes survive chat summarization. Limits scale with model context.',
            parameters: {
                type: 'object',
                properties: {
                    key: {
                        type: 'string',
                        description: 'Short descriptive key (e.g., "working_files", "issue_details", "architecture_decision")'
                    },
                    content: {
                        type: 'string',
                        description: 'The note content'
                    }
                },
                required: ['key', 'content']
            }
        },
        roles: 'all'
    });

    // ========================================
    // scratchpad_read
    // ========================================
    registry.register('scratchpad_read', async ({ key } = {}) => {
        const pad = State.scratchpad || {};

        if (key) {
            const k = key.trim();
            if (pad.hasOwnProperty(k)) {
                return { key: k, content: pad[k] };
            }
            return { error: `Key "${k}" not found`, available_keys: Object.keys(pad) };
        }

        // Return all entries
        const entries = Object.entries(pad);
        if (entries.length === 0) {
            return { message: 'Scratchpad is empty', entries: {} };
        }

        return {
            total_entries: entries.length,
            entries: Object.fromEntries(entries)
        };
    }, {
        type: 'function',
        function: {
            name: 'scratchpad_read',
            description: 'Read from the scratchpad. Omit key to read all entries, or specify a key to read a specific note.',
            parameters: {
                type: 'object',
                properties: {
                    key: {
                        type: 'string',
                        description: 'Key to read (optional — omit to read all entries)'
                    }
                },
                required: []
            }
        },
        roles: 'all'
    });

    // ========================================
    // scratchpad_clear
    // ========================================
    registry.register('scratchpad_clear', async ({ key } = {}) => {
        const pad = State.scratchpad || {};

        if (key) {
            const k = key.trim();
            if (!pad.hasOwnProperty(k)) {
                return { error: `Key "${k}" not found`, available_keys: Object.keys(pad) };
            }
            delete pad[k];
            State.scratchpad = pad;
            return {
                success: true,
                removed: k,
                remaining_entries: Object.keys(pad).length,
                message: `Removed "${k}"`
            };
        }

        // Clear everything
        State.scratchpad = {};
        return {
            success: true,
            message: 'Scratchpad cleared'
        };
    }, {
        type: 'function',
        function: {
            name: 'scratchpad_clear',
            description: 'Clear scratchpad entries. Specify a key to remove one entry, or omit to clear everything.',
            parameters: {
                type: 'object',
                properties: {
                    key: {
                        type: 'string',
                        description: 'Key to remove (optional — omit to clear all)'
                    }
                },
                required: []
            }
        },
        roles: 'all'
    });
}

// ============================================
// SYSTEM PROMPT HELPER
// ============================================

/**
 * Build the scratchpad section for the system prompt.
 * If total content is under auto-inject threshold, dumps everything inline.
 * If over, shows only keys with a hint to use scratchpad_read.
 * Also injects a summary countdown when approaching the next summarization.
 * 
 * @returns {string} Prompt section (empty string if scratchpad is empty and no countdown)
 */
export function buildScratchpadPrompt() {
    const lim = _limits();
    const pad = State.scratchpad || {};
    const entries = Object.entries(pad);

    let section = '';

    // Summary countdown — encourage note-taking before summarization
    // Self-contained estimate to avoid circular dep on ChatSummarizer
    try {
        const total = (State.chatHistory || []).length;
        const mode = State.settings.summarizerMode || 'balanced';
        // Derive threshold/interval from context window (matches summarizer % logic)
        const fillPct = { aggressive: 0.30, balanced: 0.50, conservative: 0.75 }[mode] || 0.50;
        let threshold = 30, interval = 15;
        try {
            const modelId = State.settings.llmModel;
            const model = (State.models || []).find(m => m.id === modelId);
            const ctx = model?.meta?.contextTokens;
            if (ctx) {
                const cap = Math.max(20, Math.min(250, Math.floor(ctx * fillPct / 800)));
                threshold = Math.max(20, Math.min(200, cap));
                interval = Math.max(10, Math.min(80, Math.round(cap * 0.45)));
            }
        } catch { /* ignore — use defaults */ }

        if (total >= threshold - interval) {
            // Try to read actual coveredCount from storage
            let coveredCount = 0;
            try {
                const info = JSON.parse(localStorage.getItem('chatSummaryInfo') || 'null');
                coveredCount = info?.coveredCount || 0;
            } catch { /* ignore */ }

            const messagesSinceLast = total - coveredCount;
            let remaining;
            if (total < threshold) {
                remaining = Math.ceil((threshold - total) / 2);
            } else {
                remaining = Math.max(0, Math.ceil((interval - messagesSinceLast) / 2));
            }

            if (remaining <= 8) {
                section += `\n\n⚠️ CONTEXT MANAGEMENT: Chat summarization will occur in ~${remaining} message${remaining !== 1 ? 's' : ''}. `
                    + 'Important details not in the scratchpad may be compressed. '
                    + `Use scratchpad_write to preserve key info (${lim.maxKeys} entries, ${lim.maxValueLen} chars each).`;
            }
        }
    } catch { /* ignore — summarizer may not be loaded */ }

    if (entries.length === 0) return section;

    const totalChars = entries.reduce((sum, [k, v]) => sum + k.length + v.length, 0);

    section += '\n\n--- SCRATCHPAD (your persistent notes) ---\n';

    if (totalChars <= lim.autoInjectChars) {
        // Dump everything inline
        for (const [k, v] of entries) {
            section += `[${k}]: ${v}\n`;
        }
    } else {
        // Too large — show keys only
        section += `${entries.length} entries (${totalChars} chars total). Keys: ${entries.map(([k]) => k).join(', ')}\n`;
        section += 'Use scratchpad_read to retrieve specific entries.\n';
    }

    return section;
}
