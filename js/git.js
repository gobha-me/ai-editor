/**
 * AI Editor - Git API
 * 
 * Public interface for all git operations. Replaces the old monolithic gitea.js.
 * 
 * All consumers import from here. This module resolves the active connection
 * and provider from State, then delegates to the appropriate git-provider plugin.
 * Consumers never need to know which provider they're talking to.
 * 
 * Usage:
 *   import { Git, loadProject, loadFile, saveFile, batchSaveFiles } from './git.js';
 *   const file = await Git.getFile(owner, repo, path, branch);
 *   const repos = await Git.listAllRepos();
 */

import { State, EventBus, Storage, Plugins } from './core.js';
import { GitProviderRegistry } from './git-providers/index.js';

// ============================================
// RE-EXPORT ENCODING UTILITIES
// ============================================

// Consumers that need these (e.g., providers themselves) can import from here
export { utf8ToBase64, base64ToUtf8 } from './git-providers/gitea.js';

// ============================================
// CONNECTION RESOLUTION
// ============================================

/**
 * Resolve the current project's provider and connection.
 * Throws if no project is loaded or connection is missing.
 * @returns {{ provider: Object, connection: Object }}
 */
function resolveCurrentConnection() {
    if (!State.currentProject) {
        throw new Error('No project is currently loaded');
    }
    const connId = State.currentProject.connectionId;
    if (!connId) {
        throw new Error('Current project has no connectionId');
    }
    return GitProviderRegistry.resolve(connId);
}

/**
 * Convenience: get owner/repo/branch from State plus resolved provider+connection.
 * Most API calls need all of these.
 */
function resolveContext() {
    const { provider, connection } = resolveCurrentConnection();
    const { owner, repo } = State.currentProject;
    const branch = State.currentBranch || 'main';
    return { provider, connection, owner, repo, branch };
}

/**
 * Resolve provider/connection for issue operations.
 * Runs the 'resolveIssueConnection' plugin hook, allowing plugins to
 * redirect issue operations to a different connection/repo (e.g., issues
 * on GitHub while code lives on Gitea).
 * 
 * Falls back to current project connection if no plugin overrides.
 */
async function resolveIssueContext(owner, repo) {
    const { provider, connection } = resolveCurrentConnection();
    const defaultCtx = { provider, connection, owner, repo, redirected: false };

    // Give plugins a chance to redirect
    const result = await Plugins.runHook('resolveIssueConnection', defaultCtx);
    return result || defaultCtx;
}

// ============================================
// GIT API (provider-agnostic)
// ============================================

/**
 * Provider-agnostic git API.
 * Every method auto-resolves the current project's connection and provider.
 * Methods that don't need a project context (like listAllRepos) are standalone.
 */
