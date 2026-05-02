// @ts-check
/**
 * Composer — turns a `RetrievalRequest` into a `RetrievalResult`.
 * Implements [DESIGN-retrieval.md](../../../docs/DESIGN-retrieval.md)
 * §"Composition Algorithm" (lines 395–456) end-to-end with one explicit
 * stub: step 6.5 (`consult_ledger`) is a no-op in 1.4.17 and lands as the
 * "ledger consumer" PR (PR 10 of the 1.5.0 stream). PR 9 honors the
 * `RetrievalRequest.task_ledger` field but does not read or write it.
 *
 * Algorithm (mirrors design pseudocode):
 *
 *   1. Budget accounting:
 *      `retrieval_budget = total - system_reserve - output_reserve - history_reserve`.
 *   2. History packaging: estimate per-turn tokens and pack oldest→newest
 *      until `history_reserve` is exhausted; oldest dropped first.
 *   3. Strategy selection via [`router.js`](./router.js).
 *   4. Per-strategy retrieval in parallel (`Promise.allSettled` so one
 *      strategy's throw doesn't tank the call).
 *   5. Pinned chunks consume budget first.
 *   6. Interleave with per-strategy token budgets, dedup by ChunkID.
 *   6.5 Ledger consultation — DEFERRED to PR 10. `diagnostics.ledger_consulted`
 *      is always `false` in this PR.
 *   7. Overflow guard: if selected exceeds budget, drop non-pinned chunks
 *      via round-robin across strategies, lowest-score-first within each.
 *      Phase 1 simplification — scores aren't comparable across strategies
 *      (the design's whole `ScoreKind` point), so cross-strategy fairness
 *      beats raw-score comparison.
 *   8. Assemble blocks (`task` tail, `retrieved` body, `history` body).
 *
 * **No runtime wire-up:** the Composer is exported but not yet called by
 * `find_relevant_files` or `js/context-manager.js`; production wiring lands
 * with the migration PR (1.5.2 per ROADMAP). Removability holds (Decision
 * §7) — with `composer.js` deleted nothing in production degrades.
 *
 * **Dependency injection mirrors 1.4.15 / 1.4.16:** the caller supplies
 * the strategy list and a `getChunkByID` for `priority_pins`, so the
 * Composer is testable without an embedder, vector store, or chunk store.
 *
 * @module intelligence/retrieval/composer
 */

import { CHUNKER_VERSION } from './contracts.js';
import { selectStrategies } from './router.js';

/**
 * @typedef {import('./contracts.js').RetrievalRequest} RetrievalRequest
 * @typedef {import('./contracts.js').RetrievalResult} RetrievalResult
 * @typedef {import('./contracts.js').ChunkRef} ChunkRef
 * @typedef {import('./contracts.js').ChunkID} ChunkID
 * @typedef {import('./contracts.js').Strategy} Strategy
 * @typedef {import('./contracts.js').StrategyName} StrategyName
 * @typedef {import('./contracts.js').ContextBlock} ContextBlock
 * @typedef {import('./contracts.js').Diagnostics} Diagnostics
 * @typedef {import('./contracts.js').HistoryTurn} HistoryTurn
 */

/**
 * Resolve a chunk by ID. Returns null when the ID is unknown (stale pin
 * after a re-ingest, etc.) — the Composer surfaces a `STALE_PIN` warning
 * and proceeds.
 *
 * @typedef {(id: ChunkID) => Promise<ChunkRef|null>} GetChunkByID
 */

/**
 * Token estimate per turn. Mirrors the order-of-magnitude approximation
 * the chunkers use (`Math.ceil(content.length / 4)`); the precise budget
 * will tighten when retrieval starts feeding a tokenizer-aware pipeline,
 * but for `history_reserve` packing this is enough — overflow is dropped
 * oldest-first regardless.
 *
 * @param {HistoryTurn} turn
 * @returns {number}
 */
function estimateTurnTokens(turn) {
    const content = typeof turn.content === 'string' ? turn.content : '';
    return Math.max(1, Math.ceil(content.length / 4));
}

/**
 * Step 1: compute the retrieval budget. Treats missing fields as 0.
 *
 * @param {RetrievalRequest} req
 * @returns {{ retrieval: number, history: number, total: number }}
 */
