/**
 * Search Web Worker
 * Handles intensive search operations without blocking UI
 */

// Search configuration
let config = {
    excludePatterns: ['node_modules', '.git', '.svn', '.hg', '__pycache__', '*.min.js', '*.css', '*.map'],
    maxFileSize: 1024 * 1024, // 1MB max file size for searching
    maxResults: 10000
};

// Build regex for exclusion patterns
function buildExcludeRegex(patterns) {
    const escaped = patterns.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\.'));
    return new RegExp(`(${escaped.join('|')})`, 'i');
}

let excludeRegex = buildExcludeRegex(config.excludePatterns);

// Search a single file content
function searchInContent(content, searchPattern, options) {
    const results = [];
    
    try {
        const flags = options.caseSensitive ? 'gm' : 'gim';
        const regex = new RegExp(searchPattern, flags);
        
        let match;
        const lines = content.split('\n');
        
        while ((match = regex.exec(content)) !== null) {
            // Find line number
            const lineStart = content.lastIndexOf('\n', match.index) + 1;
            const lineEnd = content.indexOf('\n', match.index);
            const lineNum = content.slice(0, lineStart).split('\n').length;
            
            // Get context (lines before and after)
            const contextBefore = Math.max(0, lineNum - 3);
            const contextAfter = Math.min(lines.length - 1, lineNum + 2);
            
            const context = lines.slice(contextBefore, contextAfter + 1).map((line, idx) => ({
                lineNum: contextBefore + idx + 1,
                content: line
            }));
            
            results.push({
                match: match[0],
                groups: match.slice(1),
                index: match.index,
                lineNum: lineNum,
                column: match.index - lineStart,
                context: context
            });
            
            // Prevent infinite loops with zero-length matches
            if (match.index === regex.lastIndex) {
                regex.lastIndex++;
            }
            
            if (results.length >= config.maxResults) {
                break;
            }
        }
    } catch (e) {
        results.push({
            error: e.message,
            pattern: searchPattern
        });
    }
    
    return results;
}

// Replace matches in content
function replaceInContent(content, searchPattern, replacement, options) {
    try {
        const flags = options.caseSensitive ? 'gm' : 'gim';
        const regex = new RegExp(searchPattern, flags);
        
        let result = content;
        let matchCount = 0;
        
        result = result.replace(regex, (match, ...args) => {
            matchCount++;
            
            // Handle replacement with regex groups
            if (typeof replacement === 'function') {
                return replacement(match, ...args);
            }
            
            // String replacement with $1, $2, etc.
            let replacementStr = replacement;
            const groups = args.slice(0, -2); // Last two args are offset and string
            
            for (let i = 0; i < groups.length; i++) {
                replacementStr = replacementStr.replace(new RegExp(`\\$${i + 1}`, 'g'), groups[i] || '');
            }
            
            // Handle $& (matched string)
            replacementStr = replacementStr.replace(/\$\&/g, match);
            
            // Handle $` (before match)
            replacementStr = replacementStr.replace(/\$\`/g, args[args.length - 2] || '');
            
            // Handle $' (after match)
            replacementStr = replacementStr.replace(/\$\'/g, args[args.length - 1] || '');
            
            return replacementStr;
        });
        
        return {
            success: true,
            content: result,
            matchCount: matchCount
        };
    } catch (e) {
        return {
            success: false,
            error: e.message
        };
    }
}

// Search across multiple files
async function searchInFiles(files, searchPattern, options) {
    const results = {
        files: {},
        totalFiles: files.length,
        totalMatches: 0,
        errors: []
    };
    
    for (const file of files) {
        // Skip excluded files
        if (excludeRegex.test(file.path)) {
            continue;
        }
        
        // Skip binary/large files
        if (file.size > config.maxFileSize) {
            continue;
        }
        
        // Skip non-text files based on extension
        const textExtensions = ['.md', '.txt', '.json', '.xml', '.html', '.css', '.js', '.ts', '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.rb', '.php', '.go', '.rs', '.swift', '.kt', '.scala', '.yml', '.yaml', '.ini', '.conf', '.sh', '.bash', '.zsh', '.fish', '.sql', '.vue', '.svelte', '.jsx', '.tsx'];
        const ext = '.' + file.path.split('.').pop();
        if (!textExtensions.includes(ext.toLowerCase())) {
            continue;
        }
        
        try {
            const fileResults = searchInContent(file.content, searchPattern, options);
            
            if (fileResults.length > 0 && !fileResults[0]?.error) {
                results.files[file.path] = {
                    path: file.path,
                    matches: fileResults,
                    matchCount: fileResults.length
                };
                results.totalMatches += fileResults.length;
            }
        } catch (e) {
            results.errors.push({
                file: file.path,
                error: e.message
            });
        }
        
        // Send progress update
        self.postMessage({
            type: 'progress',
            current: results.totalFiles - files.length + 1,
            total: results.totalFiles
        });
    }
    
    return results;
}

// Message handler
self.onmessage = async function(e) {
    const { type, payload, id } = e.data;
    
    switch (type) {
        case 'search':
            try {
                const results = await searchInFiles(
                    payload.files,
                    payload.pattern,
                    payload.options
                );
                self.postMessage({
                    type: 'searchComplete',
                    id: id,
                    results: results
                });
            } catch (e) {
                self.postMessage({
                    type: 'error',
                    id: id,
                    error: e.message
                });
            }
            break;
            
        case 'replace':
            try {
                const result = replaceInContent(
                    payload.content,
                    payload.searchPattern,
                    payload.replacement,
                    payload.options
                );
                self.postMessage({
                    type: 'replaceComplete',
                    id: id,
                    result: result
                });
            } catch (e) {
                self.postMessage({
                    type: 'error',
                    id: id,
                    error: e.message
                });
            }
            break;
            
        case 'updateConfig':
            config = { ...config, ...payload };
            excludeRegex = buildExcludeRegex(config.excludePatterns);
            self.postMessage({
                type: 'configUpdated',
                id: id
            });
            break;
            
        default:
            self.postMessage({
                type: 'error',
                id: id,
                error: `Unknown message type: ${type}`
            });
    }
};