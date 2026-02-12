/**
 * LLM API Client
 * OpenAI-compatible chat completions with streaming, tool calling,
 * cost tracking, and provider-specific extensions.
 * Extracted from llm.js in 0.9.13.
 */

import { State, EventBus, Storage, Providers, ProviderRegistry, Roles } from '../core.js';
import { ToolRegistry } from '../tools/registry.js';
import { sanitizeMessages, stripThinkBlocks } from './utils.js';
import { LLMDebug } from './debug.js';
import {
    EditorPrompts,
    buildSystemPrompt,
    buildEditPrompt,
    buildCommitMessagePrompt,
    getLanguageFromPath
} from '../prompts.js';

// ============================================
// REQUEST BODY BUILDER
// ============================================

/**
 * Build request body with provider-specific extensions.
 * Handles OpenAI-compatible base + Venice.ai extensions.
 */
export function buildRequestBody(model, messages, options = {}) {
    const {
        stream = true,
        maxTokens = 4096,
        temperature = 0.7,
        tools = null
    } = options;

    const sanitizedMessages = sanitizeMessages(messages);

    const requestBody = {
        model,
        messages: sanitizedMessages,
        max_tokens: maxTokens,
        temperature,
        stream
    };

    if (stream) {
        requestBody.stream_options = { include_usage: true };
    }

    if (tools && Array.isArray(tools) && tools.length > 0) {
        requestBody.tools = tools;
        requestBody.tool_choice = 'auto';
    }

    return ProviderRegistry.transformRequest(requestBody, State.settings);
}

// ============================================
// LLM API CLIENT
// ============================================

