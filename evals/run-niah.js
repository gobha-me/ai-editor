// @ts-check
/**
 * NIAH grid orchestrator.
 *
 * Runs the haystack-and-needle test over a (model × length × depth) grid
 * **sequentially** (concurrency = 1). A single 900K-token call can consume
 * 30%+ of a model's TPM cap; parallelism would just queue 429s. Pacer is
 * **per-model** because Venice publishes different caps per model
 * (see RateLimiterPool in `pacing.js`).
 *
 * Bypasses LLM.chat() so we can capture rate-limit response headers
 * — the eval's own thin fetch path. Reads endpoint + key from
 * `State.settings`, pricing/context from `State.models`.
 *
 * @module evals/run-niah
 */

import { State, EventBus, ProviderRegistry } from '../js/core.js';
import { CHARS_PER_TOKEN } from '../js/intelligence/compression/tokens.js';
import { buildHaystack } from './haystack.js';
import { scoreText } from './scoring.js';
import { RateLimiterPool, sleep } from './pacing.js';

const NEEDLE_SECRET = 'DELTA-RHINO-7';
const NEEDLE_SENTENCE = `Note from operator: the verification passcode is ${NEEDLE_SECRET}. Memorize it; it will be requested.`;
const QUESTION = `What is the verification passcode mentioned in the operator's note above? Answer with only the passcode token, nothing else.`;
const SYSTEM_PROMPT = 'You are a careful reader. When asked about a fact in the provided text, answer it exactly.';

// Reasoning models (qwen3, deepseek-v3.2/v4) consume hundreds of tokens
// in chain-of-thought before emitting visible content. 4000 is generous
// enough that reasoning has room and the model still emits its answer;
// at $0.15-0.48/M output, the impact on total cost is negligible
// (~$0.02 across the entire 150-call grid).
const PER_CALL_OUTPUT_BUDGET = 4000;
const CELL_TIMEOUT_MS = 180_000;

/**
 * @typedef {Object} CellResult
 * @property {string} model
 * @property {number} lengthTokens          Estimated (chars/3.5).
 * @property {number} depthPct
 * @property {number} replicate              0-indexed
 * @property {boolean} hit
 * @property {string}  response
 * @property {number}  latencyMs
 * @property {number|null} inputTokensReported
 * @property {number|null} outputTokens
 * @property {number}  costUsd
 * @property {string|null} finishReason
 * @property {string|null} error
 */