function computeBudgets(req) {
    const b = req && req.budget ? req.budget : { total_tokens: 0, system_reserve: 0, output_reserve: 0, history_reserve: 0 };
    const total = Number(b.total_tokens) || 0;
    const sys = Number(b.system_reserve) || 0;
    const out = Number(b.output_reserve) || 0;
    const hist = Number(b.history_reserve) || 0;
    return { retrieval: total - sys - out - hist, history: hist, total };
}

/**
 * Step 2: pack history turns until `history_reserve` is exhausted.
 * Oldest turns drop first so the most recent context survives. Returns
 * the kept turns plus a flag indicating whether anything was dropped.
 *
 * @param {HistoryTurn[]|null|undefined} history
 * @param {number} historyReserve
 * @returns {{ kept: HistoryTurn[], droppedCount: number, usedTokens: number }}
 */
function packageHistory(history, historyReserve) {
    if (!Array.isArray(history) || history.length === 0 || historyReserve <= 0) {
        return { kept: [], droppedCount: 0, usedTokens: 0 };
    }
    const turnTokens = history.map(estimateTurnTokens);
    let total = turnTokens.reduce((a, b) => a + b, 0);
    let dropFromHead = 0;
    while (total > historyReserve && dropFromHead < history.length) {
        total -= turnTokens[dropFromHead];
        dropFromHead += 1;
    }
    const kept = history.slice(dropFromHead);
    return { kept, droppedCount: dropFromHead, usedTokens: total };
}

/**
 * Step 5: resolve `priority_pins` to chunks. Stale pins surface as
 * warnings; an oversized pin (single chunk > total budget) throws — the
 * design's "caller-visible error, not a silent failure" rule (line 460).
 *
 * @param {RetrievalRequest} req
 * @param {GetChunkByID} getChunkByID
 * @param {number} retrievalBudget
 * @param {Array<{level:string, code:string, detail:string}>} warnings
 * @returns {Promise<ChunkRef[]>}
 */
async function resolvePinnedChunks(req, getChunkByID, retrievalBudget, warnings) {
    const ids = Array.isArray(req.priority_pins) ? req.priority_pins : [];
    if (ids.length === 0) return [];
    /** @type {ChunkRef[]} */
    const pinned = [];
    /** @type {Set<ChunkID>} */
    const seen = new Set();
    for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        let chunk = null;
        try {
            chunk = await getChunkByID(id);
        } catch (err) {
            warnings.push({ level: 'warn', code: 'PIN_LOOKUP_FAILED', detail: `${id}: ${err && err.message ? err.message : 'lookup error'}` });
            continue;
        }
        if (!chunk) {
            warnings.push({ level: 'warn', code: 'STALE_PIN', detail: id });
            continue;
        }
        if (Number(chunk.tokens) > retrievalBudget) {
            throw new Error(`OVERSIZED_PIN: chunk ${id} (${chunk.tokens} tokens) exceeds retrieval budget (${retrievalBudget} tokens)`);
        }
        pinned.push(chunk);
    }
    return pinned;
}

/**
 * Step 4: run viable strategies in parallel. `Promise.allSettled` so a
 * throwing strategy degrades the call rather than failing it. Records
 * per-strategy latency and degradation in the diagnostics scaffold.
 *
 * @param {Array<{strategy: Strategy, quota: number}>} viable
 * @param {RetrievalRequest} req
 * @param {Object} acc
 * @param {Object<StrategyName, number>} acc.latency
 * @param {Object<StrategyName, number>} acc.chunksPerStrategy
 * @param {StrategyName[]} acc.degraded
 * @param {Array<{level:string, code:string, detail:string}>} acc.warnings
 * @returns {Promise<Array<{name: StrategyName, chunks: ChunkRef[]}>>}
 */
async function runStrategies(viable, req, acc) {
    const tasks = viable.map(async ({ strategy, quota }) => {
        const start = Date.now();
        try {
            const chunks = await strategy.retrieve(req, quota);
            const elapsed = Date.now() - start;
            acc.latency[strategy.name] = elapsed;
            const safe = Array.isArray(chunks) ? chunks : [];
            acc.chunksPerStrategy[strategy.name] = safe.length;
            return { name: strategy.name, chunks: safe };
        } catch (err) {
            const elapsed = Date.now() - start;
            acc.latency[strategy.name] = elapsed;
            acc.chunksPerStrategy[strategy.name] = 0;
            acc.degraded.push(strategy.name);
            acc.warnings.push({
                level: 'warn',
                code: 'STRATEGY_THREW',
                detail: `${strategy.name}: ${err && err.message ? err.message : 'unknown error'}`,
            });
            return { name: strategy.name, chunks: /** @type {ChunkRef[]} */ ([]) };
        }
    });
    return Promise.all(tasks);
}

