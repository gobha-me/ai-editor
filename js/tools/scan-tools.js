/**
 * AI Editor - Scan Tools
 * Efficient code navigation: scan structure, then fetch specifics
 * Reduces token usage by 85-97% compared to reading full files
 */

import { State } from '../core.js';
import { Git } from '../git.js';
import { EditTracker } from './edit-tracker.js';
import { IgnoreManager } from '../ignore.js';
import { resolveFileContent } from './_file-content.js';

/**
 * Find the end of a function by matching braces
 * @param {string[]} lines - File lines
 * @param {number} startLine - Line where function starts
 * @returns {number} Line number where function ends
 */
function findFunctionEnd(lines, startLine) {
    let braceCount = 0;
    let inFunction = false;
    
    for (let i = startLine; i < lines.length; i++) {
        const line = lines[i];
        
        // Count braces
        for (const char of line) {
            if (char === '{') {
                braceCount++;
                inFunction = true;
            } else if (char === '}') {
                braceCount--;
                if (inFunction && braceCount === 0) {
                    return i;
                }
            }
        }
    }
    
    return lines.length - 1;
}

/**
 * Extract a short signature/initializer for a const declaration
 * @param {string[]} lines - File lines
 * @param {number} startLine - Line where const is declared
 * @returns {string|null} Signature or null
 */
function extractSignature(lines, startLine) {
    const line = lines[startLine];
    
    // Extract everything after the = sign
    const match = line.match(/=\s*(.+)/);
    if (!match) return null;
    
    let sig = match[1].trim();
    
    // If it's a single-line value, use it
    if (!sig.endsWith('{') && !sig.endsWith('(')) {
        return sig.length > 60 ? sig.substring(0, 60) + '...' : sig;
    }
    
    // For objects/functions, show just the start
    if (sig.startsWith('{')) {
        // Collect until we find the closing brace or hit reasonable length
        let collected = sig;
        for (let i = startLine + 1; i < Math.min(startLine + 3, lines.length); i++) {
            collected += ' ' + lines[i].trim();
            if (collected.includes('}')) break;
        }
        return collected.length > 80 ? collected.substring(0, 80) + '...' : collected;
    }
    
    return sig.length > 60 ? sig.substring(0, 60) + '...' : sig;
}

/**
 * Register all scan-related tools.
 * @param {Object} registry - ToolRegistry instance
 */
