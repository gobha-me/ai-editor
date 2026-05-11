// @ts-check
/**
 * Local Filesystem Provider
 *
 * In-memory git provider for zip-upload-only workflows. Implements
 * the same interface as Gitea/GitHub/GitLab providers so ALL existing
 * code (file tree, tabs, editor, tools) works without modification.
 *
 * Storage:
 *   Files are held in a Map keyed by `owner/repo` → Map<path, {content, size}>
 *   No network calls, no authentication, no branches, no issues.
 *   Data lives only in memory — gone on page refresh (by design).
 *
 * Automatically registered. A "local" connection is auto-created when
 * a zip is uploaded with no active project.
 */

// In-memory file stores: repoKey → Map<path, FileEntry>
// repoKey = `${owner}/${repo}`
const _stores = new Map();

/**
 * @typedef {{ content: string, size: number, isBinary: boolean }} LocalFile
 */

/**
 * Get or create the file store for a repo.
 * @param {string} owner
 * @param {string} repo
 * @returns {Map<string, LocalFile>}
 */
function _getStore(owner, repo) {
    const key = `${owner}/${repo}`;
    if (!_stores.has(key)) _stores.set(key, new Map());
    return _stores.get(key);
}

const LOCAL_PROVIDER = {
    id: 'local',
    name: 'Local (in-memory)',
    icon: '💾',
    glyph: 'ZP',
    description: 'In-memory filesystem for zip uploads. No network required.',
    fixedUrl: 'local://',
    hidden: true,  // Don't show in connection settings dropdown

    // ========================================
    // AUTH — always succeeds
    // ========================================

    async testConnection() {
        return { ok: true, user: 'local' };
    },

    getHeaders() { return {}; },
    getBaseUrl() { return 'local://'; },

    // ========================================
    // REPOS
    // ========================================

    async listRepos(connection) {
        return Array.from(_stores.keys()).map(key => {
            const [owner, repo] = key.split('/');
            return {
                name: repo,
                fullName: `${owner}/${repo}`,
                owner: owner,
                description: 'Local project (in-memory)',
                defaultBranch: 'main',
                private: false
            };
        });
    },

    async getRepo(connection, owner, repo) {
        return {
            name: repo,
            fullName: `${owner}/${repo}`,
            owner: owner,
            defaultBranch: 'main',
            private: false
        };
    },

    // ========================================
    // BRANCHES — single "main" branch
    // ========================================

    async listBranches() {
        return [{ name: 'main' }];
    },

    async createBranch() {
        throw new Error('Local provider does not support branches. Connect a Git host to use branches.');
    },

    // ========================================
    // FILE TREE
    // ========================================

    async getFileTree(connection, owner, repo) {
        const store = _getStore(owner, repo);
        const entries = [];

        // Collect all directory paths
        const dirs = new Set();
        for (const path of store.keys()) {
            const parts = path.split('/');
            for (let i = 1; i < parts.length; i++) {
                dirs.add(parts.slice(0, i).join('/'));
            }
        }

        // Add directories
        for (const dir of dirs) {
            entries.push({
                path: dir,
                type: 'dir',
                name: dir.split('/').pop()
            });
        }

        // Add files
        for (const [path, file] of store) {
            entries.push({
                path,
                type: 'file',
                name: path.split('/').pop(),
                size: file.size,
                sha: _hash(path + file.content)
            });
        }

        return entries.sort((a, b) => a.path.localeCompare(b.path));
    },

    async getContents(connection, owner, repo, path = '') {
        const store = _getStore(owner, repo);

        if (!path) {
            // Root listing
            return this.getFileTree(connection, owner, repo);
        }

        const file = store.get(path);
        if (file) {
            return {
                type: 'file',
                path,
                name: path.split('/').pop(),
                content: file.content,
                size: file.size,
                sha: _hash(path + file.content)
            };
        }

        // Check if it's a directory
        const prefix = path.endsWith('/') ? path : path + '/';
        const children = [];
        for (const [p] of store) {
            if (p.startsWith(prefix)) children.push(p);
        }
        if (children.length > 0) {
            return { type: 'dir', path, entries: children };
        }

        const err = new Error(`File not found: ${path}`);
        err.status = 404;
        throw err;
    },

    // ========================================
    // FILE READ
    // ========================================

    async getFile(connection, owner, repo, path) {
        const store = _getStore(owner, repo);
        const file = store.get(path);

        if (!file) {
            const err = new Error(`File not found: ${path}`);
            err.status = 404;
            throw err;
        }

        return {
            path,
            name: path.split('/').pop(),
            content: file.content,
            sha: _hash(path + file.content),
            size: file.size,
            encoding: file.isBinary ? 'base64' : 'text'
        };
    },

    // ========================================
    // FILE CRUD — modifies in-memory store
    // ========================================

    async createFile(connection, owner, repo, path, content) {
        const store = _getStore(owner, repo);
        const entry = { content, size: content.length, isBinary: false };
        store.set(path, entry);
        return { path, sha: _hash(path + content) };
    },

    async updateFile(connection, owner, repo, path, content) {
        return this.createFile(connection, owner, repo, path, content);
    },

    async deleteFile(connection, owner, repo, path) {
        const store = _getStore(owner, repo);
        store.delete(path);
        return { path, deleted: true };
    },

    async batchCommitFiles(connection, owner, repo, files) {
        const store = _getStore(owner, repo);
        const results = [];
        const errors = [];

        for (const f of files) {
            try {
                if (f.operation === 'delete') {
                    store.delete(f.path);
                } else {
                    const content = f.encoding === 'base64' ? f.content : f.content;
                    store.set(f.path, {
                        content,
                        size: content.length,
                        isBinary: f.encoding === 'base64'
                    });
                }
                results.push({ path: f.path, sha: _hash(f.path + (f.content || '')) });
            } catch (e) {
                errors.push({ path: f.path, error: e.message });
            }
        }

        return { results, errors };
    },

    // ========================================
    // BLAME / HISTORY — not supported (no commits)
    // ========================================

    async getBlame() {
        return { ranges: [] };
    },

    async getFileCommits() {
        return [];
    },

    async getCommits() {
        return [];
    },

    // ========================================
    // ISSUES / PRs — not supported
    // ========================================
    //
    // Slice 2 of Touch 3 Merge Conflict Resolver (2.19.0) deliberately
    // does NOT advertise `mergeConflictResolution` for Local: the
    // resolver's entry point lives on the PR Review surface, and Local
    // has no PR concept (`listMergeRequests` returns []). The capability
    // flag would never be reached, so leaving it default-undefined is
    // correct — flipping it on would suggest a code path that does not
    // exist.

    async listIssues() { return []; },
    async listMergeRequests() { return []; },

    // ========================================
    // UI EXTENSIONS
    // ========================================

    contributes: {
        panels: [],
        tools: [],
        settings: [],
        menuItems: []
    }
};

// ============================================
// PUBLIC API
// ============================================

/**
 * Load extracted zip files into the local provider's in-memory store.
 * Creates the repo store if it doesn't exist.
 *
 * @param {string} owner - Virtual owner (e.g., "local")
 * @param {string} repo - Virtual repo name (e.g., "my-project")
 * @param {Array<{path: string, content: string, isBinary: boolean, size: number}>} files
 */
export function loadFilesIntoLocal(owner, repo, files) {
    const store = _getStore(owner, repo);
    store.clear();
    for (const f of files) {
        store.set(f.path, {
            content: f.content,
            size: f.size || f.content.length,
            isBinary: f.isBinary || false
        });
    }
}

/**
 * Check if a local repo exists.
 */
export function hasLocalRepo(owner, repo) {
    return _stores.has(`${owner}/${repo}`);
}

/**
 * Remove a local repo from memory.
 */
export function removeLocalRepo(owner, repo) {
    _stores.delete(`${owner}/${repo}`);
}

// Simple hash for fake SHAs
function _hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return Math.abs(h).toString(16).padStart(8, '0');
}

export { LOCAL_PROVIDER };
