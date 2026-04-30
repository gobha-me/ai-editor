// @ts-check
/**
 * Cost + wall-clock pre-flight estimator for the NIAH grid.
 *
 * Reads pricing and context window directly off the parsed model entry
 * (Venice provider populates `pricing.input/output` and `meta.contextTokens`
 * — see js/providers/venice.js). Wall-clock estimate is TPM-bound — divides
 * total input tokens by an assumed TPM budget (default 3M, matching
 * Venice's published limit for tool-capable models).
 *
 * @module evals/cost-preflight
 */

const OUTPUT_TOKENS_PER_CALL = 50;  // tight — model returns the passcode and stops
const DEFAULT_TPM = 3_000_000;

/**
 * @typedef {Object} TierConfig
 * @property {string} modelId
 * @property {number[]} lengths     Input-token targets per cell.
 * @property {number[]} depths      0..1 each.
 * @property {number} replicates
 */

/**
 * @typedef {Object} GridConfig
 * @property {TierConfig[]} tiers
 * @property {number} [maxUsd=8]
 * @property {number} [tpmAssumed=3000000]
 * @property {boolean} [sequentialTiers=false]   When true, ETA = sum-of-tiers; when false (default), ETA = max-of-tiers (parallel execution).
 */

/**
 * @param {GridConfig} config
 * @param {Array<{id: string, pricing: {input:number,output:number}|null}>} models
 * @returns {{ perTier: Array<{modelId,calls,inputTok,outputTok,costUsd,etaMs,pricingMissing:boolean}>, totalUsd: number, callCount: number, etaMs: number }}
 */
export function estimateGridCost(config, models) {
    if (!Array.isArray(config?.tiers)) throw new Error('config.tiers required');
    const tpm = config.tpmAssumed || DEFAULT_TPM;
    const perTier = [];
    let totalUsd = 0;
    let callCount = 0;

    for (const tier of config.tiers) {
        const m = models.find(x => x.id === tier.modelId);
        const calls = tier.lengths.length * tier.depths.length * tier.replicates;
        const inputTok = tier.lengths.reduce((s, n) => s + n, 0)
            * tier.depths.length * tier.replicates;
        const outputTok = calls * OUTPUT_TOKENS_PER_CALL;
        const inPrice = m?.pricing?.input ?? 0;   // $/1M
        const outPrice = m?.pricing?.output ?? 0;
        const costUsd = (inputTok / 1_000_000) * inPrice
                      + (outputTok / 1_000_000) * outPrice;
        const etaMs = Math.ceil((inputTok / tpm) * 60 * 1000);

        perTier.push({
            modelId: tier.modelId, calls, inputTok, outputTok, costUsd, etaMs,
            pricingMissing: !m?.pricing
        });
        totalUsd += costUsd;
        callCount += calls;
    }

    // Parallel tier execution (default): wall-clock is max-of-tiers because
    // each tier hits a distinct model with its own RPM/TPM bucket and runs
    // concurrently. Sequential mode sums them.
    const etaMs = config.sequentialTiers
        ? perTier.reduce((s, t) => s + t.etaMs, 0)
        : (perTier.length === 0 ? 0 : Math.max(...perTier.map(t => t.etaMs)));

    return { perTier, totalUsd, callCount, etaMs };
}

/** Format helper for the UI. */
export function formatUsd(n) {
    if (n < 0.01) return `$${n.toFixed(4)}`;
    if (n < 1)    return `$${n.toFixed(3)}`;
    return `$${n.toFixed(2)}`;
}

export function formatDuration(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r === 0 ? `${m}m` : `${m}m${r}s`;
}
