// @ts-check
/**
 * Structured Error Utilities
 *
 * Extends native Error with a machine-readable `.code` and a human-readable
 * `.recoveryHint` so callers can react programmatically AND show the user
 * something actionable.
 *
 * @module utils/errors
 */

/**
 * Well-known error codes.
 * Consumers should compare `err.code` against these constants
 * rather than parsing `.message` strings.
 *
 * @enum {string}
 */
export const ErrorCode = {
    // Network / connectivity
    NETWORK_OFFLINE:     'NETWORK_OFFLINE',
    NETWORK_TIMEOUT:     'NETWORK_TIMEOUT',

    // Authentication / authorization
    AUTH_INVALID_TOKEN:  'AUTH_INVALID_TOKEN',
    AUTH_FORBIDDEN:      'AUTH_FORBIDDEN',

    // Git provider
    GIT_NOT_FOUND:       'GIT_NOT_FOUND',
    GIT_CONFLICT:        'GIT_CONFLICT',
    GIT_VALIDATION:      'GIT_VALIDATION',
    GIT_NOT_SUPPORTED:   'GIT_NOT_SUPPORTED',
    BLAME_UNSUPPORTED:   'BLAME_UNSUPPORTED',

    // LLM
    LLM_API_ERROR:       'LLM_API_ERROR',
    LLM_STREAM_ERROR:    'LLM_STREAM_ERROR',
    LLM_TIMEOUT:         'LLM_TIMEOUT',

    // Tool execution
    TOOL_NOT_FOUND:      'TOOL_NOT_FOUND',
    TOOL_EXECUTION:      'TOOL_EXECUTION',
    TOOL_TIMEOUT:        'TOOL_TIMEOUT',
    TOOL_ROLE_DENIED:    'TOOL_ROLE_DENIED',

    // Storage
    STORAGE_QUOTA:       'STORAGE_QUOTA',
    STORAGE_IDB_UNAVAIL: 'STORAGE_IDB_UNAVAIL',

    // Generic
    UNKNOWN:             'UNKNOWN',
};

/**
 * Structured application error.
 *
 * @extends Error
 */
export class EditorError extends Error {
    /**
     * @param {string} message      - Human-readable error message
     * @param {Object} opts
     * @param {string} opts.code         - Machine-readable code from ErrorCode
     * @param {string} [opts.recoveryHint] - Actionable suggestion for the user
     * @param {number} [opts.status]     - HTTP status code (if applicable)
     * @param {Object} [opts.context]    - Arbitrary metadata (endpoint, path, etc.)
     * @param {Error}  [opts.cause]      - Original error (native cause chaining)
     */
    constructor(message, { code, recoveryHint, status, context, cause } = {}) {
        super(message, { cause });
        this.name = 'EditorError';
        /** @type {string} */
        this.code = code || ErrorCode.UNKNOWN;
        /** @type {string|undefined} */
        this.recoveryHint = recoveryHint;
        /** @type {number|undefined} */
        this.status = status;
        /** @type {Object|undefined} */
        this.context = context;
    }

    /**
     * Create from a fetch Response.
     * @param {Response} response
     * @param {Object} [opts] - Additional EditorError options to merge
     * @returns {Promise<EditorError>}
     */
    static async fromResponse(response, opts = {}) {
        let body = '';
        try { body = await response.text(); } catch { /* ignore */ }

        let friendlyMsg;
        try {
            const parsed = JSON.parse(body);
            friendlyMsg = parsed.message || parsed.error || parsed.errors?.[0];
        } catch { /* not JSON */ }

        const msg = friendlyMsg || (body.length < 200 ? body : `HTTP ${response.status}`);
        const code = STATUS_TO_CODE[response.status] || ErrorCode.UNKNOWN;
        const hint = STATUS_TO_HINT[response.status] || undefined;

        return new EditorError(msg, {
            code,
            recoveryHint: hint,
            status: response.status,
            context: { url: response.url, rawBody: body.slice(0, 500) },
            ...opts,
        });
    }

    /**
     * Wrap any thrown value into an EditorError.
     * If it's already an EditorError, returns it unchanged.
     * @param {*} err
     * @param {Object} [defaults] - Default code/hint if err has none
     * @returns {EditorError}
     */
    static wrap(err, defaults = {}) {
        if (err instanceof EditorError) return err;

        const message = err?.message || String(err);
        let code = defaults.code || ErrorCode.UNKNOWN;
        let hint = defaults.recoveryHint;

        // Infer code from common patterns
        if (err?.name === 'AbortError' || message.includes('abort')) {
            code = ErrorCode.NETWORK_TIMEOUT;
            hint = hint || 'The request was cancelled or timed out. Try again.';
        } else if (message.includes('timeout')) {
            code = ErrorCode.NETWORK_TIMEOUT;
            hint = hint || 'The operation timed out. Try again or check your connection.';
        } else if (message.includes('Failed to fetch') || message.includes('NetworkError')) {
            code = ErrorCode.NETWORK_OFFLINE;
            hint = hint || 'Network request failed. Check your internet connection.';
        }

        return new EditorError(message, { code, recoveryHint: hint, cause: err, ...defaults });
    }
}

/**
 * Map HTTP status codes to error codes.
 * @type {Object.<number, string>}
 */
const STATUS_TO_CODE = {
    401: ErrorCode.AUTH_INVALID_TOKEN,
    403: ErrorCode.AUTH_FORBIDDEN,
    404: ErrorCode.GIT_NOT_FOUND,
    409: ErrorCode.GIT_CONFLICT,
    422: ErrorCode.GIT_VALIDATION,
    429: ErrorCode.LLM_API_ERROR,
    500: ErrorCode.LLM_API_ERROR,
    502: ErrorCode.LLM_API_ERROR,
    503: ErrorCode.LLM_API_ERROR,
};

/**
 * Map HTTP status codes to recovery hints.
 * @type {Object.<number, string>}
 */
const STATUS_TO_HINT = {
    401: 'Check your API token in Settings → Connections.',
    403: 'Your token lacks permission for this operation. Check token scopes.',
    404: 'The resource was not found. Use the file tree to verify the path.',
    409: 'The file was modified elsewhere. Refresh and try again.',
    422: 'The server rejected the request. Check your parameters.',
    429: 'Rate limited. Wait a moment and try again.',
    500: 'Server error. Try again in a few seconds.',
    502: 'Bad gateway. The server may be restarting.',
    503: 'Service temporarily unavailable. Try again shortly.',
};
