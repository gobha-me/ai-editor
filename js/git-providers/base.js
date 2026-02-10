/**
 * Base Git Provider
 * 
 * Default interface that all git providers extend. Providers only need
 * to implement the methods they support — unimplemented methods throw
 * a clear "not supported" error.
 * 
 * Provider shape mirrors LLM ProviderRegistry pattern:
 *   - id, name, icon, description (metadata)
 *   - fixedUrl (null = user-configurable, string = hardcoded like GitHub)
 *   - API methods receive a `connection` object with url/token
 *   - contributes {} declares UI extensions
 * 
 * Connection object shape:
 *   { id, provider, label, url, token, enabled }
 */

function notSupported(provider, method) {
    throw new Error(`${provider} does not support ${method}`);
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
     * Build request headers for API calls.
     * Override for providers with different auth schemes.
     * @param {Object} connection - { url, token, ... }
     * @returns {Object} Headers object
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
     * @param {Object} connection - { url, ... }
     * @returns {string} Base URL for API requests
     */
    getBaseUrl(connection) {
        return `${connection.url.replace(/\/$/, '')}/api/v1`;
    },

    /**
     * Generic HTTP request helper.
     * Providers can override for custom error handling.
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
                // Most Git APIs return { message: "..." } or { error: "..." }
                friendlyMsg = parsed.message || parsed.error || parsed.errors?.[0] || friendlyMsg;
            } catch {
                // Not JSON — use raw text if short, otherwise just status
                if (rawBody.length < 200) friendlyMsg = rawBody;
            }
            
            const err = new Error(`${this.name}: ${friendlyMsg}`);
            err.status = response.status;
            err.url = url;
            err.endpoint = endpoint;
            err.rawBody = rawBody;
            throw err;
        }

        const text = await response.text();
        return text ? JSON.parse(text) : null;
    },

    // ========================================
    // REPOSITORIES
    // ========================================

    async listRepos(connection) {
        notSupported(this.name, 'listRepos');
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

    async batchUpdateFiles(connection, owner, repo, files, message, branch = 'main') {
        notSupported(this.name, 'batchUpdateFiles');
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
