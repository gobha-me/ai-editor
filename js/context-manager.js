/**
 * Context Manager - Intelligent file indexing and context optimization
 * Uses embeddings for semantic file search to reduce token usage
 */

import { State, EventBus, Storage } from './core.js';
import { EmbeddingsClient } from './embeddings-client.js';
import { Git } from './git.js';

const ContextManager = {
    _fileIndex: new Map(), // path -> { path, summary, embedding, lastIndexed }
    _indexing: false,
    _indexedProject: null, // Track which project is indexed
    _queryCount: 0,        // Times findRelevantFiles was called for current index
    _lastQueried: null,    // Timestamp of last query

    // ── File Filtering ──

    /** Extensions that should never be indexed (binary/generated/media) */
    SKIP_EXTENSIONS: new Set([
        // Images
        'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'bmp', 'tiff',
        // Fonts
        'woff', 'woff2', 'ttf', 'eot', 'otf',
        // Media
        'mp3', 'mp4', 'wav', 'ogg', 'webm', 'avi', 'mov',
        // Archives
        'zip', 'tar', 'gz', 'bz2', 'rar', '7z',
        // Compiled/binary
        'wasm', 'pyc', 'pyo', 'class', 'o', 'so', 'dylib', 'dll', 'exe',
        // Maps & minified
        'map',
        // Data blobs
        'sqlite', 'db', 'bin', 'dat',
        // Lockfiles (huge, no semantic value)
        'lock',
        // PDF/office
        'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    ]),

    /** Path patterns to exclude (directories & specific files) */
    SKIP_PATH_PATTERNS: [
        /node_modules\//,
        /vendor\//,
        /\.git\//,
        /dist\//,
        /build\//,
        /\.min\.(js|css)$/,
        /bundle\.(js|css)$/,
        /package-lock\.json$/,
        /yarn\.lock$/,
        /pnpm-lock\.yaml$/,
    ],

    /**
     * Check if a file should be indexed based on extension and path.
     */
    shouldIndex(path) {
        // Extension check
        const ext = path.split('.').pop()?.toLowerCase();
        if (ext && this.SKIP_EXTENSIONS.has(ext)) return false;

        // Path pattern check
        for (const pattern of this.SKIP_PATH_PATTERNS) {
            if (pattern.test(path)) return false;
        }

        return true;
    },

    /**
     * Check if context manager is enabled
     */
    isEnabled() {
        return State.settings.useEmbeddings === true;
    },

    /**
     * Generate a smart summary of a file for embedding
     * @param {string} path - File path
     * @param {string} content - File content
     * @returns {string} Summary text optimized for embedding
     */
    summarizeFile(path, content) {
        if (!content) return `File: ${path}`;
        const ext = path.split('.').pop()?.toLowerCase();
        const lines = content.split('\n');
        const summary = [];

        // Add file path as context
        summary.push(`File: ${path}`);

        // Extract based on file type
        if (['js', 'jsx', 'ts', 'tsx', 'mjs'].includes(ext)) {
            // JavaScript/TypeScript
            const imports = lines
                .filter(l => l.trim().startsWith('import ') || l.trim().startsWith('export '))
                .slice(0, 10);
            
            const functions = lines
                .filter(l => /^(export\s+)?(async\s+)?function\s+\w+/.test(l.trim()) || 
                            /^(export\s+)?const\s+\w+\s*=\s*(async\s*)?\(/.test(l.trim()))
                .map(l => l.trim())
                .slice(0, 15);
            
            const classes = lines
                .filter(l => /^(export\s+)?class\s+\w+/.test(l.trim()))
                .map(l => l.trim())
                .slice(0, 10);

            if (imports.length) summary.push('Imports/Exports: ' + imports.join(' '));
            if (functions.length) summary.push('Functions: ' + functions.join(' '));
            if (classes.length) summary.push('Classes: ' + classes.join(' '));

        } else if (['py'].includes(ext)) {
            // Python
            const imports = lines.filter(l => l.trim().startsWith('import ') || l.trim().startsWith('from ')).slice(0, 10);
            const defs = lines.filter(l => /^(async\s+)?def\s+\w+/.test(l.trim()) || /^class\s+\w+/.test(l.trim())).slice(0, 15);
            
            if (imports.length) summary.push('Imports: ' + imports.join(' '));
            if (defs.length) summary.push('Definitions: ' + defs.join(' '));

        } else if (['java', 'kt', 'scala'].includes(ext)) {
            // Java/Kotlin/Scala
            const imports = lines.filter(l => l.trim().startsWith('import ')).slice(0, 10);
            const classes = lines.filter(l => /^(public|private|protected)?\s*(class|interface|enum)\s+\w+/.test(l.trim())).slice(0, 10);
            const methods = lines.filter(l => /^(public|private|protected)?\s+\w+\s+\w+\s*\(/.test(l.trim())).slice(0, 15);
            
            if (imports.length) summary.push('Imports: ' + imports.join(' '));
            if (classes.length) summary.push('Classes: ' + classes.join(' '));
            if (methods.length) summary.push('Methods: ' + methods.join(' '));

        } else if (['go'].includes(ext)) {
            // Go
            const imports = lines.filter(l => l.trim().startsWith('import ')).slice(0, 10);
            const funcs = lines.filter(l => /^func\s+\w+/.test(l.trim())).slice(0, 15);
            
            if (imports.length) summary.push('Imports: ' + imports.join(' '));
            if (funcs.length) summary.push('Functions: ' + funcs.join(' '));

        } else if (['rs'].includes(ext)) {
            // Rust
            const uses = lines.filter(l => l.trim().startsWith('use ')).slice(0, 10);
            const items = lines.filter(l => /^(pub\s+)?(fn|struct|enum|trait|impl)\s+\w+/.test(l.trim())).slice(0, 15);
            
            if (uses.length) summary.push('Uses: ' + uses.join(' '));
            if (items.length) summary.push('Items: ' + items.join(' '));

        } else if (['html', 'htm'].includes(ext)) {
            // HTML
            const title = content.match(/<title>(.*?)<\/title>/i);
            if (title) summary.push('Title: ' + title[1]);
            summary.push('HTML document');

        } else if (['css', 'scss', 'sass', 'less'].includes(ext)) {
            // CSS
            const selectors = lines.filter(l => l.trim().endsWith('{') && !l.trim().startsWith('@')).slice(0, 20);
            if (selectors.length) summary.push('Selectors: ' + selectors.map(s => s.trim()).join(' '));

        } else if (['md', 'markdown'].includes(ext)) {
            // Markdown
            const headers = lines.filter(l => l.trim().startsWith('#')).slice(0, 10);
            if (headers.length) summary.push('Headers: ' + headers.join(' '));
        }

        // Add first few lines of actual content as fallback
        const contentSample = lines.slice(0, 5).join(' ').trim();
        if (contentSample) {
            summary.push('Content: ' + contentSample.slice(0, 200));
        }

        return summary.join(' | ').slice(0, 1000); // Limit total summary size
    },

    /**
     * Index a single file
     * @param {string} path - File path
     * @param {string} content - File content
     * @returns {Promise<boolean>} Success status
     */
    async indexFile(path, content) {
        if (!this.isEnabled()) return false;

        try {
            const summary = this.summarizeFile(path, content);
            const embedding = await EmbeddingsClient.embed(summary);

            if (embedding) {
                this._fileIndex.set(path, {
                    path,
                    summary,
                    embedding,
                    lastIndexed: Date.now()
                });

                EventBus.emit('context:fileIndexed', { path });
                return true;
            }
            return false;

        } catch (error) {
            console.error(`[Context] Failed to index ${path}:`, error);
            return false;
        }
    },

    /**
     * Index all files in current project
     * @param {boolean} force - Force re-index even if already indexed
     * @returns {Promise<number>} Number of files indexed
     */
    async indexProject(force = false) {
        if (!this.isEnabled()) return 0;
        if (this._indexing) {
            console.log('[Context] Already indexing, skipping');
            return 0;
        }
        if (!State.currentProject) {
            console.log('[Context] No project loaded');
            return 0;
        }

        const projectKey = `${State.currentProject.owner}/${State.currentProject.repo}@${State.currentBranch}`;

        // Check if we've already indexed this project
        if (!force && this._indexedProject === projectKey && this._fileIndex.size > 0) {
            console.log('[Context] Project already indexed');
            return this._fileIndex.size;
        }

        this._indexing = true;
        this._fileIndex.clear();
        this._queryCount = 0;
        this._lastQueried = null;

        console.log(`[Context] Indexing project: ${projectKey}`);
        EventBus.emit('context:indexStart', { project: projectKey });

        try {
            // Filter files: type, extension, path patterns
            const allFiles = State.fileTree.filter(f => f.type === 'file');
            const eligible = allFiles.filter(f => this.shouldIndex(f.path));
            const skipped = allFiles.length - eligible.length;

            if (skipped > 0) {
                console.log(`[Context] Filtered: ${eligible.length} eligible, ${skipped} skipped (binary/vendor/generated)`);
            }

            // Respect maxIndexFiles setting (default: 200)
            const maxFiles = State.settings.maxIndexFiles || 200;
            const files = eligible.slice(0, maxFiles);
            if (eligible.length > maxFiles) {
                console.warn(`[Context] Capped at ${maxFiles} files (${eligible.length} eligible). Increase maxIndexFiles in settings.`);
            }

            const totalFiles = files.length;
            let indexed = 0;

            // Load embeddings model if not initialized
            await EmbeddingsClient.init();

            // Index files in batches to avoid blocking
            const batchSize = 5;
            for (let i = 0; i < files.length; i += batchSize) {
                const batch = files.slice(i, i + batchSize);
                
                await Promise.all(batch.map(async file => {
                    try {
                        // Fetch file content
                        const { owner, repo } = State.currentProject;
                        const fileData = await Git.getFile(owner, repo, file.path, State.currentBranch);
                        const content = fileData.content;
                        
                        // Skip very large files (content-based check)
                        if (content.length > 500000) {
                            console.log(`[Context] Skipping large file: ${file.path} (${(content.length / 1024).toFixed(0)}KB)`);
                            return;
                        }

                        await this.indexFile(file.path, content);
                        indexed++;

                        // Emit progress
                        EventBus.emit('context:indexProgress', {
                            current: indexed,
                            total: totalFiles,
                            percent: Math.round((indexed / totalFiles) * 100)
                        });

                    } catch (error) {
                        console.error(`[Context] Failed to index ${file.path}:`, error);
                    }
                }));

                // Small delay between batches
                await new Promise(resolve => setTimeout(resolve, 10));
            }

            this._indexedProject = projectKey;
            console.log(`[Context] Indexed ${indexed} files`);

            // Persist to storage
            await this.saveIndexToStorage();

            EventBus.emit('context:indexComplete', {
                project: projectKey,
                filesIndexed: indexed,
                totalFiles: allFiles.length,
                eligible: eligible.length,
                skipped
            });

            return indexed;

        } catch (error) {
            console.error('[Context] Indexing failed:', error);
            EventBus.emit('context:indexError', { error: error.message });
            return 0;

        } finally {
            this._indexing = false;
        }
    },

    /**
     * Incremental re-index: only re-embed files that changed.
     * Used after merges or branch switches when an existing index is loaded.
     * @param {string[]} changedPaths - Paths that changed
     */
    async reindexChanged(changedPaths) {
        if (!this.isEnabled() || !State.currentProject) return 0;

        const { owner, repo } = State.currentProject;
        const branch = State.currentBranch;
        let updated = 0;

        for (const path of changedPaths) {
            if (!this.shouldIndex(path)) continue;

            try {
                const fileData = await Git.getFile(owner, repo, path, branch);
                if (fileData.content.length > 500000) continue;
                await this.indexFile(path, fileData.content);
                updated++;
            } catch (e) {
                // File might have been deleted in the merge — remove from index
                this._fileIndex.delete(path);
            }
        }

        if (updated > 0) {
            await this.saveIndexToStorage();
            console.log(`[Context] Incrementally re-indexed ${updated} changed file(s)`);
        }

        return updated;
    },

    /**
     * Find relevant files based on a query
     * @param {string} query - Search query (natural language)
     * @param {number} topK - Number of results to return
     * @returns {Promise<Array>} Top K relevant files with similarity scores
     */
    async findRelevantFiles(query, topK = 5) {
        if (!this.isEnabled()) return [];
        if (this._fileIndex.size === 0) {
            console.log('[Context] No files indexed, indexing project first...');
            await this.indexProject();
        }
        if (this._fileIndex.size === 0) return [];

        try {
            // Generate query embedding
            const queryEmbedding = await EmbeddingsClient.embed(query);
            if (!queryEmbedding) return [];

            // Get all indexed files
            const indexedFiles = Array.from(this._fileIndex.values());

            // Find most similar
            const results = EmbeddingsClient.findSimilar(queryEmbedding, indexedFiles, topK);

            console.log(`[Context] Found ${results.length} relevant files for query: "${query}"`);
            results.forEach((r, i) => {
                console.log(`  ${i + 1}. ${r.path} (similarity: ${r.similarity.toFixed(3)})`);
            });

            // Track query stats
            this._trackQuery();

            return results;

        } catch (error) {
            console.error('[Context] Failed to find relevant files:', error);
            return [];
        }
    },

    /**
     * Update index for a single file (incremental update)
     */
    async updateFileIndex(path, content) {
        if (!this.isEnabled()) return;
        if (!this.shouldIndex(path)) return;
        await this.indexFile(path, content);
        await this.saveIndexToStorage();
    },

    /**
     * Remove file from index
     */
    removeFileIndex(path) {
        if (this._fileIndex.has(path)) {
            this._fileIndex.delete(path);
            EventBus.emit('context:fileRemoved', { path });
            this.saveIndexToStorage();
        }
    },

    /**
     * Save index to IndexedDB for persistence
     */
    async saveIndexToStorage() {
        if (!this._indexedProject) return;

        const indexData = {
            project: this._indexedProject,
            timestamp: Date.now(),
            files: Array.from(this._fileIndex.entries()),
            queryCount: this._queryCount,
            lastQueried: this._lastQueried
        };

        Storage.set(`embeddings-index-${this._indexedProject}`, indexData);
    },

    /**
     * Track a query against the current index and persist stats.
     */
    _trackQuery() {
        this._queryCount++;
        this._lastQueried = Date.now();
        // Persist just the stats without re-serializing the full index
        // (save the expensive write for indexProject)
        const key = `embeddings-index-${this._indexedProject}`;
        const existing = Storage.get(key);
        if (existing) {
            existing.queryCount = this._queryCount;
            existing.lastQueried = this._lastQueried;
            Storage.set(key, existing);
        }
    },

    /**
     * Load index from storage
     */
    async loadIndexFromStorage() {
        if (!State.currentProject) return false;

        const projectKey = `${State.currentProject.owner}/${State.currentProject.repo}@${State.currentBranch}`;
        const indexData = Storage.get(`embeddings-index-${projectKey}`);

        if (indexData && indexData.files) {
            this._fileIndex = new Map(indexData.files);
            this._indexedProject = projectKey;
            this._queryCount = indexData.queryCount || 0;
            this._lastQueried = indexData.lastQueried || null;
            
            const age = Date.now() - indexData.timestamp;
            const maxAge = (State.settings.embeddingCacheExpiry || 7) * 24 * 60 * 60 * 1000;

            if (age > maxAge) {
                console.log('[Context] Index is stale, will re-index');
                return false;
            }

            console.log(`[Context] Loaded ${this._fileIndex.size} files from cache`);
            return true;
        }

        return false;
    },

    /**
     * Clear all indexes
     */
    clearIndex() {
        this._fileIndex.clear();
        this._indexedProject = null;
        console.log('[Context] Index cleared');
        EventBus.emit('context:indexCleared');
    },

    /**
     * Remove the stored embedding index for a specific branch.
     * Called when a branch is deleted after merge.
     * @param {string} branchName - Branch name to remove
     */
    removeIndexForBranch(branchName) {
        if (!State.currentProject) return;
        const { owner, repo } = State.currentProject;
        const key = `embeddings-index-${owner}/${repo}@${branchName}`;
        const existing = Storage.get(key);
        if (existing) {
            Storage.remove(key);
            console.log(`[Context] Removed embedding index for deleted branch: ${branchName}`);
        }
        // If the deleted branch was the currently loaded index, clear in-memory too
        if (this._indexedProject === `${owner}/${repo}@${branchName}`) {
            this._fileIndex.clear();
            this._indexedProject = null;
        }
    },

    /**
     * Scan localStorage for embedding indexes whose branch no longer exists.
     * Call after branch list refresh.
     * @param {string[]} liveBranches - Array of branch names that still exist
     */
    cleanupOrphanedIndexes(liveBranches) {
        if (!State.currentProject) return;
        const { owner, repo } = State.currentProject;
        const prefix = `ai-editor-embeddings-index-${owner}/${repo}@`;
        const branchSet = new Set(liveBranches);
        let removed = 0;

        for (let i = 0; i < localStorage.length; i++) {
            const fullKey = localStorage.key(i);
            if (fullKey && fullKey.startsWith(prefix)) {
                const branch = fullKey.slice(prefix.length);
                if (!branchSet.has(branch)) {
                    localStorage.removeItem(fullKey);
                    removed++;
                    console.log(`[Context] Cleaned up orphaned index: ${branch}`);
                }
            }
        }

        if (removed > 0) {
            console.log(`[Context] Cleaned up ${removed} orphaned embedding index(es)`);
        }
    },

    /**
     * Get index statistics
     */
    getStats() {
        return {
            filesIndexed: this._fileIndex.size,
            project: this._indexedProject,
            isIndexing: this._indexing,
            enabled: this.isEnabled(),
            queryCount: this._queryCount,
            lastQueried: this._lastQueried
        };
    }
};

// ============================================
// EVENT LISTENERS — Automatic index lifecycle
// ============================================

// ── Project load: restore from cache or auto-index ──
EventBus.on('project:loaded', async () => {
    if (!ContextManager.isEnabled()) return;

    const loaded = await ContextManager.loadIndexFromStorage();
    
    if (!loaded && State.settings.autoReindex !== false) {
        console.log('[Context] Auto-indexing project...');
        setTimeout(() => ContextManager.indexProject(), 1000);
    }
});

// ── Branch switch: load cached index for new branch or re-index ──
EventBus.on('branch:switch', async ({ branch }) => {
    if (!ContextManager.isEnabled() || !State.currentProject) return;

    const newKey = `${State.currentProject.owner}/${State.currentProject.repo}@${branch}`;
    if (ContextManager._indexedProject === newKey) return; // Already on this branch

    console.log(`[Context] Branch switched to ${branch}, loading index...`);

    // Clear current in-memory index
    ContextManager._fileIndex.clear();
    ContextManager._indexedProject = null;

    // Try to load cached index for the new branch
    const loaded = await ContextManager.loadIndexFromStorage();
    if (!loaded && State.settings.autoReindex !== false) {
        console.log(`[Context] No cached index for ${branch}, auto-indexing...`);
        setTimeout(() => ContextManager.indexProject(), 1000);
    }
});

// ── Branch deleted: remove its embedding index from storage ──
EventBus.on('git:branchDeleted', ({ name }) => {
    if (!ContextManager.isEnabled()) return;
    console.log(`[Context] Branch deleted: ${name}, removing embedding index`);
    ContextManager.removeIndexForBranch(name);
});

// ── PR merged: reindex changed files on the target branch ──
// This event is emitted from project-manager.js with enriched data
EventBus.on('context:prMerged', async ({ baseBranch, changedFiles }) => {
    if (!ContextManager.isEnabled() || !State.currentProject) return;

    const currentKey = `${State.currentProject.owner}/${State.currentProject.repo}@${baseBranch}`;

    // Only reindex if we have an index for the target branch
    if (ContextManager._indexedProject === currentKey && changedFiles?.length > 0) {
        console.log(`[Context] PR merged into ${baseBranch}, re-indexing ${changedFiles.length} changed file(s)...`);
        await ContextManager.reindexChanged(changedFiles);
    }
});

// ── File CRUD: incremental index updates ──
EventBus.on('git:fileCreated', async ({ path, content }) => {
    if (!ContextManager.isEnabled()) return;
    if (!ContextManager.shouldIndex(path)) return;
    console.log(`[Context] File created: ${path}, updating index`);
    await ContextManager.updateFileIndex(path, content);
});

EventBus.on('git:fileUpdated', async ({ path, content }) => {
    if (!ContextManager.isEnabled()) return;
    if (!ContextManager.shouldIndex(path)) return;
    console.log(`[Context] File updated: ${path}, updating index`);
    await ContextManager.updateFileIndex(path, content);
});

EventBus.on('git:fileDeleted', ({ path }) => {
    if (!ContextManager.isEnabled()) return;
    console.log(`[Context] File deleted: ${path}, removing from index`);
    ContextManager.removeFileIndex(path);
});

export { ContextManager };
