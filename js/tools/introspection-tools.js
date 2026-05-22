// @ts-check
/**
 * AI Editor — Introspection tools (gitea#504, self-introspection Phase 1).
 *
 * Three read-only handlers that let the model inspect its own conversation
 * history without leaving the chat surface:
 *
 *   - list_conversations()                                → {active_id, count, conversations[]}
 *   - read_chat_history({conversation_id?, offset?, limit?}) → {conversation_id, total, messages[]}
 *   - search_chat_history({query, conversation_id?, max_hits?}) → {query, scope, count, hits[]}
 *
 * Shape mirrors the meta-tool surface (`list_tool_categories → list_tools_by_category
 * → find_tool`) so the discovery affordance is recognizable. Tokenization for
 * search re-uses the AND-match strategy from `_scoreCategorical` in
 * `meta-tools.js:53-66`.
 *
 * Under the 3.X amendment direction (`docs/discussion/3.0-amendment-implementation.md`
 * §7), a fresh `Coder` sub-agent on spawn reads what PM has curated through these
 * tools. Phase 1 ships under the current 2.X substrate; Phase 2 (gitea#506) adds
 * runtime state + telemetry readers. Sub-agent transcript inspection
 * (`read_subagent_transcript`) is deferred to a follow-up — PM curates in chat
 * history, not in sub-agent panels.
 *
 * @module tools/introspection-tools
 */

import { State, Storage } from '../core.js';
import { ConversationManager } from '../chat/conversations.js';

const READ_DEFAULT_LIMIT = 20;
const READ_MAX_LIMIT = 100;
const SEARCH_DEFAULT_MAX_HITS = 10;
const SEARCH_MAX_MAX_HITS = 50;
const SEARCH_SNIPPET_CHARS = 200;
const LIST_MAX = 50;

/* -------------------------------------------------------------------------- */
/* Content normalization — handle multimodal arrays + tool-call-only assistant */
/* messages + tool result messages without leaking renderer internals.        */
/* -------------------------------------------------------------------------- */

/**
 * Reduce a message to a stable `{content, tool_calls?}` shape the model can
 * read. Inputs come from the live `State.chatHistory` (assistant text, user
 * text, multimodal arrays, tool results) or a persisted conversation payload.
 *
 * - String content: returned verbatim.
 * - Array content (multimodal): text parts joined, image parts replaced with
 *   `[image]` so the snippet stays scannable without bloating with base64.
 * - Tool-call-only assistant turns (`content: ''` + `tool_calls`): synthesize
 *   a one-line summary like `<tool_calls: read_file, edit_file>`.
 * - Tool result messages: surface `content` as-is; `_display` is renderer
 *   state and is dropped.
 *
 * @param {Object} msg
 * @returns {{ content: string, tool_calls?: Array<{name:string}> }}
 */
function normalizeMessage(msg) {
    if (!msg || typeof msg !== 'object') {
        return { content: '' };
    }
    const role = msg.role;
    const rawContent = msg.content;
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : null;

    let content = '';
    if (typeof rawContent === 'string') {
        content = rawContent;
    } else if (Array.isArray(rawContent)) {
        const parts = [];
        for (const part of rawContent) {
            if (!part || typeof part !== 'object') continue;
            if (part.type === 'text' && typeof part.text === 'string') {
                parts.push(part.text);
            } else if (part.type === 'image_url') {
                parts.push('[image]');
            }
        }
        content = parts.join(' ');
    }

    if (role === 'assistant' && content === '' && calls && calls.length > 0) {
        const names = calls
            .map(c => (c && c.function && typeof c.function.name === 'string') ? c.function.name : null)
            .filter(n => n !== null);
        content = `<tool_calls: ${names.join(', ')}>`;
    }

    const out = { content };
    if (calls && calls.length > 0) {
        out.tool_calls = calls
            .map(c => {
                const name = (c && c.function && typeof c.function.name === 'string')
                    ? c.function.name
                    : null;
                return name ? { name } : null;
            })
            .filter(x => x !== null);
    }
    return out;
}

