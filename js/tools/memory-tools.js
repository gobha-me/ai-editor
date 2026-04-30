// @ts-check
/**
 * AI Editor — Memory LLM tools
 *
 * Three OpenAI-function-calling tools that expose the curated-atomic-facts
 * subsystem (`js/intelligence/memory/`) to the chat model:
 *
 *   - memory_remember — create or supersede a record at (scope, owner, key)
 *   - memory_recall   — semantic search (with `query`) or list (without)
 *   - memory_revise   — patch an existing record in place by id
 *
 * Memory PR #4 of 8 in the 1.3.0 track. Foundation for PRs #5–#8 — these
 * tools are dormant until the system prompt or UI surfaces tell the model
 * to use them. **No user-visible behavior change in this PR.**
 *
 * Decisions honored from kickoff (memory `project_design_engagement.md`,
 * 2026-04-30):
 *   - Scope is `user | workspace` only — `persona` was dropped.
 *   - `source` enum drives UI treatment; the `confidence: float` field is
 *     gone (so this module never references it).
 *
 * @module tools/memory-tools
 */

import { State } from '../core.js';
import {
    create,
    update,
    supersede,
    getByKey,
    list,
    searchSemantic,
    MEMORY_SCOPES,
    MEMORY_CATEGORIES,
    MEMORY_SOURCES,
    embedRecord,
    getActiveWorkspaceId,
    getOrCreateUserOwnerId,
} from '../intelligence/memory/index.js';
import { EmbeddingsClient } from '../embeddings-client.js';

const CATEGORIES = Array.from(MEMORY_CATEGORIES);
const SOURCES = Array.from(MEMORY_SOURCES);
const SCOPES = Array.from(MEMORY_SCOPES);
const RECALL_SCOPES = [...SCOPES, 'all'];

/* -------------------------------------------------------------------------- */
/* Test seams — production code paths through the real singletons.            */
/* -------------------------------------------------------------------------- */

/** @type {{ embed: (text: string) => Promise<number[]|null>, isEnabled?: () => boolean } | null} */
let _embeddingsOverride = null;
/** @type {string | undefined} */
let _workspaceIdOverride;

function _embeddings() {
    return _embeddingsOverride || EmbeddingsClient;
}

function _workspaceId() {
    return _workspaceIdOverride !== undefined ? _workspaceIdOverride : getActiveWorkspaceId();
}

