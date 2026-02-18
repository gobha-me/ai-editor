/**
 * GitLab Git Provider
 * 
 * Implements the git provider interface for GitLab.com and self-hosted GitLab.
 * 
 * Key API differences from GitHub/Gitea:
 *   - Auth: PRIVATE-TOKEN header
 *   - API v4: /api/v4
 *   - Projects identified by URL-encoded owner/repo path
 *   - MRs use iid (internal ID), source_branch/target_branch naming
 *   - File paths URL-encoded in endpoints (not path segments)
 *   - Batch commits via Commits API (atomic multi-file operations)
 *   - Tree API supports recursive=true natively
 *   - CI via commit statuses API
 * 
 * All methods receive a `connection` object:
 *   { id, provider, label, url, token, enabled }
 */

import { EventBus } from '../core.js';
import { circuitBreakerGuard, markReachable, markUnreachable, healthProbe } from './base.js';

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

/**
 * Encode a project path for GitLab API URLs.
 * GitLab expects owner/repo to be URL-encoded as a single path segment.
 * e.g., "jeff/ai-editor" → "jeff%2Fai-editor"
 */
function projectId(owner, repo) {
    return encodeURIComponent(`${owner}/${repo}`);
}

/**
 * Encode a file path for GitLab repository file API URLs.
 * Forward slashes must be URL-encoded.
 * e.g., "js/app.js" → "js%2Fapp.js"
 */
function encodePath(path) {
    return encodeURIComponent(path);
}

// ============================================
// PROVIDER DEFINITION
// ============================================

