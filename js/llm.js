/**
 * AI Editor - LLM API Client
 * OpenAI-compatible API for chat completions
 */

import { State, EventBus, Storage, Providers, ProviderRegistry, Roles } from './core.js';
import { buildScratchpadPrompt } from './tools/scratchpad-tools.js';
import { ToolRegistry } from './tools/registry.js';
import { ContextManager } from './context-manager.js';

// ============================================
// THINK-BLOCK STRIPPING
// ============================================

/**
 * Strip <think> blocks from text content.
 * Handles multiple blocks, nested whitespace, and partial/unclosed tags.
 * Used for non-streaming responses where think blocks arrive intact.
 */
function stripThinkBlocks(text) {
    if (!text) return text;
    // Strip all <think>...</think> blocks (non-greedy, handles multiple)
    let result = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
    // Also strip unclosed block at end (model cut off mid-thought)
    result = result.replace(/<think>[\s\S]*$/gi, '');
    return result.trim();
}

// ============================================
// MESSAGE SANITIZATION
// ============================================

/**
 * Strip internal tracking fields from messages before API submission.
 * OpenAI API spec only allows: role, content, name, tool_calls, tool_call_id
 * Internal fields like timestamp, isSummary can cause API errors if included.
 * 
 * CRITICAL: This function MUST properly handle all message types:
 * - user/assistant messages with content
 * - assistant messages with tool_calls (content may be null)
 * - tool messages with tool_call_id and content (JSON string)
 * 
 * Uses explicit field copying instead of destructuring to avoid corruption.
 */
function sanitizeMessages(messages) {
    const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool']);
    
    return messages
        .filter(msg => {
            // Drop invalid roles
            if (!VALID_ROLES.has(msg.role)) {
                console.warn(`[sanitizeMessages] Dropping invalid role: "${msg.role}"`);
                return false;
            }
            // Drop empty assistant messages (no content AND no tool_calls)
            if (msg.role === 'assistant' && !msg.content && !msg.tool_calls) {
                console.warn('[sanitizeMessages] Dropping empty assistant message');
                return false;
            }
            return true;
        })
        .map(msg => {
            const clean = { role: msg.role };
            
            // Content — normalize null for assistant+tool_calls (OpenAI spec allows null,
            // Venice rejects absent content field)
            if (msg.content !== undefined && msg.content !== null) {
                clean.content = msg.content;
            } else if (msg.role === 'assistant' && msg.tool_calls) {
                clean.content = null;
            } else if (msg.content !== undefined) {
                clean.content = msg.content;
            }
            
            if (msg.name !== undefined) clean.name = msg.name;
            
            // tool_calls — filter sparse gaps from SSE index-based accumulation
            if (msg.tool_calls !== undefined) {
                clean.tool_calls = Array.isArray(msg.tool_calls)
                    ? msg.tool_calls.filter(tc => tc && tc.function?.name)
                    : msg.tool_calls;
            }
            
            if (msg.tool_call_id !== undefined) clean.tool_call_id = msg.tool_call_id;
            
            return clean;
        });
}

// ============================================
// REQUEST BODY BUILDER
// ============================================

/**
 * Build request body with provider-specific extensions.
 * Handles OpenAI-compatible base + Venice.ai extensions.
 */