const Git = {
    // ========================================
    // MULTI-CONNECTION
    // ========================================

    /**
     * List repos from ALL enabled connections (aggregated).
     * Does not require a current project.
     */
    async listAllRepos() {
        return GitProviderRegistry.listAllRepos();
    },

    /**
     * Force-retry all downed connections on next request.
     * Bypasses circuit breaker cooldown.
     */
    forceRetryAll() {
        GitProviderRegistry.forceRetryAll();
    },

    /**
     * Get IDs of connections currently marked unreachable.
     * @returns {string[]}
     */
    getDownConnectionIds() {
        return GitProviderRegistry.getDownConnectionIds();
    },

    /**
     * List repos from a specific connection.
     */
    async listRepos(connectionId) {
        const { provider, connection } = GitProviderRegistry.resolve(connectionId);
        return provider.listRepos(connection);
    },

    /**
     * Create a new repository on a specific connection.
     */
    async createRepo(connectionId, name, options = {}) {
        const { provider, connection } = GitProviderRegistry.resolve(connectionId);
        return provider.createRepo(connection, name, options);
    },

    // ========================================
    // REPOSITORIES (current project)
    // ========================================

    async getRepo(owner, repo) {
        const { provider, connection } = resolveCurrentConnection();
        return provider.getRepo(connection, owner, repo);
    },

    // ========================================
    // BRANCHES
    // ========================================

    async listBranches(owner, repo) {
        const { provider, connection } = resolveCurrentConnection();
        return provider.listBranches(connection, owner, repo);
    },

    async createBranch(owner, repo, name, from = 'main') {
        const { provider, connection } = resolveCurrentConnection();
        return provider.createBranch(connection, owner, repo, name, from);
    },

    async deleteBranch(owner, repo, name) {
        const { provider, connection } = resolveCurrentConnection();
        return provider.deleteBranch(connection, owner, repo, name);
    },

    // ========================================
    // FILE TREE / CONTENTS
    // ========================================

    async getContents(owner, repo, path = '', ref = 'main') {
        const { provider, connection } = resolveCurrentConnection();
        return provider.getContents(connection, owner, repo, path, ref);
    },

    async getFileTree(owner, repo, ref = 'main', path = '') {
        const { provider, connection } = resolveCurrentConnection();
        return provider.getFileTree(connection, owner, repo, ref, path);
    },

    async getFile(owner, repo, path, ref = 'main') {
        const { provider, connection } = resolveCurrentConnection();
        return provider.getFile(connection, owner, repo, path, ref);
    },

    // ========================================
    // BLAME & FILE HISTORY
    // ========================================

    async getBlame(owner, repo, path, ref = 'main') {
        const { provider, connection } = resolveCurrentConnection();
        return provider.getBlame(connection, owner, repo, path, ref);
    },

    async getFileCommits(owner, repo, path, ref = 'main') {
        const { provider, connection } = resolveCurrentConnection();
        return provider.getFileCommits(connection, owner, repo, path, ref);
    },

    // ========================================
    // FILE CRUD
    // ========================================

    async createFile(owner, repo, path, content, message, branch = 'main') {
        const { provider, connection } = resolveCurrentConnection();
        return provider.createFile(connection, owner, repo, path, content, message, branch);
    },

    async updateFile(owner, repo, path, content, message, sha, branch = 'main') {
        const { provider, connection } = resolveCurrentConnection();
        return provider.updateFile(connection, owner, repo, path, content, message, sha, branch);
    },

    async deleteFile(owner, repo, path, message, sha, branch = 'main') {
        const { provider, connection } = resolveCurrentConnection();
        return provider.deleteFile(connection, owner, repo, path, message, sha, branch);
    },

    async renameFile(owner, repo, oldPath, newPath, message, branch = 'main') {
        const { provider, connection } = resolveCurrentConnection();
        return provider.renameFile(connection, owner, repo, oldPath, newPath, message, branch);
    },

    async batchCommitFiles(owner, repo, files, message, branch = 'main') {
        const { provider, connection } = resolveCurrentConnection();
        return provider.batchCommitFiles(connection, owner, repo, files, message, branch);
    },

    // ========================================
    // ISSUES
    // ========================================

    async listIssues(owner, repo, state = 'open', labels = '') {
        const ctx = await resolveIssueContext(owner, repo);
        return ctx.provider.listIssues(ctx.connection, ctx.owner, ctx.repo, state, labels);
    },

    async getIssue(owner, repo, number) {
        const ctx = await resolveIssueContext(owner, repo);
        return ctx.provider.getIssue(ctx.connection, ctx.owner, ctx.repo, number);
    },

    async createIssue(owner, repo, title, body, labels = []) {
        const ctx = await resolveIssueContext(owner, repo);
        return ctx.provider.createIssue(ctx.connection, ctx.owner, ctx.repo, title, body, labels);
    },

    async updateIssue(owner, repo, number, fields) {
        const ctx = await resolveIssueContext(owner, repo);
        return ctx.provider.updateIssue(ctx.connection, ctx.owner, ctx.repo, number, fields);
    },

    async getIssueComments(owner, repo, number) {
        const ctx = await resolveIssueContext(owner, repo);
        return ctx.provider.getIssueComments(ctx.connection, ctx.owner, ctx.repo, number);
    },

    async createIssueComment(owner, repo, number, body) {
        const ctx = await resolveIssueContext(owner, repo);
        return ctx.provider.createIssueComment(ctx.connection, ctx.owner, ctx.repo, number, body);
    },

    async updateIssueState(owner, repo, number, state) {
        const ctx = await resolveIssueContext(owner, repo);
        return ctx.provider.updateIssueState(ctx.connection, ctx.owner, ctx.repo, number, state);
    },

    // ========================================
    // MERGE REQUESTS
    // ========================================

    async listMergeRequests(owner, repo, state = 'open') {
        const { provider, connection } = resolveCurrentConnection();
        return provider.listMergeRequests(connection, owner, repo, state);
    },

    async createMergeRequest(owner, repo, title, body, head, base = 'main') {
        const { provider, connection } = resolveCurrentConnection();
        return provider.createMergeRequest(connection, owner, repo, title, body, head, base);
    },

    async getPullRequest(owner, repo, number) {
        const { provider, connection } = resolveCurrentConnection();
        return provider.getPullRequest(connection, owner, repo, number);
    },

    async getPullRequestFiles(owner, repo, number) {
        const { provider, connection } = resolveCurrentConnection();
        return provider.getPullRequestFiles(connection, owner, repo, number);
    },

    async getPullRequestComments(owner, repo, number) {
        const { provider, connection } = resolveCurrentConnection();
        return provider.getPullRequestComments(connection, owner, repo, number);
    },

    async addPullRequestComment(owner, repo, number, body) {
        const { provider, connection } = resolveCurrentConnection();
        return provider.addPullRequestComment(connection, owner, repo, number, body);
    },

    async mergePullRequest(owner, repo, number, opts = {}) {
        const { provider, connection } = resolveCurrentConnection();
        return provider.mergePullRequest(connection, owner, repo, number, opts);
    },

    // ========================================
    // COMMIT DIFF
    // ========================================

    async getCommitDiff(owner, repo, sha) {
        const { provider, connection } = resolveCurrentConnection();
        return provider.getCommitDiff(connection, owner, repo, sha);
    },

    // ========================================
    // CI/CD
    // ========================================

    async getCommitStatus(owner, repo, ref) {
        const { provider, connection } = resolveCurrentConnection();
        return provider.getCommitStatus(connection, owner, repo, ref);
    },

    async listWorkflowRuns(owner, repo) {
        const { provider, connection } = resolveCurrentConnection();
        return provider.listWorkflowRuns(connection, owner, repo);
    },

    async getWorkflowRun(owner, repo, runId) {
        const { provider, connection } = resolveCurrentConnection();
        return provider.getWorkflowRun(connection, owner, repo, runId);
    },

    async getWorkflowRunLogs(owner, repo, runId) {
        const { provider, connection } = resolveCurrentConnection();
        return provider.getWorkflowRunLogs(connection, owner, repo, runId);
    },

    // ========================================
    // TAGS & RELEASES
    // ========================================

    async listTags(owner, repo) {
        const { provider, connection } = resolveCurrentConnection();
        return provider.listTags(connection, owner, repo);
    },

    async compareRefs(owner, repo, base, head) {
        const { provider, connection } = resolveCurrentConnection();
        return provider.compareRefs(connection, owner, repo, base, head);
    },

    async listReleases(owner, repo) {
        const { provider, connection } = resolveCurrentConnection();
        return provider.listReleases(connection, owner, repo);
    },

    async createRelease(owner, repo, opts) {
        const { provider, connection } = resolveCurrentConnection();
        return provider.createRelease(connection, owner, repo, opts);
    }
};

