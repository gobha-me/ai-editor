/**
 * AI Editor - LLM API Client
 * OpenAI-compatible API for chat completions
 */

import { State, EventBus, Storage, Providers, Roles } from './core.js';

// ============================================
// LLM DEBUG LOGGER
// ============================================

/**
 * Ring-buffer debug logger. Captures raw SSE data, parsed deltas,
 * think-block filter decisions, and final results for every LLM exchange.
 * Zero impact on control flow — pure observation.
 */
const LLMDebug = {
    exchanges: [],
    maxExchanges: 30,
    _current: null,

    /** Start recording a new exchange */
    startExchange(requestBody) {
        const ex = {
            id: Date.now(),
            ts: new Date().toISOString(),
            model: requestBody.model,
            stream: requestBody.stream,
            toolsSent: requestBody.tools?.length || 0,
            msgCount: requestBody.messages?.length || 0,
            messages: requestBody.messages?.map(m => ({
                role: m.role,
                preview: typeof m.content === 'string'
                    ? m.content.slice(0, 200) + (m.content.length > 200 ? '…' : '')
                    : m.content === null ? '<null>' : '<array>',
                hasToolCalls: !!m.tool_calls,
                toolCallId: m.tool_call_id || null
            })),
            chunks: [],       // raw SSE data lines + parsed summaries
            thinkEvents: [],  // think-block filter decisions
            result: null,
            error: null,
            durationMs: null
        };
        this._current = ex;
        this.exchanges.push(ex);
        if (this.exchanges.length > this.maxExchanges) this.exchanges.shift();
        EventBus.emit('debug:exchange', ex);
        return ex;
    },

    /** Log one raw SSE data line + what we parsed from it */
    logChunk(rawData, parsed) {
        if (!this._current) return;
        if (this._current.chunks.length >= 500) {
            if (this._current.chunks.length === 500)
                this._current.chunks.push({ raw: '--- TRUNCATED ---', parsed: null });
            return;
        }
        this._current.chunks.push({ raw: rawData, parsed });
    },

    /** Log a think-block filter decision */
    logThink(event, detail) {
        if (!this._current) return;
        this._current.thinkEvents.push({
            event, detail,
            atChunk: this._current.chunks.length
        });
    },

    /** Finalize with result */
    endExchange(result) {
        if (!this._current) return;
        this._current.result = {
            contentLen: result.content?.length || 0,
            contentPreview: (result.content || '').slice(0, 500),
            toolCalls: result.toolCalls ? result.toolCalls.map(tc => ({
                id: tc.id,
                name: tc.function?.name,
                argsPreview: (tc.function?.arguments || '').slice(0, 300)
            })) : null,
            finishReason: result.finishReason || null,
            usage: result.usage
        };
        this._current.durationMs = Date.now() - this._current.id;
        const done = this._current;
        this._current = null;
        EventBus.emit('debug:exchangeDone', done);
    },

    /** Log an error */
    logError(err) {
        if (!this._current) return;
        this._current.error = err.message || String(err);
        this._current.durationMs = Date.now() - this._current.id;
        this._current = null;
    },

    clear() {
        this.exchanges = [];
        this._current = null;
        EventBus.emit('debug:cleared');
    },

    /** Full text export of all exchanges */
    exportText() {
        return this.exchanges.map(ex => {
            const L = [];
            L.push(`=== ${ex.ts} | ${ex.model} | ${ex.stream ? 'stream' : 'non-stream'} | tools_sent:${ex.toolsSent} | msgs:${ex.msgCount} | ${ex.durationMs}ms ===`);
            L.push('');
            L.push('--- REQUEST MESSAGES ---');
            for (const m of (ex.messages || [])) {
                let d = `  [${m.role}]`;
                if (m.hasToolCalls) d += ' +tool_calls';
                if (m.toolCallId) d += ` tool_call_id=${m.toolCallId}`;
                d += ` ${m.preview}`;
                L.push(d);
            }
            L.push('');
            L.push(`--- RAW SSE CHUNKS (${ex.chunks.length}) ---`);
            for (let i = 0; i < ex.chunks.length; i++) {
                const c = ex.chunks[i];
                L.push(`[${i}] ${c.raw}`);
                if (c.parsed) L.push(`     → ${JSON.stringify(c.parsed)}`);
            }
            if (ex.thinkEvents.length > 0) {
                L.push('');
                L.push(`--- THINK EVENTS (${ex.thinkEvents.length}) ---`);
                for (const t of ex.thinkEvents) {
                    L.push(`  @chunk${t.atChunk} ${t.event}: ${t.detail}`);
                }
            }
            L.push('');
            L.push('--- RESULT ---');
            if (ex.error) {
                L.push(`ERROR: ${ex.error}`);
            } else if (ex.result) {
                L.push(`content: ${ex.result.contentLen} chars | finishReason: ${ex.result.finishReason}`);
                if (ex.result.contentPreview) L.push(`preview: ${ex.result.contentPreview}`);
                if (ex.result.toolCalls) {
                    L.push(`toolCalls: ${ex.result.toolCalls.length}`);
                    for (const tc of ex.result.toolCalls)
                        L.push(`  ${tc.name} (${tc.id}): ${tc.argsPreview}`);
                } else {
                    L.push('toolCalls: null');
                }
                if (ex.result.usage) L.push(`usage: ${JSON.stringify(ex.result.usage)}`);
            } else {
                L.push('(no result)');
            }
            L.push('');
            return L.join('\n');
        }).join('\n\n');
    }
};

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
        const rawModels = data.data || data.models || data || [];

        if (!Array.isArray(rawModels)) {
            State.models = [];
            return State.models;
        }

        // Parse through the active provider to get normalized + enriched models
        State.models = Providers.parseModels(rawModels)
            .filter(m => m.type === 'text' || !m.type)  // Only text models by default
            .sort((a, b) => a.id.localeCompare(b.id));

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

            // Request usage stats in streaming mode (OpenAI extension, Venice supports it)
            if (stream) {
                requestBody.stream_options = { include_usage: true };
            }

            if (tools) {
                requestBody.tools = tools;
                requestBody.tool_choice = 'auto';
            }

            LLMDebug.startExchange(requestBody);

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

            let result;
            if (stream) {
                result = await this._handleStream(response, onToken);
            } else {
                const data = await response.json();
                LLMDebug.logChunk(JSON.stringify(data).slice(0, 2000), {
                    type: 'non-stream',
                    hasToolCalls: !!data.choices?.[0]?.message?.tool_calls,
                    finishReason: data.choices?.[0]?.finish_reason
                });
                result = {
                    content: data.choices?.[0]?.message?.content || '',
                    toolCalls: data.choices?.[0]?.message?.tool_calls || null,
                    usage: data.usage
                };
            }

            LLMDebug.endExchange(result);

            // Track cost
            this._trackUsage(result.usage, model);
            return result;

        } catch (err) {
            LLMDebug.logError(err);
            throw err;
        } finally {
            State.isGenerating = false;
            this.abortController = null;
            EventBus.emit('llm:generating', false);
        }
    },

    /**
     * Track token usage and estimated cost for the session.
     */
    _trackUsage(usage, modelId) {
        if (!usage) {
            // Estimate from content length if no usage data
            return;
        }

        const inputTokens = usage.prompt_tokens || 0;
        const outputTokens = usage.completion_tokens || 0;

        State.sessionCost.totalInputTokens += inputTokens;
        State.sessionCost.totalOutputTokens += outputTokens;
        State.sessionCost.requests += 1;

        // Calculate cost from model pricing
        const model = State.models.find(m => m.id === modelId);
        if (model?.pricing) {
            // pricing is per 1M tokens
            const inputCost = (inputTokens / 1_000_000) * (model.pricing.input || 0);
            const outputCost = (outputTokens / 1_000_000) * (model.pricing.output || 0);
            State.sessionCost.totalCost += inputCost + outputCost;
        }

        EventBus.emit('cost:updated', { usage, sessionCost: State.sessionCost });
    },

    async _handleStream(response, onToken) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let content = '';
        let toolCalls = [];
        let usage = null;
        let buffer = '';       // Handle partial SSE lines
        let inThinkBlock = false;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            // Keep the last potentially incomplete line in the buffer
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') {
                    LLMDebug.logChunk('[DONE]', null);
                    continue;
                }

                try {
                    const parsed = JSON.parse(data);

                    // Capture usage from the final chunk (stream_options.include_usage)
                    if (parsed.usage) {
                        usage = parsed.usage;
                    }

                    const delta = parsed.choices?.[0]?.delta;
                    const fr = parsed.choices?.[0]?.finish_reason;

                    // === DEBUG: log every SSE data line ===
                    LLMDebug.logChunk(data.slice(0, 500), {
                        hasContent: !!delta?.content,
                        contentSnip: delta?.content ? delta.content.slice(0, 100) : null,
                        hasToolCalls: !!delta?.tool_calls,
                        toolCallDelta: delta?.tool_calls || null,
                        finishReason: fr || null,
                        hasUsage: !!parsed.usage
                    });

                    if (!delta) continue;

                    if (delta.content) {
                        // Strip <think>...</think> blocks from streamed content
                        let chunk = delta.content;

                        // Handle think block boundaries
                        if (inThinkBlock) {
                            const endIdx = chunk.indexOf('</think>');
                            if (endIdx >= 0) {
                                chunk = chunk.slice(endIdx + 8);
                                inThinkBlock = false;
                                LLMDebug.logThink('think-end', `remaining: "${chunk.slice(0, 80)}"`);
                            } else {
                                continue; // Still inside think block, skip
                            }
                        }

                        // Check for new think block starts
                        const startIdx = chunk.indexOf('<think>');
                        if (startIdx >= 0) {
                            const before = chunk.slice(0, startIdx);
                            const afterStart = chunk.slice(startIdx + 7);
                            const endIdx = afterStart.indexOf('</think>');
                            if (endIdx >= 0) {
                                // Complete think block in one chunk
                                chunk = before + afterStart.slice(endIdx + 8);
                                LLMDebug.logThink('think-inline', `complete block in one chunk`);
                            } else {
                                // Think block spans chunks
                                chunk = before;
                                inThinkBlock = true;
                                LLMDebug.logThink('think-start', `entering think block, before: "${before.slice(0, 80)}"`);
                            }
                        }

                        if (chunk) {
                            content += chunk;
                            if (onToken) onToken(chunk, content);
                            EventBus.emit('llm:token', { token: chunk, content });
                        }
                    }

                    if (delta.tool_calls) {
                        LLMDebug.logThink('tool-call-delta', JSON.stringify(delta.tool_calls).slice(0, 300));
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

        return {
            content,
            toolCalls: toolCalls.length > 0 ? toolCalls : null,
            usage
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

    // Add role context
    const role = Roles.get(State.settings.role);
    if (role && role.id !== 'full') {
        prompt += `\n\nActive role: ${role.name}. ${role.description}`;
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
        // === CODE TOOLS ===
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
        },

        // === ISSUE TOOLS ===
        {
            type: 'function',
            function: {
                name: 'list_issues',
                description: 'List issues for the current project. Returns open issues by default.',
                parameters: {
                    type: 'object',
                    properties: {
                        state: {
                            type: 'string',
                            enum: ['open', 'closed', 'all'],
                            description: 'Filter by issue state (default: open)'
                        },
                        labels: {
                            type: 'string',
                            description: 'Comma-separated label names to filter by'
                        }
                    },
                    required: []
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'read_issue',
                description: 'Read a specific issue by number, including its body, labels, and comments.',
                parameters: {
                    type: 'object',
                    properties: {
                        number: {
                            type: 'integer',
                            description: 'The issue number'
                        }
                    },
                    required: ['number']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'create_issue',
                description: 'Create a new issue in the current project.',
                parameters: {
                    type: 'object',
                    properties: {
                        title: {
                            type: 'string',
                            description: 'Issue title'
                        },
                        body: {
                            type: 'string',
                            description: 'Issue body/description (markdown supported)'
                        },
                        labels: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Array of label names to apply'
                        }
                    },
                    required: ['title']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'update_issue',
                description: 'Update an existing issue (title, body, state, or labels).',
                parameters: {
                    type: 'object',
                    properties: {
                        number: {
                            type: 'integer',
                            description: 'The issue number to update'
                        },
                        title: {
                            type: 'string',
                            description: 'New title (optional)'
                        },
                        body: {
                            type: 'string',
                            description: 'New body (optional)'
                        },
                        state: {
                            type: 'string',
                            enum: ['open', 'closed'],
                            description: 'Set issue state (optional)'
                        }
                    },
                    required: ['number']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'add_issue_comment',
                description: 'Add a comment to an existing issue.',
                parameters: {
                    type: 'object',
                    properties: {
                        number: {
                            type: 'integer',
                            description: 'The issue number'
                        },
                        body: {
                            type: 'string',
                            description: 'Comment text (markdown supported)'
                        }
                    },
                    required: ['number', 'body']
                }
            }
        }
    ],

    // Tool execution handlers - these will be connected to the actual implementations
    handlers: {},

    /**
     * Get tool definitions filtered by the active role.
     * Uses Roles.filterTools() to strip tools the current role shouldn't access.
     */
    getToolsForRole() {
        return Roles.filterTools(this.definitions);
    }
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
    LLMDebug,
    LLMTools,
    EditorPrompts,
    buildSystemPrompt,
    generateEdit,
    generateCommitMessage,
    analyzeIssue,
    getLanguageFromPath
};