function buildRequestBody(model, messages, options = {}) {
    const {
        stream = true,
        maxTokens = 4096,
        temperature = 0.7,
        tools = null
    } = options;

    // Sanitize messages - strip internal fields before API submission
    const sanitizedMessages = sanitizeMessages(messages);

    // Base OpenAI-compatible payload
    const requestBody = {
        model,
        messages: sanitizedMessages,
        max_tokens: maxTokens,
        temperature,
        stream
    };

    // Add streaming usage stats (OpenAI extension, Venice supports it)
    if (stream) {
        requestBody.stream_options = { include_usage: true };
    }

    // Add tools if provided
    if (tools && Array.isArray(tools) && tools.length > 0) {
        requestBody.tools = tools;
        requestBody.tool_choice = 'auto';
    }

    // Provider-specific request transforms (Venice params, OpenRouter routing, etc.)
    // This replaces the old hardcoded Venice block — providers handle their own extensions.
    return ProviderRegistry.transformRequest(requestBody, State.settings);
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
            ts: new Date().toISOString(),  // Changed from 'timestamp' to match render
            model: requestBody.model,
            stream: requestBody.stream,
            toolsSent: requestBody.tools?.length || 0,  // Changed from 'toolCount' to match render
            msgCount: requestBody.messages?.length || 0,  // Changed from 'messageCount' to match render
            messages: requestBody.messages?.map(m => ({
                role: m.role,
                preview: typeof m.content === 'string'  // Changed from 'contentPreview' to match render
                    ? m.content.slice(0, 150) + (m.content.length > 150 ? '…' : '')
                    : (m.content === null ? '<null>' : '<array>'),
                hasToolCalls: !!m.tool_calls,
                toolCallId: m.tool_call_id || null
            })),
            chunks: [],         // { raw, parsed } for each SSE data line
            thinkEvents: [],    // Think-block filter decisions (with atChunk instead of chunkIndex)
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
        this._current.thinkEvents.push({ 
            event, 
            detail, 
            atChunk: this._current.chunks.length  // Changed from 'chunkIndex' to match render
        });
    },

    /** Finalize the current exchange with the result. */
    endExchange(result) {
        if (!this._current) return;
        this._current.result = {
            contentLen: result.content?.length || 0,  // Changed from 'contentLength' to match render
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
            lines.push(`=== Exchange ${ex.ts} | ${ex.model} | ${ex.stream ? 'stream' : 'non-stream'} ===`);
            lines.push(`Messages: ${ex.msgCount} | Tools: ${ex.toolsSent} | Duration: ${ex.durationMs}ms`);
            lines.push('');
            
            // Messages summary
            lines.push('--- MESSAGES ---');
            for (const m of (ex.messages || [])) {
                let desc = `[${m.role}]`;
                if (m.hasToolCalls) desc += ' (has tool_calls)';
                if (m.toolCallId) desc += ` (tool_call_id: ${m.toolCallId})`;
                desc += ` ${m.preview}`;
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
                    lines.push(`  [chunk ${t.atChunk}] ${t.event}: ${t.detail}`);
                }
                lines.push('');
            }

            // Result
            lines.push('--- RESULT ---');
            if (ex.error) {
                lines.push(`ERROR: ${ex.error}`);
            } else if (ex.result) {
                lines.push(`Content: ${ex.result.contentLen} chars | finishReason: ${ex.result.finishReason}`);
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

        // Parse through the active provider to get normalized + enriched models
        State.models = Providers.parseModels(rawModels)
            .filter(m => m.type === 'text' || !m.type)  // Only text models by default
            .sort((a, b) => a.id.localeCompare(b.id));

        Storage.set('models', State.models);
        EventBus.emit('llm:modelsLoaded', State.models);
        return State.models;
    },

    /**
     * Fetch embedding models from the API endpoint.
     * Tries ?type=embedding query parameter first, falls back to filtering all models.
     * @returns {Promise<Array>} Array of embedding model objects
     */
    async listEmbeddingModels() {
        const baseUrl = State.settings.llmEndpoint.replace(/\/$/, '');
        
        // Try fetching with type=embedding parameter (Venice.ai style)
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

            // Filter for embedding models
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
            // Build request with message sanitization and provider-specific extensions
            const requestBody = buildRequestBody(model, messages, {
                stream,
                maxTokens,
                temperature,
                tools
            });

            // === DEBUG: Start exchange logging with tool diagnostic ===
            LLMDebug.startExchange(requestBody);
            // Extra diagnostic: WHY are tools missing?
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
                // Log the raw non-streaming response
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
     * Parses the full OpenAI usage shape including:
     *   - prompt_tokens_details.cached_tokens (cache hits)
     *   - completion_tokens_details.reasoning_tokens (thinking)
     */
    _trackUsage(usage, modelId) {
        if (!usage) {
            // Estimate from content length if no usage data
            return;
        }

        const inputTokens = usage.prompt_tokens || 0;
        const outputTokens = usage.completion_tokens || 0;

        // Extract detailed token breakdown (OpenAI / Venice / OpenRouter)
        const cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;
        const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens || 0;

        State.sessionCost.totalInputTokens += inputTokens;
        State.sessionCost.totalOutputTokens += outputTokens;
        State.sessionCost.cachedInputTokens += cachedTokens;
        State.sessionCost.reasoningTokens += reasoningTokens;
        State.sessionCost.requests += 1;

        // Calculate cost from model pricing
        const model = State.models.find(m => m.id === modelId);
        if (model?.pricing) {
            const inputPrice = model.pricing.input || 0;    // per 1M tokens
            const outputPrice = model.pricing.output || 0;
            const cachePrice = model.pricing.cacheInput ?? null;

            // Non-cached input tokens pay full price; cached tokens pay cache price (or 0)
            const uncachedInput = inputTokens - cachedTokens;
            const inputCost = (uncachedInput / 1_000_000) * inputPrice;
            const cacheCost = cachePrice !== null
                ? (cachedTokens / 1_000_000) * cachePrice
                : 0; // If no cache price in metadata, cached tokens are free
            const outputCost = (outputTokens / 1_000_000) * outputPrice;

            const totalCost = inputCost + cacheCost + outputCost;
            State.sessionCost.totalCost += totalCost;

            // Calculate cache savings (what we would have paid at full input price)
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
        let buffer = '';       // Handle partial SSE lines
        let inThinkBlock = false;
        let thinkBuffer = '';  // Buffer for detecting split </think> tags
        let hasToolCallsInResponse = false;  // Track if this response includes tool calls
        let streamError = null; // Captured from SSE error responses

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

                // --- Parse SSE chunk ---
                let parsed;
                try {
                    parsed = JSON.parse(data);
                } catch (e) {
                    // Not valid JSON — skip (partial line, keepalive, etc.)
                    continue;
                }

                // === Detect error responses embedded in SSE stream ===
                // Providers use varying error shapes:
                //   OpenAI:  { "error": { "message": "...", "type": "...", "code": ... } }
                //   Venice:  { "error": "ConnectionError: ...", "error_type": "..." }
                //   Generic: { "object": "error", "message": "...", "code": 400 }
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
                    // Store error and break out of stream — do NOT throw inside
                    // the line-parsing loop (it would be silently swallowed)
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

                    // Only apply think-block stripping if NO tool calls in response
                    // When tools are present, preserve full content for context
                    if (!hasToolCallsInResponse && !hasTools) {
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
            // If an error was captured inside the SSE line loop, stop reading
            if (streamError) break;
        }

        // Propagate stream errors — caller (handlers.js) has proper error recovery
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
- Find semantically relevant files using AI embeddings (find_relevant_files) — PREFERRED for discovery
- Create pull requests to submit work (create_pull_request)
- List open pull requests (list_pull_requests)
- Commit dirty editor files to Git (commit_files) — auto-generates commit message if not provided
- Check which files have uncommitted changes (list_dirty_files)
- List all available projects across connections (list_projects)
- Switch the active project and branch (set_active_project) — refuses if dirty files exist
- Persist notes to a scratchpad that survives context compression (scratchpad_write, scratchpad_read, scratchpad_clear)

📝 SCRATCHPAD — YOUR PERSISTENT MEMORY:
You have a scratchpad for notes that persist across the entire conversation, even when older messages are summarized away. This is critical for long tasks.

**ALWAYS write to the scratchpad when you:**
- Start a new task: note the goal, relevant files, and approach
- Discover important details: function signatures, file paths, config values, dependencies
- Make architectural decisions: record WHAT you decided and WHY
- Read an issue: save key requirements, acceptance criteria, edge cases
- Complete a sub-task: update progress so you remember what's done and what's next
- Encounter constraints: record gotchas, API quirks, or user preferences

**Scratchpad keys to use consistently:**
- "task" — current goal and approach
- "files" — key file paths and what they contain
- "progress" — what's done, what's next
- "decisions" — architectural choices with reasoning
- "context" — issue details, user requirements, constraints

**Example — starting work on an issue:**
  scratchpad_write("task", "Issue #42: Fix login timeout. Need to add retry logic in auth-handler.js")
  scratchpad_write("files", "js/auth-handler.js (login flow, line 85-120), js/retry.js (retry util)")
  scratchpad_write("progress", "Phase 1: Read issue ✓ | Phase 2: Implement retry | Phase 3: Test")

**Rules:**
- 10 entries max, 500 chars each — keep entries concise and updated, not append-only
- Overwrite stale entries rather than creating new ones
- The scratchpad contents appear in your context automatically — you don't need to read them manually
- Cleared when the user starts a new chat

🚨 EFFICIENCY RULES — AVOID UNNECESSARY TOOL CALLS:
1. **DO NOT re-read files or data you already have.** If a previous tool result showed you file contents, search results, or project structure — USE THAT DATA. Do not call the same tool again with the same arguments.
2. **Compressed results still contain key findings.** If you see "[File: path — N lines. Key symbols: ...]", those symbols ARE the file contents summary. Use read_lines only if you need specific line ranges not yet seen.
3. **Minimum tools needed.** Skip steps you don't need:
   - If you already know the project structure → skip get_project_tree
   - If you DON'T know which files to look at → use find_relevant_files (semantic search) FIRST
   - If you already know which file to edit → skip search_in_files
   - If you know the exact string to grep → use search_in_files directly
   - If the file is already open → skip open_file
   - If you have enough context to respond → just respond, no tools needed
4. **For edits, the minimum path is:** open_file (if not already open) → read_lines (target region only) → edit tool
5. **For investigation, scale to complexity:** Simple questions may need 0-1 tool calls. Complex refactors may need 4-6.

WORKFLOW — Use these tools as needed (not all are required every time):
0. **If no project is loaded** and the user asks you to do something with code/files → call list_projects to see what's available, then set_active_project to load one. Most tools require an active project.
1. scratchpad_write — note the task, plan, and key files BEFORE diving in
2. get_project_tree — understand the project structure (skip if you already know it)
3. **find_relevant_files — STRONGLY PREFERRED when you need to discover which files are relevant to a task or question.** This uses semantic/AI search and is much better than grep when you don't know exact function names or strings to search for. Use it for questions like "where is X handled?", "which files relate to Y?", or at the start of any new task to orient yourself.
4. search_in_files — find exact text patterns or identifiers (use when you KNOW the specific string/symbol to grep for)
5. read_lines — examine specific sections of candidate files (PREFERRED over full file reads)
5. open_file — switch to the file that needs editing (MUST do this before editing)
6. read_lines — see exact line numbers in the target region before editing
7. replace_lines / insert_lines / delete_lines — make targeted, SMALL edits (10-30 lines max)
8. create_file — if a new file is needed
9. commit_files — commit your changes when the user says to commit, or when a logical unit of work is complete. Uses list_dirty_files to preview what will be committed.
10. set_active_project — switch to a different project if the user asks to work on something else. Commit first if there are dirty files.
11. scratchpad_write — update progress after completing each phase

🚨 CRITICAL TOOL USAGE RULES:
1. **ALWAYS provide ALL required parameters for every tool call**
   - create_file: MUST include path, content, AND message (all 3 required)
   - replace_lines: MUST include start_line, end_line, AND new_content
   - insert_lines: MUST include after_line AND content
   - read_file/open_file: MUST include path
   - NEVER leave parameters empty, undefined, or incomplete

2. **ALWAYS call open_file BEFORE using edit tools**
   - replace_lines, insert_lines, delete_lines REQUIRE a file to be open first
   - You will get an error if you try to edit without opening a file
   - Workflow: open_file → read_lines (target area) → replace_lines

3. **If you hit token limits while generating large files:**
   - Create file with MINIMAL working content first (10-20 lines skeleton)
   - Then use replace_lines or insert_lines to add sections incrementally
   - NEVER try to generate 100+ lines in one create_file call

4. **For large code implementations:**
   - Break into phases: Phase 1 (core logic), Phase 2 (helpers), Phase 3 (UI)
   - Implement each phase separately with its own tool calls
   - Update the scratchpad "progress" entry after each phase

IMPORTANT RULES:
- Make SMALL, targeted edits. Replace 10-30 lines at a time, not 50+
- After editing, explain what you changed and which lines
- You can use multiple tools in sequence — but use the MINIMUM rounds needed
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

    // Inject active issue context (working on a branch for this issue)
    if (State.currentIssue) {
        const ci = State.currentIssue;
        prompt += `\n\n--- ACTIVE ISSUE ---\nCurrently working on issue #${ci.number}: ${ci.title}\nBranch: ${ci.branch}\nUse the read_issue tool with number ${ci.number} to get full issue details, body, and comments.\nWhen work is complete, use create_pull_request to submit changes for review.`;
    }

    // Inject focused issue context (triaging/reviewing an issue in chat)
    if (State.focusedIssue) {
        const fi = State.focusedIssue;
        let focusCtx = `\n\n--- FOCUSED ISSUE (TRIAGE MODE) ---`;
        focusCtx += `\nIssue #${fi.number}: ${fi.title}`;
        focusCtx += `\nState: ${fi.state || 'open'}`;
        if (fi.labels?.length) focusCtx += `\nLabels: ${fi.labels.join(', ')}`;
        if (fi.assignees?.length) focusCtx += `\nAssignees: ${fi.assignees.join(', ')}`;
        if (fi.createdAt) focusCtx += `\nCreated: ${fi.createdAt}`;
        focusCtx += `\n\nDescription:\n${fi.body || '(no description)'}`;

        // Include comments
        const comments = fi.issueComments || [];
        if (comments.length > 0) {
            focusCtx += `\n\nComments (${comments.length}):`;
            // Include last 5 comments to stay within reasonable token budget
            const shown = comments.slice(-5);
            if (comments.length > 5) focusCtx += `\n... (${comments.length - 5} earlier comments omitted)`;
            for (const c of shown) {
                const date = c.createdAt ? new Date(c.createdAt).toISOString().split('T')[0] : '';
                focusCtx += `\n\n[${c.user || 'unknown'} ${date}]\n${(c.body || '').slice(0, 500)}`;
            }
        }

        focusCtx += `\n\nYou are helping triage this issue. The user may ask you to:`;
        focusCtx += `\n- Find relevant code in the project using search_project, read_file, or scan tools`;
        focusCtx += `\n- Assess the impact, complexity, or validity of the issue`;
        focusCtx += `\n- Suggest an implementation approach`;
        focusCtx += `\n- Help decide whether to accept or deny the issue`;
        focusCtx += `\nBe specific and reference actual code when possible.`;
        prompt += focusCtx;
    }

    // Inject scratchpad (persistent LLM notes)
    prompt += buildScratchpadPrompt();

    // Inject embeddings status so the LLM knows semantic search is available
    const ctxStats = ContextManager.getStats();
    if (ctxStats.enabled && ctxStats.filesIndexed > 0) {
        prompt += `\n\n🔍 SEMANTIC SEARCH ACTIVE: The project "${ctxStats.project}" has ${ctxStats.filesIndexed} files indexed for semantic search. Use find_relevant_files to discover which files relate to a topic — it understands natural language queries like "error handling" or "authentication flow" and returns the most relevant files ranked by similarity. This is MUCH more effective than grep when you don't know exact identifiers.`;
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
// LLM TOOLS - Now managed by ToolRegistry
// ============================================

const LLMTools = {
    /**
     * Get all tool definitions from the registry.
     * @returns {Array} Array of tool definitions
     */
    get definitions() {
        const defs = ToolRegistry.getDefinitions();
        console.log('[LLMTools] Fetching definitions from registry, count:', defs.length);
        return defs;
    },

    /**
     * Get tool definitions filtered by the active role.
     * First gets tools from registry, then filters by role permissions.
     */
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
        
        prompt = `Generate a concise git commit message for the following changes across ${changedFiles.length} file(s).\n\n${fileDiffs}\n\nRespond with ONLY the commit message, no quotes or explanation. Use conventional commit format (feat:, fix:, refactor:, docs:, etc). If multiple files changed, summarize the overall change.`;
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
        model: commitModel,
        skipThinkStrip: true
    });

    // Use rawContent to survive think-block stripping (some models like minimax
    // wrap short utility responses in <think> blocks, and stripThinkBlocks at the
    // LLM layer can empty the content entirely).
    const raw = (result.rawContent || result.content || '').trim();
    let cleaned = stripThinkBlocks(raw).trim();
    if (!cleaned) {
        // Think-block stripping nuked everything — extract text from inside tags
        cleaned = raw.replace(/<\/?think>/gi, '').trim();
    }
    return (cleaned || 'Update files').replace(/^[\"']|[\"']$/g, '');
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
