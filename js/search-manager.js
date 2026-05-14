/**
 * Search Manager
 * Handles search operations via web worker with EventBus integration.
 * ES module — import { SearchManager } from './search-manager.js'
 *
 * Sibling-placement per 2.44.0.3 (sweep wave close); previously at
 * `js/managers/search-manager.js`. The `js/managers/` directory retired —
 * it held this one file; the singleton-class shape matches the top-level
 * idiom (`tab-manager.js`, `project-manager.js`, `file-tree.js`).
 */

import { EventBus, Storage } from './core.js';

class _SearchManager {
    constructor() {
        this.worker = null;
        this.currentSearchId = null;
        this.searchHistory = [];
        this.maxHistory = 20;
    }

    init() {
        if (typeof Worker !== 'undefined') {
            try {
                this.worker = new Worker('./js/workers/search-worker.js');
                this.worker.onmessage = (e) => this._handleWorkerMessage(e.data);
                this.worker.onerror = (e) => {
                    console.error('[Search] Worker error:', e);
                    EventBus.emit('search:error', { error: e.message });
                };
                console.log('[Search] Web worker initialized');
            } catch (err) {
                console.warn('[Search] Worker init failed, using sync fallback:', err.message);
            }
        }
        this._loadHistory();
    }

    // ========================================
    // SEARCH
    // ========================================

    /**
     * Search across files.
     * @param {Array} files - [{ path, content }]
     * @param {string} pattern - Search pattern (plain text or regex)
     * @param {Object} options - { caseSensitive, regex, wholeWord }
     */
    search(files, pattern, options = {}) {
        if (!pattern) return;

        // If regex mode, validate
        if (options.regex) {
            try {
                new RegExp(pattern, options.caseSensitive ? '' : 'i');
            } catch (e) {
                EventBus.emit('search:error', { error: `Invalid regex: ${e.message}` });
                return;
            }
        }

        this.currentSearchId = Date.now().toString();
        this._addToHistory(pattern, options);

        if (this.worker) {
            this.worker.postMessage({
                type: 'search',
                id: this.currentSearchId,
                payload: { files, pattern, options }
            });
        } else {
            this._searchSync(files, pattern, options);
        }
    }

    /** Cancel current search. */
    cancelSearch() {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
            this.init();
        }
        this.currentSearchId = null;
        EventBus.emit('search:cancelled');
    }

    // ========================================
    // REPLACE
    // ========================================

    /**
     * Replace all occurrences in content.
     * Emits search:replaceComplete with { success, content, matchCount }
     */
    replace(content, searchPattern, replacement, options = {}) {
        if (this.worker) {
            this.worker.postMessage({
                type: 'replace',
                id: Date.now().toString(),
                payload: { content, searchPattern, replacement, options }
            });
        } else {
            const result = this._replaceSync(content, searchPattern, replacement, options);
            EventBus.emit('search:replaceComplete', result);
        }
    }

    // ========================================
    // HISTORY
    // ========================================

    getHistory() { return this.searchHistory; }

    clearHistory() {
        this.searchHistory = [];
        Storage.remove('searchHistory');
        EventBus.emit('search:historyUpdated', this.searchHistory);
    }

    // ========================================
    // INTERNAL
    // ========================================

    _handleWorkerMessage(data) {
        switch (data.type) {
            case 'progress':
                EventBus.emit('search:progress', { current: data.current, total: data.total });
                break;
            case 'searchComplete':
                if (data.id === this.currentSearchId) {
                    EventBus.emit('search:complete', data.results);
                }
                break;
            case 'replaceComplete':
                EventBus.emit('search:replaceComplete', data.result);
                break;
            case 'error':
                EventBus.emit('search:error', { error: data.error });
                break;
        }
    }

    _searchSync(files, pattern, options) {
        const results = { files: {}, totalFiles: files.length, totalMatches: 0, errors: [] };

        const textExts = new Set([
            'md','txt','json','xml','html','css','js','ts','py','java','c','cpp','h','hpp',
            'rb','php','go','rs','swift','kt','scala','yml','yaml','ini','conf','sh','bash',
            'zsh','sql','vue','svelte','jsx','tsx','toml','pl','pm','r','lua','zig','nix'
        ]);

        let searchPattern = pattern;
        if (!options.regex) {
            searchPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
        if (options.wholeWord) {
            searchPattern = `\\b${searchPattern}\\b`;
        }

        const flags = options.caseSensitive ? 'gm' : 'gim';
        let regex;
        try { regex = new RegExp(searchPattern, flags); }
        catch (e) { EventBus.emit('search:error', { error: e.message }); return; }

        for (const file of files) {
            if (/node_modules|\.git\/|\.min\.js$|\.map$/.test(file.path)) continue;
            const ext = file.path.split('.').pop().toLowerCase();
            if (!textExts.has(ext)) continue;
            if (!file.content) continue;

            try {
                const lines = file.content.split('\n');
                const fileResults = [];
                let match;
                regex.lastIndex = 0;

                while ((match = regex.exec(file.content)) !== null) {
                    const lineStart = file.content.lastIndexOf('\n', match.index) + 1;
                    const lineNum = file.content.slice(0, lineStart).split('\n').length;
                    const column = match.index - lineStart;

                    fileResults.push({
                        match: match[0],
                        index: match.index,
                        lineNum,
                        column,
                        lineContent: lines[lineNum - 1] || ''
                    });

                    if (match.index === regex.lastIndex) regex.lastIndex++;
                    if (fileResults.length >= 500) break;
                }

                if (fileResults.length > 0) {
                    results.files[file.path] = {
                        path: file.path,
                        matches: fileResults,
                        matchCount: fileResults.length
                    };
                    results.totalMatches += fileResults.length;
                }
            } catch (e) {
                results.errors.push({ file: file.path, error: e.message });
            }
        }

        EventBus.emit('search:complete', results);
    }

    _replaceSync(content, searchPattern, replacement, options) {
        try {
            let pat = options.regex ? searchPattern : searchPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (options.wholeWord) pat = `\\b${pat}\\b`;
            const flags = options.caseSensitive ? 'gm' : 'gim';
            const regex = new RegExp(pat, flags);
            let count = 0;
            const result = content.replace(regex, (...args) => { count++; return replacement; });
            return { success: true, content: result, matchCount: count };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    _addToHistory(pattern, options) {
        this.searchHistory = [
            { pattern, options, timestamp: Date.now() },
            ...this.searchHistory.filter(h => h.pattern !== pattern)
        ].slice(0, this.maxHistory);
        Storage.set('searchHistory', this.searchHistory);
    }

    _loadHistory() {
        // Pre-2.40.0 the unprefixed `searchHistory` key was migrated by a
        // hand-written shim here; 2.40.0 retired it in favor of the
        // shared `Storage.migrateLegacyKey` helper.
        Storage.migrateLegacyKey('searchHistory', 'searchHistory');
        this.searchHistory = Storage.get('searchHistory', []);
    }
}

const SearchManager = new _SearchManager();
export { SearchManager };
