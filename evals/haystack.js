// @ts-check
/**
 * Haystack builder for NIAH context-attention eval.
 *
 * Slices a long corpus to a target token length, plants a needle string
 * at a specified depth (0..1), returns the assembled prompt + the actual
 * char index where the needle landed. Token math uses the same
 * chars/3.5 heuristic the rest of the codebase uses
 * (`js/intelligence/compression/tokens.js`).
 *
 * @module evals/haystack
 */

import { CHARS_PER_TOKEN } from '../js/intelligence/compression/tokens.js';

let _cachedCorpus = null;

/**
 * Fetch the Pride & Prejudice fixture once, cache for subsequent cells.
 * @returns {Promise<string>}
 */
export async function loadCorpus() {
    if (_cachedCorpus) return _cachedCorpus;
    const res = await fetch('./fixtures/pap.txt');
    if (!res.ok) throw new Error(`fixture load failed: ${res.status}`);
    _cachedCorpus = await res.text();
    return _cachedCorpus;
}

/**
 * @param {string} corpus
 * @param {number} targetChars
 * @returns {string}  Repeated/truncated to target length. Repeats if corpus
 *                    is shorter than target, with paragraph-break joiner so
 *                    the seam isn't a hard concatenation.
 */
function fitToLength(corpus, targetChars) {
    if (corpus.length >= targetChars) return corpus.slice(0, targetChars);
    const reps = Math.ceil(targetChars / corpus.length);
    return Array(reps).fill(corpus).join('\n\n').slice(0, targetChars);
}

/**
 * Build a haystack at a given token length with the needle planted at
 * the requested depth. Depth = 0.5 means the needle character mid-text;
 * 0.05 means near the start, 0.95 near the end.
 *
 * @param {Object} args
 * @param {string} args.corpus
 * @param {number} args.targetTokens
 * @param {string} args.needle      Full needle sentence to insert (verbatim).
 * @param {number} args.depthPct    0..1
 * @returns {{ text: string, actualTokens: number, needleCharIndex: number }}
 */
export function buildHaystack({ corpus, targetTokens, needle, depthPct }) {
    if (!corpus) throw new Error('corpus required');
    if (typeof targetTokens !== 'number' || targetTokens <= 0) {
        throw new Error('targetTokens must be > 0');
    }
    if (typeof depthPct !== 'number' || depthPct < 0 || depthPct > 1) {
        throw new Error('depthPct must be in [0,1]');
    }
    if (typeof needle !== 'string' || !needle) throw new Error('needle required');

    const targetChars = Math.floor(targetTokens * CHARS_PER_TOKEN);
    const needleChars = needle.length;
    const fillerChars = Math.max(0, targetChars - needleChars);
    const fitted = fitToLength(corpus, fillerChars);

    // Snap to the nearest paragraph-break boundary so the needle isn't
    // mid-sentence — keeps insertion plausible and keeps depth approximately
    // honest after snap.
    const rawIdx = Math.floor(fillerChars * depthPct);
    const idx = snapToBoundary(fitted, rawIdx);

    const before = fitted.slice(0, idx);
    const after = fitted.slice(idx);
    const text = `${before}\n\n${needle}\n\n${after}`;
    const actualTokens = Math.ceil(text.length / CHARS_PER_TOKEN);
    const needleCharIndex = before.length + 2; // +2 for the '\n\n' delimiter

    return { text, actualTokens, needleCharIndex };
}

/**
 * Snap to the nearest paragraph-break (\n\n) within ±200 chars; fallback
 * to the requested index if no break is nearby. Keeps needle insertion
 * looking natural without distorting depth more than ~0.5%.
 * @param {string} s
 * @param {number} idx
 * @returns {number}
 */
function snapToBoundary(s, idx) {
    if (idx <= 0) return 0;
    if (idx >= s.length) return s.length;
    const window = 200;
    const lo = Math.max(0, idx - window);
    const hi = Math.min(s.length, idx + window);
    let best = -1;
    let bestDist = Infinity;
    for (let i = lo; i < hi - 1; i++) {
        if (s[i] === '\n' && s[i + 1] === '\n') {
            const d = Math.abs(i - idx);
            if (d < bestDist) { bestDist = d; best = i; }
        }
    }
    return best === -1 ? idx : best;
}

/** Test-only export. */
export const __testing = { snapToBoundary, fitToLength };
