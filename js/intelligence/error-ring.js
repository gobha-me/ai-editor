// @ts-check
/**
 * AI Editor — Global error ring buffer (gitea#506, self-introspection Phase 2).
 *
 * Bounded FIFO that captures uncaught errors and unhandled promise rejections
 * surfaced from the ai-editor app shell. The `get_recent_errors` introspection
 * tool reads from it so the model can answer "any recent errors?" without the
 * user having to flip to DevTools.
 *
 * Scope is deliberately narrow: only the two top-level browser hooks
 * (`window.onerror` + `unhandledrejection`). No `console.error` wrapping —
 * intentional debug logs would entangle with real failures, and once the wrap
 * is in place, removing it later breaks any caller that came to rely on it.
 * Call sites that *want* to deposit a structured error into the ring import
 * `record(source, message, stack?)` and call it explicitly.
 *
 * The preview-shim error capture at `js/preview/preview-shim.js:26` is
 * iframe-scoped (the sandboxed preview frame) and feeds a separate accessor
 * for `preview_errors`; this module does not touch it.
 *
 * @module intelligence/error-ring
 */

const RING_CAPACITY = 50;
const MAX_MESSAGE_CHARS = 2000;
const MAX_STACK_CHARS = 4000;

/** @type {Array<{ts: number, source: string, message: string, stack?: string}>} */
const _ring = [];

let _initialized = false;

/**
 * Push a normalized entry onto the ring, dropping the oldest when at capacity.
 * Long messages/stacks are truncated with an `…[truncated]` marker so a single
 * megabyte-sized rejection reason can't blow the ring's read cost.
 *
 * @param {string} source  Free-form sink label (`'window.onerror'`, `'unhandledrejection'`, or caller-supplied).
 * @param {string} message
 * @param {string} [stack]
 */
export function record(source, message, stack) {
    const safeSource = typeof source === 'string' && source.length > 0 ? source : 'unknown';
    const safeMessage = _truncate(typeof message === 'string' ? message : String(message), MAX_MESSAGE_CHARS);
    const entry = {
        ts: Date.now(),
        source: safeSource,
        message: safeMessage,
    };
    if (typeof stack === 'string' && stack.length > 0) {
        entry.stack = _truncate(stack, MAX_STACK_CHARS);
    }
    _ring.push(entry);
    while (_ring.length > RING_CAPACITY) {
        _ring.shift();
    }
}

/**
 * Read up to `limit` most-recent entries, newest-first. Returns plain copies
 * so callers can mutate freely without corrupting the ring.
 *
 * @param {{limit?: number}} [opts]
 * @returns {Array<{ts: number, source: string, message: string, stack?: string}>}
 */
export function read(opts) {
    const limit = (opts && typeof opts.limit === 'number' && opts.limit > 0)
        ? Math.min(opts.limit, RING_CAPACITY)
        : RING_CAPACITY;
    const out = [];
    for (let i = _ring.length - 1; i >= 0 && out.length < limit; i--) {
        const e = _ring[i];
        const copy = { ts: e.ts, source: e.source, message: e.message };
        if (e.stack !== undefined) copy.stack = e.stack;
        out.push(copy);
    }
    return out;
}

/**
 * Wipe the ring. Test seam — production code never calls this.
 */
export function clear() {
    _ring.length = 0;
}

/**
 * Wire `window.onerror` + `unhandledrejection` listeners. Idempotent — a
 * second call is a no-op so hot-reload / test harnesses don't stack handlers.
 * Safe to call in non-browser environments (returns silently when `window`
 * is undefined).
 */
export function init() {
    if (_initialized) return;
    if (typeof window === 'undefined') return;

    window.addEventListener('error', (event) => {
        const msg = (event && typeof event.message === 'string') ? event.message : 'Unknown error';
        const stack = (event && event.error && typeof event.error.stack === 'string') ? event.error.stack : undefined;
        record('window.onerror', msg, stack);
    });

    window.addEventListener('unhandledrejection', (event) => {
        const reason = event ? event.reason : null;
        let msg;
        let stack;
        if (reason instanceof Error) {
            msg = reason.message || String(reason);
            stack = reason.stack;
        } else if (typeof reason === 'string') {
            msg = reason;
        } else {
            try {
                msg = JSON.stringify(reason);
            } catch (_) {
                msg = String(reason);
            }
        }
        record('unhandledrejection', msg || 'Unknown rejection', stack);
    });

    _initialized = true;
}

function _truncate(s, max) {
    if (typeof s !== 'string') return '';
    if (s.length <= max) return s;
    return s.slice(0, max) + '…[truncated]';
}

// Test seams.
export const _testing = {
    RING_CAPACITY,
    MAX_MESSAGE_CHARS,
    MAX_STACK_CHARS,
    _ring,
    _isInitialized: () => _initialized,
    _resetInitialized: () => { _initialized = false; },
};