const gitlabProvider = {
    id: 'gitlab',
    name: 'GitLab',
    icon: '🦊',
    description: 'GitLab.com or self-hosted GitLab',

    // ========================================
    // AUTH / HTTP
    // ========================================

    getHeaders(connection) {
        return {
            'PRIVATE-TOKEN': connection.token,
            'Content-Type': 'application/json'
        };
    },

    getBaseUrl(connection) {
        const url = connection.url?.replace(/\/$/, '') || 'https://gitlab.com';
        // Ensure /api/v4 suffix
        if (url.endsWith('/api/v4')) return url;
        return `${url}/api/v4`;
    },

    /**
     * Get the web URL for link generation (without /api/v4).
     */
    getWebUrl(connection) {
        const url = connection.url?.replace(/\/$/, '') || 'https://gitlab.com';
        return url.replace(/\/api\/v4$/, '');
    },

    /** Default request timeout (ms) for lightweight reads. */
    REQUEST_TIMEOUT: 15_000,
    /** Extended timeout for write operations. */
    WRITE_TIMEOUT: 30_000,
    /** Heavy timeout for batch commits, large listings, etc. */
    HEAVY_TIMEOUT: 60_000,
    /** Lightweight endpoint for health probes. */
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
                const rawBody = await response.text();
                let friendlyMsg = `${response.status}`;
                try {
                    const parsed = JSON.parse(rawBody);
                    friendlyMsg = parsed.message || parsed.error || 
                        (Array.isArray(parsed) ? parsed.join(', ') : friendlyMsg);
                } catch {
                    if (rawBody.length < 200) friendlyMsg = rawBody;
                }

                const err = new Error(`GitLab: ${friendlyMsg}`);
                err.status = response.status;
                err.url = url;
                err.endpoint = endpoint;
                err.rawBody = rawBody;

                // Rate limit info
                const remaining = response.headers.get('RateLimit-Remaining');
                if (remaining !== null && response.status === 429) {
                    const reset = response.headers.get('RateLimit-Reset');
                    err.message = `GitLab: Rate limit exceeded. Resets at ${reset ? new Date(parseInt(reset) * 1000).toLocaleTimeString() : 'unknown'}`;
                }

                throw err;
            }

            markReachable(connection, 'gitlab');

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
                        console.log(`[GitLab] Timeout on ${endpoint} but health probe OK — server is slow, not dead`);
                    } else {
                        markUnreachable(connection, 'gitlab', error.message);
                    }
                } else {
                    markUnreachable(connection, 'gitlab', error.message);
                }
            }
            throw error;
        }
    },

    // ========================================
    // REPOSITORIES
    // ========================================

    async listRepos(connection) {
        // Fetch projects the user is a member of, sorted by last activity
        const repos = await this.request(connection, 'GET',
            '/projects?membership=true&order_by=last_activity_at&per_page=100', null, this.HEAVY_TIMEOUT
        );
        return repos.map(r => ({
            id: r.id,
            owner: r.namespace?.full_path || r.path_with_namespace.split('/').slice(0, -1).join('/'),
            name: r.path,
            fullName: r.path_with_namespace,
            description: r.description,
            defaultBranch: r.default_branch,
            private: r.visibility === 'private',
            url: r.web_url
        }));
    },

    async getRepo(connection, owner, repo) {
        const r = await this.request(connection, 'GET',
            `/projects/${projectId(owner, repo)}`
        );
        return {
            id: r.id,
            owner: r.namespace?.full_path || owner,
            name: r.path,
            fullName: r.path_with_namespace,
            description: r.description,
            defaultBranch: r.default_branch,
            private: r.visibility === 'private',
            url: r.web_url
        };
    },

    async createRepo(connection, name, { description = '', isPrivate = true, autoInit = true } = {}) {
        const r = await this.request(connection, 'POST', '/projects', {
            name,
            description,
            visibility: isPrivate ? 'private' : 'public',
            initialize_with_readme: autoInit,
            default_branch: 'main'
        });
        const owner = r.namespace?.full_path || r.path_with_namespace.split('/').slice(0, -1).join('/');
        EventBus.emit('git:repoCreated', { connectionId: connection.id, owner, repo: r.path });
        return {
            id: r.id,
            owner,
            name: r.path,
            fullName: r.path_with_namespace,
            description: r.description,
            defaultBranch: r.default_branch,
            private: r.visibility === 'private',
            url: r.web_url
        };
    },

    // ========================================
    // BRANCHES
    // ========================================

    async listBranches(connection, owner, repo) {
        const branches = await this.request(connection, 'GET',
            `/projects/${projectId(owner, repo)}/repository/branches?per_page=100`
        );
        return branches.map(b => ({
            name: b.name,
            protected: b.protected,
            sha: b.commit.id
        }));
    },

    async createBranch(connection, owner, repo, name, from = 'main') {
        await this.request(connection, 'POST',
            `/projects/${projectId(owner, repo)}/repository/branches`, {
                branch: name,
                ref: from
            }
        );
        EventBus.emit('git:branchCreated', { connectionId: connection.id, owner, repo, name });
        return name;
    },

    async deleteBranch(connection, owner, repo, name) {
        await this.request(connection, 'DELETE',
            `/projects/${projectId(owner, repo)}/repository/branches/${encodeURIComponent(name)}`
        );
        EventBus.emit('git:branchDeleted', { connectionId: connection.id, owner, repo, name });
    },

    // ========================================
    // FILE TREE / CONTENTS
    // ========================================

    async getContents(connection, owner, repo, path = '', ref = 'main') {
        let endpoint = `/projects/${projectId(owner, repo)}/repository/tree?ref=${encodeURIComponent(ref)}&per_page=100`;
        if (path) endpoint += `&path=${encodeURIComponent(path)}`;

        const items = await this.request(connection, 'GET', endpoint);
        return (items || []).map(item => ({
            name: item.name,
            path: item.path,
            type: item.type === 'tree' ? 'dir' : 'file',
            sha: item.id,
            size: 0,  // Tree API doesn't return size
            url: null
        }));
    },

    async getFileTree(connection, owner, repo, ref = 'main', path = '') {
        // GitLab tree API supports recursive=true natively
        // Paginate to get all entries (default per_page=20)
        const allItems = [];
        let page = 1;
        const perPage = 100;

        while (true) {
            let endpoint = `/projects/${projectId(owner, repo)}/repository/tree?ref=${encodeURIComponent(ref)}&recursive=true&per_page=${perPage}&page=${page}`;
            if (path) endpoint += `&path=${encodeURIComponent(path)}`;

            const items = await this.request(connection, 'GET', endpoint, null, this.HEAVY_TIMEOUT);
            if (!items || items.length === 0) break;

            allItems.push(...items);

            // If we got fewer than perPage, we're done
            if (items.length < perPage) break;
            page++;

            // Safety valve — cap at 10K items
            if (allItems.length >= 10000) {
                console.warn('[GitLab] Tree exceeds 10K items, stopping pagination');
                break;
            }
        }

        let tree = allItems.map(item => ({
            name: item.name,
            path: item.path,
            type: item.type === 'tree' ? 'dir' : 'file',
            sha: item.id,
            size: 0,
            url: null
        }));

        return tree.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
            return a.path.localeCompare(b.path);
        });
    },

    async getFile(connection, owner, repo, path, ref = 'main', opts = {}) {
        const file = await this.request(connection, 'GET',
            `/projects/${projectId(owner, repo)}/repository/files/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
            null, opts.timeout || null
        );
        const content = file.content ? base64ToUtf8(file.content) : '';
        return {
            name: file.file_name,
            path: file.file_path,
            sha: file.blob_id,
            size: file.size,
            content,
            encoding: file.encoding
        };
    },

    // ========================================
    // BLAME & FILE HISTORY
    // ========================================

    async getBlame(connection, owner, repo, path, ref = 'main') {
        // GitLab: GET /projects/:id/repository/files/:path/blame?ref=branch
        const data = await this.request(connection, 'GET',
            `/projects/${projectId(owner, repo)}/repository/files/${encodePath(path)}/blame?ref=${encodeURIComponent(ref)}`);

        // Normalize GitLab blame format: [{ commit: { id, message, authored_date, author_name, ... }, lines: [...] }]
        let lineNum = 1;
        const ranges = (data || []).map(part => {
            const c = part.commit || {};
            const range = {
                commit: {
                    sha: c.id || '',
                    shortSha: c.short_id || (c.id || '').slice(0, 7),
                    message: (c.message || '').split('\n')[0],
                    author: c.author_name || '',
                    email: c.author_email || '',
                    date: c.authored_date || ''
                },
                startLine: lineNum,
                lines: part.lines || []
            };
            lineNum += range.lines.length;
            return range;
        });
        return { ranges };
    },

    async getFileCommits(connection, owner, repo, path, ref = 'main') {
        const data = await this.request(connection, 'GET',
            `/projects/${projectId(owner, repo)}/repository/commits?ref_name=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}&per_page=50`);
        return (data || []).map(c => ({
            sha: c.id,
            shortSha: c.short_id || (c.id || '').slice(0, 7),
            message: (c.message || '').split('\n')[0],
            author: c.author_name || '',
            email: c.author_email || '',
            date: c.authored_date || ''
        }));
    },

    // ========================================
    // FILE CRUD
    // ========================================

    async createFile(connection, owner, repo, path, content, message, branch = 'main', encoding = 'text') {
        const result = await this.request(connection, 'POST',
            `/projects/${projectId(owner, repo)}/repository/files/${encodePath(path)}`, {
                branch,
                content,
                commit_message: message,
                encoding
            }
        );
        EventBus.emit('git:fileCreated', { connectionId: connection.id, owner, repo, path, branch, content });
        return result;
    },

    async updateFile(connection, owner, repo, path, content, message, sha, branch = 'main') {
        // GitLab doesn't need SHA for updates — it uses branch-level locking.
        // We accept sha for interface compatibility but don't send it.
        const result = await this.request(connection, 'PUT',
            `/projects/${projectId(owner, repo)}/repository/files/${encodePath(path)}`, {
                branch,
                content,
                commit_message: message,
                encoding: 'text'
            }
        );
        EventBus.emit('git:fileUpdated', { connectionId: connection.id, owner, repo, path, branch, content });
        return result;
    },

    async deleteFile(connection, owner, repo, path, message, sha, branch = 'main') {
        await this.request(connection, 'DELETE',
            `/projects/${projectId(owner, repo)}/repository/files/${encodePath(path)}`, {
                branch,
                commit_message: message
            }
        );
        EventBus.emit('git:fileDeleted', { connectionId: connection.id, owner, repo, path, branch });
    },

    async renameFile(connection, owner, repo, oldPath, newPath, message, branch = 'main') {
        // GitLab has no rename API — use commits API for atomic move
        const file = await this.getFile(connection, owner, repo, oldPath, branch);
        await this.request(connection, 'POST',
            `/projects/${projectId(owner, repo)}/repository/commits`, {
                branch,
                commit_message: message,
                actions: [
                    { action: 'delete', file_path: oldPath },
                    { action: 'create', file_path: newPath, content: file.content, encoding: 'text' }
                ]
            }
        );
        EventBus.emit('git:fileRenamed', { connectionId: connection.id, owner, repo, oldPath, newPath, branch });
    },

    async batchCommitFiles(connection, owner, repo, files, message, branch = 'main') {
        // GitLab's Commits API supports atomic multi-file operations in a single commit!
        // Much better than the sequential approach GitHub/Gitea need.
        const actions = files.map(f => ({
            action: f.operation === 'update' ? 'update' : 'create',
            file_path: f.path,
            content: f.content,
            encoding: f.encoding || 'text'
        }));

        try {
            await this.request(connection, 'POST',
                `/projects/${projectId(owner, repo)}/repository/commits`, {
                    branch,
                    commit_message: message,
                    actions
                },
                this.HEAVY_TIMEOUT
            );

            const results = files.map(f => ({ path: f.path, success: true }));
            EventBus.emit('git:batchCommitted', {
                connectionId: connection.id, owner, repo, branch, message,
                succeeded: results.length, failed: 0
            });
            return { results, errors: [] };
        } catch (error) {
            // If atomic commit fails, fall back to individual operations
            console.warn('[GitLab] Atomic batch commit failed, falling back to sequential:', error.message);
            const results = [];
            const errors = [];

            for (const file of files) {
                try {
                    if (file.operation === 'update') {
                        await this.updateFile(connection, owner, repo,
                            file.path, file.content, message, file.sha, branch
                        );
                    } else {
                        await this.createFile(connection, owner, repo,
                            file.path, file.content, message, branch, file.encoding || 'text'
                        );
                    }
                    results.push({ path: file.path, success: true });
                } catch (err) {
                    errors.push({ path: file.path, success: false, error: err.message });
                }
            }

            EventBus.emit('git:batchCommitted', {
                connectionId: connection.id, owner, repo, branch, message,
                succeeded: results.length, failed: errors.length
            });
            return { results, errors };
        }
    },

    // ========================================
    // ISSUES
    // ========================================

    async listIssues(connection, owner, repo, state = 'open', labels = '', page = 1) {
        let openedState = state;
        // GitLab uses 'opened' not 'open'
        if (state === 'open') openedState = 'opened';

        let endpoint = `/projects/${projectId(owner, repo)}/issues?state=${openedState}&per_page=100&order_by=created_at&sort=asc&page=${page}`;
        if (labels) endpoint += `&labels=${encodeURIComponent(labels)}`;
        const items = await this.request(connection, 'GET', endpoint);

        return (items || []).map(i => {
            // Parse dependencies from body
            const depPattern = /(?:depends\s+on|blocked\s+by|requires|after|prerequisite[s]?:?)\s*#(\d+)/gi;
            const body = i.description || '';
            const deps = [];
            let match;
            while ((match = depPattern.exec(body)) !== null) {
                const depNum = parseInt(match[1]);
                if (!deps.includes(depNum)) deps.push(depNum);
            }

            return {
                number: i.iid,  // GitLab uses iid (internal ID) for project-scoped resources
                title: i.title,
                body,
                state: i.state === 'opened' ? 'open' : i.state,  // Normalize to 'open'
                labels: (i.labels || []),  // GitLab returns labels as string array
                assignees: (i.assignees || []).map(a => a.username),
                dependencies: deps,
                createdAt: i.created_at,
                updatedAt: i.updated_at,
                url: i.web_url
            };
        });
    },

    async getIssue(connection, owner, repo, number) {
        const i = await this.request(connection, 'GET',
            `/projects/${projectId(owner, repo)}/issues/${number}`
        );
        return {
            number: i.iid,
            title: i.title,
            body: i.description || '',
            state: i.state === 'opened' ? 'open' : i.state,
            labels: i.labels || [],
            assignees: (i.assignees || []).map(a => a.username),
            comments: i.user_notes_count,
            createdAt: i.created_at,
            updatedAt: i.updated_at,
            url: i.web_url
        };
    },

    async createIssue(connection, owner, repo, title, body, labels = []) {
        const result = await this.request(connection, 'POST',
            `/projects/${projectId(owner, repo)}/issues`, {
                title,
                description: body,  // GitLab uses 'description' not 'body'
                labels: labels.join(',')  // GitLab expects comma-separated string
            }
        );
        EventBus.emit('git:issueCreated', { connectionId: connection.id, owner, repo, number: result.iid });
        return { ...result, number: result.iid };
    },

    async getIssueComments(connection, owner, repo, number) {
        const notes = await this.request(connection, 'GET',
            `/projects/${projectId(owner, repo)}/issues/${number}/notes?per_page=100&sort=asc`
        );
        // Filter out system notes (auto-generated by GitLab)
        return (notes || [])
            .filter(n => !n.system)
            .map(n => ({
                id: n.id,
                body: n.body,
                user: n.author.username,
                createdAt: n.created_at
            }));
    },

    async createIssueComment(connection, owner, repo, number, body) {
        const result = await this.request(connection, 'POST',
            `/projects/${projectId(owner, repo)}/issues/${number}/notes`, {
                body
            }
        );
        EventBus.emit('git:issueCommented', { connectionId: connection.id, owner, repo, number });
        return result;
    },

    async updateIssueState(connection, owner, repo, number, state) {
        // GitLab uses 'close' / 'reopen' via state_event
        const stateEvent = state === 'closed' ? 'close' : 'reopen';
        const result = await this.request(connection, 'PUT',
            `/projects/${projectId(owner, repo)}/issues/${number}`, {
                state_event: stateEvent
            }
        );
        EventBus.emit('git:issueUpdated', { connectionId: connection.id, owner, repo, number, state });
        return result;
    },

    async updateIssue(connection, owner, repo, number, fields) {
        const payload = {};
        if (fields.title !== undefined) payload.title = fields.title;
        if (fields.body !== undefined) payload.description = fields.body;  // GitLab: description
        if (fields.state !== undefined) {
            payload.state_event = fields.state === 'closed' ? 'close' : 'reopen';
        }
        if (fields.labels !== undefined) payload.labels = fields.labels.join(',');

        const result = await this.request(connection, 'PUT',
            `/projects/${projectId(owner, repo)}/issues/${number}`, payload
        );
        EventBus.emit('git:issueUpdated', { connectionId: connection.id, owner, repo, number, fields });
        return {
            number: result.iid,
            title: result.title,
            state: result.state === 'opened' ? 'open' : result.state,
            url: result.web_url
        };
    },

    // ========================================
    // MERGE REQUESTS
    // ========================================

    async listMergeRequests(connection, owner, repo, state = 'open') {
        let openedState = state;
        if (state === 'open') openedState = 'opened';

        const mrs = await this.request(connection, 'GET',
            `/projects/${projectId(owner, repo)}/merge_requests?state=${openedState}&per_page=50&order_by=updated_at`
        );
        return (mrs || []).map(mr => ({
            number: mr.iid,
            title: mr.title,
            body: mr.description,
            state: mr.state === 'opened' ? 'open' : mr.state,
            head: mr.source_branch,   // GitLab: source_branch
            base: mr.target_branch,   // GitLab: target_branch
            mergeable: mr.merge_status === 'can_be_merged',
            url: mr.web_url
        }));
    },

    async createMergeRequest(connection, owner, repo, title, body, head, base = 'main') {
        const mr = await this.request(connection, 'POST',
            `/projects/${projectId(owner, repo)}/merge_requests`, {
                title,
                description: body,
                source_branch: head,
                target_branch: base
            }
        );
        EventBus.emit('git:mrCreated', { connectionId: connection.id, owner, repo, number: mr.iid });
        return {
            number: mr.iid,
            title: mr.title,
            url: mr.web_url
        };
    },

    async getPullRequest(connection, owner, repo, number) {
        const mr = await this.request(connection, 'GET',
            `/projects/${projectId(owner, repo)}/merge_requests/${number}`
        );
        return {
            number: mr.iid,
            title: mr.title,
            body: mr.description || '',
            state: mr.state === 'opened' ? 'open' : mr.state,
            head: mr.source_branch,
            headSha: mr.sha || mr.diff_refs?.head_sha || '',
            base: mr.target_branch,
            mergeable: mr.merge_status === 'can_be_merged',
            merged: mr.state === 'merged',
            user: mr.author?.username,
            additions: mr.changes_count ? parseInt(mr.changes_count) : null,
            deletions: null,  // GitLab doesn't provide this on the MR object
            changed_files: mr.changes_count ? parseInt(mr.changes_count) : null,
            createdAt: mr.created_at,
            updatedAt: mr.updated_at,
            url: mr.web_url
        };
    },

    async getPullRequestFiles(connection, owner, repo, number) {
        // GitLab: /merge_requests/:iid/diffs returns structured diff objects
        const diffs = await this.request(connection, 'GET',
            `/projects/${projectId(owner, repo)}/merge_requests/${number}/diffs?per_page=100`
        );
        return (diffs || []).map(d => ({
            filename: d.new_path || d.old_path,
            status: d.new_file ? 'added' : d.deleted_file ? 'removed' : d.renamed_file ? 'renamed' : 'modified',
            additions: null,    // GitLab diffs don't include line counts per-file
            deletions: null,
            changes: null,
            patch: d.diff || null,
            previousFilename: d.renamed_file ? d.old_path : null
        }));
    },

    async getPullRequestComments(connection, owner, repo, number) {
        // GitLab uses "notes" for both general and inline comments
        const notes = await this.request(connection, 'GET',
            `/projects/${projectId(owner, repo)}/merge_requests/${number}/notes?per_page=100&sort=asc`
        );

        return (notes || [])
            .filter(n => !n.system)  // Exclude system-generated notes
            .map(n => ({
                id: n.id,
                body: n.body,
                user: n.author?.username,
                createdAt: n.created_at,
                // GitLab inline notes have position data
                path: n.position?.new_path || n.position?.old_path || null,
                line: n.position?.new_line || n.position?.old_line || null,
                type: n.position ? 'review' : 'general'
            }));
    },

    async addPullRequestComment(connection, owner, repo, number, body) {
        return this.request(connection, 'POST',
            `/projects/${projectId(owner, repo)}/merge_requests/${number}/notes`, {
                body
            }
        );
    },

    async mergePullRequest(connection, owner, repo, number, { mergeType = 'squash', title = '', message = '', deleteBranch = false, headSha = '' } = {}) {
        const payload = {
            should_remove_source_branch: deleteBranch
        };
        if (mergeType === 'squash') payload.squash = true;
        if (headSha) payload.sha = headSha;
        if (title || message) {
            payload.merge_commit_message = [title, message].filter(Boolean).join('\n\n');
            if (mergeType === 'squash') {
                payload.squash_commit_message = payload.merge_commit_message;
            }
        }

        const result = await this.request(connection, 'PUT',
            `/projects/${projectId(owner, repo)}/merge_requests/${number}/merge`, payload
        );

        EventBus.emit('git:prMerged', { connectionId: connection.id, owner, repo, number });
        return {
            merged: result.state === 'merged',
            sha: result.merge_commit_sha || null,
            message: `MR !${number} merged via ${mergeType}`
        };
    },

    // ========================================
    // TAGS & RELEASES
    // ========================================

    async listTags(connection, owner, repo) {
        const tags = await this.request(connection, 'GET',
            `/projects/${projectId(owner, repo)}/repository/tags?per_page=50&order_by=updated&sort=desc`
        );
        return (tags || []).map(t => ({
            name: t.name,
            sha: t.commit?.id || '',
            date: t.commit?.committed_date || null
        }));
    },

    async compareRefs(connection, owner, repo, base, head) {
        const result = await this.request(connection, 'GET',
            `/projects/${projectId(owner, repo)}/repository/compare?from=${encodeURIComponent(base)}&to=${encodeURIComponent(head)}`
        );
        const commits = (result.commits || []).map(c => ({
            sha: c.id || c.sha,
            message: c.message || '',
            author: c.author_name || 'unknown',
            date: c.authored_date || c.committed_date || ''
        }));
        // GitLab returns diffs, not files
        const files = (result.diffs || []).map(d => ({
            filename: d.new_path || d.old_path,
            status: d.new_file ? 'added' : d.deleted_file ? 'removed' : d.renamed_file ? 'renamed' : 'modified',
            additions: (d.diff || '').split('\n').filter(l => l.startsWith('+')).length,
            deletions: (d.diff || '').split('\n').filter(l => l.startsWith('-')).length,
            patch: d.diff || ''
        }));
        return { commits, files, totalCommits: commits.length };
    },

    async listReleases(connection, owner, repo) {
        const releases = await this.request(connection, 'GET',
            `/projects/${projectId(owner, repo)}/releases?per_page=20&order_by=released_at&sort=desc`
        );
        return (releases || []).map(r => ({
            id: r.name, // GitLab uses tag_name as primary key
            tag: r.tag_name,
            name: r.name || r.tag_name,
            body: r.description || '',
            draft: false, // GitLab doesn't have draft releases
            prerelease: false,
            url: r._links?.self || '',
            createdAt: r.released_at || r.created_at || ''
        }));
    },

    async createRelease(connection, owner, repo, { tag, name, body, draft = false, prerelease = false, target }) {
        const payload = {
            tag_name: tag,
            name: name || tag,
            description: body || ''
        };
        if (target) payload.ref = target;

        const result = await this.request(connection, 'POST',
            `/projects/${projectId(owner, repo)}/releases`, payload
        );
        return {
            id: result.name,
            tag: result.tag_name,
            url: result._links?.self || ''
        };
    },

    // ========================================
    // COMMIT DIFF
    // ========================================

    async getCommitDiff(connection, owner, repo, sha) {
        // GitLab: GET /projects/:id/repository/commits/:sha returns commit info
        const commit = await this.request(connection, 'GET',
            `/projects/${projectId(owner, repo)}/repository/commits/${sha}`);
        // GitLab: GET /projects/:id/repository/commits/:sha/diff returns file diffs
        const diffs = await this.request(connection, 'GET',
            `/projects/${projectId(owner, repo)}/repository/commits/${sha}/diff`);
        const files = (diffs || []).map(d => ({
            path: d.new_path || d.old_path,
            oldPath: d.old_path,
            status: d.new_file ? 'added' : d.deleted_file ? 'removed' : d.renamed_file ? 'renamed' : 'modified',
            additions: (d.diff || '').split('\n').filter(l => l.startsWith('+')).length,
            deletions: (d.diff || '').split('\n').filter(l => l.startsWith('-')).length,
            patch: d.diff || ''
        }));
        return {
            sha,
            shortSha: (commit.short_id || sha.slice(0, 7)),
            message: (commit.message || '').split('\n')[0],
            author: commit.author_name || '',
            date: commit.authored_date || '',
            files
        };
    },

    // ========================================
    // CI/CD STATUS
    // ========================================

    async getCommitStatus(connection, owner, repo, ref) {
        try {
            const statuses = await this.request(connection, 'GET',
                `/projects/${projectId(owner, repo)}/repository/commits/${encodeURIComponent(ref)}/statuses`
            );

            if (!statuses || statuses.length === 0) {
                // Try pipelines API as fallback
                return this._getPipelineStatus(connection, owner, repo, ref);
            }

            // Derive combined state: any failure → failure, any pending → pending, else success
            let state = 'success';
            if (statuses.some(s => s.status === 'pending' || s.status === 'running' || s.status === 'created')) state = 'pending';
            if (statuses.some(s => s.status === 'failed')) state = 'failure';
            if (statuses.every(s => s.status === 'created' || s.status === 'manual')) state = 'unknown';

            return {
                state,
                total: statuses.length,
                statuses: statuses.map(s => ({
                    context: s.name,
                    state: s.status === 'failed' ? 'failure' : s.status === 'running' ? 'pending' : s.status,
                    description: s.description || '',
                    url: s.target_url
                }))
            };
        } catch {
            return this._getPipelineStatus(connection, owner, repo, ref);
        }
    },

    /**
     * Fallback: get CI status from pipelines API.
     * GitLab CI often only populates pipelines, not commit statuses.
     */
    async _getPipelineStatus(connection, owner, repo, ref) {
        try {
            const pipelines = await this.request(connection, 'GET',
                `/projects/${projectId(owner, repo)}/pipelines?ref=${encodeURIComponent(ref)}&per_page=5&order_by=id&sort=desc`
            );

            if (!pipelines || pipelines.length === 0) {
                return { state: 'unknown', total: 0, statuses: [] };
            }

            const latest = pipelines[0];
            const stateMap = {
                'success': 'success',
                'failed': 'failure',
                'running': 'pending',
                'pending': 'pending',
                'created': 'pending',
                'canceled': 'error',
                'skipped': 'unknown',
                'manual': 'unknown'
            };

            // Fetch pipeline jobs for detail
            let jobs = [];
            try {
                jobs = await this.request(connection, 'GET',
                    `/projects/${projectId(owner, repo)}/pipelines/${latest.id}/jobs?per_page=50`
                );
            } catch { /* no jobs detail */ }

            return {
                state: stateMap[latest.status] || 'unknown',
                total: jobs.length || 1,
                statuses: jobs.length ? jobs.map(j => ({
                    context: `${j.stage}/${j.name}`,
                    state: stateMap[j.status] || j.status,
                    description: j.status,
                    url: j.web_url
                })) : [{
                    context: `Pipeline #${latest.id}`,
                    state: stateMap[latest.status] || latest.status,
                    description: latest.status,
                    url: latest.web_url
                }]
            };
        } catch {
            return { state: 'unknown', total: 0, statuses: [] };
        }
    },

    // ========================================
    // CI/CD (GitLab CI Pipelines — optional)
    // ========================================

    async listWorkflowRuns(connection, owner, repo) {
        try {
            const pipelines = await this.request(connection, 'GET',
                `/projects/${projectId(owner, repo)}/pipelines?per_page=20&order_by=id&sort=desc`
            );

            return (pipelines || []).map(p => ({
                id: p.id,
                name: `Pipeline #${p.id}`,
                status: p.status,
                conclusion: p.status === 'success' ? 'success' : p.status === 'failed' ? 'failure' : null,
                branch: p.ref,
                event: p.source || 'push',
                createdAt: p.created_at,
                updatedAt: p.updated_at,
                url: p.web_url
            }));
        } catch (e) {
            console.warn(`[GitLab] Could not fetch pipelines for ${owner}/${repo}:`, e.message);
            return [];
        }
    },

    async getWorkflowRun(connection, owner, repo, runId) {
        const p = await this.request(connection, 'GET',
            `/projects/${projectId(owner, repo)}/pipelines/${runId}`
        );
        return {
            id: p.id,
            name: `Pipeline #${p.id}`,
            status: p.status,
            conclusion: p.status === 'success' ? 'success' : p.status === 'failed' ? 'failure' : null,
            branch: p.ref,
            event: p.source || 'push',
            createdAt: p.created_at,
            updatedAt: p.updated_at,
            url: p.web_url,
            logsUrl: p.web_url
        };
    },

    async getWorkflowRunLogs(connection, owner, repo, runId) {
        // Pipeline job logs in GitLab require fetching each job individually.
        // Return the pipeline URL for the user to view in browser.
        const webUrl = this.getWebUrl(connection);
        return {
            message: 'GitLab pipeline logs are available in the GitLab UI.',
            url: `${webUrl}/${owner}/${repo}/-/pipelines/${runId}`
        };
    },

    // ========================================
    // UI EXTENSIONS
    // ========================================

    contributes: {
        panels: [
            {
                id: 'gitlab-issues',
                slot: 'sidebar-panels',
                title: 'Issues',
                icon: '📋',
                collapsible: true,
                refreshEvent: 'issues:refresh',
                priority: 10
            },
            {
                id: 'gitlab-mrs',
                slot: 'sidebar-panels',
                title: 'Merge Requests',
                icon: '🔀',
                collapsible: true,
                refreshEvent: 'prs:refresh',
                priority: 15
            }
        ],

        settings: [
            {
                id: 'url',
                type: 'text',
                label: 'GitLab URL',
                placeholder: 'https://gitlab.com',
                field: 'url',
                required: true
            },
            {
                id: 'token',
                type: 'password',
                label: 'Personal Access Token',
                placeholder: 'glpat-xxxxxxxxxxxxxxxxxxxx',
                field: 'token',
                required: true
            }
        ],

        tools: []
    }
};

export default gitlabProvider;
export { utf8ToBase64, base64ToUtf8, projectId, encodePath };
