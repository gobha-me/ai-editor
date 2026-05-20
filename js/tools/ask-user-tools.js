// @ts-check
/**
 * AI Editor - ask_user Tool (github#33 Phase 1)
 *
 * Lets the LLM present a structured question to the user inline in the
 * chat. The handler returns a Promise that the AskUserCard component
 * resolves when the user submits — from the chat loop's perspective
 * `ask_user` is just a slow-running tool. No new pause-and-resume
 * infrastructure: handlers.js bypasses the 30s timeout for this tool
 * (USER_PAUSE_TOOLS), and the cancel path calls `cancelUserResponse`
 * to release the awaited Promise.
 *
 * Phase 1 scope:
 *   - Three modes: single_choice, multi_select, free_text
 *   - allow_custom (default true) adds a free-text field alongside choices
 *   - One pending question at a time (no nesting / queueing)
 *   - Cancel via the Stop button releases the Promise with a cancelled envelope
 *
 * Out of scope (Feature 2 of #33, separate PR): queued user input during
 * long runs, persistence across reloads.
 *
 * @module tools/ask-user-tools
 */

import { setPendingUserResponse } from '../chat/state.js';

const VALID_TYPES = new Set(['single_choice', 'multi_select', 'free_text']);

/**
 * Validate the args bundle. Returns `null` on success or an `{ error }`
 * envelope on failure (the registry forwards it to the LLM unchanged).
 *
 * @param {Object} args
 * @returns {{error: string} | null}
 */
function _validate(args) {
    if (!args || typeof args !== 'object') {
        return { error: 'ask_user requires an arguments object.' };
    }
    if (typeof args.question !== 'string' || !args.question.trim()) {
        return { error: 'ask_user requires a non-empty "question" string.' };
    }
    if (!VALID_TYPES.has(args.type)) {
        return {
            error: 'ask_user "type" must be one of: ' + [...VALID_TYPES].join(', ') +
                '. Got: ' + JSON.stringify(args.type),
        };
    }
    if (args.type !== 'free_text') {
        if (!Array.isArray(args.options) || args.options.length === 0) {
            return {
                error: 'ask_user with type="' + args.type +
                    '" requires a non-empty "options" array of {label,value} entries.',
            };
        }
        for (let i = 0; i < args.options.length; i++) {
            const o = args.options[i];
            if (!o || typeof o !== 'object' || typeof o.label !== 'string' || typeof o.value !== 'string') {
                return {
                    error: 'ask_user options[' + i + '] must have string "label" and "value" fields.',
                };
            }
        }
    }
    return null;
}

/**
 * Register the ask_user tool.
 * @param {{register: Function}} registry
 */
export function registerAskUserTools(registry) {
    registry.register('ask_user', async (args) => {
        const invalid = _validate(args);
        if (invalid) return invalid;

        const allowCustom = args.allow_custom !== false; // default true
        const normalized = {
            question: args.question,
            type: args.type,
            options: args.type === 'free_text' ? [] : args.options,
            allow_custom: allowCustom,
        };

        return new Promise((resolve) => {
            setPendingUserResponse({ ...normalized, resolve });
        });
    }, {
        type: 'function',
        function: {
            name: 'ask_user',
            description: 'Ask the user a structured question with optional choices, free-text, or both — pauses the chat loop until they answer. Use when you need a decision (architecture choice, scope question, naming) rather than guessing or asking in free text.',
            parameters: {
                type: 'object',
                properties: {
                    question: {
                        type: 'string',
                        description: 'The question to ask the user. Be specific.',
                    },
                    type: {
                        type: 'string',
                        enum: ['single_choice', 'multi_select', 'free_text'],
                        description: 'Interaction type. single_choice = radio buttons (one value); multi_select = checkboxes (zero or more values); free_text = text area only.',
                    },
                    options: {
                        type: 'array',
                        description: 'Required for single_choice and multi_select. Each entry: {label,value,description?}.',
                        items: {
                            type: 'object',
                            properties: {
                                label: { type: 'string', description: 'Display text for the option.' },
                                value: { type: 'string', description: 'Stable identifier returned in the answer.' },
                                description: { type: 'string', description: 'Optional clarifier shown beside the option.' },
                            },
                            required: ['label', 'value'],
                        },
                    },
                    allow_custom: {
                        type: 'boolean',
                        description: 'Whether to render a free-text input alongside the choices for custom user responses. Default: true. Ignored when type="free_text" (always shown).',
                    },
                },
                required: ['question', 'type'],
            },
        },
        // Plan-mode safe: pauses the loop for input but doesn't mutate
        // file or repo state. The LLM may need to ask clarifying
        // questions before producing a plan.
        readOnly: true,
        // Result depends on the user's response — same args may
        // legitimately yield different answers across the conversation.
        // Migrated from the legacy `STATEFUL_READ_TOOLS` hand-list.
        cache: 'never',
    });
}