/**
 * Step 6: per-strategy budget + dedup. Each viable strategy gets a token
 * share proportional to its applicability; chunks are admitted in arrival
 * order until the strategy's slice is exhausted. ChunkID dedup spans
 * pinned + all strategies.
 *
 * `applicabilityByName` mirrors the router's normalization so chunk-quota
 * (router) and token-quota (composer) stay in step.
 *
 * @param {ChunkRef[]} pinned
 * @param {Array<{name: StrategyName, chunks: ChunkRef[]}>} retrieved
 * @param {Object<StrategyName, number>} applicabilityByName
 * @param {number} remainingBudget
 * @returns {ChunkRef[]}
 */
function interleaveAndDedup(pinned, retrieved, applicabilityByName, remainingBudget) {
    /** @type {ChunkRef[]} */
    const selected = pinned.slice();
    /** @type {Set<ChunkID>} */
    const seen = new Set(pinned.map((c) => c.id));
    if (remainingBudget <= 0 || retrieved.length === 0) return selected;

    const totalScore = retrieved.reduce((acc, r) => acc + (applicabilityByName[r.name] || 0), 0);
    if (totalScore <= 0) return selected;

    for (const { name, chunks } of retrieved) {
        const share = (applicabilityByName[name] || 0) / totalScore;
        const strategyBudget = Math.floor(remainingBudget * share);
        if (strategyBudget <= 0) continue;
        let used = 0;
        for (const chunk of chunks) {
            if (!chunk || !chunk.id) continue;
            if (seen.has(chunk.id)) continue;
            const tokens = Number(chunk.tokens) || 0;
            if (used + tokens > strategyBudget) break;
            selected.push(chunk);
            seen.add(chunk.id);
            used += tokens;
        }
    }
    return selected;
}

/**
 * Step 7: overflow guard. If `selected` exceeds the retrieval budget,
 * drop non-pinned chunks until it fits. Round-robin across the strategies
 * that produced the chunks (so no single strategy gets fully evicted
 * before another loses a chunk), and within each strategy drop
 * lowest-score-first. This keeps cross-strategy fairness without
 * comparing scores across strategies — the design's `ScoreKind` rule
 * (lines 458, 67–71).
 *
 * Pinned chunks (provenance.retrieved_by === 'pinned' or in the pinned set)
 * are never dropped here; the OVERSIZED_PIN throw in step 5 already
 * guarantees no single pin exceeds the total budget.
 *
 * @param {ChunkRef[]} selected
 * @param {ChunkRef[]} pinned
 * @param {number} retrievalBudget
 * @returns {{ kept: ChunkRef[], droppedTokens: number, droppedCount: number }}
 */
function dropOverflow(selected, pinned, retrievalBudget) {
    const pinnedIds = new Set(pinned.map((c) => c.id));
    let totalTokens = selected.reduce((acc, c) => acc + (Number(c.tokens) || 0), 0);
    if (totalTokens <= retrievalBudget) {
        return { kept: selected, droppedTokens: 0, droppedCount: 0 };
    }

    /** @type {Map<StrategyName, ChunkRef[]>} */
    const buckets = new Map();
    for (const c of selected) {
        if (pinnedIds.has(c.id)) continue;
        const name = (c.provenance && c.provenance.retrieved_by) || 'unknown';
        if (!buckets.has(name)) buckets.set(name, []);
        /** @type {ChunkRef[]} */ (buckets.get(name)).push(c);
    }
    for (const arr of buckets.values()) {
        arr.sort((a, b) => {
            const sa = (a.provenance && Number(a.provenance.score)) || 0;
            const sb = (b.provenance && Number(b.provenance.score)) || 0;
            return sa - sb;
        });
    }

    /** @type {Set<ChunkID>} */
    const dropped = new Set();
    let droppedTokens = 0;
    const bucketKeys = Array.from(buckets.keys());
    let safety = selected.length + 1;
    while (totalTokens > retrievalBudget && safety > 0) {
        let removedThisRound = false;
        for (const k of bucketKeys) {
            const arr = /** @type {ChunkRef[]} */ (buckets.get(k));
            if (!arr || arr.length === 0) continue;
            const chunk = /** @type {ChunkRef} */ (arr.shift());
            const tokens = Number(chunk.tokens) || 0;
            dropped.add(chunk.id);
            droppedTokens += tokens;
            totalTokens -= tokens;
            removedThisRound = true;
            if (totalTokens <= retrievalBudget) break;
        }
        if (!removedThisRound) break;
        safety -= 1;
    }
    const kept = selected.filter((c) => !dropped.has(c.id));
    return { kept, droppedTokens, droppedCount: dropped.size };
}