/**
 * Tokenize a search query the same way `_scoreCategorical` does: lowercase,
 * split on whitespace, drop tokens shorter than 2 characters. Shared so the
 * model's mental model of "what counts as a word" matches across `find_tool`
 * and `search_chat_history`.
 *
 * @param {string} query
 * @returns {string[]}
 */
function tokenize(query) {
    if (typeof query !== 'string') return [];
    return query
        .toLowerCase()
        .split(/\s+/)
        .filter(t => t.length >= 2);
}

/**
 * Score a message against tokenized query terms. AND-match: returns 0 unless
 * every token is present at least once in the normalized content. Score is the
 * sum of substring occurrence counts so a message that mentions a term three
 * times outranks one that mentions it once.
 *
 * @param {string} normalizedContent  Already lowercased.
 * @param {string[]} tokens
 * @returns {number}
 */
function scoreMessage(normalizedContent, tokens) {
    if (tokens.length === 0) return 0;
    let total = 0;
    for (const tok of tokens) {
        let count = 0;
        let idx = 0;
        while (true) {
            const found = normalizedContent.indexOf(tok, idx);
            if (found === -1) break;
            count += 1;
            idx = found + tok.length;
        }
        if (count === 0) return 0;
        total += count;
    }
    return total;
}

/**
 * Carve a snippet around the first occurrence of any token. Caps at
 * `SEARCH_SNIPPET_CHARS` characters total with `…` markers when truncated.
 *
 * @param {string} content  Original-case content.
 * @param {string} normalizedContent  Lowercased mirror.
 * @param {string[]} tokens
 * @returns {string}
 */
function makeSnippet(content, normalizedContent, tokens) {
    if (content.length <= SEARCH_SNIPPET_CHARS) return content;
    let firstHit = -1;
    for (const tok of tokens) {
        const at = normalizedContent.indexOf(tok);
        if (at !== -1 && (firstHit === -1 || at < firstHit)) {
            firstHit = at;
        }
    }
    if (firstHit === -1) {
        return content.slice(0, SEARCH_SNIPPET_CHARS) + '…';
    }
    const half = Math.floor(SEARCH_SNIPPET_CHARS / 2);
    const start = Math.max(0, firstHit - half);
    const end = Math.min(content.length, start + SEARCH_SNIPPET_CHARS);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < content.length ? '…' : '';
    return prefix + content.slice(start, end) + suffix;
}

/* -------------------------------------------------------------------------- */
/* Conversation access — active vs other                                       */
/* -------------------------------------------------------------------------- */

/**
 * Fetch the messages array for a conversation by id. Returns the in-memory
 * `State.chatHistory` mirror when the id matches the active conversation
 * (avoids a redundant IDB read); otherwise reads the persisted payload.
 *
 * Returns null when the id is unknown so the caller can return a friendly
 * error envelope rather than crash on `null.length`.
 *
 * @param {string} convId
 * @returns {Array|null}
 */
function getMessagesForId(convId) {
    if (!convId || typeof convId !== 'string') return null;
    const activeId = ConversationManager.getActiveId();
    if (convId === activeId) {
        return State.chatHistory;
    }
    const payload = Storage.get(`conv-${convId}`);
    if (!payload || !Array.isArray(payload.messages)) return null;
    return payload.messages;
}

/**
 * Resolve the conversation_id arg the same way every introspection tool does:
 * trim the input, fall back to the active id when omitted, return null when no
 * conversation exists at all (empty fresh session).
 *
 * @param {unknown} input
 * @returns {string|null}
 */
function resolveConvId(input) {
    if (typeof input === 'string' && input.trim().length > 0) {
        return input.trim();
    }
    return ConversationManager.getActiveId();
}

/* -------------------------------------------------------------------------- */
/* Tool registration                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Register the three introspection tools on the supplied registry. Idempotent
 * only across registry-clear/register cycles (matches every other
 * `register*Tools` factory in `js/tools/`).
 *
 * @param {Object} registry  ToolRegistry instance.
 */
