/**
 * AI Editor - Todo Tools (github#26)
 *
 * Structured task list the LLM owns and updates across a conversation.
 * Survives summarization the same way the scratchpad does — via
 * re-injection into the system prompt every turn (see buildTodoPrompt).
 * Conversation-scoped: persisted alongside chat history in the
 * `conv-{id}` payload by ConversationManager (js/chat/conversations.js).
 *
 * Shape mirrors Claude Code's TodoWrite for familiarity:
 *   { id: number, content: string, status: 'pending'|'in_progress'|'completed', activeForm?: string }
 *
 * Caps are hard (not summarizer-mode-scaled) because the structure itself
 * bounds size — 20 items × 200 chars ≈ 4 KB worst case, well under any
 * model's context budget regardless of mode.
 */

import { State } from '../core.js';

const MAX_ITEMS = 20;
const MAX_CONTENT_LEN = 200;
const MAX_ACTIVEFORM_LEN = 200;
const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed']);

/**
 * Validate and normalize a single todo entry. Returns either
 * `{ ok: true, todo }` with a sanitized item, or `{ ok: false, error }`.
 *
 * `id` must be present and resolve to a finite number — the LLM assigns
 * stable ids so it can refer to items across turns. We don't auto-generate.
 */
function _validateTodo(raw, index) {
    if (!raw || typeof raw !== 'object') {
        return { ok: false, error: `todos[${index}] must be an object` };
    }
    const id = Number(raw.id);
    if (!Number.isFinite(id)) {
        return { ok: false, error: `todos[${index}].id is required and must be a number` };
    }
    if (typeof raw.content !== 'string' || raw.content.trim() === '') {
        return { ok: false, error: `todos[${index}].content is required and must be a non-empty string` };
    }
    if (typeof raw.status !== 'string' || !VALID_STATUSES.has(raw.status)) {
        return {
            ok: false,
            error: `todos[${index}].status must be one of: pending, in_progress, completed (got: ${JSON.stringify(raw.status)})`,
        };
    }
    const todo = {
        id,
        content: raw.content.slice(0, MAX_CONTENT_LEN),
        status: raw.status,
    };
    if (raw.activeForm !== undefined) {
        if (typeof raw.activeForm !== 'string') {
            return { ok: false, error: `todos[${index}].activeForm must be a string when provided` };
        }
        todo.activeForm = raw.activeForm.slice(0, MAX_ACTIVEFORM_LEN);
    }
    return { ok: true, todo };
}

function _summarize(list) {
    const by_status = { pending: 0, in_progress: 0, completed: 0 };
    for (const t of list) by_status[t.status] = (by_status[t.status] || 0) + 1;
    return { total: list.length, by_status };
}

/**
 * Register todo tools.
 * @param {Object} registry - ToolRegistry instance
 */
export function registerTodoTools(registry) {

    // ========================================
    // todo_write — full-list replace
    // ========================================
    registry.register('todo_write', async ({ todos } = {}) => {
        if (!Array.isArray(todos)) {
            return { error: '`todos` is required and must be an array' };
        }
        if (todos.length > MAX_ITEMS) {
            return {
                error: `Too many items (${todos.length}). Max ${MAX_ITEMS}. Drop completed items or merge related ones.`,
                max_items: MAX_ITEMS,
            };
        }

        const seenIds = new Set();
        const validated = [];
        for (let i = 0; i < todos.length; i++) {
            const v = _validateTodo(todos[i], i);
            if (!v.ok) return { error: v.error };
            if (seenIds.has(v.todo.id)) {
                return { error: `Duplicate id ${v.todo.id} at todos[${i}]. Each todo needs a unique id.` };
            }
            seenIds.add(v.todo.id);
            validated.push(v.todo);
        }

        State.todo = validated;
        const sum = _summarize(validated);
        return {
            success: true,
            total: sum.total,
            by_status: sum.by_status,
            message: `Saved ${sum.total} todo${sum.total === 1 ? '' : 's'} (${sum.by_status.in_progress} in progress, ${sum.by_status.pending} pending, ${sum.by_status.completed} completed)`,
        };
    }, {
        type: 'function',
        function: {
            name: 'todo_write',
            description: 'Replace the conversation\'s structured todo list. Use this to track multi-step work — write the full list each time (this tool is a full replace, not a patch). The list survives chat summarization and appears in your context every turn so you always know what\'s next.',
            parameters: {
                type: 'object',
                properties: {
                    todos: {
                        type: 'array',
                        description: `Full todo list (max ${MAX_ITEMS} items). Provide the entire list each call — this is a full replace.`,
                        items: {
                            type: 'object',
                            properties: {
                                id: {
                                    type: 'number',
                                    description: 'Stable integer id you assign. Reuse the same id across turns to refer to the same todo.',
                                },
                                content: {
                                    type: 'string',
                                    description: `Imperative-form description (max ${MAX_CONTENT_LEN} chars), e.g. "Add retry logic to auth-handler.js"`,
                                },
                                status: {
                                    type: 'string',
                                    enum: ['pending', 'in_progress', 'completed'],
                                    description: 'Lifecycle state of this item.',
                                },
                                activeForm: {
                                    type: 'string',
                                    description: 'Optional present-continuous form for UI display, e.g. "Adding retry logic". Max 200 chars.',
                                },
                            },
                            required: ['id', 'content', 'status'],
                        },
                    },
                },
                required: ['todos'],
            },
        },
        roles: 'all',
    });

    // ========================================
    // todo_read
    // ========================================
    registry.register('todo_read', async () => {
        const list = State.todo || [];
        if (list.length === 0) {
            return { message: 'Todo list is empty', todos: [] };
        }
        return {
            ...(_summarize(list)),
            todos: list,
        };
    }, {
        type: 'function',
        function: {
            name: 'todo_read',
            description: 'Read the current structured todo list for this conversation. Returns an empty list when nothing has been written. The list also appears in your context automatically each turn — you usually don\'t need to call this.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
        roles: 'all',
        readOnly: true,
    });
}

// ============================================
// SYSTEM PROMPT HELPER
// ============================================

const STATUS_GLYPH = {
    pending: ' ',
    in_progress: '~',
    completed: 'x',
};

/**
 * Build the todo section for the system prompt. Empty list → empty string.
 * Compact format keeps token cost minimal (~30-40 tokens for a 5-item list).
 *
 * Example output (5 items, mid-task):
 *
 *   --- TODO LIST (5 items: 1 in progress, 2 pending, 2 completed) ---
 *   [x] (1) Read the issue and capture acceptance criteria
 *   [x] (2) Sketch the API surface
 *   [~] (3) Wire the tool into the registry
 *   [ ] (4) Add unit tests
 *   [ ] (5) Update CHANGELOG and bump version
 *
 * @returns {string} Prompt section (empty string when no todos)
 */
export function buildTodoPrompt() {
    const list = State.todo || [];
    if (list.length === 0) return '';

    const sum = _summarize(list);
    const header = `\n\n--- TODO LIST (${sum.total} item${sum.total === 1 ? '' : 's'}: ${sum.by_status.in_progress} in progress, ${sum.by_status.pending} pending, ${sum.by_status.completed} completed) ---`;

    const lines = list.map(t => {
        const glyph = STATUS_GLYPH[t.status] || '?';
        return `[${glyph}] (${t.id}) ${t.content}`;
    });

    return `${header}\n${lines.join('\n')}\n`;
}
