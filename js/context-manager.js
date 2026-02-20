/**
 * Context Manager - Intelligent file indexing and context optimization
 * Uses embeddings for semantic file search to reduce token usage
 */

import { State, EventBus, Storage } from './core.js';
import { EmbeddingsClient } from './embeddings-client.js';
import { Git } from './git.js';
import { IgnoreManager } from './ignore.js';

const ContextManager = {
    _fileIndex: new Map(), // path -> { path, summary, embedding, lastIndexed }
    _indexing: false,
    _indexedProject: null, // Track which project is indexed
    _queryCount: 0,        // Times findRelevantFiles was called for current index
    _lastQueried: null,    // Timestamp of last query

    // ── Pause / Resume ──
    _manualPause: false,     // User clicked pause
    _autoPause: false,       // LLM or file operation auto-paused
    _pauseResolve: null,     // Resolve function for the pause promise
    _indexProgress: null,    // { current, total } for UI

    // ── File Filtering ──

    /** Max file size (bytes) to download for indexing. Checked from tree metadata BEFORE download. */
    MAX_INDEX_SIZE: 250_000,  // 250KB — generous for code; data files get caught here

    /**
     * Check if a file should be indexed based on ignore patterns and size.
     * Delegates to IgnoreManager for pattern matching.
     * @param {string} path
     * @param {number} [size] - File size from tree metadata (bytes). 0/undefined = unknown, allow.
     */
    shouldIndex(path, size) {
        return !IgnoreManager.isIgnored(path, size);
    },

    /**
     * Check if context manager is enabled
     */
    isEnabled() {
        return State.settings.useEmbeddings === true;
    },

    /**
     * Target summary size in chars. ~4 chars/token for code → ~6000 chars ≈ 1500 tokens.
     * Conservative default for BGE-M3 (8192 token limit). The embeddings client
     * will auto-discover smaller limits via trim-and-retry.
     */
    SUMMARY_TARGET_CHARS: 6000,

    /**
     * Generate a rich summary of a file for embedding.
     * 
     * Structure: [file path] [structural signals] [raw content head+tail]
     * 
     * The structural signals (imports, exports, function/class declarations,
     * doc comments, TODOs) anchor the embedding on "what this file IS."
     * The raw content sample adds semantic depth — the model understands
     * code patterns even without explicit labels.
     * 
     * @param {string} path - File path
     * @param {string} content - File content
     * @returns {string} Summary text optimized for embedding
     */
    summarizeFile(path, content) {
        if (!content) return `File: ${path}`;
        const ext = path.split('.').pop()?.toLowerCase();
        const lines = content.split('\n');
        const budget = this.SUMMARY_TARGET_CHARS;

        // ── Phase 1: Structural signals (always included, uncapped) ──
        const structure = [`File: ${path}`];

        // Extract structural patterns by language family
        const extractors = this._getExtractors(ext);
        for (const { label, patterns, limit } of extractors) {
            const matches = [];
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                for (const pattern of patterns) {
                    if (typeof pattern === 'function' ? pattern(trimmed) : pattern.test(trimmed)) {
                        matches.push(trimmed);
                        break;
                    }
                }
                if (matches.length >= limit) break;
            }
            if (matches.length) structure.push(`${label}: ${matches.join(' | ')}`);
        }

        // Cross-language: doc comments, TODOs, important strings
        const docComments = lines
            .filter(l => /^\s*(\*|\/\*\*|\/\/\/|#{1,3}\s|"""|'''|\/\/ @)/.test(l))
            .map(l => l.trim().replace(/^[\/*#'"\s]+/, '').trim())
            .filter(l => l.length > 10 && l.length < 200)
            .slice(0, 10);
        if (docComments.length) structure.push(`Docs: ${docComments.join(' | ')}`);

        const todos = lines
            .filter(l => /(?:TODO|FIXME|HACK|XXX|NOTE|WARN)[\s:]/i.test(l))
            .map(l => l.trim())
            .slice(0, 5);
        if (todos.length) structure.push(`Notes: ${todos.join(' | ')}`);

        const structureText = structure.join('\n');

        // ── Phase 2: Raw content to fill remaining budget ──
        const remaining = budget - structureText.length;
        if (remaining < 200) return structureText.slice(0, budget);

        // Head gets 70% of remaining budget, tail gets 30%
        // Head: imports, early code. Tail: exports, module.exports, final definitions.
        const headBudget = Math.floor(remaining * 0.7);
        const tailBudget = remaining - headBudget;

        const fullContent = content;
        let rawSample = '';

        if (fullContent.length <= remaining) {
            // Small file — include everything
            rawSample = fullContent;
        } else {
            const head = fullContent.slice(0, headBudget);
            const tail = fullContent.slice(-tailBudget);
            rawSample = head + '\n…\n' + tail;
        }

        return structureText + '\n---\n' + rawSample;
    },

    /**
     * Get structural extractors for a file extension.
     * Each extractor: { label, patterns: (regex|function)[], limit }
     */
    _getExtractors(ext) {
        const CODE_EXT = {
            // JavaScript / TypeScript
            js: 'js', jsx: 'js', ts: 'js', tsx: 'js', mjs: 'js', cjs: 'js',
            // Python
            py: 'py', pyw: 'py', pyi: 'py',
            // Go
            go: 'go',
            // Rust
            rs: 'rs',
            // C / C++
            c: 'c', h: 'c', cpp: 'c', cxx: 'c', cc: 'c', hpp: 'c', hxx: 'c',
            // Perl
            pl: 'pl', pm: 'pl',
            // Java / Kotlin / Scala
            java: 'java', kt: 'java', scala: 'java',
            // Ruby
            rb: 'rb',
            // PHP
            php: 'php',
            // Shell
            sh: 'sh', bash: 'sh', zsh: 'sh',
            // HTML
            html: 'html', htm: 'html',
            // CSS
            css: 'css', scss: 'css', sass: 'css', less: 'css',
            // Markdown
            md: 'md', markdown: 'md',
            // Config
            json: 'cfg', yaml: 'cfg', yml: 'cfg', toml: 'cfg', ini: 'cfg',
        };

        const family = CODE_EXT[ext] || null;

        switch (family) {
            case 'js': return [
                { label: 'Imports', patterns: [l => l.startsWith('import '), l => l.startsWith('require(')], limit: 20 },
                { label: 'Exports', patterns: [/^export\s+(default\s+)?(function|class|const|let|var|async)\s/], limit: 20 },
                { label: 'Functions', patterns: [
                    /^(async\s+)?function\s+\w+/,
                    /^(const|let|var)\s+\w+\s*=\s*(async\s*)?\(/,
                    /^(const|let|var)\s+\w+\s*=\s*(async\s*)?\w+\s*=>/,
                    /^\w+\s*\(.*\)\s*\{/,  // method shorthand
                ], limit: 30 },
                { label: 'Classes', patterns: [/^(export\s+)?class\s+\w+/], limit: 10 },
            ];

            case 'py': return [
                { label: 'Imports', patterns: [l => l.startsWith('import '), l => l.startsWith('from ')], limit: 20 },
                { label: 'Definitions', patterns: [
                    /^(async\s+)?def\s+\w+/,
                    /^class\s+\w+/,
                    /^@\w+/,  // decorators
                ], limit: 30 },
            ];

            case 'go': return [
                { label: 'Package', patterns: [/^package\s+\w+/], limit: 1 },
                { label: 'Imports', patterns: [l => l.startsWith('import ')], limit: 15 },
                { label: 'Functions', patterns: [/^func\s+(\(.*?\)\s*)?\w+/], limit: 30 },
                { label: 'Types', patterns: [/^type\s+\w+\s+(struct|interface)/], limit: 15 },
            ];

            case 'rs': return [
                { label: 'Uses', patterns: [l => l.startsWith('use ')], limit: 20 },
                { label: 'Items', patterns: [/^(pub\s+)?(fn|struct|enum|trait|impl|type|mod|const|static)\s+\w+/], limit: 30 },
                { label: 'Macros', patterns: [/^(pub\s+)?macro_rules!\s+\w+/], limit: 5 },
            ];

            case 'c': return [
                { label: 'Includes', patterns: [/^#include\s+[<"]/], limit: 20 },
                { label: 'Defines', patterns: [/^#define\s+\w+/], limit: 10 },
                { label: 'Declarations', patterns: [
                    /^(static|extern|inline|virtual)?\s*(void|int|char|bool|float|double|auto|unsigned|signed|long|short|const|struct|class|enum|union|template|namespace)\s/,
                    /^(class|struct|enum|union|namespace)\s+\w+/,
                    /^template\s*</,
                ], limit: 30 },
            ];

            case 'pl': return [
                { label: 'Uses', patterns: [/^use\s+\w+/, /^require\s+/], limit: 15 },
                { label: 'Subs', patterns: [/^sub\s+\w+/, /^(my|our|local)\s+/], limit: 25 },
                { label: 'Package', patterns: [/^package\s+\w+/], limit: 3 },
            ];

            case 'java': return [
                { label: 'Package', patterns: [/^package\s+/], limit: 1 },
                { label: 'Imports', patterns: [l => l.startsWith('import ')], limit: 20 },
                { label: 'Types', patterns: [
                    /^(public|private|protected|abstract|final)?\s*(class|interface|enum|record)\s+\w+/,
                ], limit: 10 },
                { label: 'Methods', patterns: [
                    /^(public|private|protected|abstract|static|final|override)?\s+\w+[\w<>\[\],\s]+\w+\s*\(/,
                ], limit: 25 },
            ];

            case 'rb': return [
                { label: 'Requires', patterns: [/^require\s+/, /^require_relative\s+/], limit: 15 },
                { label: 'Definitions', patterns: [/^(def|class|module)\s+\w+/], limit: 25 },
            ];

            case 'php': return [
                { label: 'Uses', patterns: [/^use\s+/, /^namespace\s+/], limit: 15 },
                { label: 'Definitions', patterns: [
                    /^(public|private|protected|static|abstract|final)?\s*(function|class|interface|trait|enum)\s+\w+/,
                ], limit: 25 },
            ];

            case 'sh': return [
                { label: 'Functions', patterns: [/^\w+\s*\(\)\s*\{/, /^function\s+\w+/], limit: 20 },
                { label: 'Variables', patterns: [/^(export\s+)?\w+=/], limit: 15 },
            ];

            case 'html': return [
                { label: 'Structure', patterns: [
                    /<title>.*<\/title>/i,
                    /^<(header|nav|main|section|article|aside|footer|form|table)\b/i,
                    /^<(h[1-6]|meta|link|script)\b/i,
                    /\bid=["'][^"']+["']/,
                ], limit: 20 },
            ];

            case 'css': return [
                { label: 'Selectors', patterns: [l => l.endsWith('{') && !l.startsWith('@')], limit: 30 },
                { label: 'Variables', patterns: [/^\s*--[\w-]+\s*:/], limit: 15 },
                { label: 'Media', patterns: [/^@media\s+/], limit: 5 },
            ];

            case 'md': return [
                { label: 'Headers', patterns: [l => l.startsWith('#')], limit: 20 },
                { label: 'Links', patterns: [/\[.*\]\(.*\)/], limit: 10 },
            ];

            case 'cfg': return [
                { label: 'Keys', patterns: [
                    /^"?\w+[\w.-]*"?\s*[:=]/,  // JSON/YAML/TOML keys
                    /^\[[\w.-]+\]/,             // TOML/INI sections
                ], limit: 30 },
            ];

            default: return [];
        }
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

    // ── Pause / Resume API ──

    /** @returns {boolean} Whether indexing is effectively paused */
    get paused() { return this._manualPause || this._autoPause; },

    /**
     * Toggle manual pause. User-initiated pause overrides auto.
     */
    togglePause() {
        this._manualPause = !this._manualPause;
        if (!this._manualPause) this._autoPause = false; // manual resume clears auto too
        this._emitPauseState();
        if (!this.paused && this._pauseResolve) {
            this._pauseResolve();
            this._pauseResolve = null;
        }
    },

    /**
     * Auto-pause for LLM/file operations. Does NOT override manual pause.
     */
    autoPause() {
        if (!this._indexing || this._manualPause) return; // already paused or not running
        if (!this._autoPause) {
            this._autoPause = true;
            this._emitPauseState();
        }
    },

    /**
     * Resume from auto-pause. Manual pause stays.
     */
    autoResume() {
        if (!this._autoPause) return;
        this._autoPause = false;
        this._emitPauseState();
        if (!this.paused && this._pauseResolve) {
            this._pauseResolve();
            this._pauseResolve = null;
        }
    },

    _emitPauseState() {
        EventBus.emit('context:pauseChanged', {
            paused: this.paused,
            manual: this._manualPause,
            auto: this._autoPause,
            indexing: this._indexing,
            progress: this._indexProgress
        });
    },

    /**
     * Called inside the indexing loop. If paused, awaits resume.
     * Returns false if indexing should abort (generation changed).
     */
    async _waitIfPaused(generation) {
        while (this.paused) {
            if (this._indexGeneration !== generation) return false;
            await new Promise(resolve => { this._pauseResolve = resolve; });
        }
        return true;
    },

    /**
     * Index all files in current project
     * @param {boolean} force - Force re-index even if already indexed
     * @param {boolean} resume - Resume partial index (skip already-indexed files)
     * @returns {Promise<number>} Number of files indexed
     */
    async indexProject(force = false, resume = false) {
        if (!this.isEnabled()) return 0;
        if (!State.currentProject) {
            console.log('[Context] No project loaded');
            return 0;
        }

        // Snapshot the project context NOW — these won't change mid-loop
        const snapshot = {
            connectionId: State.currentProject.connectionId,
            owner: State.currentProject.owner,
            repo: State.currentProject.repo,
            branch: State.currentBranch,
            fileTree: [...State.fileTree]  // shallow copy of tree array
        };
        const projectKey = `${snapshot.owner}/${snapshot.repo}@${snapshot.branch}`;

        // If another indexing run is in progress, cancel it
        if (this._indexing) {
            console.log(`[Context] Cancelling in-progress indexing for new project: ${projectKey}`);
            this._indexGeneration = (this._indexGeneration || 0) + 1;
            // Wait briefly for the old run to notice the cancellation
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        // Resume: only valid for the same project with existing partial index
        const canResume = resume && this._indexedProject === projectKey && this._fileIndex.size > 0;

        // Check if we've already fully indexed this project
        if (!force && !resume && this._indexedProject === projectKey && this._fileIndex.size > 0) {
            console.log('[Context] Project already indexed');
            return this._fileIndex.size;
        }

        // Generation counter: if this changes mid-loop, another indexProject call has started
        const generation = (this._indexGeneration || 0) + 1;
        this._indexGeneration = generation;

        this._indexing = true;
        this._indexProgress = { current: 0, total: 0 };
        this._autoPause = false; // Reset auto-pause for new run

        if (!canResume) {
            this._fileIndex.clear();
            this._queryCount = 0;
            this._lastQueried = null;
        }

        console.log(`[Context] ${canResume ? 'Resuming' : 'Indexing'} project: ${projectKey}${canResume ? ` (${this._fileIndex.size} already indexed)` : ''}`);
        EventBus.emit('context:indexStart', { project: projectKey, resuming: canResume });
        this._emitPauseState();

        try {
            // Filter files from the SNAPSHOT, not live State.fileTree
            const allFiles = snapshot.fileTree.filter(f => f.type === 'file');
            const eligible = allFiles.filter(f => this.shouldIndex(f.path, f.size));
            const skipped = allFiles.length - eligible.length;

            if (skipped > 0) {
                // Log any large files that were caught only by size filter
                const sizeSkipped = allFiles.filter(f => 
                    f.size && f.size > IgnoreManager.MAX_FILE_SIZE && 
                    !IgnoreManager.isIgnored(f.path, 0)  // would pass if not for size
                );
                const sizeNote = sizeSkipped.length 
                    ? ` (${sizeSkipped.map(f => `${f.path} ${(f.size/1024).toFixed(0)}KB`).join(', ')})` 
                    : '';
                console.log(`[Context] Filtered: ${eligible.length} eligible, ${skipped} skipped (binary/vendor/generated/large)${sizeNote}`);
            }

            // Respect maxIndexFiles setting (default: 200)
            const maxFiles = State.settings.maxIndexFiles || 200;
            let files = eligible.slice(0, maxFiles);
            if (eligible.length > maxFiles) {
                console.warn(`[Context] Capped at ${maxFiles} files (${eligible.length} eligible). Increase maxIndexFiles in settings.`);
            }

            // Resume: skip files already in the index
            if (canResume) {
                const before = files.length;
                files = files.filter(f => !this._fileIndex.has(f.path));
                console.log(`[Context] Resume: ${before - files.length} already indexed, ${files.length} remaining`);
            }

            const totalFiles = files.length;
            let indexed = 0;
            let failed = 0;
            this._indexProgress = { current: 0, total: totalFiles };

            // Load embeddings model if not initialized
            await EmbeddingsClient.init();

            // ── Concurrent Pool ──
            // Unlike Promise.all batches, a pool keeps N workers busy at all times.
            // When one file completes, the next starts immediately — no waiting
            // for the slowest file in a group.
            const INDEX_TIMEOUT = 30_000; // 30s — patient but not hostage
            let maxConcurrency = 3;
            let activeCount = 0;
            let fileIdx = 0;
            let circuitOpen = false;
            let consecutiveTimeouts = 0;
            let consecutiveSuccesses = 0;
            const ctx = this; // for nested closures

            /**
             * Process a single file. Returns when the file is indexed or fails.
             */
            async function processFile(file) {
                try {
                    const fileData = await Git.getFile(
                        snapshot.owner, snapshot.repo, file.path, snapshot.branch,
                        { timeout: INDEX_TIMEOUT }
                    );
                    const content = fileData.content;

                    await ctx.indexFile(file.path, content);
                    indexed++;
                    consecutiveSuccesses++;
                    consecutiveTimeouts = 0;

                    ctx._indexProgress = { current: indexed, total: totalFiles };
                    EventBus.emit('context:indexProgress', {
                        current: indexed,
                        total: totalFiles,
                        percent: Math.round((indexed / totalFiles) * 100)
                    });

                    // Ramp up after sustained success
                    if (consecutiveSuccesses >= 10 && maxConcurrency < 5) {
                        const prev = maxConcurrency;
                        maxConcurrency = Math.min(5, maxConcurrency + 1);
                        if (maxConcurrency !== prev) {
                            console.log(`[Context] 10 consecutive OK — concurrency ${prev} → ${maxConcurrency}`);
                        }
                        consecutiveSuccesses = 0;
                    }

                    return 'ok';

                } catch (error) {
                    if (error.circuitOpen) {
                        failed++;
                        circuitOpen = true;
                        return 'circuit';
                    } else if (error.status === 404) {
                        // File in tree but not on this branch/ref — normal during branch switches
                        console.log(`[Context] Skipping ${file.path} (not found on branch)`);
                        return 'skip';
                    } else if (error.name === 'TimeoutError') {
                        failed++;
                        consecutiveTimeouts++;
                        consecutiveSuccesses = 0;
                        // Reduce concurrency on timeouts
                        if (consecutiveTimeouts >= 2 && maxConcurrency > 1) {
                            const prev = maxConcurrency;
                            maxConcurrency = Math.max(1, maxConcurrency - 1);
                            if (maxConcurrency !== prev) {
                                console.log(`[Context] ${consecutiveTimeouts} timeout(s) — concurrency ${prev} → ${maxConcurrency}`);
                            }
                        }
                        return 'timeout';
                    }
                    failed++;
                    console.error(`[Context] Failed to index ${file.path}:`, error);
                    return 'error';
                }
            }

            // Pool driver: resolves when all files processed or aborted
            await new Promise((resolvePool) => {
                function pump() {
                    // Drain condition
                    if (fileIdx >= files.length && activeCount === 0) {
                        return resolvePool();
                    }

                    // Abort on generation change
                    if (ctx._indexGeneration !== generation) {
                        if (activeCount === 0) resolvePool();
                        return;
                    }

                    // Circuit breaker — stop launching new work
                    if (circuitOpen) {
                        if (activeCount === 0) resolvePool();
                        return;
                    }

                    // Launch workers up to current maxConcurrency
                    while (activeCount < maxConcurrency && fileIdx < files.length && !circuitOpen) {
                        // Pause check — if paused, schedule a retry instead of blocking the pool
                        if (ctx.paused) {
                            const onResume = () => {
                                EventBus.off('context:pauseChanged', onResume);
                                pump();
                            };
                            EventBus.on('context:pauseChanged', onResume);
                            return; // Stop pumping until resumed
                        }

                        const file = files[fileIdx++];
                        activeCount++;

                        processFile(file).then((result) => {
                            activeCount--;
                            if (result === 'timeout') {
                                // Small delay after timeout before starting next
                                setTimeout(pump, 300);
                            } else {
                                pump();
                            }
                        });
                    }
                }

                pump();
            });

            // Circuit breaker recovery
            if (circuitOpen) {
                console.log(`[Context] Circuit breaker open — waiting for connection restore…`);
                const restored = await new Promise(resolve => {
                    const onRestore = () => { resolve(true); cleanup(); };
                    const timer = setTimeout(() => { resolve(false); cleanup(); }, 90_000);
                    const cleanup = () => {
                        EventBus.off('git:connectionRestored', onRestore);
                        clearTimeout(timer);
                    };
                    EventBus.on('git:connectionRestored', onRestore);
                });

                if (restored && fileIdx < files.length) {
                    console.log(`[Context] Connection restored — resuming (${files.length - fileIdx} files remaining)`);
                    circuitOpen = false;
                    maxConcurrency = 2;
                    consecutiveTimeouts = 0;

                    // Run the pool again for remaining files
                    await new Promise((resolvePool) => {
                        function pump() {
                            if (fileIdx >= files.length && activeCount === 0) return resolvePool();
                            if (ctx._indexGeneration !== generation) { if (activeCount === 0) resolvePool(); return; }
                            if (circuitOpen) { if (activeCount === 0) resolvePool(); return; }

                            while (activeCount < maxConcurrency && fileIdx < files.length && !circuitOpen) {
                                if (ctx.paused) {
                                    const onResume = () => { EventBus.off('context:pauseChanged', onResume); pump(); };
                                    EventBus.on('context:pauseChanged', onResume);
                                    return;
                                }
                                const file = files[fileIdx++];
                                activeCount++;
                                processFile(file).then((result) => {
                                    activeCount--;
                                    result === 'timeout' ? setTimeout(pump, 300) : pump();
                                });
                            }
                        }
                        pump();
                    });
                } else if (!restored) {
                    console.warn(`[Context] Connection not restored after 90s — stopping`);
                }
            }

            if (failed > 0) {
                console.log(`[Context] Indexing finished with ${failed} failures`);
            }

            // Final check: don't save if project switched during last batch
            if (this._indexGeneration !== generation) {
                console.log(`[Context] Indexing completed but project already switched — discarding`);
                return 0;
            }

            this._indexedProject = projectKey;
            const totalIndexed = this._fileIndex.size; // includes resumed + new
            console.log(`[Context] Indexed ${indexed} files${canResume ? ` (${totalIndexed} total)` : ''}`);

            // Persist to storage
            await this.saveIndexToStorage();

            EventBus.emit('context:indexComplete', {
                project: projectKey,
                filesIndexed: totalIndexed,
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
            // Only clear _indexing if we're still the active generation
            if (this._indexGeneration === generation) {
                this._indexing = false;
                this._indexProgress = null;
                this._autoPause = false;
                this._emitPauseState();
            }
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
     * Copy the embedding index from one branch to another.
     * Used when creating a new branch (files are identical at creation time).
     * @param {string} sourceBranch - Branch to copy from
     * @param {string} targetBranch - Branch to copy to
     * @returns {boolean} Whether the copy succeeded
     */
    copyIndexForBranch(sourceBranch, targetBranch) {
        if (!State.currentProject) return false;
        const { owner, repo } = State.currentProject;
        const sourceKey = `embeddings-index-${owner}/${repo}@${sourceBranch}`;
        const targetKey = `embeddings-index-${owner}/${repo}@${targetBranch}`;

        // Try in-memory first (if currently loaded index matches the source)
        const sourceProjectKey = `${owner}/${repo}@${sourceBranch}`;
        if (this._indexedProject === sourceProjectKey && this._fileIndex.size > 0) {
            // Clone from in-memory to storage under the new branch key
            const indexData = {
                project: `${owner}/${repo}@${targetBranch}`,
                timestamp: Date.now(),
                files: Array.from(this._fileIndex.entries()),
                queryCount: 0,
                lastQueried: null
            };
            Storage.set(targetKey, indexData);
            console.log(`[Context] Copied in-memory index (${this._fileIndex.size} files) from ${sourceBranch} → ${targetBranch}`);
            return true;
        }

        // Fall back to storage-to-storage copy
        const sourceData = Storage.get(sourceKey);
        if (sourceData && sourceData.files) {
            const targetData = {
                ...sourceData,
                project: `${owner}/${repo}@${targetBranch}`,
                timestamp: Date.now(),
                queryCount: 0,
                lastQueried: null
            };
            Storage.set(targetKey, targetData);
            console.log(`[Context] Copied stored index (${sourceData.files.length} files) from ${sourceBranch} → ${targetBranch}`);
            return true;
        }

        console.log(`[Context] No index to copy from ${sourceBranch}`);
        return false;
    },

    /**
     * Scan storage for embedding indexes whose branch no longer exists.
     * Call after branch list refresh.
     * @param {string[]} liveBranches - Array of branch names that still exist
     */
    cleanupOrphanedIndexes(liveBranches) {
        if (!State.currentProject) return;
        const { owner, repo } = State.currentProject;
        const prefix = `embeddings-index-${owner}/${repo}@`;
        const branchSet = new Set(liveBranches);
        let removed = 0;

        for (const key of Storage.keys('embeddings-index-')) {
            if (key.startsWith(prefix)) {
                const branch = key.slice(prefix.length);
                if (!branchSet.has(branch)) {
                    Storage.remove(key);
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

// ── Branch created: copy parent branch's index to the new branch ──
EventBus.on('branch:created', ({ sourceBranch, targetBranch }) => {
    if (!ContextManager.isEnabled()) return;
    ContextManager.copyIndexForBranch(sourceBranch, targetBranch);
});

// ── Branch list refreshed: clean up orphaned embedding indexes ──
EventBus.on('branches:refresh', () => {
    if (!ContextManager.isEnabled() || !State.branches?.length) return;
    const liveBranches = State.branches.map(b => b.name);
    // Defer to avoid blocking the branch UI update
    setTimeout(() => ContextManager.cleanupOrphanedIndexes(liveBranches), 500);
});

// ── PR merged: reindex changed files on the target branch AND clean up deleted branch ──
// This event is emitted from pr-detail.js (UI) and pr-tools.js (LLM) with enriched data
EventBus.on('context:prMerged', async ({ baseBranch, changedFiles, deletedBranch }) => {
    if (!ContextManager.isEnabled() || !State.currentProject) return;

    // Clean up embedding index for the deleted source branch
    if (deletedBranch) {
        console.log(`[Context] Cleaning up embeddings for merged+deleted branch: ${deletedBranch}`);
        ContextManager.removeIndexForBranch(deletedBranch);
    }

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

EventBus.on('git:fileRenamed', async ({ oldPath, newPath, content }) => {
    if (!ContextManager.isEnabled()) return;
    console.log(`[Context] File renamed: ${oldPath} → ${newPath}, migrating index`);
    ContextManager.removeFileIndex(oldPath);
    if (ContextManager.shouldIndex(newPath)) {
        // If content was provided, index directly; otherwise the next scan will pick it up
        if (content) {
            await ContextManager.updateFileIndex(newPath, content);
        }
    }
});

export { ContextManager };
