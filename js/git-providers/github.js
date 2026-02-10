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

    async request(connection, method, endpoint, data = null) {
        const url = `${this.getBaseUrl(connection)}${endpoint}`;
        const options = {
            method,
            headers: this.getHeaders(connection)
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

            const text = await response.text();
            return text ? JSON.parse(text) : null;
        } catch (error) {
            if (!error.status) {
                error.url = url;
                error.endpoint = endpoint;
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
            '/user/repos?sort=pushed&per_page=100&type=all'
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
                `/repos/${owner}/${repo}/git/trees/${ref}?recursive=true`
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

    async getFile(connection, owner, repo, path, ref = 'main') {
        const endpoint = `/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
        const file = await this.request(connection, 'GET', endpoint);
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

    async batchUpdateFiles(connection, owner, repo, files, message, branch = 'main') {
        const results = [];
        const errors = [];

        for (const file of files) {
            try {
                const result = await this.updateFile(
                    connection, owner, repo,
                    file.path, file.content, message, file.sha, branch
                );
                results.push({ path: file.path, success: true, newSha: result.content?.sha });
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

    async listIssues(connection, owner, repo, state = 'open', labels = '') {
        let endpoint = `/repos/${owner}/${repo}/issues?state=${state}&per_page=50&sort=updated`;
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

    async getPullRequestComments(connection, owner, repo, number) {
        // PR review comments (line-level)
        let reviewComments = [];
        try {
            const comments = await this.request(connection, 'GET',
                `/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`
            );
            reviewComments = (comments || []).map(c => ({
                id: c.id,
                body: c.body,
                user: c.user.login,
                createdAt: c.created_at,
                path: c.path,
                line: c.line || c.original_line,
                type: 'review'
            }));
        } catch { /* no review comments */ }

        // General PR comments (issue comments API)
        let generalComments = [];
        try {
            const comments = await this.request(connection, 'GET',
                `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`
            );
            generalComments = (comments || []).map(c => ({
                id: c.id,
                body: c.body,
                user: c.user.login,
                createdAt: c.created_at,
                type: 'general'
            }));
        } catch { /* no general comments */ }

        return [...reviewComments, ...generalComments]
            .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
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
            // GitHub returns a redirect to a zip of logs — can't easily consume in browser.
            // Return the URL instead so the user can download.
            return {
                message: 'GitHub workflow logs are available as a zip download.',
                url: `https://github.com/${owner}/${repo}/actions/runs/${runId}`
            };
        } catch (e) {
            console.warn('[GitHub] Could not fetch workflow logs:', e.message);
            return null;
        }
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

export default githubProvider;
export { utf8ToBase64, base64ToUtf8 };
