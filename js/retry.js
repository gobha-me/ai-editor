/**
 * AI Editor - Retry Utility
 * 
 * Exponential backoff retry for transient API failures.
 * Designed for SSE streams and fetch calls that fail with
 * recoverable errors (empty responses, 502/503, network blips).
 * 
 * Usage:
 *   const result = await withRetry(() => llm.chat(options), {
 *     maxRetries: 3,
 *     onRetry: (attempt, delay, err) => showToast(`Retry ${attempt}...`)
 *   });
 */

// ============================================
// RETRYABLE ERROR DETECTION
// ============================================

/**
 * Checks that determine if an error is transient and worth retrying.
 * Each function receives the error and returns true if retryable.
 */
const RETRYABLE_CHECKS = [
    // Empty response body (MiniMax, Venice intermittent failures)
    (err) => err.message?.includes('zero-length'),
    (err) => err.message?.includes('empty document'),
    (err) => err.message?.includes('Unexpected end of JSON'),

    // Server-side transient errors
    (err) => [502, 503, 504, 429].includes(err.status),
    (err) => err.message?.includes('502') || err.message?.includes('503') || err.message?.includes('504'),

    // Network-level failures
    (err) => err.name === 'TypeError' && err.message?.includes('fetch'),
    (err) => err.name === 'TypeError' && err.message?.includes('network'),
    (err) => err.message?.includes('Failed to fetch'),
    (err) => err.message?.includes('NetworkError'),

    // Connection reset / timeout
    (err) => err.message?.includes('ECONNRESET'),
    (err) => err.message?.includes('ETIMEDOUT'),
    (err) => err.name === 'AbortError' && !err._userAborted,  // Not user-initiated abort
];

/**
 * Determine if an error is retryable.
 * @param {Error} err
 * @returns {boolean}
 */
function isRetryable(err) {
    return RETRYABLE_CHECKS.some(check => {
        try { return check(err); }
        catch { return false; }
    });
}

// ============================================
// RETRY WRAPPER
// ============================================

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 15000;

/**
 * Execute a function with exponential backoff retry on transient failures.
 * 
 * @param {Function} fn - Async function to execute
 * @param {Object} [options]
 * @param {number} [options.maxRetries=3] - Maximum retry attempts
 * @param {number} [options.baseDelay=1000] - Base delay in ms (doubles each retry)
 * @param {number} [options.maxDelay=15000] - Maximum delay cap in ms
 * @param {Function} [options.onRetry] - Callback: (attempt, delayMs, error) => void
 * @param {Function} [options.isRetryable] - Custom retryable check (overrides default)
 * @param {AbortSignal} [options.signal] - Abort signal to cancel retries
 * @returns {Promise<*>} Result of fn()
 */
async function withRetry(fn, options = {}) {
    const {
        maxRetries = DEFAULT_MAX_RETRIES,
        baseDelay = DEFAULT_BASE_DELAY_MS,
        maxDelay = DEFAULT_MAX_DELAY_MS,
        onRetry = null,
        isRetryable: customCheck = null,
        signal = null
    } = options;

    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;

            // Check if user cancelled
            if (signal?.aborted) throw err;

            // Check if retryable
            const retryable = customCheck ? customCheck(err) : isRetryable(err);
            if (!retryable || attempt === maxRetries) throw err;

            // Calculate delay with jitter
            const delay = Math.min(
                baseDelay * Math.pow(2, attempt) + Math.random() * 500,
                maxDelay
            );

            // Notify caller
            if (onRetry) {
                onRetry(attempt + 1, delay, err);
            }

            console.warn(
                `[Retry] Attempt ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms:`,
                err.message
            );

            // Wait with abort support
            await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, delay);
                if (signal) {
                    signal.addEventListener('abort', () => {
                        clearTimeout(timer);
                        reject(new DOMException('Retry aborted', 'AbortError'));
                    }, { once: true });
                }
            });
        }
    }

    throw lastError;
}

// ============================================
// EXPORTS
// ============================================

export { withRetry, isRetryable, RETRYABLE_CHECKS };