export function registerIntrospectionTools(registry) {

    /* ============================================================ */
    /* list_conversations                                           */
    /* ============================================================ */
    registry.register('list_conversations', async () => {
        const activeId = ConversationManager.getActiveId();
        const all = ConversationManager.list();
        const conversations = all.slice(0, LIST_MAX).map(c => ({
            id: c.id,
            title: c.title,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            messageCount: c.messageCount,
        }));
        return {
            active_id: activeId,
            count: conversations.length,
            conversations,
        };
    }, {
        type: 'function',
        function: {
            name: 'list_conversations',
            description: 'Enumerate stored chat conversations with id, title, timestamps, and messageCount, plus the active conversation id. The cheapest introspection call — use this first when you need to figure out which conversations exist or which one is current. Returns up to 50 conversations sorted by most-recent-update first.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
        readOnly: true,
        cache: 'never',
    });

    /* ============================================================ */
    /* read_chat_history                                            */
    /* ============================================================ */
    registry.register('read_chat_history', async (args) => {
        const a = args || {};

        if (a.limit !== undefined) {
            if (typeof a.limit !== 'number' || !Number.isInteger(a.limit) || a.limit < 1) {
                return { error: 'limit must be a positive integer.' };
            }
            if (a.limit > READ_MAX_LIMIT) {
                return { error: `limit cannot exceed ${READ_MAX_LIMIT}. Paginate with offset instead.` };
            }
        }
        if (a.offset !== undefined) {
            if (typeof a.offset !== 'number' || !Number.isInteger(a.offset) || a.offset < 0) {
                return { error: 'offset must be a non-negative integer.' };
            }
        }

        const convId = resolveConvId(a.conversation_id);
        if (!convId) {
            return {
                conversation_id: null,
                total: 0,
                offset: 0,
                limit: a.limit || READ_DEFAULT_LIMIT,
                messages: [],
                message: 'No active conversation. Start a chat first or call list_conversations.',
            };
        }

        const messages = getMessagesForId(convId);
        if (messages === null) {
            return { error: `Conversation not found: ${convId}. Call list_conversations to see valid ids.` };
        }

        const offset = a.offset || 0;
        const limit = a.limit || READ_DEFAULT_LIMIT;
        const slice = messages.slice(offset, offset + limit);

        const out = slice.map((msg, i) => {
            const normalized = normalizeMessage(msg);
            const entry = {
                index: offset + i,
                role: msg.role || 'unknown',
                content: normalized.content,
            };
            if (typeof msg.timestamp === 'number') entry.timestamp = msg.timestamp;
            if (normalized.tool_calls) entry.tool_calls = normalized.tool_calls;
            return entry;
        });

        return {
            conversation_id: convId,
            total: messages.length,
            offset,
            limit,
            messages: out,
        };
    }, {
        type: 'function',
        function: {
            name: 'read_chat_history',
            description: 'Read a slice of messages from a conversation. Default scope is the active conversation; pass conversation_id to read another. Returns {conversation_id, total, offset, limit, messages}. Each message has {index, role, content, timestamp?, tool_calls?}. Tool-call-only assistant turns are summarized as <tool_calls: name1, name2>; multimodal content is text-flattened with [image] markers.',
            parameters: {
                type: 'object',
                properties: {
                    conversation_id: {
                        type: 'string',
                        description: 'Optional: id of the conversation to read. Defaults to the active conversation. Get valid ids from list_conversations.',
                    },
                    offset: {
                        type: 'number',
                        description: `Optional: 0-based starting index. Default 0.`,
                    },
                    limit: {
                        type: 'number',
                        description: `Optional: max messages to return. Default ${READ_DEFAULT_LIMIT}, max ${READ_MAX_LIMIT}.`,
                    },
                },
                required: [],
            },
        },
        readOnly: true,
        cache: 'never',
    });

    /* ============================================================ */
    /* search_chat_history                                          */
    /* ============================================================ */
    registry.register('search_chat_history', async (args) => {
        const a = args || {};

        if (typeof a.query !== 'string' || a.query.trim().length === 0) {
            return { error: 'query is required (string). Provide a freeform search phrase.' };
        }
        if (a.max_hits !== undefined) {
            if (typeof a.max_hits !== 'number' || !Number.isInteger(a.max_hits) || a.max_hits < 1) {
                return { error: 'max_hits must be a positive integer.' };
            }
            if (a.max_hits > SEARCH_MAX_MAX_HITS) {
                return { error: `max_hits cannot exceed ${SEARCH_MAX_MAX_HITS}.` };
            }
        }

        const tokens = tokenize(a.query);
        if (tokens.length === 0) {
            return {
                query: a.query,
                scope: typeof a.conversation_id === 'string' ? a.conversation_id : (ConversationManager.getActiveId() || null),
                count: 0,
                hits: [],
                message: 'Query produced no scorable tokens (need at least one token of length ≥ 2).',
            };
        }

        const maxHits = a.max_hits || SEARCH_DEFAULT_MAX_HITS;
        const wantAll = a.conversation_id === '*';

        let scopeIds;
        let scopeLabel;
        if (wantAll) {
            scopeIds = ConversationManager.list().map(c => c.id);
            scopeLabel = '*';
        } else {
            const convId = resolveConvId(a.conversation_id);
            if (!convId) {
                return {
                    query: a.query,
                    scope: null,
                    count: 0,
                    hits: [],
                    message: 'No active conversation. Start a chat first or pass conversation_id.',
                };
            }
            scopeIds = [convId];
            scopeLabel = convId;
        }

        const hits = [];

        outer:
        for (const convId of scopeIds) {
            const messages = getMessagesForId(convId);
            if (messages === null) continue;
            for (let i = 0; i < messages.length; i++) {
                const msg = messages[i];
                const normalized = normalizeMessage(msg);
                if (!normalized.content) continue;
                const lower = normalized.content.toLowerCase();
                const score = scoreMessage(lower, tokens);
                if (score === 0) continue;
                hits.push({
                    conversation_id: convId,
                    message_index: i,
                    role: msg.role || 'unknown',
                    snippet: makeSnippet(normalized.content, lower, tokens),
                    timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : null,
                    score,
                });
                if (hits.length >= maxHits * 4) break outer;
            }
        }

        hits.sort((x, y) => {
            if (y.score !== x.score) return y.score - x.score;
            const tx = x.timestamp || 0;
            const ty = y.timestamp || 0;
            return ty - tx;
        });

        const limited = hits.slice(0, maxHits);
        return {
            query: a.query,
            scope: scopeLabel,
            count: limited.length,
            hits: limited,
        };
    }, {
        type: 'function',
        function: {
            name: 'search_chat_history',
            description: 'Keyword search across chat messages. Tokenized AND-match (whitespace-split, ≥2-char tokens, case-insensitive); a message hits only when every token appears at least once. Default scope is the active conversation; pass conversation_id to scope to one, or "*" to scan all stored conversations. Returns up to max_hits hits sorted by score desc then recency.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Freeform search phrase (e.g. "compression bug", "API key rotation").',
                    },
                    conversation_id: {
                        type: 'string',
                        description: 'Optional: id of a single conversation, or "*" to scan all. Defaults to the active conversation.',
                    },
                    max_hits: {
                        type: 'number',
                        description: `Optional: max hits to return. Default ${SEARCH_DEFAULT_MAX_HITS}, max ${SEARCH_MAX_MAX_HITS}.`,
                    },
                },
                required: ['query'],
            },
        },
        readOnly: true,
        cache: 'never',
    });
}

// Test seams.
export const _testing = {
    normalizeMessage,
    tokenize,
    scoreMessage,
    makeSnippet,
    getMessagesForId,
    resolveConvId,
    READ_DEFAULT_LIMIT,
    READ_MAX_LIMIT,
    SEARCH_DEFAULT_MAX_HITS,
    SEARCH_MAX_MAX_HITS,
    SEARCH_SNIPPET_CHARS,
    LIST_MAX,
};