// ============================================
// PROJECT LIFECYCLE HELPERS
// ============================================

/**
 * Load a project from a specific connection.
 * Sets up State.currentProject with connectionId for subsequent Git calls.
 * 
 * @param {string} connectionId - Connection to load from
 * @param {string} owner - Repo owner
 * @param {string} repo - Repo name
 */
async function loadProject(connectionId, owner, repo) {
    try {
        EventBus.emit('git:loading', { connectionId, owner, repo });

        const { provider, connection } = GitProviderRegistry.resolve(connectionId);

        // Get repo info
        const repoInfo = await provider.getRepo(connection, owner, repo);
        // Use canonical owner/repo from the API response to avoid
        // mismatches with nested group paths (e.g. GitLab subgroups)
        const canonicalOwner = repoInfo.owner || owner;
        const canonicalRepo = repoInfo.name || repo;
        State.currentProject = {
            connectionId,
            owner: canonicalOwner,
            repo: canonicalRepo,
            ...repoInfo
        };

        // Get branches
        State.branches = await provider.listBranches(connection, owner, repo);

        // Set default branch if current branch not found
        if (!State.branches.find(b => b.name === State.currentBranch)) {
            State.currentBranch = repoInfo.defaultBranch || 'main';
        }

        // Get file tree
        State.fileTree = await provider.getFileTree(connection, owner, repo, State.currentBranch);

        // Load issues and workflows non-blocking
        try {
            State.issues = await provider.listIssues(connection, owner, repo);
        } catch (e) {
            console.warn('Failed to load issues:', e.message);
            State.issues = [];
        }

        try {
            const prs = await provider.listMergeRequests(connection, owner, repo, 'open');
            // Fetch CI status for each PR in parallel
            State.pullRequests = await Promise.all(prs.map(async (pr) => {
                try {
                    const status = await provider.getCommitStatus(connection, owner, repo, pr.head);
                    return { ...pr, ciState: status.state, ciStatuses: status.statuses };
                } catch {
                    return { ...pr, ciState: 'unknown', ciStatuses: [] };
                }
            }));
        } catch (e) {
            console.warn('Failed to load pull requests:', e.message);
            State.pullRequests = [];
        }

        EventBus.emit('git:projectLoaded', State.currentProject);
        return State.currentProject;

    } catch (error) {
        console.error('loadProject failed:', {
            connectionId, owner, repo,
            message: error.message, status: error.status,
            stack: error.stack
        });
        EventBus.emit('git:error', error);
        throw error;
    }
}

