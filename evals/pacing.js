// @ts-check
/**
 * Header-driven RPM/TPM pacer for the NIAH eval.
 *
 * Reads `x-ratelimit-*` response headers from Venice (and other
 * OpenAI-compatible providers that publish them), tracks remaining
 * quota, returns ms-to-wait before the next call. Keeps a 10% headroom
 * on the token budget so a slightly-larger-than-expected call doesn't
 * trip a 429.
 *
 * **Per-model bucketing.** Venice publishes different caps per model
 * (e.g. qwen3-5-9b = 3M TPM vs deepseek-v3.2 = 10M TPM vs
 * deepseek-v4-flash = 1000 RPM with no TPM header at all). The
 * top-level `RateLimiterPool` keeps an independent `RateLimiter` per
 * modelId so switching tiers doesn't smear quota state across distinct
 * buckets. Some models advertise no TPM cap; the pacer treats null caps
 * as "no token-side throttling, RPM-only."
 *
 * Production note (out of scope here): wiring this into
 * `js/providers/venice.js` would let normal app traffic respect the same
 * limits — tracked in ROADMAP §1.2.5.
 *
 * @module evals/pacing
 */

const HEADER_KEYS = {
    rpmLimit: 'x-ratelimit-limit-requests',
    rpmRem:   'x-ratelimit-remaining-requests',
    rpmReset: 'x-ratelimit-reset-requests',
    tpmLimit: 'x-ratelimit-limit-tokens',
    tpmRem:   'x-ratelimit-remaining-tokens',
    tpmReset: 'x-ratelimit-reset-tokens'
};

export class RateLimiter {
    constructor({ tokenBufferPct = 0.10, perCallDelayMs = 1000 } = {}) {
        this.rpmLimit = null;
        this.tpmLimit = null;
        this.remainingReq = null;
        this.remainingTok = null;
        this.resetReqAt = null;
        this.resetTokAt = null;
        this.tokenBufferPct = tokenBufferPct;
        this.perCallDelayMs = perCallDelayMs;
        this.lastSendAt = 0;
    }

    /** @param {Headers} headers  Response.headers from fetch(). */
    ingest(headers) {
        const num = (k) => {
            const v = headers.get(k);
            if (v === null || v === '') return null;
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
        };
        const rpmL = num(HEADER_KEYS.rpmLimit);   if (rpmL !== null) this.rpmLimit = rpmL;
        const tpmL = num(HEADER_KEYS.tpmLimit);   if (tpmL !== null) this.tpmLimit = tpmL;
        const rRem = num(HEADER_KEYS.rpmRem);     if (rRem !== null) this.remainingReq = rRem;
        const tRem = num(HEADER_KEYS.tpmRem);     if (tRem !== null) this.remainingTok = tRem;
        const rRes = num(HEADER_KEYS.rpmReset);   if (rRes !== null) this.resetReqAt = rRes;
        const tRes = num(HEADER_KEYS.tpmReset);   if (tRes !== null) this.resetTokAt = tRes;
    }

    /**
     * Returns ms to wait before sending a request that will consume
     * ~`expectedInputTokens`. Zero means "go now."
     * @param {number} expectedInputTokens
     * @returns {number}
     */
    msUntilNextSend(expectedInputTokens) {
        const now = Date.now();
        const sincePerCall = now - this.lastSendAt;
        const perCallWait = Math.max(0, this.perCallDelayMs - sincePerCall);

        const tokFloor = Math.floor((this.tpmLimit ?? Infinity) * this.tokenBufferPct);
        const remTok = this.remainingTok ?? Infinity;
        const remReq = this.remainingReq ?? Infinity;

        if (remTok - expectedInputTokens < tokFloor && this.resetTokAt) {
            return Math.max(perCallWait, this.resetTokAt - now);
        }
        if (remReq <= 1 && this.resetReqAt) {
            return Math.max(perCallWait, this.resetReqAt - now);
        }
        return perCallWait;
    }

    markSent() {
        this.lastSendAt = Date.now();
    }

    /** Snapshot for UI gauge. */
    snapshot() {
        return {
            rpmLimit: this.rpmLimit,
            tpmLimit: this.tpmLimit,
            remainingReq: this.remainingReq,
            remainingTok: this.remainingTok,
            resetReqAt: this.resetReqAt,
            resetTokAt: this.resetTokAt,
        };
    }
}

/**
 * Per-model rate-limiter pool. Each modelId gets its own `RateLimiter`
 * so quota state from one model doesn't leak into another.
 *
 * Usage:
 *   const pool = new RateLimiterPool();
 *   const limiter = pool.for(modelId);
 *   const wait = limiter.msUntilNextSend(expectedInputTokens);
 *   await sleep(wait);
 *   limiter.markSent();
 *   // ...fetch...
 *   limiter.ingest(response.headers);
 */
export class RateLimiterPool {
    constructor(options = {}) {
        this._options = options;
        /** @type {Map<string, RateLimiter>} */
        this._byModel = new Map();
    }

    /** Returns the limiter for `modelId`, creating it on first use. */
    for(modelId) {
        if (!this._byModel.has(modelId)) {
            this._byModel.set(modelId, new RateLimiter(this._options));
        }
        return this._byModel.get(modelId);
    }

    /** Snapshot for UI: { modelId: snapshot } across all known models. */
    snapshotAll() {
        const out = {};
        for (const [k, v] of this._byModel.entries()) out[k] = v.snapshot();
        return out;
    }
}

/** Sleep helper that respects an AbortSignal. */
export function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (ms <= 0) return resolve();
        if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
        const t = setTimeout(resolve, ms);
        if (signal) {
            signal.addEventListener('abort', () => {
                clearTimeout(t);
                reject(new DOMException('aborted', 'AbortError'));
            }, { once: true });
        }
    });
}
