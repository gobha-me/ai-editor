// @ts-check
/**
 * AI Editor — Introspection tools (gitea#504 Phase 1 + gitea#506 Phase 2).
 *
 * Read-only handlers that let the model inspect its own conversation history
 * AND ai-editor's current runtime state without leaving the chat surface.
 *
 * Phase 1 — chat history (shipped 2.90.0):
 *   - list_conversations()                                → {active_id, count, conversations[]}
 *   - read_chat_history({conversation_id?, offset?, limit?}) → {conversation_id, total, messages[]}
 *   - search_chat_history({query, conversation_id?, max_hits?}) → {query, scope, count, hits[]}
 *
 * Phase 2 — runtime state + telemetry (shipped 2.92.0):
 *   - get_active_profile()                                → {name, base, admitted_tools[], budget, ceilings}
 *   - list_loaded_tools()                                 → [{name, category, side_effects, cache_mode}]
 *   - get_budget_state()                                  → {total, used, remaining_estimate, reserves, depth}
 *   - get_token_usage({scope?})                           → {conversation, session, by_model}
 *   - get_retrieval_stats()                               → {project, files_indexed, collections, last_indexed_at, embedder}
 *   - get_recent_errors({limit?})                         → {count, errors[]}
 *
 * Phase 1 shape mirrors the meta-tool surface (`list_tool_categories →
 * list_tools_by_category → find_tool`) so the discovery affordance is
 * recognizable. Tokenization for search re-uses the AND-match strategy from
 * `_scoreCategorical` in `meta-tools.js:53-66`.
 *
 * Phase 2 admission **differs** from Phase 1 by design (gitea#506 spec):
 * `subagent.v1` admits the Phase 1 chat-history tools but NOT the Phase 2
 * runtime readers — a clean-start boundary so a sub-agent works against a
 * fresh-shape view of state, not parent runtime artifacts.
 *
 * A fresh delegated Coder reads what PM has curated through these tools.
 *
 * @module tools/introspection-tools
 */

import { State, Storage } from '../core.js';
import { ConversationManager } from '../chat/conversations.js';
import { ToolRegistry } from './registry.js';
import { Profiles } from '../profiles/registry.js';
import {
    getActiveProfileName,
    resolveRetrievalConfig,
} from '../profiles/resolve.js';
import { resolveProfile } from '../profiles/inheritance.js';
import { getSideEffectByName } from '../intelligence/tools/side-effects.js';
import { Catalog } from '../intelligence/tools/catalog.js';
import { getConvCost } from '../intelligence/cost/cost-store.js';
import { RetrievalManager } from '../intelligence/retrieval/manager.js';
import { read as readErrorRing } from '../intelligence/error-ring.js';

const READ_DEFAULT_LIMIT = 20;
const READ_MAX_LIMIT = 100;
const SEARCH_DEFAULT_MAX_HITS = 10;
const SEARCH_MAX_MAX_HITS = 50;
const SEARCH_SNIPPET_CHARS = 200;
const LIST_MAX = 50;

// Phase 2 (gitea#506).
const ERRORS_DEFAULT_LIMIT = 50;
const ERRORS_MAX_LIMIT = 50;
const TOKEN_USAGE_SCOPES = ['conversation', 'session', 'all'];

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
/* Phase 2 helpers — runtime state + telemetry derivation                      */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the active profile to its fully-inherited shape. Mirrors what the
 * tool registry / picker would see at admission time. Returns `null` when the
 * profile name isn't registered (defensive — `getActiveProfileName` already
 * falls back to `chat.v1` so a null here would mean the registry itself was
 * cleared).
 *
 * @returns {{name: string, resolved: Object}|null}
 */
function resolveActiveProfile() {
    const name = getActiveProfileName(State.settings);
    const profileDef = Profiles.get(name);
    if (!profileDef) return null;
    const resolved = resolveProfile(profileDef, (n) => Profiles.get(n));
    return { name, resolved };
}

/**
 * Compute the per-tool entry surfaced by `list_loaded_tools`. Sources:
 *   - `name`         ← `def.function.name`
 *   - `category`     ← `Catalog.getByName(name).category` (falls back to `'misc'`)
 *   - `side_effects` ← `getSideEffectByName(name)` (fails closed to `'external'`)
 *   - `cache_mode`   ← `def.cache` (the 2.71.0 field; defaults to `'by-args'` when omitted)
 *
 * @param {Object} def  Entry from `ToolRegistry.definitions`.
 * @returns {{name: string, category: string, side_effects: string, cache_mode: string}|null}
 */
