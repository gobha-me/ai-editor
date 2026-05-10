/**
 * GitHub Git Provider
 * 
 * Implements the git provider interface for GitHub.com and GitHub Enterprise.
 * 
 * Key API differences from Gitea:
 *   - Auth: Bearer token (not `token`)
 *   - Base URL: https://api.github.com (fixed for .com, configurable for GHE)
 *   - Create + Update both use PUT /contents/{path}
 *   - File tree uses git/trees API (recursive, single request)
 *   - Branch creation via git/refs API
 *   - Issues endpoint returns PRs — filter by pull_request field
 *   - API version header: X-GitHub-Api-Version: 2022-11-28
 * 
 * All methods receive a `connection` object:
 *   { id, provider, label, url, token, enabled }
 */

import { EventBus } from '../core.js';
import { circuitBreakerGuard, markReachable, markUnreachable, healthProbe } from './base.js';
import { buildLanguageEntries } from '../intelligence/retrieval/language-extensions.js';
import { splitUnifiedDiffByFile } from '../pr-review/diff-parse.js';

// ============================================
// ENCODING UTILITIES
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

const githubProvider = {
    id: 'github',
    name: 'GitHub',
    icon: '🐙',
    description: 'GitHub.com or GitHub Enterprise',
    fixedUrl: 'https://api.github.com',  // Override for GHE via connection URL

    // ========================================
    // AUTH / HTTP
    // ========================================

    getHeaders(connection) {
        return {
            'Authorization': `Bearer ${connection.token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json'
        };
    },

    getBaseUrl(connection) {
        const url = connection.url?.replace(/\/$/, '') || 'https://api.github.com';
        // GitHub.com: use as-is (already api.github.com)
        // GHE: user provides https://github.example.com → append /api/v3
        if (url === 'https://api.github.com' || url.includes('/api/')) {
            return url;
        }
        return `${url}/api/v3`;
    },

    /** Default request timeout (ms) for lightweight reads. */
    REQUEST_TIMEOUT: 15_000,
    /** Extended timeout for write operations. */
    WRITE_TIMEOUT: 30_000,
    /** Heavy timeout for batch commits, large listings, etc. */
    HEAVY_TIMEOUT: 60_000,
    /** Lightweight endpoint for health probes. */
    HEALTH_ENDPOINT: '/rate_limit',

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
                const rawBody = await response.text();
                let friendlyMsg = `${response.status}`;
                try {
                    const parsed = JSON.parse(rawBody);
                    friendlyMsg = parsed.message || parsed.error || friendlyMsg;
                } catch {
                    if (rawBody.length < 200) friendlyMsg = rawBody;
                }

                const err = new Error(`GitHub: ${friendlyMsg}`);
                err.status = response.status;
                err.url = url;
                err.endpoint = endpoint;
                err.rawBody = rawBody;

                // Attach rate limit info if present
                const remaining = response.headers.get('X-RateLimit-Remaining');
                const reset = response.headers.get('X-RateLimit-Reset');
                if (remaining !== null) {
                    err.rateLimit = {
                        remaining: parseInt(remaining),
                        reset: reset ? new Date(parseInt(reset) * 1000) : null
                    };
                    if (response.status === 403 && parseInt(remaining) === 0) {
                        err.message = `GitHub: Rate limit exceeded. Resets at ${err.rateLimit.reset?.toLocaleTimeString() || 'unknown'}`;
                    }
                }

                throw err;
            }

            markReachable(connection, 'github');

            const text = await response.text();
            return text ? JSON.parse(text) : null;
        } catch (error) {
            if (!error.status && !error.circuitOpen) {
                error.url = url;
                error.endpoint = endpoint;
                const isTimeout = error.name === 'TimeoutError' || error.message?.includes('timed out');
                if (isTimeout) {
                    const alive = await healthProbe(
                        this.getBaseUrl(connection),
                        this.getHeaders(connection),
                        this.HEALTH_ENDPOINT
                    );
                    if (alive) {
                        console.log(`[GitHub] Timeout on ${endpoint} but health probe OK — server is slow, not dead`);
                    } else {
                        markUnreachable(connection, 'github', error.message);
                    }
                } else {
                    markUnreachable(connection, 'github', error.message);
                }
            }
            throw error;
        }
    },

    // ========================================
    // REPOSITORIES
    // ========================================

    async listRepos(connection) {
        // Fetch user repos (owned + collaborator), sorted by recent push
        const repos = await this.request(connection, 'GET',
            '/user/repos?sort=pushed&per_page=100&type=all', null, this.HEAVY_TIMEOUT
        );
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
        const branches = await this.request(connection, 'GET',
            `/repos/${owner}/${repo}/branches?per_page=100`
        );
        return branches.map(b => ({
            name: b.name,
            protected: b.protected,
            sha: b.commit.sha
        }));
    },

    async createBranch(connection, owner, repo, name, from = 'main') {
        // GitHub needs the SHA of the source branch, not the branch name
        const branches = await this.request(connection, 'GET',
            `/repos/${owner}/${repo}/branches/${from}`
        );
        const sha = branches.commit.sha;

        await this.request(connection, 'POST', `/repos/${owner}/${repo}/git/refs`, {
            ref: `refs/heads/${name}`,
            sha
        });
        EventBus.emit('git:branchCreated', { connectionId: connection.id, owner, repo, name });
        return name;
    },

    async deleteBranch(connection, owner, repo, name) {
        await this.request(connection, 'DELETE',
            `/repos/${owner}/${repo}/git/refs/heads/${name}`
        );
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
            type: item.type === 'dir' ? 'dir' : 'file',
            sha: item.sha,
            size: item.size || 0,
            url: item.html_url
        }));
    },

    async getFileTree(connection, owner, repo, ref = 'main', path = '') {
        // GitHub's git/trees API with recursive=true returns the full tree in one request.
        // Much more efficient than walking directories one by one.
        try {
            const data = await this.request(connection, 'GET',
                `/repos/${owner}/${repo}/git/trees/${ref}?recursive=true`, null, this.HEAVY_TIMEOUT
            );

            let tree = (data.tree || [])
                .filter(item => item.type === 'blob' || item.type === 'tree')
                .map(item => ({
                    name: item.path.split('/').pop(),
                    path: item.path,
                    type: item.type === 'tree' ? 'dir' : 'file',
                    sha: item.sha,
                    size: item.size || 0,
                    url: null  // Tree API doesn't include html_url
                }));

            // Filter by path prefix if specified
            if (path) {
                const prefix = path.endsWith('/') ? path : path + '/';
                tree = tree.filter(item => item.path.startsWith(prefix));
            }

            return tree.sort((a, b) => {
                if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
                return a.path.localeCompare(b.path);
            });
        } catch (e) {
            // Fallback: if git/trees fails (e.g., repo too large, >100K files),
            // walk the contents API like Gitea does
            if (e.status === 409 || e.message?.includes('too large')) {
                console.warn('[GitHub] Tree too large for recursive API, falling back to contents walk');
                return this._walkContents(connection, owner, repo, ref, path);
            }
            throw e;
        }
    },

    /**
     * Fallback: walk directory tree via contents API (like Gitea).
     * Used when git/trees recursive fails for very large repos.
     */
    async _walkContents(connection, owner, repo, ref, path = '') {
        const tree = [];

        const walk = async (currentPath) => {
            const contents = await this.getContents(connection, owner, repo, currentPath, ref);
            for (const item of contents) {
                tree.push(item);
                if (item.type === 'dir') {
                    await walk(item.path);
                }
            }
        };

        await walk(path);
        return tree.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
            return a.path.localeCompare(b.path);
        });
    },

    async getFile(connection, owner, repo, path, ref = 'main', opts = {}) {
        const endpoint = `/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
        const file = await this.request(connection, 'GET', endpoint, null, opts.timeout || null);
        const content = file.content ? base64ToUtf8(file.content.replace(/\n/g, '')) : '';
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
     * GitHub `/repos/{owner}/{repo}/languages` returns `{ Lang: bytes }`.
     * Note: this endpoint computes against the repo's default branch and
     * ignores the `ref` argument upstream — kept for interface symmetry.
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
        // GitHub REST API does not provide line-by-line blame
        const err = new Error('GitHub REST API does not support line-by-line blame. Use file history instead.');
        err.code = 'BLAME_UNSUPPORTED';
        throw err;
    },

    async getFileCommits(connection, owner, repo, path, ref = 'main') {
        const data = await this.request(connection, 'GET',
            `/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}&per_page=50`);
        return (data || []).map(c => ({
            sha: c.sha,
            shortSha: (c.sha || '').slice(0, 7),
            message: (c.commit?.message || '').split('\n')[0],
            author: c.commit?.author?.name || c.author?.login || '',
            email: c.commit?.author?.email || '',
            date: c.commit?.author?.date || ''
        }));
    },

    async getCommits(connection, owner, repo, opts = {}) {
        const { path, max_count = 20, since, author, sha } = opts;
        try {
            const params = new URLSearchParams();
            if (sha) params.set('sha', sha);
            if (path) params.set('path', path);
            if (since) params.set('since', since);
            if (author) params.set('author', author);
            params.set('per_page', String(Math.min(max_count, 100)));

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
                url: c.html_url || `https://github.com/${owner}/${repo}/commit/${c.sha}`
            }));
        } catch (e) {
            console.warn(`[GitHub] Could not fetch commits for ${owner}/${repo}:`, e.message);
            return [];
        }
    },
    // ========================================
    // FILE CRUD
    // ========================================

    // GitHub uses PUT for both create and update.
    // Create: PUT without sha. Update: PUT with sha.

    async createFile(connection, owner, repo, path, content, message, branch = 'main') {
        const result = await this.request(connection, 'PUT',
            `/repos/${owner}/${repo}/contents/${path}`, {
                content: utf8ToBase64(content),
                message,
                branch
            }
        );
        EventBus.emit('git:fileCreated', { connectionId: connection.id, owner, repo, path, branch, content });
        return result;
    },

    async updateFile(connection, owner, repo, path, content, message, sha, branch = 'main') {
        const result = await this.request(connection, 'PUT',
            `/repos/${owner}/${repo}/contents/${path}`, {
                content: utf8ToBase64(content),
                message,
                sha,
                branch
            }
        );
        EventBus.emit('git:fileUpdated', { connectionId: connection.id, owner, repo, path, branch, content });
        return result;
    },

    async deleteFile(connection, owner, repo, path, message, sha, branch = 'main') {
        await this.request(connection, 'DELETE',
            `/repos/${owner}/${repo}/contents/${path}`, {
                message,
                sha,
                branch
            }
        );
        EventBus.emit('git:fileDeleted', { connectionId: connection.id, owner, repo, path, branch });
    },

    async renameFile(connection, owner, repo, oldPath, newPath, message, branch = 'main') {
        // GitHub has no rename API — read, create new, delete old
        const file = await this.getFile(connection, owner, repo, oldPath, branch);
        await this.createFile(connection, owner, repo, newPath, file.content, message, branch);
        await this.deleteFile(connection, owner, repo, oldPath, `${message} (removed old path)`, file.sha, branch);
        EventBus.emit('git:fileRenamed', { connectionId: connection.id, owner, repo, oldPath, newPath, branch });
    },

    async batchCommitFiles(connection, owner, repo, files, message, branch = 'main') {
        const results = [];
        const errors = [];

        for (const file of files) {
            try {
                const op = file.operation || (file.sha ? 'update' : 'create');
                if (op === 'delete') {
                    await this.deleteFile(
                        connection, owner, repo,
                        file.path, message, file.sha, branch
                    );
                    results.push({ path: file.path, success: true });
                } else {
                    const result = await this.updateFile(
                        connection, owner, repo,
                        file.path, file.content, message, file.sha, branch
                    );
                    results.push({ path: file.path, success: true, newSha: result.content?.sha });
                }
            } catch (error) {
                errors.push({ path: file.path, success: false, error: error.message });
            }
        }

        EventBus.emit('git:batchCommitted', {
            connectionId: connection.id, owner, repo, branch, message,
            succeeded: results.length, failed: errors.length
        });

        return { results, errors };
    },

    // ========================================
    // ISSUES
    // ========================================

    async listIssues(connection, owner, repo, state = 'open', labels = '', page = 1) {
        let endpoint = `/repos/${owner}/${repo}/issues?state=${state}&per_page=100&sort=created&direction=asc&page=${page}`;
        if (labels) endpoint += `&labels=${encodeURIComponent(labels)}`;
        const items = await this.request(connection, 'GET', endpoint);

        // GitHub returns PRs in the issues endpoint — filter them out
        const issues = (items || []).filter(i => !i.pull_request);

        return issues.map(i => {
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
        const i = await this.request(connection, 'GET',
            `/repos/${owner}/${repo}/issues/${number}`
        );
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
        const result = await this.request(connection, 'POST',
            `/repos/${owner}/${repo}/issues`, {
                title, body, labels
            }
        );
        EventBus.emit('git:issueCreated', { connectionId: connection.id, owner, repo, number: result.number });
        return result;
    },

    async getIssueComments(connection, owner, repo, number) {
        const comments = await this.request(connection, 'GET',
            `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`
        );
        return comments.map(c => ({
            id: c.id,
            body: c.body,
            user: c.user.login,
            createdAt: c.created_at
        }));
    },

    async createIssueComment(connection, owner, repo, number, body) {
        const result = await this.request(connection, 'POST',
            `/repos/${owner}/${repo}/issues/${number}/comments`, { body }
        );
        EventBus.emit('git:issueCommented', { connectionId: connection.id, owner, repo, number });
        return result;
    },

    async updateIssueState(connection, owner, repo, number, state) {
        const result = await this.request(connection, 'PATCH',
            `/repos/${owner}/${repo}/issues/${number}`, { state }
        );
        EventBus.emit('git:issueUpdated', { connectionId: connection.id, owner, repo, number, state });
        return result;
    },

    async updateIssue(connection, owner, repo, number, fields) {
        const payload = {};
        if (fields.title !== undefined) payload.title = fields.title;
        if (fields.body !== undefined) payload.body = fields.body;
        if (fields.state !== undefined) payload.state = fields.state;
        if (fields.labels !== undefined) payload.labels = fields.labels;
        const result = await this.request(connection, 'PATCH',
            `/repos/${owner}/${repo}/issues/${number}`, payload
        );
        EventBus.emit('git:issueUpdated', { connectionId: connection.id, owner, repo, number, fields });
        return {
            number: result.number,
            title: result.title,
            state: result.state,
            url: result.html_url
        };
    },

    // ========================================
    // PULL REQUESTS
    // ========================================

    async listMergeRequests(connection, owner, repo, state = 'open') {
        const prs = await this.request(connection, 'GET',
            `/repos/${owner}/${repo}/pulls?state=${state}&per_page=50&sort=updated`
        );
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
        const pr = await this.request(connection, 'POST',
            `/repos/${owner}/${repo}/pulls`, {
                title, body, head, base
            }
        );
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
            `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`
        );
        return (files || []).map(f => ({
            filename: f.filename,
            status: f.status,        // added, removed, modified, renamed
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
            patch: f.patch || null,   // unified diff for this file (null for binary)
            previousFilename: f.previous_filename || null
        }));
    },

    /**
     * Fetch the raw unified diff for a PR via the .diff media type and
     * parse it into a Map<filename, {status, additions, deletions, patch}>.
     * Used by the PR Review surface as the always-works fallback when
     * the structured endpoints omit patch text.
     *
     * @since 2.12.0
     */
    async getPullRequestDiff(connection, owner, repo, number) {
        const url = `${this.getBaseUrl(connection)}/repos/${owner}/${repo}/pulls/${number}`;
        const headers = { ...this.getHeaders(connection), Accept: 'application/vnd.github.v3.diff' };
        const resp = await fetch(url, {
            headers,
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
                `/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`
            ).then(comments => (comments || []).map(c => ({
                // 2.12.0 — `side` lets the PR Review side-by-side renderer
                // anchor the thread to the correct cell. GitHub exposes
                // `side` directly ('LEFT'|'RIGHT'); default to RIGHT
                // when missing (covers older comments).
                id: c.id,
                body: c.body,
                user: c.user.login,
                createdAt: c.created_at,
                path: c.path,
                line: c.line || c.original_line,
                side: c.side === 'LEFT' ? 'LEFT' : 'RIGHT',
                type: 'review'
            }))).catch(() => []),

            this.request(connection, 'GET',
                `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`
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
        // GitHub: GET /repos/{owner}/{repo}/commits/{sha} returns files with patches
        const data = await this.request(connection, 'GET',
            `/repos/${owner}/${repo}/commits/${sha}`);
        const files = (data.files || []).map(f => ({
            path: f.filename,
            status: f.status || 'modified',
            additions: f.additions || 0,
            deletions: f.deletions || 0,
            patch: f.patch || ''
        }));
        return {
            sha,
            shortSha: sha.slice(0, 7),
            message: (data.commit?.message || '').split('\n')[0],
            author: data.commit?.author?.name || data.author?.login || '',
            date: data.commit?.author?.date || '',
            files
        };
    },

    // ========================================
    // CI/CD STATUS
    // ========================================

    async addPullRequestComment(connection, owner, repo, number, body) {
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
        const methodMap = { merge: 'merge', squash: 'squash', rebase: 'rebase' };
        const payload = {
            merge_method: methodMap[mergeType] || 'squash'
        };
        if (title) payload.commit_title = title;
        if (message) payload.commit_message = message;
        if (headSha) payload.sha = headSha;

        const result = await this.request(connection, 'PUT',
            `/repos/${owner}/${repo}/pulls/${number}/merge`, payload
        );

        // Optionally delete branch after merge
        if (deleteBranch) {
            try {
                const pr = await this.getPullRequest(connection, owner, repo, number);
                if (pr.head) {
                    await this.deleteBranch(connection, owner, repo, pr.head);
                }
            } catch (e) {
                console.warn(`[GitHub] Could not delete branch after merge:`, e.message);
            }
        }

        EventBus.emit('git:prMerged', { connectionId: connection.id, owner, repo, number });
        return {
            merged: result.merged ?? true,
            sha: result.sha || null,
            message: `PR #${number} merged via ${mergeType}`
        };
    },

    /**
     * Submit a GitHub PR review. Endpoint:
     *   POST /repos/{owner}/{repo}/pulls/{number}/reviews
     *
     * GitHub's enum is the canonical one (`APPROVE`/`COMMENT`/`REQUEST_CHANGES`)
     * — passthrough via `_mapEventEnumGitHub`. Comment shape matches the
     * UI draft 1:1; mapper kept for symmetry with Gitea + tests.
     *
     * @since 2.13.0
     */
    async submitPullRequestReview(connection, owner, repo, number, { event, body, comments } = {}) {
        const payload = {
            event: _mapEventEnumGitHub(event),
        };
        if (body) payload.body = body;
        if (Array.isArray(comments) && comments.length > 0) {
            payload.comments = comments.map(_mapDraftToGitHubReviewComment);
        }
        const result = await this.request(connection, 'POST',
            `/repos/${owner}/${repo}/pulls/${number}/reviews`, payload
        );
        EventBus.emit('git:prReviewSubmitted', { connectionId: connection.id, owner, repo, number });
        return {
            id: result?.id ?? 0,
            state: result?.state ?? event,
            submittedAt: result?.submitted_at || new Date().toISOString(),
            url: result?.html_url,
        };
    },

    /**
     * Create a single review comment. Two endpoints:
     *   - Reply: POST /repos/{o}/{r}/pulls/{n}/comments/{id}/replies {body}
     *   - Line-anchored: POST /repos/{o}/{r}/pulls/{n}/comments
     *     {body, commit_id, path, line, side}
     *
     * `commit_id` is required for line-anchored comments — the caller
     * passes `commitSha` resolved from the PR's head SHA.
     *
     * @since 2.13.0
     */
    async createReviewComment(connection, owner, repo, number, { body, path, line, side, commitSha, in_reply_to } = {}) {
        if (in_reply_to) {
            const result = await this.request(connection, 'POST',
                `/repos/${owner}/${repo}/pulls/${number}/comments/${in_reply_to}/replies`,
                { body }
            );
            return {
                id: result?.id ?? 0,
                body: result?.body || body,
                user: result?.user?.login || '',
                createdAt: result?.created_at || new Date().toISOString(),
                type: 'review',
            };
        }
        if (!path || !line) {
            throw new Error('createReviewComment: either in_reply_to or (path + line) is required');
        }
        if (!commitSha) {
            throw new Error('createReviewComment: commitSha is required for line-anchored comments on GitHub');
        }
        const result = await this.request(connection, 'POST',
            `/repos/${owner}/${repo}/pulls/${number}/comments`,
            { body, commit_id: commitSha, path, line, side: side || 'RIGHT' }
        );
        return {
            id: result?.id ?? 0,
            body: result?.body || body,
            user: result?.user?.login || '',
            createdAt: result?.created_at || new Date().toISOString(),
            path,
            line,
            side: side || 'RIGHT',
            type: 'review',
        };
    },

    /**
     * Capabilities — GitHub supports review submission + merge; thread
     * resolve requires GraphQL (deferred), viewed-files requires the
     * preview API (deferred to a follow-up). `rerunCi` covers the
     * Actions `rerun-failed-jobs` endpoint.
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
        };
    },

    // ========================================
    // TAGS & RELEASES
    // ========================================

    async listTags(connection, owner, repo) {
        const tags = await this.request(connection, 'GET', `/repos/${owner}/${repo}/tags?per_page=50`);
        return (tags || []).map(t => ({
            name: t.name,
            sha: t.commit?.sha || '',
            date: t.commit?.committer?.date || null
        }));
    },

    async compareRefs(connection, owner, repo, base, head) {
        const result = await this.request(connection, 'GET',
            `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
        );
        const commits = (result.commits || []).map(c => ({
            sha: c.sha,
            message: c.commit?.message || '',
            author: c.commit?.author?.name || c.author?.login || 'unknown',
            date: c.commit?.author?.date || ''
        }));
        const files = (result.files || []).map(f => ({
            filename: f.filename,
            status: f.status || 'modified',
            additions: f.additions || 0,
            deletions: f.deletions || 0,
            patch: f.patch || ''
        }));
        return {
            commits,
            files,
            totalCommits: result.total_commits ?? commits.length,
            aheadBy: typeof result.ahead_by === 'number' ? result.ahead_by : null,
            behindBy: typeof result.behind_by === 'number' ? result.behind_by : null,
        };
    },

    // GitHub's /compare endpoint already returns ahead_by + behind_by in a
    // single round-trip — override the base two-call default.
    async getBranchAheadBehind(connection, owner, repo, branch, base) {
        if (!base || !branch || base === branch) {
            return { ahead: 0, behind: 0 };
        }
        try {
            const result = await this.request(connection, 'GET',
                `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}`
            );
            return {
                ahead: typeof result.ahead_by === 'number' ? result.ahead_by : null,
                behind: typeof result.behind_by === 'number' ? result.behind_by : null,
            };
        } catch {
            return { ahead: null, behind: null };
        }
    },

    async listReleases(connection, owner, repo) {
        const releases = await this.request(connection, 'GET', `/repos/${owner}/${repo}/releases?per_page=20`);
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

    async getCommitStatus(connection, owner, repo, ref) {
        try {
            const status = await this.request(connection, 'GET',
                `/repos/${owner}/${repo}/commits/${ref}/status`
            );
            return {
                state: status.state || 'unknown',  // success, pending, failure, error
                total: status.total_count || 0,
                statuses: (status.statuses || []).map(s => ({
                    context: s.context,
                    state: s.state,
                    description: s.description,
                    url: s.target_url
                }))
            };
        } catch (e) {
            // Also try check-runs API (GitHub Actions use checks, not statuses)
            try {
                const checks = await this.request(connection, 'GET',
                    `/repos/${owner}/${repo}/commits/${ref}/check-runs`
                );
                const runs = checks.check_runs || [];
                // Derive combined state from check runs
                let state = 'success';
                if (runs.some(r => r.status === 'in_progress' || r.status === 'queued')) state = 'pending';
                if (runs.some(r => r.conclusion === 'failure')) state = 'failure';
                if (runs.some(r => r.conclusion === 'action_required')) state = 'failure';
                if (runs.length === 0) state = 'unknown';

                return {
                    state,
                    total: runs.length,
                    statuses: runs.map(r => ({
                        context: r.name,
                        state: r.conclusion || r.status,
                        description: r.output?.summary || '',
                        url: r.html_url
                    }))
                };
            } catch {
                return { state: 'unknown', total: 0, statuses: [] };
            }
        }
    },

    // ========================================
    // CI/CD (GitHub Actions)
    // ========================================

    async listWorkflowRuns(connection, owner, repo) {
        try {
            const response = await this.request(connection, 'GET',
                `/repos/${owner}/${repo}/actions/runs?per_page=20`
            );

            const runs = response?.workflow_runs || [];
            return runs.map(r => ({
                id: r.id,
                name: r.name || r.display_title || 'Workflow',
                status: r.status,
                conclusion: r.conclusion,
                branch: r.head_branch,
                headSha: r.head_sha || '',
                event: r.event,
                createdAt: r.created_at,
                updatedAt: r.updated_at,
                url: r.html_url
            }));
        } catch (e) {
            console.warn(`[GitHub] Could not fetch workflow runs for ${owner}/${repo}:`, e.message);
            return [];
        }
    },

    async getWorkflowRun(connection, owner, repo, runId) {
        const r = await this.request(connection, 'GET',
            `/repos/${owner}/${repo}/actions/runs/${runId}`
        );
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
            // Fetch jobs for the run and aggregate their logs
            const jobs = await this.listWorkflowJobs(connection, owner, repo, runId);
            if (jobs.length === 0) {
                return {
                    message: 'No jobs found for this workflow run.',
                    url: `https://github.com/${owner}/${repo}/actions/runs/${runId}`
                };
            }
            const logParts = [];
            for (const job of jobs) {
                const log = await this.getJobLog(connection, owner, repo, job.id);
                logParts.push(`=== Job: ${job.name} (${job.conclusion || job.status}) ===\n${log || '(no log available)'}`);
            }
            return {
                logs: logParts.join('\n\n'),
                url: `https://github.com/${owner}/${repo}/actions/runs/${runId}`,
                jobCount: jobs.length
            };
        } catch (e) {
            console.warn('[GitHub] Could not fetch workflow logs:', e.message);
            return {
                message: 'GitHub workflow logs are available as a zip download.',
                url: `https://github.com/${owner}/${repo}/actions/runs/${runId}`
            };
        }
    },

    async listWorkflowJobs(connection, owner, repo, runId) {
        try {
            const resp = await this.request(connection, 'GET',
                `/repos/${owner}/${repo}/actions/runs/${runId}/jobs`
            );
            const jobs = resp?.jobs || [];
            return jobs.map(j => ({
                id: j.id,
                name: j.name || 'job',
                status: j.status,
                conclusion: j.conclusion || null,
                startedAt: j.started_at || null,
                completedAt: j.completed_at || null
            }));
        } catch (e) {
            console.warn(`[GitHub] Could not list jobs for run ${runId}:`, e.message);
            return [];
        }
    },

    async getJobLog(connection, owner, repo, jobId) {
        try {
            // GitHub job logs endpoint returns 302 → plain text log
            const url = `${this.getBaseUrl(connection)}/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`;
            const resp = await fetch(url, {
                headers: {
                    ...this.getHeaders(connection),
                    'Accept': 'application/vnd.github+json'
                },
                signal: AbortSignal.timeout(30000)
            });
            if (!resp.ok) return null;
            return await resp.text();
        } catch (e) {
            console.warn(`[GitHub] Could not fetch job ${jobId} logs:`, e.message);
            return null;
        }
    },

    /**
     * Re-run only the failed jobs of a GitHub Actions workflow run.
     * The endpoint returns 201 with no body.
     *
     * @since 2.13.2
     */
    async rerunWorkflowJobs(connection, owner, repo, runId) {
        await this.request(connection, 'POST',
            `/repos/${owner}/${repo}/actions/runs/${runId}/rerun-failed-jobs`
        );
        EventBus.emit('git:ciRerun', { connectionId: connection.id, owner, repo, runId });
        return { ok: true, runId };
    },

    async downloadArchive(connection, owner, repo, ref = 'main') {
        const url = `${this.getBaseUrl(connection)}/repos/${owner}/${repo}/zipball/${encodeURIComponent(ref)}`;
        const headers = { ...this.getHeaders(connection), 'Accept': 'application/vnd.github+json' };
        const response = await fetch(url, { headers });
        if (!response.ok) {
            throw new Error(`GitHub archive download failed: ${response.status}`);
        }
        return response.blob();
    },

    // ========================================
    // UI EXTENSIONS
    // ========================================

    contributes: {
        panels: [
            {
                id: 'github-issues',
                slot: 'sidebar-panels',
                title: 'Issues',
                icon: '📋',
                collapsible: true,
                refreshEvent: 'issues:refresh',
                priority: 10
            },
            {
                id: 'github-prs',
                slot: 'sidebar-panels',
                title: 'Pull Requests',
                icon: '🔀',
                collapsible: true,
                refreshEvent: 'prs:refresh',
                priority: 15
            }
        ],

        settings: [
            {
                id: 'token',
                type: 'password',
                label: 'Personal Access Token',
                placeholder: 'ghp_xxxxxxxxxxxxxxxxxxxx',
                field: 'token',
                required: true
            }
            // No URL field — fixedUrl handles github.com.
            // GHE users can override by adding a URL field manually
            // or we can add a GHE-specific provider later.
        ],

        tools: []
    }
};

// ============================================
// PURE MAPPERS (exported for tests/test-pr-review-submit-payload.mjs)
// ============================================

/**
 * Map a draft comment to GitHub's review-comment shape.
 * GitHub's shape matches the UI draft 1:1 — `{path, line, side, body}`.
 *
 * @param {{path:string, line:number, side:'LEFT'|'RIGHT', body:string}} d
 * @returns {{path:string, line:number, side:'LEFT'|'RIGHT', body:string}}
 */
function _mapDraftToGitHubReviewComment(d) {
    return { path: d.path, line: d.line, side: d.side, body: d.body };
}

/**
 * Map UI event enum to GitHub's. GitHub uses the same enum the UI
 * does — passthrough — but the mapper keeps the call site symmetric
 * with Gitea (`_mapEventEnum`) and gives tests something to grip.
 *
 * @param {string} event
 * @returns {string}
 */
function _mapEventEnumGitHub(event) {
    return event || 'COMMENT';
}

export default githubProvider;
export { utf8ToBase64, base64ToUtf8, _mapDraftToGitHubReviewComment, _mapEventEnumGitHub };
