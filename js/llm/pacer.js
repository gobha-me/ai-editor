// @ts-check
/**
 * Production wrapper around the shared rate-limit implementation.
 *
 * The math (header ingestion, 10% headroom, null-cap fallback, per-model
 * isolation) lives in [`rate-limiter.js`](./rate-limiter.js) and is pinned by
 * [`evals/test-haystack.mjs`](../../evals/test-haystack.mjs):172–230.
 * This module is the production seam — owns the process-global singleton
 * pool and a conservative input-token estimator. Re-exports the canonical
 * classes so callers don't reach across the eval boundary directly.
 *
 * **Why a singleton.** Sessions (Touch 3 Window v2) saturate per-API-key,
 * not per-conversation — multiple agents in one window share quota. Every
 * fetch chokepoint reads from the same pool keyed by `modelId`.
 *
 * **Why per-call delay = 0 in production.** The 1000 ms eval default is
 * grid spacing for NIAH runs. Production paces against header values, not
 * a synthetic floor — adding a fixed delay would burn user-visible latency
 * for no preventative gain.
 *
 * @module llm/pacer
 */
import { RateLimiter, RateLimiterPool, sleep } from './rate-limiter.js';
import { CHARS_PER_TOKEN } from '../intelligence/compression/tokens.js';

export { RateLimiter, RateLimiterPool, sleep };

/** @type {RateLimiterPool|null} */
let _pool = null;

/**
 * Returns the singleton `RateLimiterPool`. Lazy so test runs that never
 * touch a fetch path don't allocate the Map.
 *
 * @returns {RateLimiterPool}
 */
export function getPool() {
    if (!_pool) {
        _pool = new RateLimiterPool({ perCallDelayMs: 0 });
    }
    return _pool;
}

/**
 * Conservative input-token estimate for a chat-completions request. Used
 * to ask the per-model limiter whether the next call would breach the 10%
 * token-budget headroom. Errs high (`+ 256`) because under-counting is
 * what trips 429s — over-counting only adds a few seconds of paced wait.
 *
 * @param {Array<*>|null|undefined} messages  Chat messages array (will be JSON-stringified).
 * @param {Array<*>|null|undefined} tools     Optional tools array (also serialized).
 * @returns {number} Estimated input tokens.
 */
export function estimateInputTokens(messages, tools) {
    const payload = { messages: messages || [], tools: tools || null };
    const chars = JSON.stringify(payload).length;
    return Math.ceil(chars / CHARS_PER_TOKEN) + 256;
}
