// @ts-check
/**
 * Base Git Provider
 *
 * Default interface that all git providers extend. Providers only need
 * to implement the methods they support — unimplemented methods throw
 * a clear "not supported" error.
 *
 * @module git-providers/base
 */

// ============================================
// TYPE DEFINITIONS
// ============================================

/**
 * @typedef {import('../core.js').GitConnection} GitConnection
 */

/**
 * @typedef {Object} TestConnectionResult
 * @property {boolean} ok
 * @property {string}  [user]
 * @property {string}  [error]
 */

/**
 * @typedef {Object} BlameCommit
 * @property {string} sha
 * @property {string} shortSha
 * @property {string} message
 * @property {string} author
 * @property {string} email
 * @property {string} date
 */

/**
 * @typedef {Object} BlameRange
 * @property {BlameCommit} commit
 * @property {number}      startLine
 * @property {string[]}    lines
 */

/**
 * @typedef {Object} BlameData
 * @property {BlameRange[]} ranges
 */

/**
 * @typedef {Object} FileCommit
 * @property {string} sha
 * @property {string} shortSha
 * @property {string} message
 * @property {string} author
 * @property {string} email
 * @property {string} date
 */

/**
 * @typedef {Object} PullRequestData
 * @property {number}  number
 * @property {string}  title
 * @property {string}  body
 * @property {string}  state
 * @property {string}  head
 * @property {string}  base
 * @property {boolean} [mergeable]
 * @property {string}  [url]
 */

/**
 * @typedef {Object} PRFileChange
 * @property {string} filename
 * @property {string} status
 * @property {number} additions
 * @property {number} deletions
 * @property {string} [patch]
 */

/**
 * @typedef {Object} CommitStatus
 * @property {'success'|'pending'|'failure'|'error'} state
 * @property {Array} statuses
 */

import { EditorError, ErrorCode } from '../utils/errors.js';

/** @type {Object.<number, string>} */
const STATUS_TO_GIT_CODE = {
    401: ErrorCode.AUTH_INVALID_TOKEN,
    403: ErrorCode.AUTH_FORBIDDEN,
    404: ErrorCode.GIT_NOT_FOUND,
    409: ErrorCode.GIT_CONFLICT,
    422: ErrorCode.GIT_VALIDATION,
};

/** @type {Object.<number, string>} */
const STATUS_TO_GIT_HINT = {
    401: 'Check your API token in Settings → Connections.',
    403: 'Your token lacks permission. Check token scopes.',
    404: 'Resource not found. Use the file tree to verify the path.',
    409: 'Conflict — the file was modified elsewhere. Refresh and try again.',
    422: 'Validation error. Check your parameters.',
};

/**
 * @param {string} provider
 * @param {string} method
 * @throws {EditorError}
 */
function notSupported(provider, method) {
    throw new EditorError(`${provider} does not support ${method}`, {
        code: ErrorCode.GIT_NOT_SUPPORTED,
        recoveryHint: `This operation is not available for ${provider}. Try a different provider.`,
    });
}

