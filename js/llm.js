/**
 * AI Editor - LLM API Client
 * OpenAI-compatible API for chat completions
 */

import { State, EventBus, Storage } from './core.js';

// ============================================
// LLM API CLIENT
// ============================================

const LLM = {
    abortController: null,

    async request(endpoint, data) {
        const url = `${State.settings.llmEndpoint.replace(/\/$/, '')}${endpoint}`;
        
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${State.settings.llmApiKey}`
            },
            body: JSON.stringify(data)
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`LLM API Error: ${response.status} - ${error}`);
        }

        return response;
    },

    // ========================================
    // MODELS
    // ========================================

    async listModels() {
        const url = `${State.settings.llmEndpoint.replace(/\/$/, '')}/models`;
        
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${State.settings.llmApiKey}`
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch models: ${response.status}`);
        }

        const data = await response.json();
        const models = data.data || data.models || data || [];
        
        State.models = Array.isArray(models) 
            ? models.map(m => ({
                id: m.id || m.name || m,
                name: m.id || m.name || m,
                owned_by: m.owned_by || null
            })).sort((a, b) => a.id.localeCompare(b.id))
            : [];

        Storage.set('models', State.models);
        EventBus.emit('llm:modelsLoaded', State.models);
        return State.models;
    },

    // ========================================
    // CHAT COMPLETION
    // ========================================

    async chat(messages, options = {}) {
        const {
            model = State.settings.llmModel,
            stream = true,
            maxTokens = 4096,
            temperature = 0.7,
            tools = null,
            onToken = null
        } = options;

        State.isGenerating = true;
        this.abortController = new AbortController();
        EventBus.emit('llm:generating', true);

        try {
            const requestBody = {
                model,
                messages,
                max_tokens: maxTokens,
                temperature,
                stream
            };

            if (tools) {
                requestBody.tools = tools;
                requestBody.tool_choice = 'auto';
            }

            const response = await fetch(
                `${State.settings.llmEndpoint.replace(/\/$/, '')}/chat/completions`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${State.settings.llmApiKey}`
                    },
                    body: JSON.stringify(requestBody),
                    signal: this.abortController.signal
                }
            );

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`LLM API Error: ${response.status} - ${error}`);
            }

            if (stream) {
                return await this._handleStream(response, onToken);
            } else {
                const data = await response.json();
                return {
                    content: data.choices?.[0]?.message?.content || '',
                    toolCalls: data.choices?.[0]?.message?.tool_calls || null,
                    usage: data.usage
                };
            }

        } finally {
            State.isGenerating = false;
            this.abortController = null;
            EventBus.emit('llm:generating', false);
        }
    },

    async _handleStream(response, onToken) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let content = '';
        let toolCalls = [];

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;

                    try {
                        const parsed = JSON.parse(data);
                        const delta = parsed.choices?.[0]?.delta;
                        
                        if (delta?.content) {
                            content += delta.content;
                            if (onToken) onToken(delta.content, content);
                            EventBus.emit('llm:token', { token: delta.content, content });
                        }

                        if (delta?.tool_calls) {
                            // Accumulate tool calls
                            for (const tc of delta.tool_calls) {
                                if (tc.index !== undefined) {
                                    if (!toolCalls[tc.index]) {
                                        toolCalls[tc.index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                                    }
                                    if (tc.id) toolCalls[tc.index].id = tc.id;
                                    if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
                                    if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
                                }
                            }
                        }
                    } catch (e) {
                        // Skip invalid JSON
                    }
                }
            }
        }

        return {
            content,
            toolCalls: toolCalls.length > 0 ? toolCalls : null
        };
    },

    stop() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        State.isGenerating = false;
        EventBus.emit('llm:stopped');
    }
};

// ============================================
// EDITOR-SPECIFIC PROMPTS
// ============================================

