// @ts-check
/**
 * Decision factories and type guards for the compression rule pipeline.
 *
 * A `CompressionRule.evaluate()` returns one of four discriminated unions:
 * Keep, Drop, Replace, Summarize. The Compactor dispatches on the `kind`
 * field per `docs/DESIGN-compression.md` §"CompressionRule — the plug-in
 * seam".
 *
 * Why a `kind` discriminator instead of separate types: the design's
 * pseudo-`Decision = Keep | Drop(...) | Replace(...) | Summarize(...)` maps
 * cleanly to a tagged union in JS without `instanceof` checks or a class
 * hierarchy. Pure data. Easy to log, easy to serialize for diagnostics.
 *
 * @module intelligence/compression/decisions
 */

/**
 * @typedef {import('./contracts.js').KeepDecision}      KeepDecision
 * @typedef {import('./contracts.js').DropDecision}      DropDecision
 * @typedef {import('./contracts.js').ReplaceDecision}   ReplaceDecision
 * @typedef {import('./contracts.js').SummarizeDecision} SummarizeDecision
 * @typedef {import('./contracts.js').Decision}          Decision
 */

/** Singleton — Keep carries no payload, allocate once. */
const KEEP = Object.freeze({ kind: 'keep' });

/** @returns {KeepDecision} */
export function Keep() {
    return /** @type {KeepDecision} */ (KEEP);
}

/**
 * @param {string} reason e.g. `"subsumed_by:T7"`, `"invalidated_by:T12"`.
 * @returns {DropDecision}
 */
export function Drop(reason) {
    if (typeof reason !== 'string' || !reason) {
        throw new TypeError('Drop: reason must be a non-empty string');
    }
    return { kind: 'drop', reason };
}

/**
 * @param {string} marker  Synthesized turn content (Rule 4 templated).
 * @param {string} reason
 * @returns {ReplaceDecision}
 */
export function Replace(marker, reason) {
    if (typeof marker !== 'string' || !marker) {
        throw new TypeError('Replace: marker must be a non-empty string');
    }
    if (typeof reason !== 'string' || !reason) {
        throw new TypeError('Replace: reason must be a non-empty string');
    }
    return { kind: 'replace', marker, reason };
}

/**
 * @param {string} reason  Hint to the Rule 5 fallback; not an immediate action.
 * @returns {SummarizeDecision}
 */
export function Summarize(reason) {
    if (typeof reason !== 'string' || !reason) {
        throw new TypeError('Summarize: reason must be a non-empty string');
    }
    return { kind: 'summarize', reason };
}

/** @param {unknown} d @returns {boolean} */
export function isKeep(d) {
    return !!d && typeof d === 'object' && /** @type {{kind?: string}} */ (d).kind === 'keep';
}

/** @param {unknown} d @returns {boolean} */
export function isDrop(d) {
    return !!d && typeof d === 'object' && /** @type {{kind?: string}} */ (d).kind === 'drop';
}

/** @param {unknown} d @returns {boolean} */
export function isReplace(d) {
    return !!d && typeof d === 'object' && /** @type {{kind?: string}} */ (d).kind === 'replace';
}

/** @param {unknown} d @returns {boolean} */
export function isSummarize(d) {
    return !!d && typeof d === 'object' && /** @type {{kind?: string}} */ (d).kind === 'summarize';
}

/** @param {unknown} d @returns {boolean} */
export function isDecision(d) {
    return isKeep(d) || isDrop(d) || isReplace(d) || isSummarize(d);
}
