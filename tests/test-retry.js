/**
 * Tests for retry.js — isRetryable error classification.
 * retry.js has ZERO imports, making it perfectly testable.
 */
import { isRetryable, RETRYABLE_CHECKS } from '../js/retry.js';

const { T } = window;

T.suite('isRetryable — Transient Errors (should retry)');

// Empty response errors
T.assert(isRetryable(new Error('zero-length response')), 'zero-length response is retryable');
T.assert(isRetryable(new Error('empty document')), 'empty document is retryable');
T.assert(isRetryable(new Error('Unexpected end of JSON')), 'Unexpected end of JSON is retryable');

// HTTP status errors
T.assert(isRetryable(Object.assign(new Error('Server Error'), { status: 502 })), '502 is retryable');
T.assert(isRetryable(Object.assign(new Error('Server Error'), { status: 503 })), '503 is retryable');
T.assert(isRetryable(Object.assign(new Error('Server Error'), { status: 504 })), '504 is retryable');
T.assert(isRetryable(Object.assign(new Error('Rate Limited'), { status: 429 })), '429 is retryable');

// Network errors
T.assert(isRetryable(Object.assign(new TypeError('Failed to fetch'), { name: 'TypeError' })), 'Failed to fetch is retryable');
T.assert(isRetryable(new Error('NetworkError when attempting')), 'NetworkError is retryable');
T.assert(isRetryable(new Error('ECONNRESET occurred')), 'ECONNRESET is retryable');
T.assert(isRetryable(new Error('ETIMEDOUT')), 'ETIMEDOUT is retryable');

// Provider-specific (Venice wraps transient failures)
T.assert(isRetryable(new Error('ConnectionError: zero-length response from upstream')), 'ConnectionError + zero-length is retryable');

// Status in message string
T.assert(isRetryable(new Error('Got 502 from upstream')), '502 in message is retryable');

T.suite('isRetryable — Permanent Errors (should NOT retry)');

T.assert(!isRetryable(new Error('Invalid API key')), 'Invalid API key is NOT retryable');
T.assert(!isRetryable(Object.assign(new Error('Unauthorized'), { status: 401 })), '401 is NOT retryable');
T.assert(!isRetryable(Object.assign(new Error('Not Found'), { status: 404 })), '404 is NOT retryable');
T.assert(!isRetryable(new Error('JSON parse error at position 5')), 'JSON parse error is NOT retryable');
T.assert(!isRetryable(new Error('Model not found: gpt-99')), 'Model not found is NOT retryable');
T.assert(!isRetryable(new Error('ConnectionError: unknown upstream')), 'Bare ConnectionError (no zero-length) is NOT retryable');

// User-initiated abort should NOT retry
const userAbort = new DOMException('The operation was aborted.', 'AbortError');
userAbort._userAborted = true;
T.assert(!isRetryable(userAbort), 'User-initiated AbortError is NOT retryable');

// Non-user abort (timeout) SHOULD retry
const timeoutAbort = new DOMException('The operation was aborted.', 'AbortError');
timeoutAbort._userAborted = false;
T.assert(isRetryable(timeoutAbort), 'Timeout AbortError IS retryable');

T.suite('RETRYABLE_CHECKS — Structure');

T.assert(Array.isArray(RETRYABLE_CHECKS), 'RETRYABLE_CHECKS is an array');
T.assert(RETRYABLE_CHECKS.length > 5, `RETRYABLE_CHECKS has ${RETRYABLE_CHECKS.length} checks (expected >5)`);
T.assert(RETRYABLE_CHECKS.every(fn => typeof fn === 'function'), 'All checks are functions');
