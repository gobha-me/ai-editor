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

When asked to edit code:
1. Make precise, minimal changes to achieve the goal
2. Preserve existing code style and formatting
3. Return the COMPLETE file content, not just the changed parts
4. Explain your changes briefly after the code

When asked to create new files:
1. Follow best practices for the language
2. Include appropriate comments
3. Return the complete file content

When explaining code:
1. Be concise but thorough
2. Point out potential issues or improvements
3. Reference specific line numbers when relevant

Current context:
- Project: {{project}}
- File: {{file}}
- Branch: {{branch}}`,

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

async function generateCommitMessage() {
    if (!State.currentFile) {
        return 'Update file';
    }

    const prompt = buildCommitMessagePrompt(
        State.currentFile.content,
        State.editorContent
    );

    const result = await LLM.chat([
        { role: 'user', content: prompt }
    ], { 
        stream: false,
        temperature: 0.3,
        maxTokens: 100
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
    EditorPrompts,
    buildSystemPrompt,
    generateEdit,
    generateCommitMessage,
    analyzeIssue,
    getLanguageFromPath
};