const BASE_GIT_PROVIDER = {
    id: 'generic',
    name: 'Generic Git',
    icon: '📦',
    description: 'Base git provider interface',

    // null = URL is user-configurable in connection settings
    // string = fixed URL (e.g., 'https://api.github.com')
    fixedUrl: null,

    // ========================================
    // AUTHENTICATION
    // ========================================

    /**
     * Test connectivity with given URL and token.
     * @param {GitConnection} connection
     * @returns {Promise<TestConnectionResult>}
     */
    async testConnection(connection) {
        // Default: try GET /user (works for Gitea and GitHub-compatible APIs)
        const resp = await this.request(connection, 'GET', '/user');
        return { ok: true, user: resp?.login || resp?.username || resp?.name || 'authenticated' };
    },

    /**
     * Build request headers for API calls.
     * @param {GitConnection} connection
     * @returns {Object.<string, string>}
     */
    getHeaders(connection) {
        return {
            'Authorization': `token ${connection.token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };
    },

    /**
     * Build the base API URL.
     * @param {GitConnection} connection
     * @returns {string}
     */
    getBaseUrl(connection) {
        return `${connection.url.replace(/\/$/, '')}/api/v1`;
    },

    /**
     * Generic HTTP request helper.
     * @param {GitConnection} connection
     * @param {string} method - HTTP method
     * @param {string} endpoint - API path
     * @param {Object|null} [data=null]
     * @returns {Promise<*>}
     */
    async request(connection, method, endpoint, data = null) {
        const url = `${this.getBaseUrl(connection)}${endpoint}`;
        const options = {
            method,
            headers: this.getHeaders(connection)
        };

        if (data && method !== 'GET') {
            options.body = JSON.stringify(data);
        }

        const response = await fetch(url, options);

        if (!response.ok) {
            const rawBody = await response.text();
            
            // Parse error body for a clean message
            let friendlyMsg = `${response.status}`;
            try {
                const parsed = JSON.parse(rawBody);
                friendlyMsg = parsed.message || parsed.error || parsed.errors?.[0] || friendlyMsg;
            } catch {
                if (rawBody.length < 200) friendlyMsg = rawBody;
            }
            
            throw new EditorError(`${this.name}: ${friendlyMsg}`, {
                code: STATUS_TO_GIT_CODE[response.status] || ErrorCode.UNKNOWN,
                recoveryHint: STATUS_TO_GIT_HINT[response.status],
                status: response.status,
                context: { url, endpoint, rawBody: rawBody.slice(0, 500) },
            });
        }

        const text = await response.text();
        return text ? JSON.parse(text) : null;
    },

    // ========================================
    // REPOSITORIES
    // ========================================

    /**
     * @param {GitConnection} connection
     * @returns {Promise<Array>}
     */
    async listRepos(connection) {
        notSupported(this.name, 'listRepos');
    },

    async createRepo(connection, name, { description = '', isPrivate = true, autoInit = true } = {}) {
        notSupported(this.name, 'createRepo');
    },

    async getRepo(connection, owner, repo) {
        notSupported(this.name, 'getRepo');
    },

    // ========================================
    // BRANCHES
    // ========================================

    async listBranches(connection, owner, repo) {
        notSupported(this.name, 'listBranches');
    },

    async createBranch(connection, owner, repo, name, from = 'main') {
        notSupported(this.name, 'createBranch');
    },

    async deleteBranch(connection, owner, repo, name) {
        notSupported(this.name, 'deleteBranch');
    },

    // ========================================
    // FILE TREE / CONTENTS
    // ========================================

    async getContents(connection, owner, repo, path = '', ref = 'main') {
        notSupported(this.name, 'getContents');
    },

    async getFileTree(connection, owner, repo, ref = 'main', path = '') {
        notSupported(this.name, 'getFileTree');
    },

    async getFile(connection, owner, repo, path, ref = 'main') {
        notSupported(this.name, 'getFile');
    },

    // ========================================
    // BLAME & FILE HISTORY
    // ========================================

    /**
     * Get line-by-line blame data for a file.
     * @param {GitConnection} connection
     * @param {string} owner
     * @param {string} repo
     * @param {string} path
     * @param {string} [ref='main']
     * @returns {Promise<BlameData>}
     */
    async getBlame(connection, owner, repo, path, ref = 'main') {
        notSupported(this.name, 'getBlame');
    },

    /**
     * Get commit history for a specific file.
     * @param {GitConnection} connection
     * @param {string} owner
     * @param {string} repo
     * @param {string} path
     * @param {string} [ref='main']
     * @returns {Promise<FileCommit[]>}
     */
    async getFileCommits(connection, owner, repo, path, ref = 'main') {
        notSupported(this.name, 'getFileCommits');
    },

    // ========================================
    // FILE CRUD
    // ========================================

    async createFile(connection, owner, repo, path, content, message, branch = 'main') {
        notSupported(this.name, 'createFile');
    },

    async updateFile(connection, owner, repo, path, content, message, sha, branch = 'main') {
        notSupported(this.name, 'updateFile');
    },

    async deleteFile(connection, owner, repo, path, message, sha, branch = 'main') {
        notSupported(this.name, 'deleteFile');
    },

    async renameFile(connection, owner, repo, oldPath, newPath, message, branch = 'main') {
        notSupported(this.name, 'renameFile');
    },

    /**
     * Commit multiple file operations in a single commit.
     * @param {Object} connection
     * @param {string} owner
     * @param {string} repo
     * @param {Array<{path: string, content?: string, sha?: string, operation: 'create'|'update'|'delete', encoding?: 'base64'|'text'}>} files
     * @param {string} message
     * @param {string} branch
     */
    async batchCommitFiles(connection, owner, repo, files, message, branch = 'main') {
        notSupported(this.name, 'batchCommitFiles');
    },

    // ========================================
    // ISSUES
    // ========================================

    async listIssues(connection, owner, repo, state = 'open', labels = '') {
        notSupported(this.name, 'listIssues');
    },

    async getIssue(connection, owner, repo, number) {
        notSupported(this.name, 'getIssue');
    },

    async createIssue(connection, owner, repo, title, body, labels = []) {
        notSupported(this.name, 'createIssue');
    },

    /**
     * General-purpose issue update (title, body, state, labels, etc.)
     * @param {Object} connection
     * @param {string} owner
     * @param {string} repo
     * @param {number} number - Issue number
     * @param {Object} fields - { title?, body?, state?, labels? }
     */
    async updateIssue(connection, owner, repo, number, fields) {
        notSupported(this.name, 'updateIssue');
    },

    async getIssueComments(connection, owner, repo, number) {
        notSupported(this.name, 'getIssueComments');
    },

    async createIssueComment(connection, owner, repo, number, body) {
        notSupported(this.name, 'createIssueComment');
    },

    async updateIssueState(connection, owner, repo, number, state) {
        notSupported(this.name, 'updateIssueState');
    },

    // ========================================
    // MERGE REQUESTS (normalized: PRs / MRs)
    // ========================================

    async listMergeRequests(connection, owner, repo, state = 'open') {
        notSupported(this.name, 'listMergeRequests');
    },

    async createMergeRequest(connection, owner, repo, title, body, head, base = 'main') {
        notSupported(this.name, 'createMergeRequest');
    },

    /**
     * Get full details of a single PR/MR.
     * @param {GitConnection} connection
     * @param {string} owner
     * @param {string} repo
     * @param {number} number
     * @returns {Promise<PullRequestData>}
     */
    async getPullRequest(connection, owner, repo, number) {
        notSupported(this.name, 'getPullRequest');
    },

    /**
     * Get files changed in a PR/MR with per-file patches.
     * @param {GitConnection} connection
     * @param {string} owner
     * @param {string} repo
     * @param {number} number
     * @returns {Promise<PRFileChange[]>}
     */
    async getPullRequestFiles(connection, owner, repo, number) {
        notSupported(this.name, 'getPullRequestFiles');
    },

    /**
     * Get review comments on a PR/MR.
     * Returns: [{ id, body, user, createdAt, path?, line? }]
     */
    async getPullRequestComments(connection, owner, repo, number) {
        notSupported(this.name, 'getPullRequestComments');
    },

    /**
     * Add a general comment to a PR/MR (not line-level).
     * Uses the issues comment API since PRs are issues on both GitHub and Gitea.
     */
    async addPullRequestComment(connection, owner, repo, number, body) {
        // Default: delegate to issue comment API (works for both GitHub and Gitea)
        return this.createIssueComment(connection, owner, repo, number, body);
    },

    /**
     * Merge a pull/merge request.
     * @param {Object} connection
     * @param {string} owner
     * @param {string} repo
     * @param {number} number
     * @param {Object} opts - { mergeType: 'squash'|'merge'|'rebase', title, message, deleteBranch }
     * @returns {Object} { merged, sha, message }
     */
    async mergePullRequest(connection, owner, repo, number, opts = {}) {
        notSupported(this.name, 'mergePullRequest');
    },

    // ========================================
    // CI/CD STATUS
    // ========================================

    /**
     * Get combined commit status for a ref.
     * @param {GitConnection} connection
     * @param {string} owner
     * @param {string} repo
     * @param {string} ref
     * @returns {Promise<CommitStatus>}
     */
    async getCommitStatus(connection, owner, repo, ref) {
        notSupported(this.name, 'getCommitStatus');
    },

    // ========================================
    // TAGS & RELEASES
    // ========================================

    /**
     * List tags in a repository, newest first.
     * @param {GitConnection} connection
     * @param {string} owner
     * @param {string} repo
     * @returns {Promise<Array<{name: string, sha: string, date?: string}>>}
     */
    async listTags(connection, owner, repo) {
        notSupported(this.name, 'listTags');
    },

    /**
     * Compare two refs and return the commits and file changes between them.
     * @param {GitConnection} connection
     * @param {string} owner
     * @param {string} repo
     * @param {string} base - Base ref (tag, branch, sha)
     * @param {string} head - Head ref (tag, branch, sha)
     * @returns {Promise<{commits: Array<{sha: string, message: string, author: string, date: string}>, files: Array<{filename: string, status: string, additions: number, deletions: number, patch: string}>, totalCommits: number}>}
     */
    async compareRefs(connection, owner, repo, base, head) {
        notSupported(this.name, 'compareRefs');
    },

    /**
     * List existing releases.
     * @param {GitConnection} connection
     * @param {string} owner
     * @param {string} repo
     * @returns {Promise<Array<{id: number, tag: string, name: string, body: string, draft: boolean, prerelease: boolean, url: string, createdAt: string}>>}
     */
    async listReleases(connection, owner, repo) {
        notSupported(this.name, 'listReleases');
    },

    /**
     * Create a release.
     * @param {GitConnection} connection
     * @param {string} owner
     * @param {string} repo
     * @param {Object} opts
     * @param {string} opts.tag - Tag name (will be created if it doesn't exist)
     * @param {string} opts.name - Release title
     * @param {string} opts.body - Release notes (markdown)
     * @param {boolean} [opts.draft=false]
     * @param {boolean} [opts.prerelease=false]
     * @param {string} [opts.target] - Target branch/commit for tag creation
     * @returns {Promise<{id: number, tag: string, url: string}>}
     */
    async createRelease(connection, owner, repo, opts) {
        notSupported(this.name, 'createRelease');
    },

    // ========================================
    // CI/CD (optional — returns empty by default)
    // ========================================

    async listWorkflowRuns(connection, owner, repo) {
        return [];
    },

    async getWorkflowRun(connection, owner, repo, runId) {
        return null;
    },

    async getWorkflowRunLogs(connection, owner, repo, runId) {
        return null;
    },

    // ========================================
    // ARCHIVE DOWNLOAD
    // ========================================

    /**
     * Download the repository as a zip archive for the given ref (branch/tag/sha).
     * Returns a Blob that the caller can save as a file.
     *
     * @param {GitConnection} connection
     * @param {string} owner
     * @param {string} repo
     * @param {string} [ref='main'] - Branch name, tag, or commit SHA
     * @returns {Promise<Blob>}
     */
    async downloadArchive(connection, owner, repo, ref = 'main') {
        notSupported(this.name, 'downloadArchive');
    },

    // ========================================
    // UI EXTENSIONS (declarative)
    // ========================================

    /**
     * Declares what this provider contributes to the UI.
     * Core reads this manifest and wires everything up.
     * 
     * panels[]    - Sidebar sections (issues, workflows, MRs, pipelines, etc.)
     * tools[]     - LLM tool definitions (auto-registered into ToolRegistry)
     * settings[]  - Connection settings fields (rendered in connection editor)
     * menuItems[] - Context menu items
     */
    contributes: {
        panels: [],
        tools: [],
        settings: [],
        menuItems: []
    }
};

export { BASE_GIT_PROVIDER };

// ============================================
// CIRCUIT BREAKER
// ============================================

/**
 * Cooldown period (ms) before allowing a probe request to a downed connection.
 * During cooldown, all requests short-circuit with an error — no network hit.
 */
const CIRCUIT_COOLDOWN_MS = 60_000;

/**
 * Guard to call at the top of every provider's request() method.
 * Throws immediately if the circuit is open and cooldown hasn't expired.
 * Returns true if this is a probe request (cooldown expired, testing recovery).
 *
 * @param {object} connection
 * @returns {boolean} isProbe — true if this request is a recovery probe
 * @throws {Error} if circuit is open and cooldown is active
 */
export function circuitBreakerGuard(connection) {
    if (!connection._unreachable) return false;
    if (connection._forceRetry) {
        // Force-retry flag: clear it and let the request through
        delete connection._forceRetry;
        return true;
    }
    const elapsed = Date.now() - (connection._unreachableAt || 0);
    if (elapsed < CIRCUIT_COOLDOWN_MS) {
        const remainSec = Math.ceil((CIRCUIT_COOLDOWN_MS - elapsed) / 1000);
        const err = new Error(`Connection offline (retry in ${remainSec}s)`);
        err.circuitOpen = true;
        throw err;
    }
    // Cooldown expired — allow one probe request through
    return true;
}

/**
 * Mark a connection as unreachable with a timestamp.
 * @param {object} connection
 * @param {string} provider — provider id for the event
 * @param {string} errorMsg
 */
export function markUnreachable(connection, provider, errorMsg) {
    if (!connection._unreachable) {
        connection._unreachable = true;
        connection._unreachableAt = Date.now();
        // Lazy import to avoid circular deps
        import('../core.js').then(({ EventBus }) => {
            EventBus.emit('git:connectionLost', {
                connectionId: connection.id, provider, error: errorMsg
            });
        });
        console.warn(`[${provider}] Connection unreachable: ${connection.url} — ${errorMsg}`);
    } else {
        // Update timestamp on repeated failures (extends cooldown)
        connection._unreachableAt = Date.now();
    }
}

/**
 * Mark a connection as restored.
 * @param {object} connection
 * @param {string} provider
 */
export function markReachable(connection, provider) {
    if (connection._unreachable) {
        connection._unreachable = false;
        delete connection._unreachableAt;
        import('../core.js').then(({ EventBus }) => {
            EventBus.emit('git:connectionRestored', { connectionId: connection.id, provider });
        });
        console.log(`[${provider}] Connection restored: ${connection.url}`);
    }
}

// ============================================
// HEALTH PROBE
// ============================================

/** Timeout for the lightweight health probe (ms). */
const HEALTH_PROBE_TIMEOUT = 5_000;

/**
 * Lightweight health probe — raw fetch to a provider's health endpoint.
 * Bypasses circuit breaker and request() entirely.
 *
 * Called after a timeout to distinguish "server is slow" from "server is dead."
 *   - Returns true  → server is alive, operation was just slow (don't trip breaker)
 *   - Returns false → server is genuinely unreachable (trip the breaker)
 *
 * @param {string} baseUrl  — provider's API base URL
 * @param {object} headers  — provider's auth headers
 * @param {string} endpoint — lightweight health endpoint (e.g. '/version')
 * @returns {Promise<boolean>}
 */
export async function healthProbe(baseUrl, headers, endpoint) {
    try {
        const resp = await fetch(`${baseUrl}${endpoint}`, {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT)
        });
        return resp.ok || resp.status === 401;  // 401 = server is up, token issue
    } catch {
        return false;
    }
}
