/**
 * AI Editor - Gitea API Client
 * Handles all Gitea/Git operations
 */

import { State, EventBus, Storage } from './core.js';

// ============================================
// API CLIENT
// ============================================

const GiteaAPI = {
    async request(method, endpoint, data = null) {
        const url = `${State.settings.giteaUrl.replace(/\/$/, '')}/api/v1${endpoint}`;
        
        const options = {
            method,
            headers: {
                'Authorization': `token ${State.settings.giteaToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        };

        if (data && method !== 'GET') {
            options.body = JSON.stringify(data);
        }

        try {
            const response = await fetch(url, options);
            
            if (!response.ok) {
                const error = await response.text();
                const fullError = new Error(`Gitea API Error: ${response.status} - ${error}`);
                fullError.status = response.status;
                fullError.url = url;
                fullError.endpoint = endpoint;
                throw fullError;
            }

            // Handle empty responses
            const text = await response.text();
            return text ? JSON.parse(text) : null;
        } catch (error) {
            // Add context to network errors
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

    async listUserRepos() {
        const repos = await this.request('GET', '/user/repos');
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

    async getRepo(owner, repo) {
        const r = await this.request('GET', `/repos/${owner}/${repo}`);
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

    async listBranches(owner, repo) {
        const branches = await this.request('GET', `/repos/${owner}/${repo}/branches`);
        return branches.map(b => ({
            name: b.name,
            protected: b.protected,
            sha: b.commit.id
        }));
    },

    async createBranch(owner, repo, branchName, fromBranch = 'main') {
        // First get the SHA of the source branch
        const sourceBranch = await this.request('GET', `/repos/${owner}/${repo}/branches/${fromBranch}`);
        const sha = sourceBranch.commit.id;

        // Create new branch
        await this.request('POST', `/repos/${owner}/${repo}/git/refs`, {
            ref: `refs/heads/${branchName}`,
            sha: sha
        });

        EventBus.emit('gitea:branchCreated', { owner, repo, branchName });
        return branchName;
    },

    async deleteBranch(owner, repo, branchName) {
        await this.request('DELETE', `/repos/${owner}/${repo}/branches/${branchName}`);
        EventBus.emit('gitea:branchDeleted', { owner, repo, branchName });
    },

    // ========================================
    // FILE TREE / CONTENTS
    // ========================================

    async getContents(owner, repo, path = '', ref = 'main') {
        const endpoint = `/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
        const contents = await this.request('GET', endpoint);
        
        // Normalize to array (single file returns object)
        const items = Array.isArray(contents) ? contents : [contents];
        
        return items.map(item => ({
            name: item.name,
            path: item.path,
            type: item.type, // 'file' or 'dir'
            sha: item.sha,
            size: item.size,
            url: item.html_url
        }));
    },

    async getFileTree(owner, repo, ref = 'main', path = '') {
        const tree = [];
        
        async function walk(currentPath) {
            const contents = await GiteaAPI.getContents(owner, repo, currentPath, ref);
            
            for (const item of contents) {
                tree.push(item);
                if (item.type === 'dir') {
                    await walk(item.path);
                }
            }
        }

        await walk(path);
        return tree.sort((a, b) => {
            // Directories first, then alphabetical
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
            return a.path.localeCompare(b.path);
        });
    },

    async getFile(owner, repo, path, ref = 'main') {
        const endpoint = `/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
        const file = await this.request('GET', endpoint);
        
        // Gitea returns base64 encoded content
        const content = file.content ? atob(file.content) : '';
        
        return {
            name: file.name,
            path: file.path,
            sha: file.sha,
            size: file.size,
            content: content,
            encoding: file.encoding
        };
    },

    // ========================================
    // FILE CRUD
    // ========================================

    async createFile(owner, repo, path, content, message, branch = 'main') {
        const data = {
            content: btoa(content), // base64 encode
            message: message,
            branch: branch
        };

        const result = await this.request('POST', `/repos/${owner}/${repo}/contents/${path}`, data);
        EventBus.emit('gitea:fileCreated', { owner, repo, path, branch });
        return result;
    },

    async updateFile(owner, repo, path, content, message, sha, branch = 'main') {
        const data = {
            content: btoa(content), // base64 encode
            message: message,
            sha: sha, // Required for updates
            branch: branch
        };

        const result = await this.request('PUT', `/repos/${owner}/${repo}/contents/${path}`, data);
        
        // Clear draft after successful save
        Storage.clearDraft(owner, repo, branch, path);
        
        EventBus.emit('gitea:fileUpdated', { owner, repo, path, branch });
        return result;
    },

    async deleteFile(owner, repo, path, message, sha, branch = 'main') {
        const data = {
            message: message,
            sha: sha,
            branch: branch
        };

        await this.request('DELETE', `/repos/${owner}/${repo}/contents/${path}`, data);
        EventBus.emit('gitea:fileDeleted', { owner, repo, path, branch });
    },

    async renameFile(owner, repo, oldPath, newPath, message, branch = 'main') {
        // Gitea doesn't have a rename API, so we:
        // 1. Get old file content
        // 2. Create new file
        // 3. Delete old file
        const file = await this.getFile(owner, repo, oldPath, branch);
        await this.createFile(owner, repo, newPath, file.content, message, branch);
        await this.deleteFile(owner, repo, oldPath, `${message} (removed old path)`, file.sha, branch);
        
        EventBus.emit('gitea:fileRenamed', { owner, repo, oldPath, newPath, branch });
    },

    // ========================================
    // ISSUES (Bonus Feature)
    // ========================================

    async listIssues(owner, repo, state = 'open') {
        const issues = await this.request('GET', `/repos/${owner}/${repo}/issues?state=${state}&limit=50`);
        return (issues || []).map(i => {
            // Parse dependencies from issue body (looks for "depends on #X", "blocked by #X", "requires #X")
            const depPattern = /(?:depends\s+on|blocked\s+by|requires|after|prerequisite[s]?:?)\s*#(\d+)/gi;
            const body = i.body || '';
            const deps = [];
            let match;
            while ((match = depPattern.exec(body)) !== null) {
                const depNum = parseInt(match[1]);
                if (!deps.includes(depNum)) {
                    deps.push(depNum);
                }
            }
            
            return {
                number: i.number,
                title: i.title,
                body: body,
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

    async getIssue(owner, repo, number) {
        const i = await this.request('GET', `/repos/${owner}/${repo}/issues/${number}`);
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

    async getIssueComments(owner, repo, number) {
        const comments = await this.request('GET', `/repos/${owner}/${repo}/issues/${number}/comments`);
        return comments.map(c => ({
            id: c.id,
            body: c.body,
            user: c.user.login,
            createdAt: c.created_at
        }));
    },

    async createIssueComment(owner, repo, number, body) {
        const result = await this.request('POST', `/repos/${owner}/${repo}/issues/${number}/comments`, { body });
        EventBus.emit('gitea:issueCommented', { owner, repo, number });
        return result;
    },

    async updateIssueState(owner, repo, number, state) {
        const result = await this.request('PATCH', `/repos/${owner}/${repo}/issues/${number}`, { state });
        EventBus.emit('gitea:issueUpdated', { owner, repo, number, state });
        return result;
    },

    // ========================================
    // WORKFLOW RUNS (Bonus Feature)
    // ========================================

    async listWorkflowRuns(owner, repo) {
        try {
            // Gitea Actions API endpoint
            const response = await this.request('GET', `/repos/${owner}/${repo}/actions/runs?limit=20`);
            
            // Handle various response formats from different Gitea versions
            let runs = [];
            if (Array.isArray(response)) {
                runs = response;
            } else if (response && response.workflow_runs) {
                runs = response.workflow_runs;
            } else if (response && response.runs) {
                runs = response.runs;
            }
            
            return runs.map(r => ({
                id: r.id,
                name: r.name || r.workflow_name || 'Workflow',
                status: r.status,
                conclusion: r.conclusion,
                branch: r.head_branch || r.branch,
                event: r.event,
                createdAt: r.created_at,
                updatedAt: r.updated_at,
                url: r.html_url || `${State.settings.giteaUrl}/${owner}/${repo}/actions/runs/${r.id}`
            }));
        } catch (e) {
            // Actions might not be enabled - log full error
            console.warn('Could not fetch workflow runs:', {
                message: e.message,
                status: e.status,
                url: e.url,
                endpoint: e.endpoint,
                stack: e.stack
            });
            return [];
        }
    },

    async getWorkflowRun(owner, repo, runId) {
        const r = await this.request('GET', `/repos/${owner}/${repo}/actions/runs/${runId}`);
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
            logs_url: r.logs_url
        };
    },

    async getWorkflowRunLogs(owner, repo, runId) {
        try {
            const logs = await this.request('GET', `/repos/${owner}/${repo}/actions/runs/${runId}/logs`);
            return logs;
        } catch (e) {
            console.warn('Could not fetch workflow logs:', {
                message: e.message,
                status: e.status,
                url: e.url,
                endpoint: e.endpoint,
                stack: e.stack
            });
            return null;
        }
    },

    // ========================================
    // BATCH OPERATIONS
    // ========================================

    /**
     * Commit multiple files in a single batch.
     * Uses sequential API calls (each creates a commit).
     * Returns array of results with updated SHAs.
     */
    async batchUpdateFiles(owner, repo, files, message, branch = 'main') {
        const results = [];
        const errors = [];

        for (const file of files) {
            try {
                const result = await this.updateFile(
                    owner, repo,
                    file.path,
                    file.content,
                    message,
                    file.sha,
                    branch
                );
                results.push({
                    path: file.path,
                    success: true,
                    newSha: result.content.sha
                });
            } catch (error) {
                errors.push({
                    path: file.path,
                    success: false,
                    error: error.message
                });
            }
        }

        EventBus.emit('gitea:batchCommitted', { 
            owner, repo, branch, message,
            succeeded: results.length,
            failed: errors.length
        });

        return { results, errors };
    },

    // ========================================
    // PULL REQUESTS
    // ========================================

    async createPullRequest(owner, repo, title, body, head, base = 'main') {
        const pr = await this.request('POST', `/repos/${owner}/${repo}/pulls`, {
            title,
            body,
            head,
            base
        });
        EventBus.emit('gitea:prCreated', { owner, repo, number: pr.number });
        return {
            number: pr.number,
            title: pr.title,
            url: pr.html_url
        };
    },

    async listPullRequests(owner, repo, state = 'open') {
        const prs = await this.request('GET', `/repos/${owner}/${repo}/pulls?state=${state}`);
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
    }
};

// ============================================
// HELPER FUNCTIONS
// ============================================

async function loadProject(owner, repo) {
    try {
        EventBus.emit('gitea:loading', { owner, repo });

        // Get repo info
        const repoInfo = await GiteaAPI.getRepo(owner, repo);
        State.currentProject = { owner, repo, ...repoInfo };

        // Get branches
        State.branches = await GiteaAPI.listBranches(owner, repo);
        
        // Set default branch if not already set
        if (!State.branches.find(b => b.name === State.currentBranch)) {
            State.currentBranch = repoInfo.defaultBranch || 'main';
        }

        // Get file tree
        State.fileTree = await GiteaAPI.getFileTree(owner, repo, State.currentBranch);

        // Load issues and workflows non-blocking (don't fail project load)
        try {
            State.issues = await GiteaAPI.listIssues(owner, repo);
        } catch (e) {
            console.warn('Failed to load issues:', {
                message: e.message,
                status: e.status,
                url: e.url,
                endpoint: e.endpoint,
                stack: e.stack
            });
            State.issues = [];
        }

        try {
            State.workflowRuns = await GiteaAPI.listWorkflowRuns(owner, repo);
        } catch (e) {
            console.warn('Failed to load workflow runs:', {
                message: e.message,
                status: e.status,
                url: e.url,
                endpoint: e.endpoint,
                stack: e.stack
            });
            State.workflowRuns = [];
        }

        EventBus.emit('gitea:projectLoaded', State.currentProject);
        return State.currentProject;

    } catch (error) {
        // Log full error with context
        console.error('loadProject failed:', {
            owner,
            repo,
            message: error.message,
            status: error.status,
            url: error.url,
            endpoint: error.endpoint,
            stack: error.stack
        });
        EventBus.emit('gitea:error', error);
        throw error;
    }
}

async function loadFile(path) {
    if (!State.currentProject) {
        throw new Error('No project selected');
    }

    const { owner, repo } = State.currentProject;
    
    try {
        EventBus.emit('gitea:loadingFile', { path });

        // Check for draft first
        const draft = Storage.getDraft(owner, repo, State.currentBranch, path);
        
        // Get file from Gitea
        const file = await GiteaAPI.getFile(owner, repo, path, State.currentBranch);
        
        State.currentFile = file;
        State.editorContent = draft || file.content;
        State.editorDirty = !!draft;

        EventBus.emit('gitea:fileLoaded', { 
            file, 
            hasDraft: !!draft,
            content: State.editorContent 
        });

        return file;

    } catch (error) {
        // Log full error with context
        console.error('Failed to load file:', {
            owner,
            repo,
            branch: State.currentBranch,
            path,
            message: error.message,
            status: error.status,
            url: error.url,
            endpoint: error.endpoint,
            stack: error.stack
        });
        EventBus.emit('gitea:error', error);
        throw error;
    }
}

async function saveFile(commitMessage) {
    if (!State.currentProject || !State.currentFile) {
        throw new Error('No file to save');
    }

    const { owner, repo } = State.currentProject;
    const { path, sha } = State.currentFile;

    try {
        EventBus.emit('gitea:saving', { path });

        const result = await GiteaAPI.updateFile(
            owner, 
            repo, 
            path, 
            State.editorContent,
            commitMessage,
            sha,
            State.currentBranch
        );

        // Update local state with new SHA
        State.currentFile.sha = result.content.sha;
        State.currentFile.content = State.editorContent;
        State.editorDirty = false;

        EventBus.emit('gitea:saved', { path, sha: result.content.sha });
        return result;

    } catch (error) {
        // Log full error with context
        console.error('saveFile failed:', {
            owner,
            repo,
            branch: State.currentBranch,
            path,
            message: error.message,
            status: error.status,
            url: error.url,
            endpoint: error.endpoint,
            stack: error.stack
        });
        EventBus.emit('gitea:error', error);
        throw error;
    }
}

/**
 * Batch-save multiple dirty tabs in one operation.
 * Returns { results, errors } with per-file status.
 */
async function batchSaveFiles(commitMessage, tabs) {
    if (!State.currentProject) {
        throw new Error('No project selected');
    }

    const { owner, repo } = State.currentProject;
    const files = tabs.map(tab => ({
        path: tab.path,
        content: tab.content,
        sha: tab.sha
    }));

    EventBus.emit('gitea:batchSaving', { files: files.map(f => f.path) });

    const { results, errors } = await GiteaAPI.batchUpdateFiles(
        owner, repo, files, commitMessage, State.currentBranch
    );

    // Update tab SHAs for successful saves
    for (const result of results) {
        const tab = tabs.find(t => t.path === result.path);
        if (tab) {
            tab.sha = result.newSha;
            tab.dirty = false;
            tab.originalContent = tab.content;
        }
        // Also update currentFile if it matches
        if (State.currentFile && State.currentFile.path === result.path) {
            State.currentFile.sha = result.newSha;
            State.currentFile.content = tab.content;
            State.editorDirty = false;
        }
    }

    if (errors.length > 0) {
        console.error('Batch save had errors:', errors);
    }

    EventBus.emit('gitea:batchSaved', { results, errors });
    return { results, errors };
}

// ============================================
// EXPORTS
// ============================================

export {
    GiteaAPI,
    loadProject,
    loadFile,
    saveFile,
    batchSaveFiles
};
