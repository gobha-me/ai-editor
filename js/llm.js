/**
 * AI Editor - LLM API Client
 * OpenAI-compatible API for chat completions
 */

import { State, EventBus, Storage, Providers, Roles } from './core.js';

// ============================================
// THINK-BLOCK STRIPPING
// ============================================

/**
 * Strip <think>...</think> blocks from text content.
 * Handles multiple blocks, nested whitespace, and partial/unclosed tags.
 * Used for non-streaming responses where think blocks arrive intact.
 */
function stripThinkBlocks(text) {
    if (!text) return text;
    // Strip all <think>...</think> blocks (non-greedy, handles multiple)
    let result = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
    // Also strip unclosed <think> block at end (model cut off mid-thought)
    result = result.replace(/<think>[\s\S]*$/gi, '');
    return result.trim();
}

// ============================================
// LLM DEBUG LOGGER
// ============================================

/**
 * Ring-buffer debug logger that captures raw SSE data, parsed deltas,
 * think-block filter decisions, and final results for every LLM exchange.
 * Rendered by the 🔬 Debug Modal in index.html.
 */
const LLMDebug = {
    exchanges: [],      // Ring buffer of exchange records
    maxExchanges: 50,
    _current: null,     // Exchange being recorded right now

    /** Start a new exchange. Called at top of LLM.chat(). */
    startExchange(requestBody) {
        const exchange = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            model: requestBody.model,
            stream: requestBody.stream,
            toolCount: requestBody.tools?.length || 0,
            messageCount: requestBody.messages?.length || 0,
            messages: requestBody.messages?.map(m => ({
                role: m.role,
                contentPreview: typeof m.content === 'string'
                    ? m.content.slice(0, 150) + (m.content.length > 150 ? '…' : '')
                    : (m.content === null ? '<null>' : '<array>'),
                hasToolCalls: !!m.tool_calls,
                toolCallId: m.tool_call_id || null
            })),
            chunks: [],         // { raw, parsed } for each SSE data line
            thinkEvents: [],    // Think-block filter decisions
            result: null,       // Final { content, toolCalls, finishReason }
            error: null,
            durationMs: null
        };
        this._current = exchange;
        this.exchanges.push(exchange);
        if (this.exchanges.length > this.maxExchanges) {
            this.exchanges.shift();
        }
        EventBus.emit('debug:exchange', exchange);
        return exchange;
    },

    /** Log a raw SSE chunk + what we parsed from it. */
    logChunk(raw, parsed) {
        if (!this._current) return;
        // Keep last 500 chunks per exchange to avoid memory blowout
        if (this._current.chunks.length >= 500) {
            if (this._current.chunks.length === 500) {
                this._current.chunks.push({ raw: '--- TRUNCATED (500 chunk limit) ---', parsed: null });
            }
            return;
        }
        this._current.chunks.push({ raw, parsed });
    },

    /** Log a think-block filter event. */
    logThink(event, detail) {
        if (!this._current) return;
        this._current.thinkEvents.push({ event, detail, chunkIndex: this._current.chunks.length });
    },

    /** Finalize the current exchange with the result. */
    endExchange(result) {
        if (!this._current) return;
        this._current.result = {
            contentLength: result.content?.length || 0,
            contentPreview: (result.content || '').slice(0, 300),
            toolCalls: result.toolCalls ? result.toolCalls.map(tc => ({
                id: tc.id,
                name: tc.function?.name,
                argsPreview: (tc.function?.arguments || '').slice(0, 200)
            })) : null,
            finishReason: result.finishReason,
            usage: result.usage
        };
        this._current.durationMs = Date.now() - this._current.id;
        const finished = this._current;
        this._current = null;
        EventBus.emit('debug:exchangeDone', finished);
    },

    /** Log an error for the current exchange. */
    logError(error) {
        if (!this._current) return;
        this._current.error = error.message || String(error);
        this._current.durationMs = Date.now() - this._current.id;
        this._current = null;
    },

    /** Clear all exchanges. */
    clear() {
        this.exchanges = [];
        this._current = null;
        EventBus.emit('debug:cleared');
    },

    /** Export all exchanges as text. */
    exportText() {
        return this.exchanges.map(ex => {
            const lines = [];
            lines.push(`=== Exchange ${ex.timestamp} | ${ex.model} | ${ex.stream ? 'stream' : 'non-stream'} ===`);
            lines.push(`Messages: ${ex.messageCount} | Tools: ${ex.toolCount} | Duration: ${ex.durationMs}ms`);
            lines.push('');
            
            // Messages summary
            lines.push('--- MESSAGES ---');
            for (const m of (ex.messages || [])) {
                let desc = `[${m.role}]`;
                if (m.hasToolCalls) desc += ' (has tool_calls)';
                if (m.toolCallId) desc += ` (tool_call_id: ${m.toolCallId})`;
                desc += ` ${m.contentPreview}`;
                lines.push(desc);
            }
            lines.push('');

            // Raw chunks
            lines.push(`--- RAW SSE CHUNKS (${ex.chunks.length}) ---`);
            for (const c of ex.chunks) {
                lines.push(`RAW: ${c.raw}`);
                if (c.parsed) lines.push(`  → ${JSON.stringify(c.parsed)}`);
            }
            lines.push('');

            // Think events
            if (ex.thinkEvents.length > 0) {
                lines.push(`--- THINK BLOCK EVENTS (${ex.thinkEvents.length}) ---`);
                for (const t of ex.thinkEvents) {
                    lines.push(`  [chunk ${t.chunkIndex}] ${t.event}: ${t.detail}`);
                }
                lines.push('');
            }

            // Result
            lines.push('--- RESULT ---');
            if (ex.error) {
                lines.push(`ERROR: ${ex.error}`);
            } else if (ex.result) {
                lines.push(`Content: ${ex.result.contentLength} chars | finishReason: ${ex.result.finishReason}`);
                if (ex.result.contentPreview) lines.push(`Preview: ${ex.result.contentPreview}`);
                if (ex.result.toolCalls) {
                    lines.push(`Tool calls: ${ex.result.toolCalls.length}`);
                    for (const tc of ex.result.toolCalls) {
                        lines.push(`  ${tc.name} (${tc.id}): ${tc.argsPreview}`);
                    }
                }
                if (ex.result.usage) lines.push(`Usage: ${JSON.stringify(ex.result.usage)}`);
            } else {
                lines.push('(no result recorded)');
            }
            lines.push('');
            return lines.join('\n');
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

            // === DEBUG: Start exchange logging with tool diagnostic ===
            LLMDebug.startExchange(requestBody);
            // Extra diagnostic: WHY are tools missing?
            if (!requestBody.tools || requestBody.tools.length === 0) {
                LLMDebug.logThink('tool-diagnostic', 
                    `tools param type=${typeof tools}, isArray=${Array.isArray(tools)}, ` +
                    `length=${tools?.length}, truthy=${!!tools}, ` +
                    `requestBody.tools=${JSON.stringify(requestBody.tools)?.slice(0, 100)}`
                );
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

            let result;
            if (stream) {
                result = await this._handleStream(response, onToken);
            } else {
                const data = await response.json();
                // Log the raw non-streaming response
                LLMDebug.logChunk(JSON.stringify(data).slice(0, 2000), {
                    type: 'non-stream-response',
                    hasToolCalls: !!data.choices?.[0]?.message?.tool_calls,
                    finishReason: data.choices?.[0]?.finish_reason
                });
                const rawContent = data.choices?.[0]?.message?.content || '';
                result = {
                    content: stripThinkBlocks(rawContent),
                    toolCalls: data.choices?.[0]?.message?.tool_calls || null,
                    finishReason: data.choices?.[0]?.finish_reason || 'stop',
                    usage: data.usage
                };
            }

            // === DEBUG: End exchange logging ===
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
        let finishReason = null;
        let buffer = '';       // Handle partial SSE lines
        let inThinkBlock = false;
        let thinkBuffer = '';  // Buffer for detecting split </think> tags

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

                    // === Detect error responses embedded in SSE stream ===
                    if (parsed.error_type || parsed.error) {
                        const errMsg = parsed.error_message || parsed.error?.message || JSON.stringify(parsed);
                        console.error('[LLM] SSE error response:', errMsg);
                        LLMDebug.logChunk(data.slice(0, 500), {
                            hasContent: false, contentChunk: null,
                            hasToolCalls: false, toolCallsDelta: null,
                            finishReason: null, hasUsage: false
                        });
                        throw new Error(`LLM stream error: ${errMsg}`);
                    }

                    // === DEBUG: Log raw chunk with parsed summary ===
                    const delta = parsed.choices?.[0]?.delta;
                    const chunkFinish = parsed.choices?.[0]?.finish_reason;
                    LLMDebug.logChunk(data.slice(0, 500), {
                        hasContent: !!delta?.content,
                        contentChunk: delta?.content ? delta.content.slice(0, 80) : null,
                        hasToolCalls: !!delta?.tool_calls,
                        toolCallsDelta: delta?.tool_calls || null,
                        finishReason: chunkFinish || null,
                        hasUsage: !!parsed.usage
                    });

                    // Capture usage from the final chunk (stream_options.include_usage)
                    if (parsed.usage) {
                        usage = parsed.usage;
                    }

                    // Capture finish_reason
                    if (chunkFinish) {
                        finishReason = chunkFinish;
                    }

                    if (!delta) continue;

                    if (delta.content) {
                        let chunk = delta.content;

                        // --- Think-block stripping (handles split tags) ---
                        if (inThinkBlock) {
                            thinkBuffer += chunk;
                            const endIdx = thinkBuffer.indexOf('</think>');
                            if (endIdx >= 0) {
                                chunk = thinkBuffer.slice(endIdx + 8);
                                inThinkBlock = false;
                                LLMDebug.logThink('think-end', `Exited think block, remaining: "${chunk.slice(0, 60)}"`);
                                thinkBuffer = '';
                            } else {
                                if (thinkBuffer.length > 8) {
                                    thinkBuffer = thinkBuffer.slice(-7);
                                }
                                continue; // Skip this chunk entirely
                            }
                        }

                        const startIdx = chunk.indexOf('<think>');
                        if (startIdx >= 0) {
                            const before = chunk.slice(0, startIdx);
                            const afterStart = chunk.slice(startIdx + 7);
                            const endIdx = afterStart.indexOf('</think>');
                            if (endIdx >= 0) {
                                chunk = before + afterStart.slice(endIdx + 8);
                                LLMDebug.logThink('think-complete', `Complete think block in one chunk, kept: "${chunk.slice(0, 60)}"`);
                            } else {
                                chunk = before;
                                thinkBuffer = afterStart;
                                inThinkBlock = true;
                                LLMDebug.logThink('think-start', `Entered think block, kept before: "${before.slice(0, 60)}"`);
                            }
                        }
                        // --- End think-block stripping ---

                        if (chunk) {
                            content += chunk;
                            if (onToken) onToken(chunk, content);
                            EventBus.emit('llm:token', { token: chunk, content });
                        }
                    }

                    if (delta.tool_calls) {
                        LLMDebug.logThink('tool-call-delta', JSON.stringify(delta.tool_calls));
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
            finishReason: finishReason || (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
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
- Read the current file open in the editor (read_current_file)
- Read specific line ranges efficiently (read_lines) — PREFERRED for large files
- Make surgical edits to specific lines (replace_lines, insert_lines, delete_lines)
- Query the project file tree (get_project_tree)
- Open specific files in the editor (open_file) — REQUIRED before using replace_lines/insert_lines/delete_lines
- Read any file's content without opening it (read_file) — auto-truncates large files
- List all open tabs (list_open_tabs)
- Create new files in the repository (create_file)
- Search for text patterns across the codebase (search_in_files)

WORKFLOW — Follow these steps for investigation and editing tasks:
1. get_project_tree — understand the project structure
2. search_in_files — find where relevant code lives (function names, error strings, variables)
3. read_lines — examine specific sections of candidate files (avoids loading entire files)
4. open_file — switch to the file that needs editing (MUST do this before editing)
5. read_current_file or read_lines — see exact line numbers before editing
6. replace_lines / insert_lines / delete_lines — make targeted, SMALL edits (10-30 lines max)
7. create_file — if a new file is needed

IMPORTANT RULES:
- You MUST call open_file before using replace_lines, insert_lines, or delete_lines
- ALWAYS use read_current_file or read_lines to see line numbers before editing
- Prefer read_lines over read_file for files over 100 lines — only read the section you need
- Make SMALL, targeted edits. Replace 10-30 lines at a time, not 50+
- After editing, explain what you changed and which lines
- You can use multiple tools in sequence — use as many rounds as needed
- Do NOT include trailing newlines in new_content for replace_lines

⚠️ CRITICAL — LINE NUMBER DRIFT:
Every edit changes line numbers for all subsequent lines in the file.
- After replace_lines or insert_lines, ALL line numbers below the edit shift
- You MUST call read_lines on the target region BEFORE each subsequent edit
- NEVER make a second edit using line numbers from before a previous edit
- The tool result includes surrounding context — verify your edit landed correctly
- Work TOP-DOWN (edit higher line numbers first) to minimize drift impact

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
        const issuesSummary = State.issues.map(i => 
            `  #${i.number}: ${i.title}${i.labels.length ? ` [${i.labels.join(', ')}]` : ''}`
        ).join('\n');
        prompt = prompt.replace('{{issues}}', `\nOpen issues (${State.issues.length}):\n${issuesSummary}`);
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
                description: 'Read the content of the currently open file in the editor. Returns line-numbered content. Large files (200+ lines) are automatically truncated — use read_lines for specific sections.',
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
                description: 'Replace specific lines in the current file. Use this for targeted edits instead of replacing the whole file. Line numbers are 1-indexed. Do NOT include a trailing newline in new_content.',
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
                description: 'Read the content of a specific file without opening it in the editor. Large files (200+ lines) are automatically truncated — use read_lines for specific sections.',
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
                name: 'read_lines',
                description: 'Read specific line range from a file. Use this instead of read_file when you only need to see a section of a large file. Lines are returned with line numbers for easy reference.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: 'File path to read from (omit to read from currently open file)'
                        },
                        start_line: {
                            type: 'integer',
                            description: 'First line to read (1-indexed, inclusive). Default: 1'
                        },
                        end_line: {
                            type: 'integer',
                            description: 'Last line to read (1-indexed, inclusive). Default: end of file'
                        }
                    },
                    required: []
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
        {
            type: 'function',
            function: {
                name: 'create_file',
                description: 'Create a new file in the project repository. Commits directly to the current branch via Gitea API. Intermediate directories are created automatically.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: 'File path relative to repo root (e.g., "src/utils/helpers.js")'
                        },
                        content: {
                            type: 'string',
                            description: 'File content to write'
                        },
                        message: {
                            type: 'string',
                            description: 'Git commit message (optional, defaults to "Create <path>")'
                        }
                    },
                    required: ['path', 'content']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'search_in_files',
                description: 'Search for text across project files. Returns matching lines with file paths and line numbers. Use to find functions, variables, strings, or patterns in the codebase.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'Text to search for (case-insensitive)'
                        },
                        path: {
                            type: 'string',
                            description: 'Optional directory prefix to limit scope (e.g., "js/")'
                        },
                        max_results: {
                            type: 'integer',
                            description: 'Max files to return (default: 20)'
                        }
                    },
                    required: ['query']
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
    getLanguageFromPath,
    stripThinkBlocks
};