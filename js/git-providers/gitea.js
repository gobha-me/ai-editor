/**
 * Gitea Git Provider
 * 
 * Implements the git provider interface for Gitea instances.
 * Extracted from the original monolithic js/gitea.js.
 * 
 * All methods receive a `connection` object:
 *   { id, provider, label, url, token, enabled }
 * 
 * Return shapes are normalized to match BASE_GIT_PROVIDER contracts.
 */

import { EventBus } from '../core.js';
import { EditorError, ErrorCode } from '../utils/errors.js';
import { circuitBreakerGuard, markReachable, markUnreachable, healthProbe } from './base.js';
import { buildLanguageEntries } from '../intelligence/retrieval/language-extensions.js';
import { splitUnifiedDiffByFile } from '../pr-review/diff-parse.js';

// ============================================
// ENCODING UTILITIES (shared)
// ============================================

function utf8ToBase64(str) {
    try {
        return btoa(unescape(encodeURIComponent(str)));
    } catch (e) {
        throw new Error(`Failed to encode content: ${e.message}`);
    }
}

function base64ToUtf8(str) {
    try {
        return decodeURIComponent(escape(atob(str)));
    } catch (e) {
        console.warn('UTF-8 base64 decoding failed, using atob fallback:', e);
        return atob(str);
    }
}

// ============================================
// PROVIDER DEFINITION
// ============================================