const EditorPrompts = {
    systemPrompt: `You are an AI coding assistant integrated into a code editor. You help users write, edit, and understand code.

You have access to tools that let you:
- Read the current file open in the editor (read_current_file) - returns full content with line count
- Make surgical edits to specific lines (replace_lines, insert_lines, delete_lines) - ALWAYS prefer these over full file replacement
- Query the project file tree (get_project_tree)
- Open specific files in the editor (open_file)
- Read any file's content without opening it (read_file)
- List all open tabs (list_open_tabs)

IMPORTANT EDITING RULES:
1. ALWAYS use read_current_file FIRST to see the current content and line count
2. Use replace_lines for modifying existing code - specify exact line numbers
3. Use insert_lines to add new code without replacing existing lines
4. Use delete_lines to remove code
5. NEVER try to replace the entire file at once - make targeted edits
6. After editing, explain what lines you changed

When working on issues or tasks:
1. Use get_project_tree to understand the project structure
2. Use open_file to navigate to relevant files
3. Use read_file to examine related code without switching tabs

Current context:
- Project: {{project}}
- File: {{file}}
- Branch: {{branch}}
{{issues}}`,

    editPrompt: `The user wants you to edit the following file.

File: {{file}}
\`\`\`{{language}}
{{content}}
\`\`\`

User request: {{request}}

Respond with the complete updated file content in a code block, followed by a brief explanation of your changes.`,

    commitMessagePrompt: `Generate a concise git commit message for the following changes.

File: {{file}}

Original content:
\`\`\`
{{original}}
\`\`\`

New content:
\`\`\`
{{updated}}
\`\`\`

Respond with ONLY the commit message, no quotes or explanation. Use conventional commit format (feat:, fix:, refactor:, docs:, etc).`,

    issueAnalysisPrompt: `Analyze this issue and suggest an implementation approach.

Issue #{{number}}: {{title}}

{{body}}

Consider:
1. Which files might need to be modified
2. A high-level implementation approach
3. Potential edge cases or concerns
4. Estimated complexity (simple/medium/complex)`
};

function buildSystemPrompt() {
    let prompt = EditorPrompts.systemPrompt;
    
    if (State.currentProject) {
        prompt = prompt.replace('{{project}}', `${State.currentProject.owner}/${State.currentProject.repo}`);
    } else {
        prompt = prompt.replace('{{project}}', 'None selected');
    }
    
    if (State.currentFile) {
        prompt = prompt.replace('{{file}}', State.currentFile.path);
    } else {
        prompt = prompt.replace('{{file}}', 'None');
    }
    
    prompt = prompt.replace('{{branch}}', State.currentBranch || 'main');
    
    // Add open issues context if available
    if (State.issues && State.issues.length > 0) {
        const issuesSummary = State.issues.slice(0, 10).map(i => 
            `  #${i.number}: ${i.title}${i.labels.length ? ` [${i.labels.join(', ')}]` : ''}`
        ).join('\n');
        prompt = prompt.replace('{{issues}}', `\nOpen issues:\n${issuesSummary}`);
    } else {
        prompt = prompt.replace('{{issues}}', '');
    }
    
    return prompt;
}

function buildEditPrompt(request) {
    if (!State.currentFile) {
        throw new Error('No file selected');
    }

    const language = getLanguageFromPath(State.currentFile.path);
    
    return EditorPrompts.editPrompt
        .replace('{{file}}', State.currentFile.path)
        .replace('{{language}}', language)
        .replace('{{content}}', State.editorContent)
        .replace('{{request}}', request);
}

function buildCommitMessagePrompt(original, updated) {
    return EditorPrompts.commitMessagePrompt
        .replace('{{file}}', State.currentFile?.path || 'unknown')
        .replace('{{original}}', original)
        .replace('{{updated}}', updated);
}

function getLanguageFromPath(path) {
    const ext = path.split('.').pop().toLowerCase();
    const langMap = {
        'js': 'javascript',
        'ts': 'typescript',
        'py': 'python',
        'go': 'go',
        'rs': 'rust',
        'rb': 'ruby',
        'java': 'java',
        'c': 'c',
        'cpp': 'cpp',
        'h': 'c',
        'hpp': 'cpp',
        'cs': 'csharp',
        'php': 'php',
        'swift': 'swift',
        'kt': 'kotlin',
        'scala': 'scala',
        'r': 'r',
        'sh': 'bash',
        'bash': 'bash',
        'zsh': 'bash',
        'ps1': 'powershell',
        'sql': 'sql',
        'html': 'html',
        'css': 'css',
        'scss': 'scss',
        'less': 'less',
        'json': 'json',
        'yaml': 'yaml',
        'yml': 'yaml',
        'toml': 'toml',
        'xml': 'xml',
        'md': 'markdown',
        'markdown': 'markdown',
        'dockerfile': 'dockerfile',
        'makefile': 'makefile'
    };
    return langMap[ext] || ext;
}

// ============================================
// LLM TOOLS DEFINITIONS
// ============================================