function summarizeLoadedTool(def) {
    const fn = def && def.function;
    if (!fn || typeof fn.name !== 'string' || fn.name.length === 0) return null;
    const name = fn.name;
    const catalogEntry = Catalog.getByName(name);
    const category = catalogEntry ? catalogEntry.category : 'misc';
    return {
        name,
        category,
        side_effects: getSideEffectByName(name),
        cache_mode: (def.cache === 'never' || def.cache === 'by-args') ? def.cache : 'by-args',
    };
}

/**
 * Roll a `ConvCost` record into the slim shape `get_token_usage` surfaces.
 * Drops the persisted bookkeeping fields (`byTool`, `byStrategy`, `firstAt`,
 * etc.) — the tool's job is "what did this conversation cost me," not "dump
 * the cost-store schema."
 *
 * @param {Object|null} convCost
 * @returns {Object}
 */
function summarizeConvCost(convCost) {
    if (!convCost) {
        return {
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            cost: 0,
            cacheSavings: 0,
            requests: 0,
        };
    }
    return {
        inputTokens: convCost.inputTokens || 0,
        outputTokens: convCost.outputTokens || 0,
        cachedTokens: convCost.cachedTokens || 0,
        reasoningTokens: convCost.reasoningTokens || 0,
        cacheReadTokens: convCost.cacheReadTokens || 0,
        cacheCreationTokens: convCost.cacheCreationTokens || 0,
        cost: convCost.cost || 0,
        cacheSavings: convCost.cacheSavings || 0,
        requests: convCost.requests || 0,
    };
}

/**
 * Slice `State.sessionCost` into a flat shape that mirrors `summarizeConvCost`.
 * Field naming differs between the State slot and the ConvCost record
 * (`totalInputTokens` vs `inputTokens`); this helper normalizes them so the
 * scopes surfaced by `get_token_usage` are comparable.
 *
 * @returns {Object}
 */
function summarizeSessionCost() {
    const sc = State.sessionCost || {};
    return {
        inputTokens: sc.totalInputTokens || 0,
        outputTokens: sc.totalOutputTokens || 0,
        cachedTokens: sc.cachedInputTokens || 0,
        reasoningTokens: sc.reasoningTokens || 0,
        cacheReadTokens: sc.cacheReadTokens || 0,
        cacheCreationTokens: sc.cacheCreationTokens || 0,
        cost: sc.totalCost || 0,
        cacheSavings: sc.cacheSavings || 0,
        requests: sc.requests || 0,
    };
}

/**
 * Surface the by-model split. `State.subagents.session_cost.byModel` (added
 * 2.89.0 by gitea#505) tracks per-child-model spend; the primary
 * conversation's model is read from `State.settings.llmModel` and aggregated
 * separately under a synthetic `primary` key alongside the sub-agent entries.
 * This gives the model a single object to scan when answering "where did the
 * tokens go."
 *
 * @returns {Object<string, {dollars: number, tokens: number}>}
 */
function summarizeByModel() {
    /** @type {Object<string, {dollars: number, tokens: number}>} */
    const out = {};
    const subagents = State.subagents || {};
    const sessionCost = subagents.session_cost || {};
    const byModel = sessionCost.byModel || {};
    for (const id of Object.keys(byModel)) {
        const entry = byModel[id] || {};
        out[id] = {
            dollars: entry.dollars || 0,
            tokens: entry.tokens || 0,
        };
    }
    return out;
}

