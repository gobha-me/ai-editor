// @ts-check
/**
 * Hit/miss scoring for NIAH text-needle responses.
 *
 * @module evals/scoring
 */

/**
 * Case-insensitive, whitespace-collapsed substring match.
 * Returns the first 80 chars of the response as evidence.
 *
 * @param {string} response
 * @param {string} secret
 * @returns {{ hit: boolean, evidence: string }}
 */
export function scoreText(response, secret) {
    if (typeof response !== 'string') response = String(response ?? '');
    if (typeof secret !== 'string' || !secret) {
        throw new Error('secret required');
    }
    const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const hit = norm(response).includes(norm(secret));
    const evidence = response.slice(0, 80).replace(/\s+/g, ' ').trim();
    return { hit, evidence };
}
