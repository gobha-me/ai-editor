// @ts-check
/**
 * Evaluation compatibility surface for the production-owned rate limiter.
 *
 * Keep eval callers on this stable path while ensuring application modules do
 * not import from the `evals/` tree, which is deliberately absent from the
 * runtime container.
 */

export { RateLimiter, RateLimiterPool, sleep } from '../js/llm/rate-limiter.js';
