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
                const error = await response.text();
                const err = new Error(`Gitea API Error: ${response.status} - ${error}`);
                err.status = response.status;
                err.url = url;
                err.endpoint = endpoint;
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
        const repos = await this.request(connection, 'GET', '/user/repos');
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

    async getFile(connection, owner, repo, path, ref = 'main') {
        const endpoint = `/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
        const file = await this.request(connection, 'GET', endpoint);
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

    async batchUpdateFiles(connection, owner, repo, files, message, branch = 'main') {
        const results = [];
        const errors = [];

        for (const file of files) {
            try {
                const result = await this.updateFile(
                    connection, owner, repo,
                    file.path, file.content, message, file.sha, branch
                );
                results.push({ path: file.path, success: true, newSha: result.content.sha });
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
        let endpoint = `/repos/${owner}/${repo}/issues?state=${state}&type=issues&limit=50`;
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

    async getPullRequestComments(connection, owner, repo, number) {
        // Gitea has review comments on /pulls/{number}/comments
        let reviewComments = [];
        try {
            const comments = await this.request(connection, 'GET',
                `/repos/${owner}/${repo}/pulls/${number}/comments`
            );
            reviewComments = (comments || []).map(c => ({
                id: c.id,
                body: c.body,
                user: c.user.login,
                createdAt: c.created_at,
                path: c.path,
                line: c.line || c.old_position,
                type: 'review'
            }));
        } catch { /* no review comments */ }

        // General comments via issues API
        let generalComments = [];
        try {
            const comments = await this.request(connection, 'GET',
                `/repos/${owner}/${repo}/issues/${number}/comments`
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

    // ========================================
    // UI EXTENSIONS
    // ========================================

    contributes: {
        panels: [
            {
                id: 'gitea-issues',
                slot: 'sidebar-panels',
                title: 'Issues',
                icon: '📋',
                collapsible: true,
                refreshEvent: 'issues:refresh',
                priority: 10
            },
            {
                id: 'gitea-prs',
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

export default giteaProvider;
export { utf8ToBase64, base64ToUtf8 };
