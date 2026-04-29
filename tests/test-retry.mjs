/**
 * Tests for retry.js — isRetryable error classification.
 * retry.js has ZERO imports, making it perfectly testable under node:test
 * with no shim. The .js sibling (tests/test-retry.js) covers the browser suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRetryable, RETRYABLE_CHECKS } from '../js/retry.js';

// ============================================
// Transient errors (should retry)
// ============================================

// Empty response errors
test('zero-length response is retryable', () => {
    assert.ok(isRetryable(new Error('zero-length response')));
});
test('empty document is retryable', () => {
    assert.ok(isRetryable(new Error('empty document')));
});
test('Unexpected end of JSON is retryable', () => {
    assert.ok(isRetryable(new Error('Unexpected end of JSON')));
});

// HTTP status errors
test('502 is retryable', () => {
    assert.ok(isRetryable(Object.assign(new Error('Server Error'), { status: 502 })));
});
test('503 is retryable', () => {
    assert.ok(isRetryable(Object.assign(new Error('Server Error'), { status: 503 })));
});
test('504 is retryable', () => {
    assert.ok(isRetryable(Object.assign(new Error('Server Error'), { status: 504 })));
});
test('429 is retryable', () => {
    assert.ok(isRetryable(Object.assign(new Error('Rate Limited'), { status: 429 })));
});

// Network errors
test('Failed to fetch is retryable', () => {
    assert.ok(isRetryable(Object.assign(new TypeError('Failed to fetch'), { name: 'TypeError' })));
});
test('NetworkError is retryable', () => {
    assert.ok(isRetryable(new Error('NetworkError when attempting')));
});
test('ECONNRESET is retryable', () => {
    assert.ok(isRetryable(new Error('ECONNRESET occurred')));
});
test('ETIMEDOUT is retryable', () => {
    assert.ok(isRetryable(new Error('ETIMEDOUT')));
});

// Provider-specific (Venice wraps transient failures)
test('ConnectionError + zero-length is retryable', () => {
    assert.ok(isRetryable(new Error('ConnectionError: zero-length response from upstream')));
});

// Status in message string
test('502 in message is retryable', () => {
    assert.ok(isRetryable(new Error('Got 502 from upstream')));
});

// ============================================
// Permanent errors (should NOT retry)
// ============================================

test('Invalid API key is NOT retryable', () => {
    assert.ok(!isRetryable(new Error('Invalid API key')));
});
test('401 is NOT retryable', () => {
    assert.ok(!isRetryable(Object.assign(new Error('Unauthorized'), { status: 401 })));
});
test('404 is NOT retryable', () => {
    assert.ok(!isRetryable(Object.assign(new Error('Not Found'), { status: 404 })));
});
test('JSON parse error is NOT retryable', () => {
    assert.ok(!isRetryable(new Error('JSON parse error at position 5')));
});
test('Model not found is NOT retryable', () => {
    assert.ok(!isRetryable(new Error('Model not found: gpt-99')));
});
test('Bare ConnectionError (no zero-length) is NOT retryable', () => {
    assert.ok(!isRetryable(new Error('ConnectionError: unknown upstream')));
});

// User-initiated abort should NOT retry
test('User-initiated AbortError is NOT retryable', () => {
    const userAbort = new DOMException('The operation was aborted.', 'AbortError');
    userAbort._userAborted = true;
    assert.ok(!isRetryable(userAbort));
});

// Non-user abort (timeout) SHOULD retry
test('Timeout AbortError IS retryable', () => {
    const timeoutAbort = new DOMException('The operation was aborted.', 'AbortError');
    timeoutAbort._userAborted = false;
    assert.ok(isRetryable(timeoutAbort));
});

// ============================================
// RETRYABLE_CHECKS structure
// ============================================

test('RETRYABLE_CHECKS is an array', () => {
    assert.ok(Array.isArray(RETRYABLE_CHECKS));
});
test('RETRYABLE_CHECKS has more than 5 checks', () => {
    assert.ok(RETRYABLE_CHECKS.length > 5, `RETRYABLE_CHECKS has ${RETRYABLE_CHECKS.length} checks (expected >5)`);
});
test('All RETRYABLE_CHECKS entries are functions', () => {
    assert.ok(RETRYABLE_CHECKS.every(fn => typeof fn === 'function'));
});