/**
 * Step 8: emit blocks in attention-aware order. Each retrieved chunk
 * gets its own `retrieved` block; each surviving history turn gets its
 * own `history` block; `req.task` becomes a single `task` block at the
 * tail. Caller stitches the prompt by `position` order (head→body→tail).
 *
 * Phase 1 emits no `system_context` block — the typedef reserves the
 * role but `RetrievalRequest` has no system-context field. Caller-
 * provided framing rides outside the Composer.
 *
 * @param {ChunkRef[]} retrievedChunks
 * @param {HistoryTurn[]} historyTurns
 * @param {string} task
 * @returns {ContextBlock[]}
 */
function assembleBlocks(retrievedChunks, historyTurns, task) {
    /** @type {ContextBlock[]} */
    const blocks = [];
    for (const chunk of retrievedChunks) {
        blocks.push({
            role: 'retrieved',
            content: typeof chunk.content === 'string' ? chunk.content : '',
            chunks: [chunk.id],
            position: 'body',
        });
    }
    for (const turn of historyTurns) {
        const role = typeof turn.role === 'string' ? turn.role : 'unknown';
        const content = typeof turn.content === 'string' ? turn.content : '';
        blocks.push({
            role: 'history',
            content: `[${role}] ${content}`,
            chunks: [],
            position: 'body',
        });
    }
    blocks.push({
        role: 'task',
        content: typeof task === 'string' ? task : '',
        chunks: [],
        position: 'tail',
    });
    return blocks;
}

/**
 * Build an empty-blocks `RetrievalResult`. Used on the early-out paths
 * (`retrieval_budget < 0`, no viable strategies and no fallback).
 *
 * @param {RetrievalRequest} req
 * @param {number} retrievalBudget
 * @param {Array<{level:string, code:string, detail:string}>} warnings
 * @param {HistoryTurn[]} historyTurns
 * @param {Object<StrategyName, string>} skippedReasons
 * @returns {RetrievalResult}
 */
function emptyResult(req, retrievalBudget, warnings, historyTurns, skippedReasons) {
    const blocks = assembleBlocks([], historyTurns, req && typeof req.task === 'string' ? req.task : '');
    const usedTokens = historyTurns.reduce((acc, t) => acc + estimateTurnTokens(t), 0);
    return {
        blocks,
        used_tokens: usedTokens,
        chunks_by_id: {},
        diagnostics: {
            strategies_used: [],
            strategies_skipped: skippedReasons,
            chunks_returned_per_strategy: {},
            tokens_used: usedTokens,
            tokens_budget: Math.max(0, retrievalBudget),
            tokens_truncated: 0,
            ledger_consulted: false,
            ledger_suppressions: 0,
            latency_per_strategy_ms: {},
            cache_hits: {},
            degraded_strategies: [],
            warnings,
            chunker_versions: { ...CHUNKER_VERSION },
        },
    };
}

/**
 * Compose a `RetrievalResult` for the given request. See module
 * docstring for the full algorithm.
 *
 * @param {RetrievalRequest} req
 * @param {Object} deps
 * @param {Strategy[]} deps.strategies         Pre-built strategies (caller wires factories).
 * @param {GetChunkByID} deps.getChunkByID     Resolves `priority_pins`; lands with chunk-store ingest.
 * @param {Object} [opts]
 * @param {number} [opts.totalQuota]           Override `DEFAULT_TOTAL_QUOTA` (tests).
 * @param {number} [opts.fallbackQuota]        Override `DEFAULT_FALLBACK_QUOTA` (tests).
 * @returns {Promise<RetrievalResult>}
 */