export function registerScanTools(registry) {
    
    // ========================================
    // scan_file - Get file outline
    // ========================================
    registry.register('scan_file', async ({ path, include_signatures = true }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }

        const branch = State.currentBranch || 'main';

        try {
            // 1.6.8 follow-up — buffer-aware read; see _file-content.js docstring.
            const { content } = await resolveFileContent(path);
            const lines = content.split('\n');
            
            const outline = [];
            
            // Determine language from extension
            const ext = path.split('.').pop().toLowerCase();
            
            if (ext === 'js' || ext === 'ts' || ext === 'jsx' || ext === 'tsx') {
                // JavaScript/TypeScript patterns
                const functionPattern = /^\s*(export\s+)?(async\s+)?function\s+(\w+)\s*\((.*?)\)/;
                const arrowPattern = /^\s*(export\s+)?const\s+(\w+)\s*=\s*(async\s*)?\((.*?)\)\s*=>/;
                const constPattern = /^\s*(export\s+)?const\s+(\w+)\s*=/;
                const classPattern = /^\s*(export\s+)?class\s+(\w+)/;
                
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    
                    // Match function declarations
                    let match = line.match(functionPattern);
                    if (match) {
                        const name = match[3];
                        const params = match[4];
                        const isAsync = !!match[2];
                        const isExport = !!match[1];
                        const endLine = findFunctionEnd(lines, i);
                        outline.push({
                            line: i + 1,
                            type: 'function',
                            name,
                            params: `(${params})`,
                            lines: endLine - i + 1,
                            async: isAsync,
                            export: isExport
                        });
                        continue;
                    }
                    
                    // Match arrow functions
                    match = line.match(arrowPattern);
                    if (match) {
                        const name = match[2];
                        const params = match[4];
                        const isAsync = !!match[3];
                        const isExport = !!match[1];
                        const endLine = findFunctionEnd(lines, i);
                        outline.push({
                            line: i + 1,
                            type: 'function',
                            name,
                            params: `(${params})`,
                            lines: endLine - i + 1,
                            async: isAsync,
                            export: isExport
                        });
                        continue;
                    }
                    
                    // Match const declarations (non-arrow)
                    match = line.match(constPattern);
                    if (match && !line.includes('=>')) {
                        const name = match[2];
                        const isExport = !!match[1];
                        const signature = include_signatures ? extractSignature(lines, i) : null;
                        outline.push({
                            line: i + 1,
                            type: 'const',
                            name,
                            signature,
                            export: isExport
                        });
                        continue;
                    }
                    
                    // Match classes
                    match = line.match(classPattern);
                    if (match) {
                        const name = match[2];
                        const isExport = !!match[1];
                        const endLine = findFunctionEnd(lines, i);
                        outline.push({
                            line: i + 1,
                            type: 'class',
                            name,
                            lines: endLine - i + 1,
                            export: isExport
                        });
                        continue;
                    }
                }
            } else if (ext === 'py') {
                // Python patterns
                const defPattern = /^\s*def\s+(\w+)\s*\((.*?)\)/;
                const classPattern = /^\s*class\s+(\w+)/;
                
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    
                    // Match function definitions
                    let match = line.match(defPattern);
                    if (match) {
                        const name = match[1];
                        const params = match[2];
                        // Find end by indentation
                        let endLine = i;
                        const indent = line.match(/^\s*/)[0].length;
                        for (let j = i + 1; j < lines.length; j++) {
                            const nextLine = lines[j];
                            if (nextLine.trim() === '') continue;
                            const nextIndent = nextLine.match(/^\s*/)[0].length;
                            if (nextIndent <= indent) {
                                endLine = j - 1;
                                break;
                            }
                            endLine = j;
                        }
                        outline.push({
                            line: i + 1,
                            type: 'function',
                            name,
                            params: `(${params})`,
                            lines: endLine - i + 1
                        });
                        continue;
                    }
                    
                    // Match class definitions
                    match = line.match(classPattern);
                    if (match) {
                        const name = match[1];
                        outline.push({
                            line: i + 1,
                            type: 'class',
                            name
                        });
                    }
                }
            }
            
            return {
                path,
                line_count: lines.length,
                size_bytes: content.length,
                language: ext,
                outline
            };
        } catch (error) {
            if (error.status === 404) {
                return { error: `File not found: '${path}' does not exist on branch '${branch}'. Use get_project_tree to see available files.` };
            }
            return { error: `Failed to scan file '${path}': ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'scan_file',
            description: '**Required:** path. Get file outline (functions, classes, exports) without reading full content. Use this BEFORE read_file to understand file structure. Returns line numbers, names, and signatures. Saves 97% tokens vs reading full file.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'File path to scan (e.g., "js/chat.js")'
                    },
                    include_signatures: {
                        type: 'boolean',
                        description: 'Include type signatures/initializers for const declarations (default: true)'
                    }
                },
                required: ['path']
            }
        },
        readOnly: true
    });

    // ========================================
    // read_function - Fetch specific function
    // ========================================
    registry.register('read_function', async ({ path, name }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        
        const { owner, repo } = State.currentProject;
        const branch = State.currentBranch || 'main';
        
        try {
            const file = await Git.getFile(owner, repo, path, branch);
            const lines = file.content.split('\n');
            
            // Search for function by name (case-sensitive)
            // Match various patterns: function name, const name, class name
            const patterns = [
                new RegExp(`^\\s*function\\s+${name}\\s*\\(`),
                new RegExp(`^\\s*const\\s+${name}\\s*=`),
                new RegExp(`^\\s*export\\s+function\\s+${name}\\s*\\(`),
                new RegExp(`^\\s*export\\s+const\\s+${name}\\s*=`),
                new RegExp(`^\\s*class\\s+${name}`),
                new RegExp(`^\\s*export\\s+class\\s+${name}`),
                new RegExp(`^\\s*def\\s+${name}\\s*\\(`)  // Python
            ];
            
            let startLine = -1;
            for (let i = 0; i < lines.length; i++) {
                for (const pattern of patterns) {
                    if (pattern.test(lines[i])) {
                        startLine = i;
                        break;
                    }
                }
                if (startLine !== -1) break;
            }
            
            if (startLine === -1) {
                return { 
                    error: `Function '${name}' not found in ${path}`,
                    suggestion: 'Use scan_file to see available functions'
                };
            }
            
            // Find end of function
            const endLine = findFunctionEnd(lines, startLine);
            
            // Extract function content
            const content = lines.slice(startLine, endLine + 1).join('\n');
            
            // Extract parameters if possible
            const firstLine = lines[startLine];
            const paramMatch = firstLine.match(/\((.*?)\)/);
            const params = paramMatch ? paramMatch[1] : '';
            
            return {
                path,
                function: name,
                start_line: startLine + 1,
                end_line: endLine + 1,
                lines: endLine - startLine + 1,
                params: `(${params})`,
                content
            };
        } catch (error) {
            if (error.status === 404) {
                return { error: `File not found: '${path}' does not exist on branch '${branch}'. Use get_project_tree to see available files.` };
            }
            return { error: `Failed to read function '${name}' from '${path}': ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'read_function',
            description: '**Required:** name, path. Read just one function/class by name from a file. Much more efficient than reading entire file. Use scan_file first to find function names and locations. Saves 89% tokens vs reading full file.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'File path containing the function'
                    },
                    name: {
                        type: 'string',
                        description: 'Function/class name to read (case-sensitive)'
                    }
                },
                required: ['path', 'name']
            }
        },
        readOnly: true
    });

    // ========================================
    // find_references - Locate symbol usage
    // ========================================
    registry.register('find_references', async ({ symbol, scope = '', max_files = 30, max_references = 100 }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        
        const { owner, repo } = State.currentProject;
        const branch = State.currentBranch || 'main';
        
        try {
            // Filter files by scope
            let files = State.fileTree.filter(f => f.type !== 'dir');
            if (scope) {
                files = files.filter(f => f.path.startsWith(scope));
            }
            files = files.filter(f => !IgnoreManager.isIgnored(f.path, f.size));
            
            // Only search text files
            const textExts = new Set([
                'js', 'ts', 'jsx', 'tsx', 'py', 'go', 'rs', 'c', 'cpp', 'h', 'hpp',
                'java', 'rb', 'php', 'css', 'scss', 'html', 'htm', 'xml', 'json',
                'yaml', 'yml', 'toml', 'md', 'txt', 'sh', 'bash', 'sql', 'vue',
                'svelte', 'conf', 'cfg', 'ini', 'pl', 'pm'
            ]);
            files = files.filter(f => {
                const ext = f.path.split('.').pop().toLowerCase();
                return textExts.has(ext);
            });
            
            const totalFiles = files.length;
            const definitions = [];
            const references = [];
            
            // Patterns for detecting definitions vs references
            const defPatterns = [
                new RegExp(`^\\s*function\\s+${symbol}\\s*\\(`),
                new RegExp(`^\\s*const\\s+${symbol}\\s*=`),
                new RegExp(`^\\s*let\\s+${symbol}\\s*=`),
                new RegExp(`^\\s*var\\s+${symbol}\\s*=`),
                new RegExp(`^\\s*class\\s+${symbol}`),
                new RegExp(`^\\s*export\\s+function\\s+${symbol}\\s*\\(`),
                new RegExp(`^\\s*export\\s+const\\s+${symbol}\\s*=`),
                new RegExp(`^\\s*export\\s+class\\s+${symbol}`),
                new RegExp(`^\\s*def\\s+${symbol}\\s*\\(`)  // Python
            ];
            
            let totalReferences = 0;
            let filesSearched = 0;
            
            // Search up to max_files
            for (const file of files.slice(0, max_files)) {
                try {
                    const fileData = await Git.getFile(owner, repo, file.path, branch);
                    const lines = fileData.content.split('\n');
                    filesSearched++;
                    
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        
                        // Check if line contains the symbol
                        if (!line.includes(symbol)) continue;
                        
                        // Determine if it's a definition or reference
                        const isDef = defPatterns.some(p => p.test(line));
                        
                        const entry = {
                            path: file.path,
                            line: i + 1,
                            context: line.trim().substring(0, 100)
                        };
                        
                        if (isDef) {
                            definitions.push(entry);
                        } else {
                            totalReferences++;
                            if (references.length < max_references) {
                                references.push(entry);
                            }
                        }
                    }
                } catch (e) {
                    // Skip unreadable files
                }
            }
            
            const result = {
                symbol,
                scope: scope || '(all files)',
                total_files_in_scope: totalFiles,
                files_searched: filesSearched,
                definitions,
                references,
                total_references: totalReferences
            };
            
            // Add truncation warnings if applicable
            if (filesSearched < totalFiles) {
                result.warning = `Only searched ${filesSearched} of ${totalFiles} files. Use 'scope' parameter to narrow search or increase max_files.`;
            }
            
            if (totalReferences > max_references) {
                result.references_truncated = true;
                result.warning = (result.warning || '') + ` Found ${totalReferences} references but only showing ${max_references}. Use 'scope' to narrow search or increase max_references.`;
            }
            
            return result;
        } catch (error) {
            return { error: `Failed to find references for '${symbol}': ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'find_references',
            description: '**Required:** symbol. Find all definitions and usages of a function/variable/class. Returns line numbers and context. Searches up to max_files (default 30) and returns up to max_references (default 100). Use scope parameter to narrow search.',
            parameters: {
                type: 'object',
                properties: {
                    symbol: {
                        type: 'string',
                        description: 'Symbol name to find (function, variable, class)'
                    },
                    scope: {
                        type: 'string',
                        description: 'Optional directory prefix to limit search (e.g., "js/")'
                    },
                    max_files: {
                        type: 'integer',
                        description: 'Maximum files to search (default: 30)'
                    },
                    max_references: {
                        type: 'integer',
                        description: 'Maximum references to return (default: 100)'
                    }
                },
                required: ['symbol']
            }
        },
        readOnly: true,
        // Aggregates across all text files matching scope. Any
        // file mutation between calls invalidates the reference set;
        // the path-keyed cache can't match the no-path argument shape.
        // Same shape as gitea#472.
        cache: 'never',
    });

    // ========================================
    // read_lines - Read specific line range
    // ========================================
    registry.register('read_lines', async ({ path, start_line, end_line, context_lines = 0 }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }

        // 2.15.1 — coerce at boundary. Some models JSON-encode ints as strings
        // ("85" rather than 85); without this, `end_line < start_line` does
        // lexicographic comparison ("105" < "85" → true) and traps the model
        // in a shrinking-range loop that no value can escape.
        const start_num = Number(start_line);
        const end_num   = Number(end_line);
        const ctx_num   = Number(context_lines);
        if (!Number.isFinite(start_num) || !Number.isFinite(end_num) || !Number.isFinite(ctx_num)) {
            return { error: `start_line, end_line, and context_lines must be numbers (got start=${JSON.stringify(start_line)}, end=${JSON.stringify(end_line)}, ctx=${JSON.stringify(context_lines)})` };
        }

        const branch = State.currentBranch || 'main';

        try {
            // 1.6.8 follow-up — buffer-aware read; see _file-content.js docstring.
            const { content, source } = await resolveFileContent(path);

            const lines = content.split('\n');

            // Validate line numbers
            const start = Math.max(1, start_num - ctx_num);
            const end = Math.min(lines.length, end_num + ctx_num);

            if (start_num < 1 || start_num > lines.length) {
                return { error: `Invalid start_line: ${start_num} (file has ${lines.length} lines)` };
            }

            if (end_num < start_num || end_num > lines.length) {
                return { error: `Invalid end_line: ${end_num} (must be between ${start_num} and ${lines.length})` };
            }

            // Extract lines (convert to 0-indexed)
            const extractedLines = lines.slice(start - 1, end);
            const resultContent = extractedLines.join('\n');

            // Track this read for drift detection
            EditTracker.recordRead(path, start, end, lines.length);

            return {
                path,
                start_line: start,
                end_line: end,
                requested_start: start_num,
                requested_end: end_num,
                context_lines: ctx_num,
                line_count: lines.length,
                content: resultContent,
                source  // 'editor' | 'tab' | 'remote' — helps debug state issues
            };
        } catch (error) {
            if (error.status === 404) {
                return { error: `File not found: '${path}' does not exist on branch '${branch}'. Use get_project_tree to see available files.` };
            }
            return { error: `Failed to read lines from '${path}': ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'read_lines',
            description: '**Required:** path, start_line, end_line. Read specific line range from a file. Buffer-aware: prefers the active editor buffer, then any open tab\'s saved content (so dirty edits made via prior edit_file calls on other tabs are visible), then falls back to the remote repository. Perfect for examining code around a reference found by find_references or scan_file. Much more efficient than reading entire file.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'File path to read from'
                    },
                    start_line: {
                        type: 'integer',
                        description: 'First line to read (1-indexed). Also accepts: start.'
                    },
                    end_line: {
                        type: 'integer',
                        description: 'Last line to read (1-indexed). Also accepts: end.'
                    },
                    context_lines: {
                        type: 'integer',
                        description: 'Number of additional lines to include before/after range (default: 0)'
                    }
                },
                required: ['path', 'start_line', 'end_line']
            }
        },
        readOnly: true
    });
}
