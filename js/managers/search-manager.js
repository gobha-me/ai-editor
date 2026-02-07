/**
 * Search Manager
 * Handles search operations and manages the search web worker
 */

class SearchManager {
    constructor() {
        this.worker = null;
        this.currentSearchId = null;
        this.searchHistory = [];
        this.maxHistory = 20;
        this.initWorker();
    }
    
    initWorker() {
        // Create web worker
        if (typeof Worker !== 'undefined') {
            this.worker = new Worker('js/workers/search-worker.js');
            
            this.worker.onmessage = (e) => {
                this.handleWorkerMessage(e.data);
            };
            
            this.worker.onerror = (e) => {
                console.error('Search worker error:', e);
                EventBus.emit('search:error', { error: e.message });
            };
        } else {
            console.warn('Web Workers not supported, search will run on main thread');
        }
    }
    
    handleWorkerMessage(data) {
        switch (data.type) {
            case 'progress':
                EventBus.emit('search:progress', {
                    current: data.current,
                    total: data.total
                });
                break;
                
            case 'searchComplete':
                if (data.id === this.currentSearchId) {
                    EventBus.emit('search:complete', data.results);
                }
                break;
                
            case 'replaceComplete':
                EventBus.emit('search:replaceComplete', data.result);
                break;
                
            case 'configUpdated':
                EventBus.emit('search:configUpdated');
                break;
                
            case 'error':
                EventBus.emit('search:error', { error: data.error });
                break;
        }
    }
    
    /**
     * Search across files
     * @param {Array} files - Array of file objects with path and content
     * @param {string} pattern - Search pattern (regex or plain text)
     * @param {Object} options - Search options
     */
    search(files, pattern, options = {}) {
        // Validate pattern
        try {
            new RegExp(pattern, options.caseSensitive ? '' : 'i');
        } catch (e) {
            EventBus.emit('search:error', { 
                error: `Invalid regex pattern: ${e.message}` 
            });
            return;
        }
        
        // Generate search ID
        this.currentSearchId = Date.now().toString();
        
        // Add to history
        this.addToHistory(pattern, options);
        
        // Send to worker
        if (this.worker) {
            this.worker.postMessage({
                type: 'search',
                id: this.currentSearchId,
                payload: {
                    files: files,
                    pattern: pattern,
                    options: options
                }
            });
        } else {
            // Fallback to synchronous search
            this.performSearchSync(files, pattern, options);
        }
    }
    