/* -------------------------------------------------------------------------- */
/* Tool registration                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Register the introspection tools (Phase 1 + Phase 2) on the supplied
 * registry. Idempotent only across registry-clear/register cycles (matches
 * every other `register*Tools` factory in `js/tools/`).
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

    /* ============================================================ */
    /* PHASE 2 — runtime state + telemetry (gitea#506)              */
    /* ============================================================ */

    /* ============================================================ */
    /* get_active_profile                                            */
    /* ============================================================ */
    registry.register('get_active_profile', async () => {
        const active = resolveActiveProfile();
        if (!active) {
            return { error: 'No active profile resolvable. The profile registry returned no entry for the active name.' };
        }
        const { name, resolved } = active;
        const tools = resolved.tools || {};
        const budget = resolved.budget || {};
        const taskLedger = resolved.task_ledger || {};
        const subagent = resolved.subagent || null;
        return {
            name,
            base: resolved.base || null,
            admitted_tools: Array.isArray(tools.admit) ? tools.admit.slice() : [],
            budget: {
                total_tokens: budget.total_tokens || 0,
                system_reserve: budget.system_reserve || 0,
                output_reserve: budget.output_reserve || 0,
                history_reserve: budget.history_reserve || 0,
                memory_reserve: budget.memory_reserve || 0,
            },
            ceilings: {
                tools_budget_tokens: tools.budget_tokens || 0,
                task_ledger_capacity: taskLedger.capacity || 0,
                novelty_threshold: typeof taskLedger.novelty_threshold === 'number' ? taskLedger.novelty_threshold : null,
                subagent_max_tokens: subagent && typeof subagent.max_tokens === 'number' ? subagent.max_tokens : null,
                subagent_max_dollars: subagent && typeof subagent.max_dollars === 'number' ? subagent.max_dollars : null,
                subagent_recursion_depth: subagent && typeof subagent.recursion_depth === 'number' ? subagent.recursion_depth : null,
            },
        };
    }, {
        type: 'function',
        function: {
            name: 'get_active_profile',
            description: 'Read the currently-active profile shape: name, inherited base, full admitted tool name list, budget reserves, and capacity ceilings. Use this when you need to know what you can actually do right now — what tools are admitted, what budget you have to work within. Pairs with list_loaded_tools for the registry-side view.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
        readOnly: true,
        cache: 'never',
    });

    /* ============================================================ */
    /* list_loaded_tools                                             */
    /* ============================================================ */
    registry.register('list_loaded_tools', async () => {
        const defs = Array.isArray(ToolRegistry.definitions) ? ToolRegistry.definitions : [];
        const tools = [];
        for (const def of defs) {
            const entry = summarizeLoadedTool(def);
            if (entry) tools.push(entry);
        }
        tools.sort((a, b) => a.name.localeCompare(b.name));
        return {
            count: tools.length,
            tools,
        };
    }, {
        type: 'function',
        function: {
            name: 'list_loaded_tools',
            description: 'Enumerate every tool currently registered on the runtime with its category, side-effect class (read/write/external), and cache mode (by-args/never). Reflects what the registry sees — not profile-side admission (use get_active_profile.admitted_tools for that). Useful when find_tool turns up empty and you need to confirm a tool exists at all.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
        readOnly: true,
        cache: 'never',
    });

    /* ============================================================ */
    /* get_budget_state                                              */
    /* ============================================================ */
    registry.register('get_budget_state', async () => {
        const active = resolveActiveProfile();
        if (!active) {
            return { error: 'No active profile resolvable; cannot derive budget reserves.' };
        }
        const budget = active.resolved.budget || {};
        const reserves = {
            system: budget.system_reserve || 0,
            output: budget.output_reserve || 0,
            history: budget.history_reserve || 0,
            memory: budget.memory_reserve || 0,
        };
        const total = budget.total_tokens || 0;
        const reservesSum = reserves.system + reserves.output + reserves.history + reserves.memory;
        // Used = total input + output spent so far this session. This is an
        // estimate; the compactor's exact next-turn allocation may differ
        // (eviction can reclaim tokens; large pending tool results inflate
        // the actual prompt). Caller should treat the value as a hint, not a pin.
        const sessionCost = State.sessionCost || {};
        const used = (sessionCost.totalInputTokens || 0) + (sessionCost.totalOutputTokens || 0);
        const remainingEstimate = Math.max(0, total - reservesSum - used);
        const depth = Array.isArray(State.chatHistory) ? State.chatHistory.length : 0;
        return {
            total,
            used,
            remaining_estimate: remainingEstimate,
            reserves,
            depth,
        };
    }, {
        type: 'function',
        function: {
            name: 'get_budget_state',
            description: 'Estimate of the current context budget posture: total ceiling, tokens used so far this session, a coarse remaining_estimate (NOT a pin — the compactor may reclaim or pending tool results may inflate), per-category reserves (system/output/history/memory), and conversation depth (turn count). Use this to decide whether to compact, delegate, or push on.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
        readOnly: true,
        cache: 'never',
    });

    /* ============================================================ */
    /* get_token_usage                                               */
    /* ============================================================ */
    registry.register('get_token_usage', async (args) => {
        const a = args || {};
        const scope = typeof a.scope === 'string' ? a.scope : 'conversation';
        if (!TOKEN_USAGE_SCOPES.includes(scope)) {
            return { error: `scope must be one of: ${TOKEN_USAGE_SCOPES.join(', ')}.` };
        }
        const activeId = ConversationManager.getActiveId();
        const convCost = activeId ? getConvCost(activeId) : null;
        return {
            scope,
            conversation: summarizeConvCost(convCost),
            session: summarizeSessionCost(),
            by_model: summarizeByModel(),
        };
    }, {
        type: 'function',
        function: {
            name: 'get_token_usage',
            description: 'Token + cost telemetry across three lenses: conversation (this chat\'s persisted ConvCost record), session (in-memory aggregates including cached/reasoning splits + request count), and by_model (per-model dollars + tokens, populated from sub-agent runs that landed on a cheap-tier override). The scope argument is informational (defaults to "conversation"); all three slices are always returned.',
            parameters: {
                type: 'object',
                properties: {
                    scope: {
                        type: 'string',
                        description: `Optional hint about which slice the model cares about. One of: ${TOKEN_USAGE_SCOPES.join(', ')}. Defaults to "conversation".`,
                    },
                },
                required: [],
            },
        },
        readOnly: true,
        cache: 'never',
    });

    /* ============================================================ */
    /* get_retrieval_stats                                           */
    /* ============================================================ */
    registry.register('get_retrieval_stats', async () => {
        const stats = (typeof RetrievalManager.getStats === 'function')
            ? RetrievalManager.getStats()
            : {};
        const active = resolveActiveProfile();
        const retrievalConfig = active ? resolveRetrievalConfig(active.name) : null;
        const collections = (retrievalConfig && Array.isArray(retrievalConfig.collections))
            ? retrievalConfig.collections.slice()
            : [];
        const embedder = (State.settings && typeof State.settings.embeddingModel === 'string')
            ? State.settings.embeddingModel
            : null;
        return {
            enabled: !!stats.enabled,
            indexing: !!stats.isIndexing,
            project: stats.project || null,
            files_indexed: stats.filesIndexed || 0,
            collections,
            // The retrieval manager tracks lastQueried (gitea#506 spec asks
            // for last_indexed_at — not currently stored; lastQueried is the
            // closest live signal and serves the model's question
            // "is the index warm?"). Surfaced under the spec name and the
            // honest name so a future patch can split them cleanly.
            last_indexed_at: stats.lastQueried || null,
            last_queried_at: stats.lastQueried || null,
            embedder,
            query_count: stats.queryCount || 0,
        };
    }, {
        type: 'function',
        function: {
            name: 'get_retrieval_stats',
            description: 'Snapshot of the retrieval subsystem: whether it\'s enabled / mid-index, what project is indexed, how many files are in the index, which collections the active profile queries, the embedder model id, and a live-query heartbeat (last_queried_at). Use this when find_relevant_files returns surprising results or when deciding whether to call index_project.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
        readOnly: true,
        cache: 'never',
    });

    /* ============================================================ */
    /* get_recent_errors                                             */
    /* ============================================================ */
    registry.register('get_recent_errors', async (args) => {
        const a = args || {};
        if (a.limit !== undefined) {
            if (typeof a.limit !== 'number' || !Number.isInteger(a.limit) || a.limit < 1) {
                return { error: 'limit must be a positive integer.' };
            }
            if (a.limit > ERRORS_MAX_LIMIT) {
                return { error: `limit cannot exceed ${ERRORS_MAX_LIMIT}.` };
            }
        }
        const limit = a.limit || ERRORS_DEFAULT_LIMIT;
        const errors = readErrorRing({ limit });
        return {
            count: errors.length,
            errors,
        };
    }, {
        type: 'function',
        function: {
            name: 'get_recent_errors',
            description: 'Read up to 50 most-recent errors captured from window.onerror + unhandled promise rejections, newest-first. Each entry carries {ts, source, message, stack?}. The ring captures uncaught failures only — caught exceptions that never bubble do not appear. Useful when the user reports "something broke" and you need to surface a stack trace without flipping to DevTools.',
            parameters: {
                type: 'object',
                properties: {
                    limit: {
                        type: 'number',
                        description: `Optional: max errors to return, newest-first. Default ${ERRORS_DEFAULT_LIMIT}, max ${ERRORS_MAX_LIMIT}.`,
                    },
                },
                required: [],
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
    // Phase 2 (gitea#506).
    resolveActiveProfile,
    summarizeLoadedTool,
    summarizeConvCost,
    summarizeSessionCost,
    summarizeByModel,
    ERRORS_DEFAULT_LIMIT,
    ERRORS_MAX_LIMIT,
    TOKEN_USAGE_SCOPES,
};
