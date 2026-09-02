// @ts-check
/**
 * Header-driven RPM/TPM rate limiting shared by production and evaluations.
 *
 * Reads `x-ratelimit-*` response headers, keeps 10% token headroom, and
 * maintains independent quota buckets per model. Providers that omit TPM
 * headers remain RPM-only.
 *
 * @module llm/rate-limiter
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

    /** @param {Headers} headers Response headers from the provider request. */
    ingest(headers) {
        const num = (key) => {
            const value = headers.get(key);
            if (value === null || value === '') return null;
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : null;
        };
        const rpmLimit = num(HEADER_KEYS.rpmLimit); if (rpmLimit !== null) this.rpmLimit = rpmLimit;
        const tpmLimit = num(HEADER_KEYS.tpmLimit); if (tpmLimit !== null) this.tpmLimit = tpmLimit;
        const remainingReq = num(HEADER_KEYS.rpmRem); if (remainingReq !== null) this.remainingReq = remainingReq;
        const remainingTok = num(HEADER_KEYS.tpmRem); if (remainingTok !== null) this.remainingTok = remainingTok;
        const resetReqAt = num(HEADER_KEYS.rpmReset); if (resetReqAt !== null) this.resetReqAt = resetReqAt;
        const resetTokAt = num(HEADER_KEYS.tpmReset); if (resetTokAt !== null) this.resetTokAt = resetTokAt;
    }

    /**
     * Return the delay before a request consuming `expectedInputTokens` may
     * be sent. Zero means the request can proceed immediately.
     * @param {number} expectedInputTokens
     * @returns {number}
     */
    msUntilNextSend(expectedInputTokens) {
        const now = Date.now();
        const sincePerCall = now - this.lastSendAt;
        const perCallWait = Math.max(0, this.perCallDelayMs - sincePerCall);

        const tokenFloor = Math.floor((this.tpmLimit ?? Infinity) * this.tokenBufferPct);
        const remainingTokens = this.remainingTok ?? Infinity;
        const remainingRequests = this.remainingReq ?? Infinity;

        if (remainingTokens - expectedInputTokens < tokenFloor && this.resetTokAt) {
            return Math.max(perCallWait, this.resetTokAt - now);
        }
        if (remainingRequests <= 1 && this.resetReqAt) {
            return Math.max(perCallWait, this.resetReqAt - now);
        }
        return perCallWait;
    }

    markSent() {
        this.lastSendAt = Date.now();
    }

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

/** Keep independent quota state for every model id. */
export class RateLimiterPool {
    constructor(options = {}) {
        this._options = options;
        /** @type {Map<string, RateLimiter>} */
        this._byModel = new Map();
    }

    /** @param {string} modelId */
    for(modelId) {
        if (!this._byModel.has(modelId)) {
            this._byModel.set(modelId, new RateLimiter(this._options));
        }
        return this._byModel.get(modelId);
    }

    snapshotAll() {
        const result = {};
        for (const [modelId, limiter] of this._byModel.entries()) {
            result[modelId] = limiter.snapshot();
        }
        return result;
    }
}

/** Sleep for `ms`, rejecting promptly when `signal` aborts. */
export function sleep(ms, signal) {
    return new Promise((resolvePromise, reject) => {
        if (ms <= 0) return resolvePromise();
        if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
        const timer = setTimeout(resolvePromise, ms);
        if (signal) {
            signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new DOMException('aborted', 'AbortError'));
            }, { once: true });
        }
    });
}