    performSearchSync(files, pattern, options) {
        const results = {
            files: {},
            totalFiles: files.length,
            totalMatches: 0,
            errors: []
        };
        
        const excludePatterns = ['node_modules', '.git', '.svn', '.hg', '__pycache__', '*.min.js', '*.css', '*.map'];
        const excludeRegex = new RegExp(`(${excludePatterns.join('|')})`, 'i');
        
        const textExtensions = ['.md', '.txt', '.json', '.xml', '.html', '.css', '.js', '.ts', '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.rb', '.php', '.go', '.rs', '.swift', '.kt', '.scala', '.yml', '.yaml', '.ini', '.conf', '.sh', '.bash', '.zsh', '.fish', '.sql', '.vue', '.svelte', '.jsx', '.tsx'];
        
        const flags = options.caseSensitive ? 'gm' : 'gim';
        const regex = new RegExp(pattern, flags);
        
        files.forEach(file => {
            // Skip excluded files
            if (excludeRegex.test(file.path)) return;
            
            // Skip non-text files
            const ext = '.' + file.path.split('.').pop();
            if (!textExtensions.includes(ext.toLowerCase())) return;
            
            try {
                const lines = file.content.split('\n');
                const fileResults = [];
                
                let match;
                while ((match = regex.exec(file.content)) !== null) {
                    const lineStart = file.content.lastIndexOf('\n', match.index) + 1;
                    const lineNum = file.content.slice(0, lineStart).split('\n').length;
                    
                    const contextBefore = Math.max(0, lineNum - 3);
                    const contextAfter = Math.min(lines.length - 1, lineNum + 2);
                    
                    const context = lines.slice(contextBefore, contextAfter + 1).map((line, idx) => ({
                        lineNum: contextBefore + idx + 1,
                        content: line
                    }));
                    
                    fileResults.push({
                        match: match[0],
                        groups: match.slice(1),
                        index: match.index,
                        lineNum: lineNum,
                        column: match.index - lineStart,
                        context: context
                    });
                    
                    if (match.index === regex.lastIndex) {
                        regex.lastIndex++;
                    }
                    
                    if (fileResults.length >= 10000) break;
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
        });
        
        EventBus.emit('search:complete', results);
    }
    
    /**
     * Replace text in content
     * @param {string} content - Original content
     * @param {string} searchPattern - Pattern to search for
     * @param {string} replacement - Replacement text
     * @param {Object} options - Search options
     */
    replace(content, searchPattern, replacement, options = {}) {
        if (this.worker) {
            this.worker.postMessage({
                type: 'replace',
                id: Date.now().toString(),
                payload: {
                    content: content,
                    searchPattern: searchPattern,
                    replacement: replacement,
                    options: options
                }
            });
        } else {
            // Synchronous replacement
            const result = this.performReplaceSync(content, searchPattern, replacement, options);
            EventBus.emit('search:replaceComplete', result);
        }
    }
    
    performReplaceSync(content, searchPattern, replacement, options) {
        try {
            const flags = options.caseSensitive ? 'gm' : 'gim';
            const regex = new RegExp(searchPattern, flags);
            
            let matchCount = 0;
            const result = content.replace(regex, (match, ...args) => {
                matchCount++;
                let replacementStr = replacement;
                const groups = args.slice(0, -2);
                
                for (let i = 0; i < groups.length; i++) {
                    replacementStr = replacementStr.replace(new RegExp(`\\$${i + 1}`, 'g'), groups[i] || '');
                }
                
                replacementStr = replacementStr.replace(/\$\&/g, match);
                replacementStr = replacementStr.replace(/\$\`/g, args[args.length - 2] || '');
                replacementStr = replacementStr.replace(/\$\'/g, args[args.length - 1] || '');
                
                return replacementStr;
            });
            
            return { success: true, content: result, matchCount };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }
    
    /**
     * Update search configuration
     * @param {Object} config - Configuration options
     */
    updateConfig(config) {
        if (this.worker) {
            this.worker.postMessage({
                type: 'updateConfig',
                id: Date.now().toString(),
                payload: config
            });
        }
    }
    
    /**
     * Add search to history
     */
    addToHistory(pattern, options) {
        const entry = {
            pattern,
            options,
            timestamp: Date.now()
        };
        
        this.searchHistory.unshift(entry);
        
        // Remove duplicates
        this.searchHistory = this.searchHistory.filter((item, index, self) =>
            index === self.findIndex(t => t.pattern === item.pattern)
        );
        
        // Limit history size
        if (this.searchHistory.length > this.maxHistory) {
            this.searchHistory = this.searchHistory.slice(0, this.maxHistory);
        }
        
        // Save to localStorage
        try {
            localStorage.setItem('searchHistory', JSON.stringify(this.searchHistory));
        } catch (e) {
            console.warn('Could not save search history:', e);
        }
        
        EventBus.emit('search:historyUpdated', this.searchHistory);
    }
    
    /**
     * Load search history from localStorage
     */
    loadHistory() {
        try {
            const history = localStorage.getItem('searchHistory');
            if (history) {
                this.searchHistory = JSON.parse(history);
                EventBus.emit('search:historyUpdated', this.searchHistory);
            }
        } catch (e) {
            console.warn('Could not load search history:', e);
        }
    }
    
    /**
     * Clear search history
     */
    clearHistory() {
        this.searchHistory = [];
        try {
            localStorage.removeItem('searchHistory');
        } catch (e) {
            console.warn('Could not clear search history:', e);
        }
        EventBus.emit('search:historyUpdated', this.searchHistory);
    }
    
    /**
     * Cancel current search
     */
    cancelSearch() {
        if (this.worker) {
            this.worker.terminate();
            this.initWorker();
        }
        this.currentSearchId = null;
        EventBus.emit('search:cancelled');
    }
}

// Export instance
window.SearchManager = new SearchManager();