export function _setEmbeddingsClientForTests(stub) { _embeddingsOverride = stub; }
export function _setWorkspaceIdForTests(id) { _workspaceIdOverride = id; }
export function _resetMemoryToolsForTests() {
    _embeddingsOverride = null;
    _workspaceIdOverride = undefined;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Resolve `owner_id_or_workspace_id` for the requested scope. */
function _resolveOwner(scope) {
    if (scope === 'workspace') {
        const id = _workspaceId();
        return typeof id === 'string' && id.length > 0 ? id : null;
    }
    return getOrCreateUserOwnerId();
}

function _actor() {
    return `agent:${State?.settings?.llmModel || 'unknown'}`;
}

/** Try to embed; swallow errors — the store accepts null and write proceeds. */
async function _safeEmbed(rec) {
    try {
        const client = _embeddings();
        if (!client || typeof client.embed !== 'function') return null;
        return await embedRecord(client, rec);
    } catch (e) {
        console.warn('[memory-tools] embedding failed:', e?.message || e);
        return null;
    }
}

/** Try to embed a free-text query for recall. */
async function _safeEmbedQuery(text) {
    try {
        const client = _embeddings();
        if (!client || typeof client.embed !== 'function') return null;
        return await client.embed(text);
    } catch (e) {
        console.warn('[memory-tools] query embedding failed:', e?.message || e);
        return null;
    }
}

function _publicRecord(r) {
    return {
        id: r.id,
        key: r.key,
        value: r.value,
        category: r.category,
        source: r.source,
        scope: r.scope,
        updated_at: r.updated_at,
    };
}

function _validateScope(scope, { allowAll = false } = {}) {
    if (scope === 'persona') {
        return `scope 'persona' was dropped from 1.3.0; use 'user' or 'workspace'`;
    }
    const allowed = allowAll ? RECALL_SCOPES : SCOPES;
    if (!allowed.includes(scope)) {
        return `scope must be one of: ${allowed.join(', ')} (got '${scope}')`;
    }
    return null;
}

function _validateCategory(category) {
    if (!CATEGORIES.includes(category)) {
        return `category must be one of: ${CATEGORIES.join(', ')} (got '${category}')`;
    }
    return null;
}

function _validateSource(source) {
    if (!SOURCES.includes(source)) {
        return `source must be one of: ${SOURCES.join(', ')} (got '${source}')`;
    }
    return null;
}

/* -------------------------------------------------------------------------- */
/* Tool registration                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Register the three memory tools on the supplied registry.
 * @param {Object} registry - ToolRegistry instance.
 */
export function registerMemoryTools(registry) {

    /* ============================================================ */
    /* memory_remember                                              */
    /* ============================================================ */
    registry.register('memory_remember', async (args) => {
        const a = args || {};
        if (!a.key || typeof a.key !== 'string') return { error: 'key is required (string)' };
        if (a.value === undefined || a.value === null) return { error: 'value is required' };
        if (!a.category) return { error: `category is required; one of: ${CATEGORIES.join(', ')}` };

        const scope = a.scope || 'workspace';
        const source = a.source || 'agent_proposed';
        const reason = typeof a.reason === 'string' ? a.reason : '';

        const scopeErr = _validateScope(scope);
        if (scopeErr) return { error: scopeErr };
        const catErr = _validateCategory(a.category);
        if (catErr) return { error: catErr };
        const srcErr = _validateSource(source);
        if (srcErr) return { error: srcErr };

        const owner = _resolveOwner(scope);
        if (owner === null) {
            return {
                error: "workspace memory requires an active project; open a repo or use scope: 'user'",
                hint: 'workspace owner-id resolution returned null — Memory repo-mode flag may be off (PR #5 ships the Settings toggle).',
            };
        }

        const value = typeof a.value === 'string' ? a.value : a.value;
        const actor = _actor();
        const embedding = await _safeEmbed({ key: a.key, value });
        const embeddingModelId = State?.settings?.embeddingModel || '';

        try {
            const existing = await getByKey({ scope, owner_id_or_workspace_id: owner, key: a.key });

            if (existing) {
                const result = await supersede(existing.id, {
                    scope,
                    owner_id_or_workspace_id: owner,
                    key: a.key,
                    value,
                    category: a.category,
                    source,
                    created_by: actor,
                    actor,
                    embedding,
                    embedding_model_id: embeddingModelId,
                }, { reason });
                return {
                    success: true,
                    action: 'superseded',
                    id: result.new.id,
                    superseded_id: existing.id,
                    key: result.new.key,
                    scope: result.new.scope,
                    category: result.new.category,
                    source: result.new.source,
                    embedded: embedding !== null,
                };
            }

            const rec = await create({
                scope,
                owner_id_or_workspace_id: owner,
                key: a.key,
                value,
                category: a.category,
                source,
                created_by: actor,
                actor,
                embedding,
                embedding_model_id: embeddingModelId,
            }, { reason });

            return {
                success: true,
                action: 'created',
                id: rec.id,
                key: rec.key,
                scope: rec.scope,
                category: rec.category,
                source: rec.source,
                embedded: embedding !== null,
            };
        } catch (e) {
            return { error: `memory_remember failed: ${e?.message || String(e)}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'memory_remember',
            description: 'Store a curated atomic fact in long-term memory. Use for stable user preferences, project decisions, or domain facts the user wants you to remember across sessions. NOT for short-term notes within this conversation — use scratchpad_write for that. If a memory with the same key already exists, this supersedes it (old record kept for audit).',
            parameters: {
                type: 'object',
                properties: {
                    key: {
                        type: 'string',
                        description: "Short identifier (e.g. 'preferred_test_runner', 'auth_approach'). Lowercased + trimmed automatically. Max 256 chars.",
                    },
                    value: {
                        type: 'string',
                        description: 'The fact itself. Be concise — a single sentence is ideal.',
                    },
                    category: {
                        type: 'string',
                        enum: CATEGORIES,
                        description: 'Bucket the fact belongs to.',
                    },
                    scope: {
                        type: 'string',
                        enum: SCOPES,
                        description: "'workspace' (default) for project-specific facts that round-trip to .aieditor/memory/*.md; 'user' for facts that follow this user across all projects.",
                    },
                    source: {
                        type: 'string',
                        enum: SOURCES,
                        description: "Default 'agent_proposed'. Use 'user_explicit' ONLY when the user just said the equivalent of 'remember this'.",
                    },
                    reason: {
                        type: 'string',
                        description: 'Brief audit note: why are you remembering this now?',
                    },
                },
                required: ['key', 'value', 'category'],
            },
        },
        roles: ['full', 'coder', 'pm'],
    });

    /* ============================================================ */
    /* memory_recall                                                */
    /* ============================================================ */
    registry.register('memory_recall', async (args) => {
        const a = args || {};
        const query = typeof a.query === 'string' && a.query.trim().length > 0 ? a.query.trim() : null;
        const scope = a.scope || 'all';
        const category = a.category || undefined;
        const limit = Math.max(1, Math.min(50, Number.isFinite(a.limit) ? Math.floor(a.limit) : 10));

        const scopeErr = _validateScope(scope, { allowAll: true });
        if (scopeErr) return { error: scopeErr };
        if (category !== undefined) {
            const catErr = _validateCategory(category);
            if (catErr) return { error: catErr };
        }

        const targetScopes = scope === 'all' ? SCOPES : [scope];
        const notes = [];
        let queryEmbedding = null;
        if (query) {
            queryEmbedding = await _safeEmbedQuery(query);
            if (queryEmbedding === null) {
                notes.push('embeddings_unavailable, returning recent records by updated_at');
            }
        }

        try {
            const collected = [];
            for (const sc of targetScopes) {
                const owner = _resolveOwner(sc);
                if (owner === null) {
                    if (scope === 'workspace') {
                        return {
                            success: true,
                            count: 0,
                            results: [],
                            note: 'no_workspace_active',
                        };
                    }
                    notes.push('no_workspace_active');
                    continue;
                }

                if (queryEmbedding) {
                    const hits = await searchSemantic({
                        scope: sc,
                        owner_id_or_workspace_id: owner,
                        queryEmbedding,
                        topK: limit,
                        category,
                    });
                    for (const h of hits) {
                        collected.push({ rec: h.record, score: h.similarity });
                    }
                } else {
                    const recs = await list({
                        scope: sc,
                        owner_id_or_workspace_id: owner,
                        category,
                        limit,
                    });
                    for (const r of recs) {
                        collected.push({ rec: r, score: r.updated_at });
                    }
                }
            }

            collected.sort((a, b) => b.score - a.score);
            const results = collected.slice(0, limit).map((c) => _publicRecord(c.rec));

            const out = {
                success: true,
                count: results.length,
                results,
            };
            if (notes.length > 0) out.note = notes.join('; ');
            return out;
        } catch (e) {
            return { error: `memory_recall failed: ${e?.message || String(e)}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'memory_recall',
            description: 'Search or list curated facts from long-term memory. Provide `query` for semantic search; omit it to list by scope/category. Returns active head records only (superseded/deleted/expired filtered out).',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Natural-language query for semantic search. Omit to list by scope/category.',
                    },
                    scope: {
                        type: 'string',
                        enum: RECALL_SCOPES,
                        description: "Default 'all' — returns workspace results merged with user results.",
                    },
                    category: {
                        type: 'string',
                        enum: CATEGORIES,
                        description: 'Optional filter.',
                    },
                    limit: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 50,
                        description: 'Default 10.',
                    },
                },
                required: [],
            },
        },
        roles: 'all',
    });

    /* ============================================================ */
    /* memory_revise                                                */
    /* ============================================================ */
    registry.register('memory_revise', async (args) => {
        const a = args || {};
        if (!a.id || typeof a.id !== 'string') return { error: 'id is required (string)' };
        if (!a.reason || typeof a.reason !== 'string') {
            return { error: 'reason is required — every revision must explain why' };
        }

        const partial = {};
        if (typeof a.value === 'string') partial.value = a.value;
        if (a.category !== undefined) {
            const catErr = _validateCategory(a.category);
            if (catErr) return { error: catErr };
            partial.category = a.category;
        }
        if (a.source !== undefined) {
            const srcErr = _validateSource(a.source);
            if (srcErr) return { error: srcErr };
            partial.source = a.source;
        }

        if (Object.keys(partial).length === 0) {
            return { error: 'memory_revise: at least one of value/category/source must be provided' };
        }

        const actor = _actor();

        try {
            // Re-embed when value changes — we need the existing record's key to
            // build the canonical embed text.
            if ('value' in partial) {
                const { getById } = await import('../intelligence/memory/index.js');
                const existing = await getById(a.id);
                if (!existing) {
                    return { error: `Memory record not found: ${a.id}. Use memory_recall to find current ids.` };
                }
                if (existing.superseded_by !== null) {
                    return { error: 'That record was superseded; use memory_recall to find the current head.' };
                }
                const embedding = await _safeEmbed({ key: existing.key, value: partial.value });
                partial.embedding = embedding;
                partial.embedding_model_id = State?.settings?.embeddingModel || '';
            }

            const result = await update(a.id, partial, { actor, reason: a.reason });
            return {
                success: true,
                id: result.id,
                key: result.key,
                updated_at: result.updated_at,
            };
        } catch (e) {
            const msg = e?.message || String(e);
            if (/not found/i.test(msg)) {
                return { error: `Memory record not found: ${a.id}. Use memory_recall to find current ids.` };
            }
            if (/superseded or deleted/i.test(msg)) {
                return { error: 'That record was superseded; use memory_recall to find the current head.' };
            }
            return { error: `memory_revise failed: ${msg}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'memory_revise',
            description: 'Update an existing memory record in place. Use when the value needs a small correction or the source/category should change. Identity fields (id, scope, owner, key) cannot change. To replace a fact wholesale with a different key, use memory_remember (it auto-supersedes). `reason` is required — the audit log captures it.',
            parameters: {
                type: 'object',
                properties: {
                    id: {
                        type: 'string',
                        description: 'Record id from memory_recall.',
                    },
                    value: {
                        type: 'string',
                        description: 'New value (optional). Omit to keep current.',
                    },
                    category: {
                        type: 'string',
                        enum: CATEGORIES,
                        description: 'Optional re-categorization.',
                    },
                    source: {
                        type: 'string',
                        enum: SOURCES,
                        description: "Optional source change (e.g., promoting agent_proposed → user_explicit after user confirmation).",
                    },
                    reason: {
                        type: 'string',
                        description: 'Required audit note explaining the revision.',
                    },
                },
                required: ['id', 'reason'],
            },
        },
        roles: ['full', 'coder', 'pm'],
    });
}