const giteaProvider = {
    id: 'gitea',
    name: 'Gitea',
    icon: '🍵',
    glyph: 'GT',
    description: 'Self-hosted Gitea / Forgejo instance',
    fixedUrl: null,  // User configures their instance URL

    // ========================================
    // AUTH / HTTP
    // ========================================

    getHeaders(connection) {
        return {
            'Authorization': `token ${connection.token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };
    },

    getBaseUrl(connection) {
        return `${connection.url.replace(/\/$/, '')}/api/v1`;
    },

    /** Default request timeout (ms) for lightweight reads. */
    REQUEST_TIMEOUT: 15_000,
    /** Extended timeout for write operations (create, update, delete). */
    WRITE_TIMEOUT: 30_000,
    /** Heavy timeout for batch commits, large tree fetches, etc. */
    HEAVY_TIMEOUT: 60_000,
    /** Lightweight endpoint for health probes (no auth needed). */
    HEALTH_ENDPOINT: '/version',

    async request(connection, method, endpoint, data = null, timeout = null) {
        // Circuit breaker: short-circuit if connection is down and cooldown active
        circuitBreakerGuard(connection);

        const effectiveTimeout = timeout || (method === 'GET' ? this.REQUEST_TIMEOUT : this.WRITE_TIMEOUT);
        const url = `${this.getBaseUrl(connection)}${endpoint}`;
        const options = {
            method,
            headers: this.getHeaders(connection),
            signal: AbortSignal.timeout(effectiveTimeout)
        };

        if (data && method !== 'GET') {
            options.body = JSON.stringify(data);
        }

        try {
            const response = await fetch(url, options);

            if (!response.ok) {
                const error = await response.text();
                const err = new Error(`Gitea API Error: ${response.status} - ${error}`);
                err.status = response.status;
                err.url = url;
                err.endpoint = endpoint;
                throw err;
            }

            // Connection is healthy — emit recovery if previously down
            markReachable(connection, 'gitea');

            const text = await response.text();
            return text ? JSON.parse(text) : null;
        } catch (error) {
            if (!error.status && !error.circuitOpen) {
                error.url = url;
                error.endpoint = endpoint;
                const isTimeout = error.name === 'TimeoutError' || error.message?.includes('timed out');
                if (isTimeout) {
                    // Server might be alive but slow — probe health endpoint
                    const alive = await healthProbe(
                        this.getBaseUrl(connection),
                        this.getHeaders(connection),
                        this.HEALTH_ENDPOINT
                    );
                    if (alive) {
                        console.log(`[Gitea] Timeout on ${endpoint} but health probe OK — server is slow, not dead`);
                    } else {
                        markUnreachable(connection, 'gitea', error.message);
                    }
                } else {
                    markUnreachable(connection, 'gitea', error.message);
                }
            }
            throw error;
        }
    },

    // ========================================
    // REPOSITORIES
    // ========================================

    async listRepos(connection) {
        const repos = await this.request(connection, 'GET', '/user/repos', null, this.HEAVY_TIMEOUT);
        return repos.map(r => ({
            id: r.id,
            owner: r.owner.login,
            name: r.name,
            fullName: r.full_name,
            description: r.description,
            defaultBranch: r.default_branch,
            private: r.private,
            url: r.html_url
        }));
    },

    async getRepo(connection, owner, repo) {
        const r = await this.request(connection, 'GET', `/repos/${owner}/${repo}`);
        return {
            id: r.id,
            owner: r.owner.login,
            name: r.name,
            fullName: r.full_name,
            description: r.description,
            defaultBranch: r.default_branch,
            private: r.private,
            url: r.html_url
        };
    },

    async createRepo(connection, name, { description = '', isPrivate = true, autoInit = true } = {}) {
        const r = await this.request(connection, 'POST', '/user/repos', {
            name,
            description,
            private: isPrivate,
            auto_init: autoInit,
            default_branch: 'main'
        });
        EventBus.emit('git:repoCreated', { connectionId: connection.id, owner: r.owner.login, repo: r.name });
        return {
            id: r.id,
            owner: r.owner.login,
            name: r.name,
            fullName: r.full_name,
            description: r.description,
            defaultBranch: r.default_branch,
            private: r.private,
            url: r.html_url
        };
    },

    // ========================================
    // BRANCHES
    // ========================================

    async listBranches(connection, owner, repo) {
        const branches = await this.request(connection, 'GET', `/repos/${owner}/${repo}/branches`);
        return branches.map(b => ({
            name: b.name,
            protected: b.protected,
            sha: b.commit.id
        }));
    },

    async createBranch(connection, owner, repo, name, from = 'main') {
        await this.request(connection, 'POST', `/repos/${owner}/${repo}/branches`, {
            new_branch_name: name,
            old_branch_name: from
        });
        EventBus.emit('git:branchCreated', { connectionId: connection.id, owner, repo, name });
        return name;
    },

    async deleteBranch(connection, owner, repo, name) {
        await this.request(connection, 'DELETE', `/repos/${owner}/${repo}/branches/${name}`);
        EventBus.emit('git:branchDeleted', { connectionId: connection.id, owner, repo, name });
    },

    // ========================================
    // FILE TREE / CONTENTS
    // ========================================

    async getContents(connection, owner, repo, path = '', ref = 'main') {
        const endpoint = `/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
        const contents = await this.request(connection, 'GET', endpoint);
        const items = Array.isArray(contents) ? contents : [contents];
        return items.map(item => ({
            name: item.name,
            path: item.path,
            type: item.type,
            sha: item.sha,
            size: item.size,
            url: item.html_url
        }));
    },

    async getFileTree(connection, owner, repo, ref = 'main', path = '') {
        const tree = [];
        const self = this;

        async function walk(currentPath) {
            const contents = await self.getContents(connection, owner, repo, currentPath, ref);
            for (const item of contents) {
                tree.push(item);
                if (item.type === 'dir') {
                    await walk(item.path);
                }
            }
        }

        await walk(path);
        return tree.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
            return a.path.localeCompare(b.path);
        });
    },

    async getFile(connection, owner, repo, path, ref = 'main', opts = {}) {
        const endpoint = `/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
        const file = await this.request(connection, 'GET', endpoint, null, opts.timeout || null);
        const content = file.content ? base64ToUtf8(file.content) : '';
        return {
            name: file.name,
            path: file.path,
            sha: file.sha,
            size: file.size,
            content,
            encoding: file.encoding
        };
    },

    /**
     * Gitea `/repos/{owner}/{repo}/languages` mirrors GitHub's shape:
     * `{ Lang: bytes }` against the default branch.
     */
    async getLanguages(connection, owner, repo, ref = 'main') {
        const endpoint = `/repos/${owner}/${repo}/languages`;
        const raw = await this.request(connection, 'GET', endpoint, null, null);
        return buildLanguageEntries(raw);
    },

    // ========================================
    // BLAME & FILE HISTORY
    // ========================================

    async getBlame(connection, owner, repo, path, ref = 'main') {
        // Gitea does not expose a blame API endpoint.
        // Throw BLAME_UNSUPPORTED so the UI falls back to file history.
        throw new EditorError('Gitea REST API does not support line-by-line blame.', {
            code: ErrorCode.BLAME_UNSUPPORTED,
            recoveryHint: 'Showing file commit history instead.',
        });
    },

    async getFileCommits(connection, owner, repo, path, ref = 'main') {
        // Gitea list-commits endpoint: GET /repos/{owner}/{repo}/commits
        // (NOT /git/commits — that path does not exist)
        const data = await this.request(connection, 'GET',
            `/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}&limit=50`);
        return (data || []).map(c => ({
            sha: c.sha,
            shortSha: (c.sha || '').slice(0, 7),
            message: (c.commit?.message || '').split('\n')[0],
            author: c.commit?.author?.name || c.author?.login || '',
            email: c.commit?.author?.email || '',
            date: c.commit?.author?.date || c.created || ''
        }));
    },

    // ========================================
    // FILE CRUD
    // ========================================

    async createFile(connection, owner, repo, path, content, message, branch = 'main') {
        const result = await this.request(connection, 'POST', `/repos/${owner}/${repo}/contents/${path}`, {
            content: utf8ToBase64(content),
            message,
            branch
        });
        EventBus.emit('git:fileCreated', { connectionId: connection.id, owner, repo, path, branch, content });
        return result;
    },

    async updateFile(connection, owner, repo, path, content, message, sha, branch = 'main') {
        const result = await this.request(connection, 'PUT', `/repos/${owner}/${repo}/contents/${path}`, {
            content: utf8ToBase64(content),
            message,
            sha,
            branch
        });
        EventBus.emit('git:fileUpdated', { connectionId: connection.id, owner, repo, path, branch, content });
        return result;
    },

    async deleteFile(connection, owner, repo, path, message, sha, branch = 'main') {
        await this.request(connection, 'DELETE', `/repos/${owner}/${repo}/contents/${path}`, {
            message,
            sha,
            branch
        });
        EventBus.emit('git:fileDeleted', { connectionId: connection.id, owner, repo, path, branch });
    },

    async renameFile(connection, owner, repo, oldPath, newPath, message, branch = 'main') {
        // Gitea has no rename API — read, create new, delete old
        const file = await this.getFile(connection, owner, repo, oldPath, branch);
        await this.createFile(connection, owner, repo, newPath, file.content, message, branch);
        await this.deleteFile(connection, owner, repo, oldPath, `${message} (removed old path)`, file.sha, branch);
        EventBus.emit('git:fileRenamed', { connectionId: connection.id, owner, repo, oldPath, newPath, branch });
    },

    /**
     * Commit multiple file creates/updates/deletes in a SINGLE commit.
     * Uses Gitea's multi-file contents endpoint so only ONE push event fires.
     *
     * @param {Object}   connection
     * @param {string}   owner
     * @param {string}   repo
     * @param {Array<{path: string, content?: string, sha?: string, operation?: 'create'|'update'|'delete', encoding?: 'base64'|'text'}>} files
     * @param {string}   message  Commit message
     * @param {string}   branch
     * @returns {Promise<{results: Array, errors: Array}>}
     */
    async batchCommitFiles(connection, owner, repo, files, message, branch = 'main') {
        const payload = {
            message,
            branch,
            files: files.map(f => {
                const entry = {
                    operation: f.operation || (f.sha ? 'update' : 'create'),
                    path: f.path
                };
                if (entry.operation !== 'delete' && f.content !== undefined) {
                    // If caller already base64-encoded (binary), pass through.
                    // Otherwise encode text to base64.
                    entry.content = f.encoding === 'base64'
                        ? f.content
                        : utf8ToBase64(f.content);
                }
                if (f.sha) {
                    entry.sha = f.sha;
                }
                return entry;
            })
        };

        const response = await this.request(
            connection, 'POST',
            `/repos/${owner}/${repo}/contents`,
            payload,
            this.HEAVY_TIMEOUT
        );

        // Normalize to { results, errors } shape for backward compat.
        // Gitea batch is atomic — all succeed or the whole request throws.
        const responseFiles = response?.files || [];
        const results = files.map(f => {
            const remote = responseFiles.find(rf => rf.path === f.path);
            return {
                path: f.path,
                success: true,
                newSha: remote?.sha || null
            };
        });

        EventBus.emit('git:batchCommitted', {
            connectionId: connection.id, owner, repo, branch, message,
            fileCount: files.length
        });

        return { results, errors: [] };
    },

    // ========================================
    // ISSUES
    // ========================================

    async listIssues(connection, owner, repo, state = 'open', labels = '', page = 1) {
        let endpoint = `/repos/${owner}/${repo}/issues?state=${state}&type=issues&limit=100&sort=oldest&page=${page}`;
        if (labels) endpoint += `&labels=${encodeURIComponent(labels)}`;
        const issues = await this.request(connection, 'GET', endpoint);
        return (issues || []).map(i => {
            // Parse dependencies from body
            const depPattern = /(?:depends\s+on|blocked\s+by|requires|after|prerequisite[s]?:?)\s*#(\d+)/gi;
            const body = i.body || '';
            const deps = [];
            let match;
            while ((match = depPattern.exec(body)) !== null) {
                const depNum = parseInt(match[1]);
                if (!deps.includes(depNum)) deps.push(depNum);
            }

            return {
                number: i.number,
                title: i.title,
                body,
                state: i.state,
                labels: (i.labels || []).map(l => l.name),
                assignees: (i.assignees || []).map(a => a.login),
                dependencies: deps,
                createdAt: i.created_at,
                updatedAt: i.updated_at,
                url: i.html_url
            };
        });
    },

    async getIssue(connection, owner, repo, number) {
        const i = await this.request(connection, 'GET', `/repos/${owner}/${repo}/issues/${number}`);
        return {
            number: i.number,
            title: i.title,
            body: i.body || '',
            state: i.state,
            labels: (i.labels || []).map(l => l.name),
            assignees: (i.assignees || []).map(a => a.login),
            comments: i.comments,
            createdAt: i.created_at,
            updatedAt: i.updated_at,
            url: i.html_url
        };
    },

    async createIssue(connection, owner, repo, title, body, labels = []) {
        const result = await this.request(connection, 'POST', `/repos/${owner}/${repo}/issues`, {
            title, body, labels
        });
        EventBus.emit('git:issueCreated', { connectionId: connection.id, owner, repo, number: result.number });
        return result;
    },

    async getIssueComments(connection, owner, repo, number) {
        const comments = await this.request(connection, 'GET', `/repos/${owner}/${repo}/issues/${number}/comments`);
        return comments.map(c => ({
            id: c.id,
            body: c.body,
            user: c.user.login,
            createdAt: c.created_at
        }));
    },

    async createIssueComment(connection, owner, repo, number, body) {
        const result = await this.request(connection, 'POST', `/repos/${owner}/${repo}/issues/${number}/comments`, { body });
        EventBus.emit('git:issueCommented', { connectionId: connection.id, owner, repo, number });
        return result;
    },

    async updateIssueState(connection, owner, repo, number, state) {
        const result = await this.request(connection, 'PATCH', `/repos/${owner}/${repo}/issues/${number}`, { state });
        EventBus.emit('git:issueUpdated', { connectionId: connection.id, owner, repo, number, state });
        return result;
    },

    async updateIssue(connection, owner, repo, number, fields) {
        const payload = {};
        if (fields.title !== undefined) payload.title = fields.title;
        if (fields.body !== undefined) payload.body = fields.body;
        if (fields.state !== undefined) payload.state = fields.state;
        if (fields.labels !== undefined) payload.labels = fields.labels;
        const result = await this.request(connection, 'PATCH', `/repos/${owner}/${repo}/issues/${number}`, payload);
        EventBus.emit('git:issueUpdated', { connectionId: connection.id, owner, repo, number, fields });
        return {
            number: result.number,
            title: result.title,
            state: result.state,
            url: result.html_url
        };
    },

    // ========================================
    // MERGE REQUESTS (Gitea calls them Pull Requests)
    // ========================================

    async listMergeRequests(connection, owner, repo, state = 'open') {
        const prs = await this.request(connection, 'GET', `/repos/${owner}/${repo}/pulls?state=${state}`);
        return prs.map(pr => ({
            number: pr.number,
            title: pr.title,
            body: pr.body,
            state: pr.state,
            head: pr.head.ref,
            base: pr.base.ref,
            mergeable: pr.mergeable,
            url: pr.html_url
        }));
    },

    async createMergeRequest(connection, owner, repo, title, body, head, base = 'main') {
        const pr = await this.request(connection, 'POST', `/repos/${owner}/${repo}/pulls`, {
            title, body, head, base
        });
        EventBus.emit('git:mrCreated', { connectionId: connection.id, owner, repo, number: pr.number });
        return {
            number: pr.number,
            title: pr.title,
            url: pr.html_url
        };
    },

    async getPullRequest(connection, owner, repo, number) {
        const pr = await this.request(connection, 'GET',
            `/repos/${owner}/${repo}/pulls/${number}`
        );
        return {
            number: pr.number,
            title: pr.title,
            body: pr.body || '',
            state: pr.state,
            head: pr.head.ref,
            headSha: pr.head.sha,
            base: pr.base.ref,
            mergeable: pr.mergeable,
            merged: pr.merged,
            user: pr.user.login,
            additions: pr.additions,
            deletions: pr.deletions,
            changed_files: pr.changed_files,
            createdAt: pr.created_at,
            updatedAt: pr.updated_at,
            url: pr.html_url
        };
    },

    async getPullRequestFiles(connection, owner, repo, number) {
        const files = await this.request(connection, 'GET',
            `/repos/${owner}/${repo}/pulls/${number}/files`
        );
        return (files || []).map(f => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
            patch: f.patch || null,
            previousFilename: f.previous_filename || null
        }));
    },

    /**
     * Fetch the raw unified diff for a PR via /pulls/{n}.diff and parse
     * it into a Map<filename, {status, additions, deletions, patch}>.
     * Used by the PR Review surface as the always-works fallback when
     * the structured endpoints omit patch text. Reuses _parseUnifiedDiff
     * already in use by getCommitDiff.
     *
     * @since 2.12.0
     */
    async getPullRequestDiff(connection, owner, repo, number) {
        const url = `${this.getBaseUrl(connection)}/repos/${owner}/${repo}/pulls/${number}.diff`;
        const resp = await fetch(url, {
            headers: this.getHeaders(connection),
            signal: AbortSignal.timeout(this.WRITE_TIMEOUT)
        });
        if (!resp.ok) {
            throw new Error(`PR diff fetch failed: ${resp.status} ${resp.statusText}`);
        }
        const rawDiff = await resp.text();
        return splitUnifiedDiffByFile(rawDiff);
    },

    async getPullRequestComments(connection, owner, repo, number) {
        // Fetch review comments and general comments in parallel
        const [reviewComments, generalComments] = await Promise.all([
            this.request(connection, 'GET',
                `/repos/${owner}/${repo}/pulls/${number}/comments`
            ).then(comments => (comments || []).map(c => {
                // 2.12.0 — `side` lets the PR Review side-by-side renderer
                // anchor the thread to the correct cell. Gitea anchors to
                // exactly one side: `old_position` set without `line` ==
                // LEFT (deleted/old line); otherwise RIGHT (new line).
                const onLeft = c.old_position && !c.line;
                return {
                    id: c.id,
                    body: c.body,
                    user: c.user.login,
                    createdAt: c.created_at,
                    path: c.path,
                    line: c.line || c.old_position,
                    side: onLeft ? 'LEFT' : 'RIGHT',
                    type: 'review'
                };
            })).catch(() => []),

            this.request(connection, 'GET',
                `/repos/${owner}/${repo}/issues/${number}/comments`
            ).then(comments => (comments || []).map(c => ({
                id: c.id,
                body: c.body,
                user: c.user.login,
                createdAt: c.created_at,
                type: 'general'
            }))).catch(() => [])
        ]);

        return [...reviewComments, ...generalComments]
            .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    },

    // ========================================
    // COMMIT DIFF
    // ========================================

    async getCommitDiff(connection, owner, repo, sha) {
        // Try /repos/{owner}/{repo}/commits/{sha} — includes files array in modern Gitea
        let commit = null;
        try {
            commit = await this.request(connection, 'GET',
                `/repos/${owner}/${repo}/commits/${sha}`);
        } catch (_) {
            // Fallback to /git/commits/ (different Gitea versions)
            try {
                commit = await this.request(connection, 'GET',
                    `/repos/${owner}/${repo}/git/commits/${sha}`);
            } catch (e2) {
                throw new Error(`Could not fetch commit ${sha.slice(0, 7)}: ${e2.message}`);
            }
        }

        let files = (commit.files || []).map(f => ({
            path: f.filename || f.new_path || f.old_path || '',
            status: f.status || 'modified',
            additions: f.additions || 0,
            deletions: f.deletions || 0,
            patch: f.patch || ''
        }));

        // Some Gitea versions return files without patches or stats.
        // Detect this and fetch the raw .diff endpoint as fallback.
        const hasPatch = files.some(f => f.patch || f.additions > 0 || f.deletions > 0);
        if (!hasPatch && files.length > 0) {
            console.log(`[Gitea] Commit ${sha.slice(0, 7)}: files lack patches, fetching raw .diff`);
            try {
                const rawDiff = await this._fetchRawDiff(connection, owner, repo, sha);
                if (rawDiff) {
                    const parsed = this._parseUnifiedDiff(rawDiff);
                    // Merge parsed patches into existing file list
                    for (const f of files) {
                        const match = parsed.get(f.path);
                        if (match) {
                            f.patch = match.patch;
                            f.additions = match.additions;
                            f.deletions = match.deletions;
                        }
                    }
                    // Add any files found in diff but missing from file list
                    for (const [path, data] of parsed) {
                        if (!files.find(f => f.path === path)) {
                            files.push({ path, ...data });
                        }
                    }
                }
            } catch (e) {
                console.warn(`[Gitea] Raw diff fetch failed for ${sha.slice(0, 7)}:`, e.message);
            }
        }

        return {
            sha,
            shortSha: sha.slice(0, 7),
            message: (commit?.commit?.message || '').split('\n')[0],
            author: commit?.commit?.author?.name || commit?.author?.login || '',
            date: commit?.commit?.author?.date || '',
            files
        };
    },

    /**
     * Fetch raw unified diff for a commit via the .diff endpoint.
     * Returns the raw diff text or null.
     */
    async _fetchRawDiff(connection, owner, repo, sha) {
        const url = `${this.getBaseUrl(connection)}/repos/${owner}/${repo}/git/commits/${sha}.diff`;
        const resp = await fetch(url, {
            headers: this.getHeaders(connection),
            signal: AbortSignal.timeout(this.WRITE_TIMEOUT)
        });
        if (!resp.ok) return null;
        return resp.text();
    },

    /**
     * Parse a raw unified diff into a Map<filename, {status, additions, deletions, patch}>.
     */
    _parseUnifiedDiff(rawDiff) {
        const fileMap = new Map();
        // Split on "diff --git" boundaries
        const sections = rawDiff.split(/^diff --git /m).slice(1); // skip empty first element

        for (const section of sections) {
            // Extract filename from "a/path b/path" header
            const headerLine = section.split('\n')[0];
            const match = headerLine.match(/a\/(.+?) b\/(.+)/);
            if (!match) continue;

            const filename = match[2];
            let status = 'modified';
            if (section.includes('new file mode')) status = 'added';
            else if (section.includes('deleted file mode')) status = 'removed';

            // Count +/- lines
            let additions = 0, deletions = 0;
            const lines = section.split('\n');
            const patchLines = [];
            let inHunk = false;

            for (const line of lines) {
                if (line.startsWith('@@')) {
                    inHunk = true;
                    patchLines.push(line);
                } else if (inHunk) {
                    if (line.startsWith('+') && !line.startsWith('+++')) {
                        additions++;
                        patchLines.push(line);
                    } else if (line.startsWith('-') && !line.startsWith('---')) {
                        deletions++;
                        patchLines.push(line);
                    } else if (line.startsWith(' ') || line === '') {
                        patchLines.push(line);
                    } else if (line.startsWith('diff ')) {
                        break; // next file
                    }
                }
            }

            fileMap.set(filename, {
                status,
                additions,
                deletions,
                patch: patchLines.join('\n')
            });
        }

        return fileMap;
    },

    // ========================================
    // COMMIT LOG
    // ========================================

    async getCommits(connection, owner, repo, opts = {}) {
        const { path, max_count = 20, since, author, sha } = opts;
        try {
            const params = new URLSearchParams();
            if (path) params.set('path', path);
            if (max_count) params.set('limit', String(Math.min(max_count, 100)));
            if (since) params.set('since', since);
            if (author) params.set('author', author);
            if (sha) params.set('sha', sha);

            const commits = await this.request(connection, 'GET',
                `/repos/${owner}/${repo}/commits?${params.toString()}`
            );

            if (!Array.isArray(commits) || commits.length === 0) {
                return [];
            }

            return commits.map(c => ({
                sha: c.sha,
                shortSha: c.sha.slice(0, 7),
                message: c.commit?.message || '',
                subject: (c.commit?.message || '').split('\n')[0],
                author: c.commit?.author?.name || c.author?.login || '',
                authorEmail: c.commit?.author?.email || '',
                date: c.commit?.author?.date || '',
                url: c.html_url || `${connection.url}/${owner}/${repo}/commit/${c.sha}`
            }));
        } catch (e) {
            console.warn(`[Gitea] Could not fetch commits for ${owner}/${repo}:`, e.message);
            return [];
        }
    },

    // ========================================
    // CI/CD STATUS
    // ========================================

    async getCommitStatus(connection, owner, repo, ref) {
        try {
            const status = await this.request(connection, 'GET',
                `/repos/${owner}/${repo}/commits/${ref}/status`
            );
            return {
                state: status.state || 'unknown',
                total: status.total_count || 0,
                statuses: (status.statuses || []).map(s => ({
                    context: s.context,
                    state: s.status,
                    description: s.description,
                    url: s.target_url
                }))
            };
        } catch {
            return { state: 'unknown', total: 0, statuses: [] };
        }
    },
    // ========================================
    // CI/CD (Gitea Actions)
    // ========================================

    async addPullRequestComment(connection, owner, repo, number, body) {
        // Gitea uses the issues API for general PR comments
        const comment = await this.request(connection, 'POST',
            `/repos/${owner}/${repo}/issues/${number}/comments`,
            { body }
        );
        return {
            id: comment.id,
            body: comment.body,
            user: comment.user.login,
            createdAt: comment.created_at
        };
    },

    async mergePullRequest(connection, owner, repo, number, { mergeType = 'squash', title = '', message = '', deleteBranch = false, headSha = '' } = {}) {
        // Gitea merge types: merge, rebase, rebase-merge, squash, manually-merged
        const doMap = { merge: 'merge', squash: 'squash', rebase: 'rebase' };
        const payload = {
            Do: doMap[mergeType] || 'squash',
            delete_branch_after_merge: deleteBranch
        };
        if (title) payload.MergeTitleField = title;
        if (message) payload.MergeMessageField = message;
        if (headSha) payload.head_commit_id = headSha;

        const result = await this.request(connection, 'POST',
            `/repos/${owner}/${repo}/pulls/${number}/merge`, payload
        );

        EventBus.emit('git:prMerged', { connectionId: connection.id, owner, repo, number });
        return {
            merged: true,
            sha: result?.sha || null,
            message: `PR #${number} merged via ${mergeType}`
        };
    },

    /**
     * Submit a Gitea PR review. Endpoint:
     *   POST /repos/{owner}/{repo}/pulls/{number}/reviews
     *
     * Gitea event enum maps `'APPROVE' → 'APPROVED'`; the other two pass
     * through unchanged. Comment side mapping per `_mapDraftToGiteaReviewComment`.
     *
     * @since 2.13.0
     */
    async submitPullRequestReview(connection, owner, repo, number, { event, body, comments } = {}) {
        const payload = {
            event: _mapEventEnum(event),
        };
        if (body) payload.body = body;
        if (Array.isArray(comments) && comments.length > 0) {
            payload.comments = comments.map(_mapDraftToGiteaReviewComment);
        }
        const result = await this.request(connection, 'POST',
            `/repos/${owner}/${repo}/pulls/${number}/reviews`, payload
        );
        EventBus.emit('git:prReviewSubmitted', { connectionId: connection.id, owner, repo, number });
        return {
            id: result?.id ?? 0,
            state: result?.state ?? event,
            submittedAt: result?.submitted_at || result?.created_at || new Date().toISOString(),
            url: result?.html_url,
        };
    },

    /**
     * Create a review comment. Two shapes:
     *   - Reply to an existing comment: wraps a single review under
     *     `POST /repos/{owner}/{repo}/pulls/{number}/reviews` with
     *     event=COMMENT and `comments:[{reply: in_reply_to, body}]`
     *     since Gitea has no standalone reply endpoint.
     *   - Line-anchored standalone: same wrapper with the line/path
     *     comment so it lives inside a one-comment review.
     *
     * @since 2.13.0
     */
    async createReviewComment(connection, owner, repo, number, { body, path, line, side, in_reply_to } = {}) {
        let comment;
        if (in_reply_to) {
            comment = { body, reply: in_reply_to };
        } else if (path && line) {
            comment = _mapDraftToGiteaReviewComment({ path, line, side: side || 'RIGHT', body });
        } else {
            throw new Error('createReviewComment: either in_reply_to or (path + line) is required');
        }
        const payload = { event: 'COMMENT', comments: [comment] };
        const result = await this.request(connection, 'POST',
            `/repos/${owner}/${repo}/pulls/${number}/reviews`, payload
        );
        EventBus.emit('git:prReviewSubmitted', { connectionId: connection.id, owner, repo, number });
        return {
            id: result?.id ?? 0,
            body,
            user: result?.user?.login || '',
            createdAt: result?.created_at || result?.submitted_at || new Date().toISOString(),
            path,
            line,
            side: side || 'RIGHT',
            type: 'review',
        };
    },

    /**
     * Capabilities — Gitea supports review submission + merge; thread
     * resolve and viewed-files are not exposed by the REST API.
     * `rerunCi` covers the Gitea Actions rerun-failed endpoint added in
     * Gitea 1.21+ (also supported by Forgejo).
     *
     * @since 2.13.0 (extended in 2.13.2 with rerunCi)
     */
    get capabilities() {
        return {
            reviewSubmission: true,
            threadResolve: false,
            viewedFiles: false,
            merge: true,
            rerunCi: true,
            mergeConflictResolution: true,
        };
    },

    // ========================================
    // TAGS & RELEASES
    // ========================================

    async listTags(connection, owner, repo) {
        const tags = await this.request(connection, 'GET', `/repos/${owner}/${repo}/tags?limit=50`);
        return (tags || []).map(t => ({
            name: t.name,
            sha: t.commit?.sha || t.id,
            date: t.commit?.timestamp || t.commit?.created || null
        }));
    },

    /**
     * Gitea's Compare schema is intentionally minimal: `{ commits,
     * total_commits }` only. The `definitions.Compare` in the upstream
     * swagger spec has no `files` property — verified against Gitea
     * 1.25 — and never has, across every released version. So
     * `compareRefs` cannot populate per-file patches on Gitea the way
     * it can on GitHub. Consumers that need patch text already cascade
     * through their own fallbacks:
     *   - release-manager → per-commit `getCommitDiff` (line 199-236
     *     of [`js/release-manager.js`](../release-manager.js))
     *   - PR Review → `getPullRequestDiff` → /pulls/{n}.diff (line
     *     154-170 of [`js/pr-review/PrReviewSurface.js`](../pr-review/PrReviewSurface.js))
     * Consumers that only need the changed-path set
     * (retrieval delta-indexer via `getChangedFilesBetween`) get the
     * paths from `commits[].files` via the override below.
     */
    async compareRefs(connection, owner, repo, base, head) {
        const result = await this.request(connection, 'GET',
            `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
        );

        if ((result?.commits || []).length === 0) {
            // Empty commits usually means a misconfigured ref name or
            // a token without read access — surface a one-line snippet
            // to make that diagnosable.
            console.log('[Gitea] Compare returned 0 commits. Response snippet:', JSON.stringify(result).slice(0, 300));
        }

        const commits = (result?.commits || []).map(c => ({
            sha: c.sha,
            message: c.commit?.message || c.message || '',
            author: c.commit?.author?.name || c.author?.login || 'unknown',
            date: c.commit?.author?.date || c.created || ''
        }));

        return { commits, files: [], totalCommits: result?.total_commits ?? commits.length };
    },

    /**
     * Override the base default (which unions `compareRefs(A,B).files`
     * and `compareRefs(B,A).files`) — on Gitea those file arrays are
     * always empty (see `compareRefs` docstring). Instead read
     * `commits[].files` directly from each /compare round-trip. Gitea's
     * `CommitAffectedFiles` carries `{ filename, status }` only (no
     * patch text, no additions/deletions), which is exactly what the
     * retrieval delta-indexer needs.
     *
     * Returns:
     *   - `[]` when both compares show zero commits (branches identical)
     *   - `Array<string>` of unique changed paths when at least one commit
     *     in either direction exposes a `files` array
     *   - `null` when commits exist but no commit carries a `files` array
     *     (server omitted them — caller falls back to a full re-walk
     *     rather than silently cloning a stale index)
     *   - `null` on any compare-round-trip error
     *
     * @since 2.69.0
     */
    async getChangedFilesBetween(connection, owner, repo, branchA, branchB) {
        if (!branchA || !branchB || branchA === branchB) return [];
        try {
            const [aToB, bToA] = await Promise.all([
                this.request(connection, 'GET',
                    `/repos/${owner}/${repo}/compare/${encodeURIComponent(branchA)}...${encodeURIComponent(branchB)}`),
                this.request(connection, 'GET',
                    `/repos/${owner}/${repo}/compare/${encodeURIComponent(branchB)}...${encodeURIComponent(branchA)}`),
            ]);

            const paths = new Set();
            let sawAnyFilesArray = false;
            let totalCommits = 0;
            for (const direction of [aToB, bToA]) {
                const commitList = direction?.commits || [];
                totalCommits += commitList.length;
                for (const c of commitList) {
                    if (Array.isArray(c?.files)) {
                        sawAnyFilesArray = true;
                        for (const f of c.files) {
                            const name = f?.filename;
                            if (typeof name === 'string' && name.length > 0) {
                                paths.add(name);
                            }
                        }
                    }
                }
            }

            if (totalCommits === 0) return [];
            if (!sawAnyFilesArray) return null;
            return Array.from(paths);
        } catch {
            return null;
        }
    },

    async listReleases(connection, owner, repo) {
        const releases = await this.request(connection, 'GET', `/repos/${owner}/${repo}/releases?limit=20`);
        return (releases || []).map(r => ({
            id: r.id,
            tag: r.tag_name,
            name: r.name || r.tag_name,
            body: r.body || '',
            draft: r.draft || false,
            prerelease: r.prerelease || false,
            url: r.html_url || '',
            createdAt: r.created_at || ''
        }));
    },

    async createRelease(connection, owner, repo, { tag, name, body, draft = false, prerelease = false, target }) {
        const payload = {
            tag_name: tag,
            name: name || tag,
            body: body || '',
            draft,
            prerelease
        };
        if (target) payload.target_commitish = target;

        const result = await this.request(connection, 'POST', `/repos/${owner}/${repo}/releases`, payload);
        return {
            id: result.id,
            tag: result.tag_name,
            url: result.html_url || ''
        };
    },

    async listWorkflowRuns(connection, owner, repo) {
        try {
            const response = await this.request(connection, 'GET',
                `/repos/${owner}/${repo}/actions/runs?limit=20`
            );

            let runs = [];
            if (Array.isArray(response)) runs = response;
            else if (response?.workflow_runs) runs = response.workflow_runs;
            else if (response?.runs) runs = response.runs;

            return runs.map(r => ({
                id: r.id,
                name: r.name || r.workflow_name || 'Workflow',
                status: r.status,
                conclusion: r.conclusion,
                branch: r.head_branch || r.branch,
                headSha: r.head_sha || r.sha || '',
                event: r.event,
                createdAt: r.created_at,
                updatedAt: r.updated_at,
                url: r.html_url || `${connection.url}/${owner}/${repo}/actions/runs/${r.id}`
            }));
        } catch (e) {
            console.warn(`[Gitea] Could not fetch workflow runs for ${owner}/${repo}:`, e.message);
            return [];
        }
    },

    async getWorkflowRun(connection, owner, repo, runId) {
        const r = await this.request(connection, 'GET', `/repos/${owner}/${repo}/actions/runs/${runId}`);
        return {
            id: r.id,
            name: r.name,
            status: r.status,
            conclusion: r.conclusion,
            branch: r.head_branch,
            event: r.event,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            url: r.html_url,
            logsUrl: r.logs_url
        };
    },

    async getWorkflowRunLogs(connection, owner, repo, runId) {
        try {
            return await this.request(connection, 'GET', `/repos/${owner}/${repo}/actions/runs/${runId}/logs`);
        } catch (e) {
            console.warn(`[Gitea] Could not fetch workflow logs:`, e.message);
            return null;
        }
    },

    async listWorkflowJobs(connection, owner, repo, runId) {
        try {
            // Gitea exposes tasks (jobs) for the repo; filter by run if possible.
            // Try run-specific jobs endpoint first (Gitea 1.22+), fall back to tasks.
            let jobs = [];
            try {
                const resp = await this.request(connection, 'GET',
                    `/repos/${owner}/${repo}/actions/runs/${runId}/jobs`
                );
                jobs = Array.isArray(resp) ? resp : (resp?.jobs || []);
            } catch {
                // Older Gitea — try the tasks endpoint
                const tasks = await this.request(connection, 'GET',
                    `/repos/${owner}/${repo}/actions/tasks`
                );
                jobs = (Array.isArray(tasks) ? tasks : (tasks?.workflow_jobs || tasks?.tasks || []))
                    .filter(t => String(t.run_id) === String(runId));
            }

            return jobs.map(j => ({
                id: j.id,
                name: j.name || 'job',
                status: j.status,
                conclusion: j.conclusion || null,
                startedAt: j.started_at || null,
                completedAt: j.completed_at || null
            }));
        } catch (e) {
            console.warn(`[Gitea] Could not list workflow jobs for run ${runId}:`, e.message);
            return [];
        }
    },

    async getJobLog(connection, owner, repo, jobId) {
        try {
            const resp = await fetch(
                `${this.getBaseUrl(connection)}/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`,
                {
                    headers: { 'Authorization': `token ${connection.token}` },
                    signal: AbortSignal.timeout(30000)
                }
            );
            if (!resp.ok) return null;
            return await resp.text();
        } catch (e) {
            console.warn(`[Gitea] Could not fetch job ${jobId} logs:`, e.message);
            return null;
        }
    },

    /**
     * Re-run only the failed jobs in a Gitea Actions workflow run.
     * Endpoint shipped in Gitea 1.21+; Forgejo mirrors it.
     *
     * @since 2.13.2
     */
    async rerunWorkflowJobs(connection, owner, repo, runId) {
        await this.request(connection, 'POST',
            `/repos/${owner}/${repo}/actions/runs/${runId}/rerun-failed`
        );
        EventBus.emit('git:ciRerun', { connectionId: connection.id, owner, repo, runId });
        return { ok: true, runId };
    },

    async downloadArchive(connection, owner, repo, ref = 'main') {
        const url = `${this.getBaseUrl(connection)}/repos/${owner}/${repo}/archive/${encodeURIComponent(ref)}.zip`;
        const response = await fetch(url, {
            headers: { 'Authorization': `token ${connection.token}` },
            signal: AbortSignal.timeout(this.HEAVY_TIMEOUT)
        });
        if (!response.ok) {
            throw new Error(`Gitea archive download failed: ${response.status}`);
        }
        return response.blob();
    },

    // ========================================
    // UI EXTENSIONS
    // ========================================

    contributes: {
        panels: [],

        settings: [
            {
                id: 'url',
                type: 'text',
                label: 'Instance URL',
                placeholder: 'https://git.example.com',
                field: 'url',
                required: true
            },
            {
                id: 'token',
                type: 'password',
                label: 'API Token',
                placeholder: 'Your Gitea API token',
                field: 'token',
                required: true
            }
        ],

        tools: []  // LLM tools contributed by this provider (populated at init)
    }
};

// ============================================
// PURE MAPPERS (exported for tests/test-pr-review-submit-payload.mjs)
// ============================================

/**
 * Map a draft comment to Gitea's review-comment shape.
 * Gitea anchors via `old_position` (LEFT) or `new_position` (RIGHT).
 *
 * @param {{path:string, line:number, side:'LEFT'|'RIGHT', body:string}} d
 * @returns {{path:string, body:string, old_position?:number, new_position?:number}}
 */
function _mapDraftToGiteaReviewComment(d) {
    const out = { path: d.path, body: d.body };
    if (d.side === 'LEFT') {
        out.old_position = d.line;
    } else {
        out.new_position = d.line;
    }
    return out;
}

/**
 * Map UI event enum (`COMMENT`/`APPROVE`/`REQUEST_CHANGES`) to Gitea's.
 * `APPROVE → APPROVED`; others passthrough.
 *
 * @param {string} event
 * @returns {string}
 */
function _mapEventEnum(event) {
    if (event === 'APPROVE') return 'APPROVED';
    return event || 'COMMENT';
}

export default giteaProvider;
export { utf8ToBase64, base64ToUtf8, _mapDraftToGiteaReviewComment, _mapEventEnum };