const LLMTools = {
    // Tool definitions for function calling
    definitions: [
        {
            type: 'function',
            function: {
                name: 'read_current_file',
                description: 'Read the content of the currently open file in the editor. Returns the full file content, path, and line count.',
                parameters: {
                    type: 'object',
                    properties: {},
                    required: []
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'replace_lines',
                description: 'Replace specific lines in the current file. Use this for targeted edits instead of replacing the whole file. Line numbers are 1-indexed.',
                parameters: {
                    type: 'object',
                    properties: {
                        start_line: {
                            type: 'integer',
                            description: 'First line to replace (1-indexed, inclusive)'
                        },
                        end_line: {
                            type: 'integer', 
                            description: 'Last line to replace (1-indexed, inclusive). Use same as start_line to replace single line.'
                        },
                        new_content: {
                            type: 'string',
                            description: 'The new content to insert (can be multiple lines)'
                        }
                    },
                    required: ['start_line', 'end_line', 'new_content']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'insert_lines',
                description: 'Insert new lines at a specific position in the current file without replacing existing content.',
                parameters: {
                    type: 'object',
                    properties: {
                        after_line: {
                            type: 'integer',
                            description: 'Insert after this line number (0 to insert at beginning, 1-indexed)'
                        },
                        content: {
                            type: 'string',
                            description: 'The content to insert (can be multiple lines)'
                        }
                    },
                    required: ['after_line', 'content']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'delete_lines',
                description: 'Delete specific lines from the current file.',
                parameters: {
                    type: 'object',
                    properties: {
                        start_line: {
                            type: 'integer',
                            description: 'First line to delete (1-indexed, inclusive)'
                        },
                        end_line: {
                            type: 'integer',
                            description: 'Last line to delete (1-indexed, inclusive)'
                        }
                    },
                    required: ['start_line', 'end_line']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'get_project_tree',
                description: 'Get the file tree structure of the current project',
                parameters: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: 'Optional path to filter files (e.g., "src/" to only list files in src directory)'
                        }
                    },
                    required: []
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'open_file',
                description: 'Open a specific file from the project in the editor',
                parameters: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: 'The path to the file to open (e.g., "src/main.js")'
                        }
                    },
                    required: ['path']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'read_file',
                description: 'Read the content of a specific file without opening it in the editor',
                parameters: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: 'The path to the file to read'
                        }
                    },
                    required: ['path']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'list_open_tabs',
                description: 'List all currently open tabs in the editor',
                parameters: {
                    type: 'object',
                    properties: {},
                    required: []
                }
            }
        }
    ],

    // Tool execution handlers - these will be connected to the actual implementations
    handlers: {}
};

// ============================================
// HIGH-LEVEL FUNCTIONS
// ============================================

async function generateEdit(request, onToken = null) {
    const systemPrompt = buildSystemPrompt();
    const editPrompt = buildEditPrompt(request);

    const messages = [
        { role: 'system', content: systemPrompt },
        ...State.chatHistory.slice(-10), // Include recent context
        { role: 'user', content: editPrompt }
    ];

    const result = await LLM.chat(messages, { 
        stream: true, 
        onToken 
    });

    // Try to extract code from response
    const codeMatch = result.content.match(/```[\w]*\n([\s\S]*?)```/);
    if (codeMatch) {
        return {
            code: codeMatch[1].trim(),
            explanation: result.content.replace(codeMatch[0], '').trim(),
            raw: result.content
        };
    }

    return {
        code: null,
        explanation: result.content,
        raw: result.content
    };
}

async function generateCommitMessage(changedFiles = null) {
    // Build a prompt that covers all changed files
    let prompt;
    
    if (changedFiles && changedFiles.length > 0) {
        // Multi-file commit message
        const fileDiffs = changedFiles.map(f => {
            const original = (f.originalContent || '').slice(0, 2000);
            const updated = (f.content || '').slice(0, 2000);
            return `File: ${f.path}\n\nOriginal (truncated):\n\`\`\`\n${original}\n\`\`\`\n\nUpdated (truncated):\n\`\`\`\n${updated}\n\`\`\``;
        }).join('\n\n---\n\n');
        
        prompt = `Generate a concise git commit message for the following changes across ${changedFiles.length} file(s).

${fileDiffs}

Respond with ONLY the commit message, no quotes or explanation. Use conventional commit format (feat:, fix:, refactor:, docs:, etc). If multiple files changed, summarize the overall change.`;
    } else if (State.currentFile) {
        prompt = buildCommitMessagePrompt(
            State.currentFile.content,
            State.editorContent
        );
    } else {
        return 'Update files';
    }

    // Use commit model if configured, otherwise fall back to default
    const commitModel = State.settings.commitModel || State.settings.llmModel;

    const result = await LLM.chat([
        { role: 'user', content: prompt }
    ], { 
        stream: false,
        temperature: 0.3,
        maxTokens: 150,
        model: commitModel
    });

    return result.content.trim().replace(/^["']|["']$/g, '');
}

async function analyzeIssue(issue, onToken = null) {
    const prompt = EditorPrompts.issueAnalysisPrompt
        .replace('{{number}}', issue.number)
        .replace('{{title}}', issue.title)
        .replace('{{body}}', issue.body);

    const systemPrompt = buildSystemPrompt();

    const result = await LLM.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
    ], {
        stream: true,
        onToken
    });

    return result.content;
}

// ============================================
// EXPORTS
// ============================================

export {
    LLM,
    LLMTools,
    EditorPrompts,
    buildSystemPrompt,
    generateEdit,
    generateCommitMessage,
    analyzeIssue,
    getLanguageFromPath
};