/**
 * Load a file from the current project.
 * Checks for local drafts and applies them if present.
 */
async function loadFile(path) {
    const { provider, connection, owner, repo, branch } = resolveContext();

    try {
        EventBus.emit('git:loadingFile', { path });

        // Always fetch fresh from remote
        const file = await provider.getFile(connection, owner, repo, path, branch);

        // Check for local draft
        const draft = Storage.getDraft(owner, repo, branch, path);

        State.currentFile = file;

        if (draft && draft !== file.content) {
            console.warn(`[DRAFT] Local draft exists for ${path}, using draft`);
            State.editorContent = draft;
            State.editorDirty = true;
            if (window.showToast) {
                window.showToast(`📝 Loaded local draft for ${path.split('/').pop()}`, 'info');
            }
        } else {
            State.editorContent = file.content;
            State.editorDirty = false;
            if (draft && draft === file.content) {
                Storage.clearDraft(owner, repo, branch, path);
            }
        }

        EventBus.emit('git:fileLoaded', {
            file,
            hasDraft: draft && draft !== file.content,
            content: State.editorContent
        });

        return file;

    } catch (error) {
        console.error('Failed to load file:', {
            owner, repo, branch, path,
            message: error.message, status: error.status,
            stack: error.stack
        });
        EventBus.emit('git:error', error);
        throw error;
    }
}

/**
 * Save the current file to the remote.
 */
async function saveFile(commitMessage) {
    const { provider, connection, owner, repo, branch } = resolveContext();

    if (!State.currentFile) {
        throw new Error('No file to save');
    }

    const { path, sha } = State.currentFile;

    try {
        EventBus.emit('git:saving', { path });

        const result = await provider.updateFile(
            connection, owner, repo, path,
            State.editorContent, commitMessage, sha, branch
        );

        // Update local state
        State.currentFile.sha = result.content.sha;
        State.currentFile.content = State.editorContent;
        State.editorDirty = false;
        Storage.clearDraft(owner, repo, branch, path);

        EventBus.emit('git:saved', { path, sha: result.content.sha });
        return result;

    } catch (error) {
        console.error('saveFile failed:', {
            owner, repo, branch, path,
            message: error.message, status: error.status,
            stack: error.stack
        });
        EventBus.emit('git:error', error);
        throw error;
    }
}

/**
 * Batch-save multiple dirty tabs.
 */
async function batchSaveFiles(commitMessage, tabs) {
    const { provider, connection, owner, repo, branch } = resolveContext();

    const files = tabs.map(tab => ({
        path: tab.path,
        content: tab.content,
        sha: tab.sha
    }));

    EventBus.emit('git:batchSaving', { files: files.map(f => f.path) });

    const { results, errors } = await provider.batchCommitFiles(
        connection, owner, repo, files, commitMessage, branch
    );

    // Update tab SHAs for successful saves
    for (const result of results) {
        const tab = tabs.find(t => t.path === result.path);
        if (tab) {
            tab.sha = result.newSha;
            tab.dirty = false;
            tab.originalContent = tab.content;
        }
        if (State.currentFile && State.currentFile.path === result.path) {
            State.currentFile.sha = result.newSha;
            State.currentFile.content = tab.content;
            State.editorDirty = false;
        }
        Storage.clearDraft(owner, repo, branch, result.path);
    }

    if (errors.length > 0) {
        console.error('Batch save had errors:', errors);
    }

    EventBus.emit('git:batchSaved', { results, errors });
    return { results, errors };
}

// ============================================
// INITIALIZATION
// ============================================

/**
 * Initialize the git provider system.
 * Call during app startup after settings are loaded.
 * 
 * Handles migration from legacy single-Gitea settings to connections[].
 */
function initGitProviders() {
    // Load existing connections from settings
    const connections = State.settings.connections || [];
    GitProviderRegistry.loadConnections(connections);

    // Migrate legacy settings if needed
    if (connections.length === 0 && State.settings.giteaUrl && State.settings.giteaToken) {
        GitProviderRegistry.migrateFromLegacySettings(State.settings);
        // Persist the migration
        State.settings.connections = GitProviderRegistry.listConnections();
    }
}

// ============================================
// EXPORTS
// ============================================

export {
    Git,
    GitProviderRegistry,
    loadProject,
    loadFile,
    saveFile,
    batchSaveFiles,
    initGitProviders,
    resolveContext
};
