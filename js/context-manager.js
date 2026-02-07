/**
 * Context Manager - Intelligent file indexing and context optimization
 * Uses embeddings for semantic file search to reduce token usage
 */

import { State, EventBus, Storage } from './core.js';
import { EmbeddingsClient } from './embeddings-client.js';
import { GiteaAPI } from './gitea.js';

const ContextManager = {
    _fileIndex: new Map(), // path -> { path, summary, embedding, lastIndexed }
    _indexing: false,
    _indexedProject: null, // Track which project is indexed

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

        console.log(`[Context] Indexing project: ${projectKey}`);
        EventBus.emit('context:indexStart', { project: projectKey });

        try {
            // Get all files from file tree
            const files = State.fileTree.filter(f => f.type === 'file');
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
                        const content = await GiteaAPI.getFileContent(owner, repo, file.path, State.currentBranch);
                        
                        // Skip binary files and very large files
                        if (content.length > 500000) { // Skip files > 500KB
                            console.log(`[Context] Skipping large file: ${file.path}`);
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

            // Persist to IndexedDB
            await this.saveIndexToStorage();

            EventBus.emit('context:indexComplete', {
                project: projectKey,
                filesIndexed: indexed,
                totalFiles
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
            files: Array.from(this._fileIndex.entries())
        };

        Storage.set(`embeddings-index-${this._indexedProject}`, indexData);
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
     * Get index statistics
     */
    getStats() {
        return {
            filesIndexed: this._fileIndex.size,
            project: this._indexedProject,
            isIndexing: this._indexing,
            enabled: this.isEnabled()
        };
    }
};

// Event listeners for automatic index updates
EventBus.on('project:loaded', async () => {
    if (!ContextManager.isEnabled()) return;

    // Try to load from cache first
    const loaded = await ContextManager.loadIndexFromStorage();
    
    // If cache miss or stale, index in background
    if (!loaded && State.settings.autoReindex !== false) {
        console.log('[Context] Auto-indexing project...');
        setTimeout(() => ContextManager.indexProject(), 1000); // Delay to not block UI
    }
});

EventBus.on('gitea:fileCreated', async ({ path, content }) => {
    if (!ContextManager.isEnabled()) return;
    console.log(`[Context] File created: ${path}, updating index`);
    await ContextManager.updateFileIndex(path, content);
});

EventBus.on('gitea:fileUpdated', async ({ path, content }) => {
    if (!ContextManager.isEnabled()) return;
    console.log(`[Context] File updated: ${path}, updating index`);
    await ContextManager.updateFileIndex(path, content);
});

EventBus.on('gitea:fileDeleted', ({ path }) => {
    if (!ContextManager.isEnabled()) return;
    console.log(`[Context] File deleted: ${path}, removing from index`);
    ContextManager.removeFileIndex(path);
});

export { ContextManager };
