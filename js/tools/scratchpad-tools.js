/**
 * AI Editor - Scratchpad Tools
 * 
 * A lightweight key-value notepad the LLM uses to persist important details
 * across conversation exchanges. Survives summarization because it lives
 * outside chat history. Cleared on new chat.
 * 
 * Limits: 10 keys max, 500 chars per value, ~2K total auto-injected into
 * system prompt. Over that threshold, only keys are shown and the LLM
 * must explicitly read entries it needs.
 */

import { State } from '../core.js';

/** Max entries, max chars per entry, auto-inject threshold */
const MAX_KEYS = 10;
const MAX_VALUE_LEN = 500;
const AUTO_INJECT_CHARS = 2000;

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

        const pad = State.scratchpad || {};
        const existingKeys = Object.keys(pad);

        // Enforce max keys (allow overwrite of existing key)
        if (!pad.hasOwnProperty(k) && existingKeys.length >= MAX_KEYS) {
            return {
                error: `Scratchpad full (${MAX_KEYS} entries max). Remove an entry first or overwrite an existing key.`,
                keys: existingKeys
            };
        }

        const val = (content || '').slice(0, MAX_VALUE_LEN);
        pad[k] = val;
        State.scratchpad = pad;

        return {
            success: true,
            key: k,
            length: val.length,
            total_entries: Object.keys(pad).length,
            message: `Wrote "${k}" (${val.length} chars)`
        };
    }, {
        type: 'function',
        function: {
            name: 'scratchpad_write',
            description: 'Write a note to the scratchpad. Use this to persist important details you\'ll need later — file paths, decisions, architecture notes, issue details, function signatures. Notes survive chat summarization. Max 10 entries, 500 chars each.',
            parameters: {
                type: 'object',
                properties: {
                    key: {
                        type: 'string',
                        description: 'Short descriptive key (e.g., "working_files", "issue_details", "architecture_decision")'
                    },
                    content: {
                        type: 'string',
                        description: 'The note content (max 500 chars)'
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
 * If total content is under AUTO_INJECT_CHARS, dumps everything inline.
 * If over, shows only keys with a hint to use scratchpad_read.
 * 
 * @returns {string} Prompt section (empty string if scratchpad is empty)
 */
export function buildScratchpadPrompt() {
    const pad = State.scratchpad || {};
    const entries = Object.entries(pad);
    if (entries.length === 0) return '';

    const totalChars = entries.reduce((sum, [k, v]) => sum + k.length + v.length, 0);

    let section = '\n\n--- SCRATCHPAD (your persistent notes) ---\n';

    if (totalChars <= AUTO_INJECT_CHARS) {
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