export const LLM = {
    abortController: null,

    // ========================================
    // MODELS
    // ========================================

    async listModels() {
        const url = `${State.settings.llmEndpoint.replace(/\/$/, '')}/models`;
        
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${State.settings.llmApiKey}`,
                ...ProviderRegistry.getHeaders(State.settings)
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

        State.models = Providers.parseModels(rawModels)
            .filter(m => m.type === 'text' || !m.type)
            .sort((a, b) => a.id.localeCompare(b.id));

        Storage.set('models', State.models);
        EventBus.emit('llm:modelsLoaded', State.models);
        return State.models;
    },

    /**
     * Fetch embedding models from the API endpoint.
     * Tries ?type=embedding query parameter first, falls back to filtering all models.
     */
    async listEmbeddingModels() {
        const baseUrl = State.settings.llmEndpoint.replace(/\/$/, '');
        
        try {
            const response = await fetch(`${baseUrl}/models?type=embedding`, {
                headers: {
                    'Authorization': `Bearer ${State.settings.llmApiKey}`,
                    ...ProviderRegistry.getHeaders(State.settings)
                }
            });

            if (response.ok) {
                const data = await response.json();
                const rawModels = data.data || data.models || data || [];
                
                if (Array.isArray(rawModels) && rawModels.length > 0) {
                    console.log(`[LLM] Found ${rawModels.length} embedding models via ?type=embedding`);
                    return rawModels.map(m => ({
                        id: m.id || m.name || String(m),
                        name: m.id || m.name || String(m),
                        type: 'embedding',
                        owned_by: m.owned_by || null
                    }));
                }
            }
        } catch (e) {
            console.warn('[LLM] Failed to fetch embedding models with ?type=embedding:', e.message);
        }

        // Fallback: fetch all models and filter by type
        try {
            const response = await fetch(`${baseUrl}/models`, {
                headers: {
                    'Authorization': `Bearer ${State.settings.llmApiKey}`,
                    ...ProviderRegistry.getHeaders(State.settings)
                }
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch models: ${response.status}`);
            }

            const data = await response.json();
            const rawModels = data.data || data.models || data || [];

            if (!Array.isArray(rawModels)) {
                return [];
            }

            const embeddingModels = rawModels
                .filter(m => {
                    const type = m.type || m.model_type || '';
                    const id = m.id || m.name || '';
                    return type === 'embedding' || 
                           type.toLowerCase().includes('embedding') ||
                           id.toLowerCase().includes('embedding');
                })
                .map(m => ({
                    id: m.id || m.name || String(m),
                    name: m.id || m.name || String(m),
                    type: 'embedding',
                    owned_by: m.owned_by || null
                }));

            console.log(`[LLM] Found ${embeddingModels.length} embedding models via filtering`);
            return embeddingModels;

        } catch (e) {
            console.error('[LLM] Failed to fetch embedding models:', e);
            throw e;
        }
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
            const requestBody = buildRequestBody(model, messages, {
                stream,
                maxTokens,
                temperature,
                tools
            });

            // === DEBUG: Start exchange logging with tool diagnostic ===
            LLMDebug.startExchange(requestBody);
            if (!requestBody.tools || requestBody.tools.length === 0) {
                LLMDebug.logThink('tool-diagnostic', 
                    `tools param: type=${typeof tools}, isArray=${Array.isArray(tools)}, ` +
                    `length=${tools?.length}, truthy=${!!tools} | ` +
                    `requestBody.tools: type=${typeof requestBody.tools}, isArray=${Array.isArray(requestBody.tools)}, ` +
                    `length=${requestBody.tools?.length}`
                );
            } else {
                LLMDebug.logThink('tool-success', 
                    `✅ Sending ${requestBody.tools.length} tools: ${requestBody.tools.map(t => t.function?.name || t.name).join(', ')}`
                );
            }

            const response = await fetch(
                `${State.settings.llmEndpoint.replace(/\/$/, '')}/chat/completions`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${State.settings.llmApiKey}`,
                        ...ProviderRegistry.getHeaders(State.settings)
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
                result = await this._handleStream(response, onToken, !!tools);
            } else {
                const data = await response.json();
                LLMDebug.logChunk(JSON.stringify(data).slice(0, 2000), {
                    type: 'non-stream-response',
                    hasToolCalls: !!data.choices?.[0]?.message?.tool_calls,
                    finishReason: data.choices?.[0]?.finish_reason
                });
                const rawContent = data.choices?.[0]?.message?.content || '';
                result = {
                    content: options.skipThinkStrip ? rawContent : stripThinkBlocks(rawContent),
                    rawContent,
                    toolCalls: data.choices?.[0]?.message?.tool_calls || null,
                    finishReason: data.choices?.[0]?.finish_reason || 'stop',
                    usage: data.usage
                };
            }

            // === DEBUG: End exchange logging ===
            LLMDebug.endExchange(result);

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
        if (!usage) return;

        const inputTokens = usage.prompt_tokens || 0;
        const outputTokens = usage.completion_tokens || 0;
        const cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;
        const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens || 0;

        State.sessionCost.totalInputTokens += inputTokens;
        State.sessionCost.totalOutputTokens += outputTokens;
        State.sessionCost.cachedInputTokens += cachedTokens;
        State.sessionCost.reasoningTokens += reasoningTokens;
        State.sessionCost.requests += 1;

        const model = State.models.find(m => m.id === modelId);
        if (model?.pricing) {
            const inputPrice = model.pricing.input || 0;
            const outputPrice = model.pricing.output || 0;
            const cachePrice = model.pricing.cacheInput ?? null;

            const uncachedInput = inputTokens - cachedTokens;
            const inputCost = (uncachedInput / 1_000_000) * inputPrice;
            const cacheCost = cachePrice !== null
                ? (cachedTokens / 1_000_000) * cachePrice
                : 0;
            const outputCost = (outputTokens / 1_000_000) * outputPrice;

            const totalCost = inputCost + cacheCost + outputCost;
            State.sessionCost.totalCost += totalCost;

            if (cachedTokens > 0) {
                const savedPerToken = inputPrice - (cachePrice || 0);
                const savings = (cachedTokens / 1_000_000) * savedPerToken;
                State.sessionCost.cacheSavings += savings;
            }
        }

        EventBus.emit('cost:updated', { usage, sessionCost: State.sessionCost });
    },

    async _handleStream(response, onToken, hasTools = false) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let content = '';
        let toolCalls = [];
        let usage = null;
        let finishReason = null;
        let buffer = '';
        let inThinkBlock = false;
        let thinkBuffer = '';
        let hasToolCallsInResponse = false;
        let streamError = null;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') {
                    LLMDebug.logChunk('[DONE]', null);
                    continue;
                }

                let parsed;
                try {
                    parsed = JSON.parse(data);
                } catch (e) {
                    continue;
                }

                // Detect error responses embedded in SSE stream
                const isErrorResponse = 
                    parsed.error_type ||
                    parsed.error ||
                    (parsed.object === 'error' && parsed.message) ||
                    (parsed.code && parsed.code >= 400 && !parsed.choices);
                
                if (isErrorResponse) {
                    const errMsg = 
                        parsed.error_message ||
                        parsed.error?.message ||
                        (typeof parsed.error === 'string' ? parsed.error : null) ||
                        parsed.message ||
                        JSON.stringify(parsed);
                    console.error('[LLM] SSE error response:', errMsg);
                    LLMDebug.logChunk(data.slice(0, 500), {
                        hasContent: false, contentSnip: null,
                        hasToolCalls: false, toolCallDelta: null,
                        finishReason: null, hasUsage: false
                    });
                    streamError = new Error(`LLM stream error: ${errMsg}`);
                    break;
                }

                // === DEBUG: Log raw chunk with parsed summary ===
                const delta = parsed.choices?.[0]?.delta;
                const chunkFinish = parsed.choices?.[0]?.finish_reason;
                LLMDebug.logChunk(data.slice(0, 500), {
                    hasContent: !!delta?.content,
                    contentSnip: delta?.content ? delta.content.slice(0, 80) : null,
                    hasToolCalls: !!delta?.tool_calls,
                    toolCallDelta: delta?.tool_calls || null,
                    finishReason: chunkFinish || null,
                    hasUsage: !!parsed.usage
                });

                if (parsed.usage) {
                    usage = parsed.usage;
                }

                if (chunkFinish) {
                    finishReason = chunkFinish;
                }

                if (!delta) continue;

                if (delta.content) {
                    let chunk = delta.content;

                    // Think-block stripping (only when no tool calls)
                    if (!hasToolCallsInResponse && !hasTools) {
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
                                continue;
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
                    }

                    if (chunk) {
                        content += chunk;
                        if (onToken) onToken(chunk, content);
                        EventBus.emit('llm:token', { token: chunk, content });
                    }
                }

                if (delta.tool_calls) {
                    hasToolCallsInResponse = true;
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
            }
            if (streamError) break;
        }

        if (streamError) {
            throw streamError;
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
// LLM TOOLS — Managed by ToolRegistry
// ============================================

export const LLMTools = {
    get definitions() {
        const defs = ToolRegistry.getDefinitions();
        console.log('[LLMTools] Fetching definitions from registry, count:', defs.length);
        return defs;
    },

    getToolsForRole() {
        const defs = ToolRegistry.getDefinitions();
        console.log('[LLMTools] getToolsForRole: registry has', defs.length, 'tools');
        
        if (defs.length === 0) {
            console.warn('[LLMTools] ⚠️ ToolRegistry is empty! Tools may not be registered yet.');
            return [];
        }
        
        const filtered = Roles.filterTools(defs);
        console.log('[LLMTools] After role filtering:', filtered.length, 'tools for role', State.settings.role);
        return filtered;
    }
};

// ============================================
// HIGH-LEVEL FUNCTIONS
// ============================================

export async function generateEdit(request, onToken = null) {
    const systemPrompt = buildSystemPrompt();
    const editPrompt = buildEditPrompt(request);

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: editPrompt }
    ];

    const result = await LLM.chat(messages, { 
        onToken,
        stream: true,
        maxTokens: 8192
    });

    const codeMatch = result.content.match(/```[\w]*\n([\s\S]*?)```/);
    return {
        ...result,
        code: codeMatch ? codeMatch[1].trim() : result.content
    };
}

export async function generateCommitMessage(changedFiles = null) {
    let diffSummary = 'Changes pending';

    if (changedFiles && changedFiles.length > 0) {
        const fileDiffs = changedFiles.map(f => {
            const original = (f.originalContent || '').slice(0, 2000);
            const updated = (f.content || '').slice(0, 2000);
            return `File: ${f.path}\n` +
                   `Original (first 2000 chars):\n${original}\n` +
                   `Updated (first 2000 chars):\n${updated}\n`;
        });
        diffSummary = fileDiffs.join('\n---\n');
    }

    const commitPrompt = buildCommitMessagePrompt(diffSummary);

    const commitModel = State.settings.commitModel || State.settings.llmModel;

    const result = await LLM.chat([
        { role: 'system', content: 'You are a helpful assistant that writes concise, descriptive git commit messages following conventional commit format.' },
        { role: 'user', content: commitPrompt }
    ], {
        model: commitModel,
        stream: false,
        maxTokens: 256,
        temperature: 0.3
    });

    const raw = (result.rawContent || result.content || '').trim();
    return raw.replace(/^["']|["']$/g, '').trim();
}

export async function analyzeIssue(issue, onToken = null) {
    const prompt = EditorPrompts.issueAnalysisPrompt
        .replace('{title}', issue.title)
        .replace('{body}', issue.body || 'No description provided')
        .replace('{labels}', (issue.labels || []).map(l => l.name || l).join(', '));

    const systemPrompt = buildSystemPrompt();

    const result = await LLM.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
    ], {
        onToken,
        stream: true,
        maxTokens: 4096
    });

    return result.content;
}