/** Run a single (model × length × depth × rep) call. */
async function runOneCall({
    modelId, corpus, lengthTokens, depthPct, replicate, limiter, abortSignal
}) {
    const cellStart = Date.now();
    const { text } = buildHaystack({
        corpus, targetTokens: lengthTokens,
        needle: NEEDLE_SENTENCE, depthPct
    });

    const userContent = `Read the following text carefully, then answer the question that follows.\n\n----- BEGIN TEXT -----\n${text}\n----- END TEXT -----\n\n${QUESTION}`;
    const expectedInputTokens = Math.ceil(userContent.length / CHARS_PER_TOKEN);

    const wait = limiter.msUntilNextSend(expectedInputTokens);
    if (wait > 0) await sleep(wait, abortSignal);

    const requestBody = {
        model: modelId,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userContent }
        ],
        temperature: 0,
        max_tokens: PER_CALL_OUTPUT_BUDGET,
        stream: true,
        stream_options: { include_usage: true }
    };

    const transformed = ProviderRegistry.transformRequest(requestBody, State.settings);

    // Eval-required: suppress Venice's default system prompt so token math
    // matches our estimate. The default adds ~1100 tokens of safety/policy
    // text that distort context-length sensitivity measurements.
    if (/venice\.ai/i.test(State.settings.llmEndpoint || '')) {
        transformed.venice_parameters = transformed.venice_parameters || {};
        transformed.venice_parameters.include_venice_system_prompt = false;
    }

    const url = `${State.settings.llmEndpoint.replace(/\/$/, '')}/chat/completions`;

    const cellAbort = new AbortController();
    const timeoutH = setTimeout(() => cellAbort.abort(), CELL_TIMEOUT_MS);
    const linked = abortSignal
        ? linkAbort(abortSignal, cellAbort.signal)
        : cellAbort.signal;

    limiter.markSent();

    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${State.settings.llmApiKey}`,
                ...ProviderRegistry.getHeaders(State.settings)
            },
            body: JSON.stringify(transformed),
            signal: linked
        });
    } catch (err) {
        clearTimeout(timeoutH);
        return errorResult({ modelId, lengthTokens, depthPct, replicate, cellStart, err });
    }

    limiter.ingest(response.headers);

    if (!response.ok) {
        clearTimeout(timeoutH);
        const errText = await safeText(response);
        return errorResult({
            modelId, lengthTokens, depthPct, replicate, cellStart,
            err: new Error(`HTTP ${response.status}: ${errText.slice(0, 200)}`)
        });
    }

    let content = '';
    let usage = null;
    let finishReason = null;
    try {
        const { content: c, usage: u, finishReason: f } = await readSseStream(response);
        content = c; usage = u; finishReason = f;
    } catch (err) {
        clearTimeout(timeoutH);
        return errorResult({ modelId, lengthTokens, depthPct, replicate, cellStart, err });
    }

    clearTimeout(timeoutH);

    const { hit } = scoreText(content, NEEDLE_SECRET);
    const inputTok = usage?.prompt_tokens ?? null;
    const outputTok = usage?.completion_tokens ?? null;
    const costUsd = computeCost(modelId, inputTok, outputTok);

    return {
        model: modelId,
        lengthTokens,
        depthPct,
        replicate,
        hit,
        response: content.slice(0, 200),
        latencyMs: Date.now() - cellStart,
        inputTokensReported: inputTok,
        outputTokens: outputTok,
        costUsd,
        finishReason,
        error: null
    };
}

/**
 * Run the full grid. Tiers execute **concurrently** by default — each
 * tier targets a distinct model on Venice, and rate-limit buckets are
 * per-model (see `RateLimiterPool`), so concurrent tiers don't fight
 * for quota. Cells **within** a tier still run sequentially because they
 * all hit the same model and share its limiter.
 *
 * Wall-clock = max(tier wall-clocks) instead of sum, dominated by the
 * largest-context tier. Set `config.sequentialTiers: true` to force
 * one-tier-at-a-time (e.g., for predictable cost-tracking ordering).
 *
 * Stop-loss: the cost cap is checked on aggregate before each cell;
 * with parallel tiers, in-flight cells in other tiers complete before
 * the abort propagates, so total spend may slightly overshoot the cap.
 * The overshoot is bounded by `tiers × per-cell cost`, which is small
 * relative to the cap.
 *
 * @param {{
 *   tiers: Array<{ modelId: string, lengths: number[], depths: number[], replicates: number }>,
 *   maxUsd?: number,
 *   tpmAssumed?: number,
 *   sequentialTiers?: boolean
 * }} config
 * @param {string} corpus
 * @param {{
 *   onCell?: (r: CellResult) => void,
 *   onProgress?: (done: number, total: number, costSoFar: number, etaMs: number) => void,
 *   onPaceTick?: (snapshot: object) => void,
 *   abortSignal?: AbortSignal
 * }} [hooks]
 * @returns {Promise<{cells: CellResult[], totalCost: number, aborted: boolean, reason?: string}>}
 */
export async function runGrid(config, corpus, hooks = {}) {
    const { onCell, onProgress, onPaceTick, abortSignal } = hooks;
    const pool = new RateLimiterPool();
    /** @type {CellResult[]} */
    const cells = [];
    const total = config.tiers.reduce(
        (s, t) => s + t.lengths.length * t.depths.length * t.replicates, 0
    );
    const maxUsd = config.maxUsd ?? 8;

    /** Mutable shared state across tier runners. */
    const shared = {
        costSoFar: 0,
        done: 0,
        abortReason: null,
    };

    const internalAbort = new AbortController();
    const linked = abortSignal
        ? linkAbort(abortSignal, internalAbort.signal)
        : internalAbort.signal;

    /** Run every cell of one tier sequentially against its own limiter. */
    async function runTier(tier) {
        const limiter = pool.for(tier.modelId);
        for (const length of tier.lengths) {
            for (const depth of tier.depths) {
                for (let rep = 0; rep < tier.replicates; rep++) {
                    if (linked.aborted) return;
                    if (shared.costSoFar >= maxUsd) {
                        shared.abortReason ??= 'max_usd_reached';
                        internalAbort.abort();
                        return;
                    }
                    const cell = await runOneCall({
                        modelId: tier.modelId,
                        corpus,
                        lengthTokens: length,
                        depthPct: depth,
                        replicate: rep,
                        limiter,
                        abortSignal: linked
                    });
                    cells.push(cell);
                    shared.costSoFar += cell.costUsd || 0;
                    shared.done++;
                    onCell?.(cell);
                    onPaceTick?.({ modelId: tier.modelId, ...limiter.snapshot() });
                    if (onProgress) {
                        const meanLatency = cells.length === 0 ? 0
                            : cells.reduce((s, c) => s + c.latencyMs, 0) / cells.length;
                        const etaMs = Math.max(0, total - shared.done) * meanLatency;
                        onProgress(shared.done, total, shared.costSoFar, etaMs);
                    }
                }
            }
        }
    }

    if (config.sequentialTiers) {
        for (const tier of config.tiers) {
            await runTier(tier);
            if (linked.aborted) break;
        }
    } else {
        await Promise.all(config.tiers.map(runTier));
    }

    if (abortSignal?.aborted) {
        return { cells, totalCost: shared.costSoFar, aborted: true, reason: 'user_abort' };
    }
    if (shared.abortReason) {
        return { cells, totalCost: shared.costSoFar, aborted: true, reason: shared.abortReason };
    }
    return { cells, totalCost: shared.costSoFar, aborted: false };
}

// ============================================================
// Helpers
// ============================================================

function computeCost(modelId, inputTok, outputTok) {
    const m = State.models.find(x => x.id === modelId);
    if (!m?.pricing) return 0;
    const inP = m.pricing.input || 0;
    const outP = m.pricing.output || 0;
    return ((inputTok || 0) / 1_000_000) * inP
         + ((outputTok || 0) / 1_000_000) * outP;
}

function errorResult({ modelId, lengthTokens, depthPct, replicate, cellStart, err }) {
    return {
        model: modelId,
        lengthTokens,
        depthPct,
        replicate,
        hit: false,
        response: '',
        latencyMs: Date.now() - cellStart,
        inputTokensReported: null,
        outputTokens: null,
        costUsd: 0,
        finishReason: null,
        error: err?.message || String(err)
    };
}

async function safeText(response) {
    try { return await response.text(); } catch { return ''; }
}

/** Combine two abort signals into one. */
function linkAbort(a, b) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (a.aborted || b.aborted) ctl.abort();
    a.addEventListener('abort', onAbort, { once: true });
    b.addEventListener('abort', onAbort, { once: true });
    return ctl.signal;
}

/**
 * Minimal SSE parser for OpenAI-compatible chat-completions stream.
 * Accumulates content deltas, captures usage from final `[DONE]`-adjacent chunk.
 */
async function readSseStream(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let usage = null;
    let finishReason = null;

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let json;
            try { json = JSON.parse(payload); } catch { continue; }
            const choice = json.choices?.[0];
            const delta = choice?.delta?.content;
            if (typeof delta === 'string') content += delta;
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            if (json.usage) usage = json.usage;
        }
    }

    return { content, usage, finishReason };
}