export async function compose(req, deps, opts = {}) {
    if (!req || typeof req !== 'object') {
        throw new TypeError('compose: req must be a RetrievalRequest object');
    }
    if (!deps || !Array.isArray(deps.strategies)) {
        throw new TypeError('compose: deps.strategies must be an array of Strategy');
    }
    if (typeof deps.getChunkByID !== 'function') {
        throw new TypeError('compose: deps.getChunkByID must be a function');
    }

    const { retrieval: retrievalBudget, history: historyReserve } = computeBudgets(req);
    /** @type {Array<{level:string, code:string, detail:string}>} */
    const warnings = [];

    const historyPack = packageHistory(req.history, historyReserve);
    if (historyPack.droppedCount > 0) {
        warnings.push({
            level: 'info',
            code: 'HISTORY_TRUNCATED',
            detail: `dropped ${historyPack.droppedCount} oldest turn(s) to fit history_reserve=${historyReserve}`,
        });
    }

    if (retrievalBudget <= 0) {
        warnings.push({
            level: 'warn',
            code: 'NO_BUDGET',
            detail: `retrieval_budget=${retrievalBudget} after reserves; no chunks admitted`,
        });
        return emptyResult(req, retrievalBudget, warnings, historyPack.kept, {});
    }

    const routed = selectStrategies(deps.strategies, req, opts);
    /** @type {Object<StrategyName, string>} */
    const strategiesSkipped = {};
    for (const s of routed.skipped) {
        strategiesSkipped[s.name] = s.reason;
    }

    if (routed.viable.length === 0) {
        // No viable + no Semantic fallback: still package history + task.
        return emptyResult(req, retrievalBudget, warnings, historyPack.kept, strategiesSkipped);
    }

    /** @type {Object<StrategyName, number>} */
    const latency = {};
    /** @type {Object<StrategyName, number>} */
    const chunksPerStrategy = {};
    /** @type {StrategyName[]} */
    const degraded = [];
    const acc = { latency, chunksPerStrategy, degraded, warnings };

    const retrieved = await runStrategies(routed.viable, req, acc);

    let pinned = /** @type {ChunkRef[]} */ ([]);
    try {
        pinned = await resolvePinnedChunks(req, deps.getChunkByID, retrievalBudget, warnings);
    } catch (err) {
        // OVERSIZED_PIN — caller-visible per design line 525.
        throw err;
    }
    const pinnedTokens = pinned.reduce((acc2, c) => acc2 + (Number(c.tokens) || 0), 0);
    const remainingBudget = retrievalBudget - pinnedTokens;

    /** @type {Object<StrategyName, number>} */
    const applicabilityByName = {};
    for (const sel of routed.viable) {
        applicabilityByName[sel.strategy.name] = Number(sel.applicability.score) || 0;
    }

    const interleaved = interleaveAndDedup(pinned, retrieved, applicabilityByName, remainingBudget);

    // Step 6.5 — DEFERRED to PR 10. Composer ignores `req.task_ledger`.
    // `diagnostics.ledger_consulted = false`; `ledger_suppressions = 0`.

    const overflow = dropOverflow(interleaved, pinned, retrievalBudget);
    const finalChunks = overflow.kept;

    const blocks = assembleBlocks(finalChunks, historyPack.kept, typeof req.task === 'string' ? req.task : '');

    const tokensUsed = finalChunks.reduce((acc2, c) => acc2 + (Number(c.tokens) || 0), 0)
        + historyPack.usedTokens;

    /** @type {Object<ChunkID, ChunkRef>} */
    const chunksById = {};
    for (const c of finalChunks) chunksById[c.id] = c;

    return {
        blocks,
        used_tokens: tokensUsed,
        chunks_by_id: chunksById,
        diagnostics: {
            strategies_used: routed.viable.map((v) => v.strategy.name),
            strategies_skipped: strategiesSkipped,
            chunks_returned_per_strategy: chunksPerStrategy,
            tokens_used: tokensUsed,
            tokens_budget: retrievalBudget,
            tokens_truncated: overflow.droppedTokens,
            ledger_consulted: false,
            ledger_suppressions: 0,
            latency_per_strategy_ms: latency,
            cache_hits: {},
            degraded_strategies: degraded,
            warnings,
            chunker_versions: { ...CHUNKER_VERSION },
        },
    };
}
