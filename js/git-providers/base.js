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
 * @property {boolean} [draft]    Draft / WIP state. When `true`, the
 *   remote intentionally blocks merge — consumers MUST NOT classify
 *   `mergeable === false` as a merge conflict on draft PRs (Gitea's
 *   `mergeable: false` covers both conflict AND draft-block; only the
 *   `draft` field disambiguates). Optional — absent on providers
 *   pre-dating 2.73.0 / on `listMergeRequests` payloads. Treat
 *   `undefined` as "not draft" for back-compat.
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
    // Two-character glyph for connection-row badges in Settings →
    // Connections. The consumer (`js/settings/connections-tab.js#glyphFor`)
    // falls back to the first two characters of the provider id
    // uppercased when this is absent — so the field is informally optional
    // for new providers but every shipping registered provider declares it.
    glyph: 'GE',
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

    /**
     * Create a branch `name` pointing at the tip of `from`.
     *
     * **Idempotent on existing-ref.** When the target ref already exists
     * on the remote, the call MUST resolve successfully and return the
     * same shape as a fresh creation (the branch name) rather than throw.
     * Concrete providers translate their own error envelopes for this
     * case (Gitea: 500 + `PushRejected ... reference already exists`;
     * GitHub: 422 + `Reference already exists`; GitLab: 400 +
     * `Branch already exists`) and short-circuit through the idempotent
     * path. The `git:branchCreated` EventBus channel is emitted only on
     * the genuine-creation path — the existing-ref path is silent so
     * downstream listeners don't fire a "created" reaction for a branch
     * that was already present.
     *
     * @param {GitConnection} connection
     * @param {string} owner
     * @param {string} repo
     * @param {string} name - Branch to create
     * @param {string} [from='main'] - Source ref (branch, tag, sha)
     * @returns {Promise<string>} The created (or pre-existing) branch name.
     */
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

    /**
     * Language statistics for the repo. Returns a `LanguageEntry[]`
     * sorted descending by `weight` ∈ [0,1]. Used by retrieval ingest
     * (2.4.0) to order eligible files by primary language so the
     * token-budget cap exhausts on the user's main language last.
     *
     * **Feature-detection contract:** returns `null` when the provider
     * does not support an upstream language-stats endpoint (Local).
     * Callers cascade to an in-memory extension scan on `null`. Errors
     * (network, 404, auth) propagate; the indexer's orchestrator
     * `orderByLanguageStats` catches them and falls back the same way.
     *
     * Note: GitHub's `/languages` endpoint computes against the
     * default branch and ignores the `ref` parameter — accepted as a
     * hint, not a filter.
     *
     * @param {GitConnection} connection
     * @param {string} owner
     * @param {string} repo
     * @param {string} [ref='main']
     * @returns {Promise<Array<{language: string, weight: number, extensions: string[]}>|null>}
     */
    async getLanguages(connection, owner, repo, ref = 'main') {
        return null;
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

    /**
     * Get commit history for a repository.
     * @param {GitConnection} connection
     * @param {string} owner
     * @param {string} repo
     * @param {Object} [opts]
     * @returns {Promise<CommitEntry[]>}
     */
    async getCommits(connection, owner, repo, opts = {}) {
        notSupported(this.name, 'getCommits');
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
     * Fetch the raw unified diff for a PR/MR and return per-file patches.
     * Used as a final fallback when both `getPullRequestFiles` and
     * `compareRefs` fail to populate per-file `patch` (Gitea quirk:
     * its /pulls/{n}/files and /compare endpoints sometimes return
     * empty patches for larger PRs while /pulls/{n}.diff always works).
     *
     * @param {GitConnection} connection
     * @param {string} owner
     * @param {string} repo
     * @param {number} number
     * @returns {Promise<Map<string, {status: string, additions: number, deletions: number, patch: string}>>}
     */
    async getPullRequestDiff(connection, owner, repo, number) {
        notSupported(this.name, 'getPullRequestDiff');
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

    /**
     * Fetch base + head content for every file changed in a PR/MR so the
     * client can run a 2-way diff and present conflict hunks for the
     * Touch 3 Merge Conflict Resolver surface.
     *
     * Default impl works for any provider that implements `getPullRequest`,
     * `getPullRequestFiles`, and `getFile` (Gitea, GitHub, GitLab). Each
     * file's per-ref content fetch tolerates a 404 (file added on one side
     * only) by falling back to an empty string. Providers gate this through
     * the `mergeConflictResolution` capability flag — false providers
     * (Local + currently GitLab pending live testing) hide the resolver
     * button in the surface.
     *
     * @param {GitConnection} connection
     * @param {string} owner
     * @param {string} repo
     * @param {number} number
     * @returns {Promise<{
     *   supported: boolean,
     *   files?: Array<{path: string, base: string, head: string, status?: string}>,
     *   baseRef?: string,
     *   headRef?: string,
     * }>}
     * @since 2.18.0 (Touch 3 Merge Conflict Resolver — slice 1)
     */
    async getMergeConflicts(connection, owner, repo, number) {
        const pr = await this.getPullRequest(connection, owner, repo, number);
        const files = await this.getPullRequestFiles(connection, owner, repo, number);
        const baseRef = pr.base;
        const headRef = pr.head;

        const results = await Promise.all((files || []).map(async (f) => {
            const path = f.filename;
            const [baseR, headR] = await Promise.all([
                this.getFile(connection, owner, repo, path, baseRef).catch(() => null),
                this.getFile(connection, owner, repo, path, headRef).catch(() => null),
            ]);
            return {
                path,
                base: baseR?.content ?? '',
                head: headR?.content ?? '',
                status: f.status,
            };
        }));

        return {
            supported: true,
            files: results,
            baseRef,
            headRef,
        };
    },

    /**
     * Submit a pull request review (line-anchored comments + an event).
     *
     * Slice 2 of the Touch 3 PR Review surface (2.13.0). Implemented by
     * Gitea + GitHub; GitLab inherits this `notSupported` and ships in
     * 2.13.1.
     *
     * @param {Object} connection
     * @param {string} owner
     * @param {string} repo
     * @param {number} number
     * @param {{event:'COMMENT'|'APPROVE'|'REQUEST_CHANGES', body?:string, comments?:Array<{path:string, line:number, side:'LEFT'|'RIGHT', body:string}>}} payload
     * @returns {Promise<{id:number, state:string, submittedAt:string, url?:string}>}
     */
    async submitPullRequestReview(connection, owner, repo, number, payload) {
        notSupported(this.name, 'submitPullRequestReview');
    },

    /**
     * Create a single review comment — either line-anchored or a reply
     * to an existing review comment.
     *
     * @param {Object} connection
     * @param {string} owner
     * @param {string} repo
     * @param {number} number
     * @param {{body:string, path?:string, line?:number, side?:'LEFT'|'RIGHT', commitSha?:string, in_reply_to?:number}} payload
     * @returns {Promise<{id:number, body:string, user:string, createdAt:string, path?:string, line?:number, side?:'LEFT'|'RIGHT', type:'review'}>}
     */
    async createReviewComment(connection, owner, repo, number, payload) {
        notSupported(this.name, 'createReviewComment');
    },

    /**
     * Capability matrix for the PR Review dock. Providers override to
     * advertise what their implementations support; the dock reads this
     * to enable / disable + render explanatory notices.
     *
     * Default = nothing supported (matches the `notSupported` defaults
     * above). The base value for `merge` is true on the assumption that
     * the provider implements `mergePullRequest`; providers without
     * merge override to false.
     *
     * @returns {{reviewSubmission:boolean, threadResolve:boolean, viewedFiles:boolean, merge:boolean, rerunCi:boolean, mergeConflictResolution:boolean}}
     */
    get capabilities() {
        return {
            reviewSubmission: false,
            threadResolve: false,
            viewedFiles: false,
            merge: false,
            rerunCi: false,
            mergeConflictResolution: false,
        };
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
    // COMMIT DIFF
    // ========================================

    /**
     * Get a single commit's full diff (files + patches).
     * @param {GitConnection} connection
     * @param {string} owner
     * @param {string} repo
     * @param {string} sha
     * @returns {Promise<{sha:string, shortSha:string, message:string, author:string, date:string, files:Array<{path:string, status:string, additions:number, deletions:number, patch:string}>}>}
     * @since 2.50.0 (extracted from informal cross-provider extension at github.js / gitea.js / gitlab.js)
     */
    async getCommitDiff(connection, owner, repo, sha) {
        notSupported(this.name, 'getCommitDiff');
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
     *
     * **`files` is provider-shaped.** GitHub's /compare returns a top-level
     * `files` array with full patches; Gitea's `Compare` schema only has
     * `commits + total_commits` (no `files` field — verified against
     * Gitea 1.25 swagger). Gitea callers that need patches cascade through
     * per-commit `getCommitDiff` (release-manager) or /pulls/{n}.diff
     * ([`getPullRequestDiff`](#getPullRequestDiff), used by PR Review);
     * callers that only need the changed-path set use
     * `getChangedFilesBetween` (Gitea overrides it to read `commits[].files`).
     *
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
     * Return ahead/behind commit counts for `branch` relative to `base`.
     * Default implementation calls `compareRefs(base, branch)` and reads the
     * length of the returned commits array as the "ahead" count, then
     * `compareRefs(branch, base)` for the "behind" count. Providers whose
     * native compare endpoint exposes ahead_by/behind_by directly (GitHub)
     * should override this to use a single round-trip.
     *
     * Returns `{ ahead: null, behind: null }` on any error — callers treat
     * null as "unknown", not "0", and hide the counts.
     *
     * @param {GitConnection} connection
     * @param {string} owner
     * @param {string} repo
     * @param {string} branch
     * @param {string} base - Base ref (e.g. 'main')
     * @returns {Promise<{ahead: number|null, behind: number|null}>}
     */
    async getBranchAheadBehind(connection, owner, repo, branch, base) {
        if (!base || !branch || base === branch) {
            return { ahead: 0, behind: 0 };
        }
        try {
            const aheadResult = await this.compareRefs(connection, owner, repo, base, branch);
            const behindResult = await this.compareRefs(connection, owner, repo, branch, base);
            return {
                ahead: aheadResult?.commits?.length ?? aheadResult?.totalCommits ?? null,
                behind: behindResult?.commits?.length ?? behindResult?.totalCommits ?? null,
            };
        } catch {
            return { ahead: null, behind: null };
        }
    },

    /**
     * Return the de-duplicated list of file paths whose content differs
     * between two refs. Used by the retrieval index to delta-index on a
     * branch switch instead of re-walking the entire tree.
     *
     * Default implementation: union of `compareRefs(branchA, branchB).files`
     * and `compareRefs(branchB, branchA).files`. Each call is a 3-dot diff
     * against the merge-base, so the union covers the symmetric difference
     * (files added/changed/removed on either branch since divergence).
     * Providers whose API exposes a direct two-tip diff in one round-trip
     * may override.
     *
     * Returns `null` on any error or unsupported provider — caller treats
     * `null` as "fall back to a full re-walk", `[]` as "branches differ
     * by zero files".
     *
     * @param {GitConnection} connection
     * @param {string} owner
     * @param {string} repo
     * @param {string} branchA
     * @param {string} branchB
     * @returns {Promise<string[]|null>}
     */
    async getChangedFilesBetween(connection, owner, repo, branchA, branchB) {
        if (!branchA || !branchB || branchA === branchB) return [];
        try {
            const [aToB, bToA] = await Promise.all([
                this.compareRefs(connection, owner, repo, branchA, branchB),
                this.compareRefs(connection, owner, repo, branchB, branchA),
            ]);
            const paths = new Set();
            for (const f of aToB?.files || []) {
                if (f && typeof f.filename === 'string' && f.filename.length > 0) {
                    paths.add(f.filename);
                }
            }
            for (const f of bToA?.files || []) {
                if (f && typeof f.filename === 'string' && f.filename.length > 0) {
                    paths.add(f.filename);
                }
            }
            return Array.from(paths);
        } catch {
            return null;
        }
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

    /**
     * List jobs/tasks for a workflow run.
     * @returns {Promise<Array<{id, name, status, conclusion, startedAt, completedAt}>>}
     */
    async listWorkflowJobs(connection, owner, repo, runId) {
        return [];
    },

    /**
     * Fetch plain-text log output for a specific job.
     * @returns {Promise<string|null>} Log text, or null if unavailable
     */
    async getJobLog(connection, owner, repo, jobId) {
        return null;
    },

    /**
     * Re-run only the failed jobs of a workflow run on the active provider.
     *
     * Implemented by Gitea (1.21+) and GitHub via near-identical Actions
     * endpoints; GitLab inherits `notSupported`. The PR Review dock uses
     * `capabilities.rerunCi` to decide whether to render the button.
     *
     * @param {GitConnection} connection
     * @param {string} owner
     * @param {string} repo
     * @param {string|number} runId
     * @returns {Promise<{ok:boolean, runId:string|number}>}
     * @since 2.13.2
     */
    async rerunWorkflowJobs(connection, owner, repo, runId) {
        notSupported(this.name, 'rerunWorkflowJobs');
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
