// @ts-check
/**
 * LLM API Client
 * OpenAI-compatible chat completions with streaming, tool calling,
 * cost tracking, and provider-specific extensions.
 * Extracted from llm.js in 0.9.13.
 *
 * @module llm/api
 */

/**
 * @typedef {import('../core.js').ChatMessage} ChatMessage
 * @typedef {import('../core.js').ModelEntry} ModelEntry
 * @typedef {import('../core.js').Settings} Settings
 * @typedef {import('../tools/registry.js').ToolDefinition} ToolDefinition
 */

/**
 * @typedef {Object} LLMChatOptions
 * @property {string}    [model]
 * @property {boolean}   [stream=true]
 * @property {number}    [maxTokens] - If omitted, resolved dynamically from model metadata
 * @property {number}    [temperature=0.7]
 * @property {ToolDefinition[]|null} [tools=null]
 * @property {((token: string, full: string) => void)|null} [onToken=null]
 * @property {boolean}   [skipThinkStrip]
 */

/**
 * @typedef {Object} LLMUsage
 * @property {number}  [prompt_tokens]
 * @property {number}  [completion_tokens]
 * @property {{cached_tokens?: number}}       [prompt_tokens_details]
 * @property {{reasoning_tokens?: number}}    [completion_tokens_details]
 */

/**
 * @typedef {Object} ToolCallDelta
 * @property {string} id
 * @property {'function'} type
 * @property {{name: string, arguments: string}} function
 */

/**
 * @typedef {Object} LLMChatResult
 * @property {string}               content
 * @property {string}               [rawContent]
 * @property {ToolCallDelta[]|null}  toolCalls
 * @property {string}               finishReason
 * @property {LLMUsage|null}        usage
 */

/**
 * @typedef {Object} RequestBodyOptions
 * @property {boolean}              [stream=true]
 * @property {number}               [maxTokens] - If omitted, resolved from model metadata
 * @property {number}               [temperature=0.7]
 * @property {ToolDefinition[]|null} [tools=null]
 */

import { State, EventBus, Storage, Providers, ProviderRegistry, Plugins, Roles } from '../core.js';
import { applyModelOverrides } from '../providers/registry.js';
import { ToolRegistry } from '../tools/registry.js';
import { sanitizeMessages, stripThinkBlocks } from './utils.js';
import { LLMDebug } from './debug.js';
import { Catalog, composeAdmission, renderForLLM } from '../intelligence/tools/index.js';
import { CODER_V1 } from '../profiles/coder-v1.js';
import { isToolsComposeDisabled } from '../utils/tools-compose-flag.js';
import { getOrCreateLedger } from '../chat/task-state.js';
import { extractUsage } from '../intelligence/cost/usage-shape.js';
import { getPlanMode } from '../chat/state.js';
import { resolveScriptAutomationConfig, resolvePreviewConfig } from '../profiles/resolve.js';
import {
    EditorPrompts,
    buildSystemPrompt,
    buildEditPrompt,
    buildCommitMessagePrompt,
    getLanguageFromPath
} from '../prompts.js';

// ============================================
// CONTEXT-AWARE SCALING
// ============================================

/**
 * Tier-based multiplier so every hard ceiling scales with the model's
 * context window.  Used by output-token caps, summarizer clamps, and
 * tool-result truncation.
 *
 *   ≤ 32 K  →  1×   (current behaviour — safe for small models)
 *   ≤128 K  →  2×
 *   ≤512 K  →  4×
 *    > 512 K →  8×
 *
 * @param {string} [modelId] - Model to look up (defaults to current)
 * @returns {{contextTokens: number|null, scale: number}}
 */
export function getContextScale(modelId) {
    const id = modelId || State.settings.llmModel;
    const model = (State.models || []).find(m => m.id === id);
    const ctx = model?.meta?.contextTokens || null;

    if (!ctx || ctx <= 0) return { contextTokens: null, scale: 1 };

    let scale;
    if (ctx <= 32768)       scale = 1;
    else if (ctx <= 131072) scale = 2;
    else if (ctx <= 524288) scale = 4;
    else                    scale = 8;

    return { contextTokens: ctx, scale };
}

// ============================================
// MAX TOKENS RESOLUTION
// ============================================

/**
 * Purpose-based output token budgets.
 * Each entry: [fraction of context window, base cap].
 * The base cap is multiplied by getContextScale().scale at resolution time
 * so large-context models aren't artificially throttled.
 */
const TOKEN_BUDGETS = {
    chat:    [0.25, 16384],  // General conversation
    edit:    [0.40, 16384],  // Code generation needs room
    commit:  [0.05,  1024],  // Commit messages are tiny
    comment: [0.05,   512],  // PR comments are tiny
    notes:   [0.15,  4096],  // Release notes, analysis
    summary: [0.10,  2048],  // Conversation summaries
};

/**
 * Resolve max_tokens for a request.
 * Priority: user setting > purpose-based calculation > omit (let provider decide).
 *
 * The cap scales with the model's context tier so a 256 K model gets 4×
 * the headroom of a 32 K model, and a 1 M model gets 8×.
 *
 * @param {string} [modelId] - Model ID to look up (defaults to current)
 * @param {string} [purpose='chat'] - One of: chat, edit, commit, comment, notes, summary
 * @returns {number}
 */
export function resolveMaxTokens(modelId, purpose = 'chat') {
    // 1. User manual override always wins
    const userMax = State.settings.advancedParams?.max_tokens;
    if (userMax && userMax > 0) return userMax;

    // 2. Look up model context window
    const id = modelId || State.settings.llmModel;
    const { contextTokens, scale } = getContextScale(id);

    if (contextTokens && contextTokens > 0) {
        const [fraction, baseCap] = TOKEN_BUDGETS[purpose] || TOKEN_BUDGETS.chat;
        const scaledCap = baseCap * scale;
        return Math.min(Math.floor(contextTokens * fraction), scaledCap);
    }

    // 3. No model metadata available — return 0 so buildRequestBody
    //    omits max_tokens entirely. Providers like Venice.ai will
    //    automatically use the maximum supported for the selected model.
    //    Other OpenAI-compatible providers also handle omitted max_tokens
    //    by using their own defaults.
    return 0;
}

// ============================================
// REQUEST BODY BUILDER
// ============================================

/**
 * Build request body with provider-specific extensions.
 * @param {string} model
 * @param {ChatMessage[]} messages
 * @param {RequestBodyOptions} [options={}]
 * @returns {Object}
 */
export function buildRequestBody(model, messages, options = {}) {
    const {
        stream = true,
        maxTokens,
        temperature = 0.7,
        tools = null
    } = options;

    const sanitizedMessages = sanitizeMessages(messages);

    // Resolve output token budget: 0 means "let the provider auto-size"
    const resolvedMaxTokens = maxTokens ?? resolveMaxTokens(model, 'chat');

    const requestBody = {
        model,
        messages: sanitizedMessages,
        temperature,
        stream: stream === false ? false : true  // Enforce boolean; default always streams
    };

    // Only include max_tokens when we have a concrete budget.
    // When 0 or absent, providers like Venice.ai auto-select the model maximum.
    if (resolvedMaxTokens > 0) {
        requestBody.max_tokens = resolvedMaxTokens;
    }

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
    /** @type {AbortController|null} */
    abortController: null,

    // ========================================
    // MODELS
    // ========================================

    /**
     * Fetch available models from the LLM endpoint.
     * @returns {Promise<ModelEntry[]>}
     */
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

        // Async enrichment (e.g. Ollama /api/show for real capabilities)
        try {
            State.models = await Providers.enrichModels(State.models, State.settings);
        } catch (e) {
            console.warn('[LLM] Model enrichment failed (using defaults):', e.message);
        }

        // Apply any user-saved capability/context overrides
        applyModelOverrides(State.models, State.settings.modelOverrides);

        Storage.set('models', State.models);
        EventBus.emit('llm:modelsLoaded', State.models);
        return State.models;
    },

    /**
     * Fetch embedding models from the API endpoint.
     * Tries ?type=embedding query parameter first, falls back to filtering all models.
     * @returns {Promise<Array<{id: string, name: string, type: 'embedding', owned_by: string|null}>>}
     */
    async listEmbeddingModels() {
        // Per 1.1.2 the embedder has its own endpoint/key — fetch the
        // embedder catalog from the embedder, not the chat LLM. Provider
        // headers still come from `apiProvider` (chat-LLM provider) — no
        // chat provider sets headers that break /models on a sibling host.
        const endpoint = State.settings.embeddingEndpoint || '';
        const apiKey = State.settings.embeddingApiKey || '';
        if (!endpoint) {
            console.warn('[LLM] listEmbeddingModels: no embedder endpoint configured');
            return [];
        }
        const baseUrl = endpoint.replace(/\/$/, '');

        try {
            const response = await fetch(`${baseUrl}/models?type=embedding`, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
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
                    'Authorization': `Bearer ${apiKey}`,
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

    /**
     * Send a chat completion request.
     * @param {ChatMessage[]} messages
     * @param {LLMChatOptions} [options={}]
     * @returns {Promise<LLMChatResult>}
     */
    async chat(messages, options = {}) {
        const {
            model = State.settings.llmModel,
            stream = true,
            maxTokens,
            temperature = 0.7,
            tools = null,
            onToken = null
        } = options;

        State.isGenerating = true;
        this.abortController = new AbortController();
        EventBus.emit('llm:generating', true);

        // Non-stream wall-clock fallback. Streaming uses an idle-resetting
        // timer inside _handleStream(); for non-stream we have no chunk
        // boundary to reset on, so the same window doubles as a wall-clock
        // cap on the full request. In production this branch is not exercised
        // (chat handlers always pass stream:true), but keep abort semantics
        // correct so non-streaming consumers don't hang indefinitely.
        const idleMs = State.settings.llmIdleTimeout || 90000;
        let nonStreamTimer = null;
        let nonStreamTimedOut = false;
        if (!stream) {
            nonStreamTimer = setTimeout(() => {
                nonStreamTimedOut = true;
                try {
                    if (this.abortController) this.abortController.abort();
                } catch (_) { /* swallow */ }
            }, idleMs);
        }

        try {
            // === Plugin hook: beforeSend ===
            const hookData = await Plugins.runHook('beforeSend', {
                messages, model, tools, stream, maxTokens, temperature
            });
            // Plugins may return modified messages/model/tools
            const hookedMessages = hookData.messages || messages;
            const hookedModel = hookData.model || model;
            const hookedTools = hookData.tools !== undefined ? hookData.tools : tools;

            const requestBody = buildRequestBody(hookedModel, hookedMessages, {
                stream,
                maxTokens,
                temperature,
                tools: hookedTools
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
                let data;
                try {
                    data = await response.json();
                } catch (err) {
                    if (nonStreamTimedOut) {
                        throw new Error(`Idle timeout (${Math.round(idleMs/1000)}s) — no response received`);
                    }
                    throw err;
                }
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

            // === Plugin hook: afterResponse ===
            await Plugins.runHook('afterResponse', {
                content: result.content,
                model: hookedModel,
                result
            });

            this._trackUsage(result.usage, hookedModel, {
                messages: hookedMessages,
                toolCalls: result.toolCalls || null,
            });
            return result;

        } catch (err) {
            LLMDebug.logError(err);
            // Translate the non-stream wall-clock abort into a friendly message
            // so consumers see the same shape they got from streaming idle-timeouts.
            if (nonStreamTimedOut && err?.name === 'AbortError') {
                throw new Error(`Idle timeout (${Math.round(idleMs/1000)}s) — no response received`);
            }
            throw err;
        } finally {
            if (nonStreamTimer !== null) clearTimeout(nonStreamTimer);
            State.isGenerating = false;
            this.abortController = null;
            EventBus.emit('llm:generating', false);
        }
    },

    /**
     * Track token usage and estimated cost for the session.
     * @param {LLMUsage|null} usage
     * @param {string} modelId
     * @param {{messages?: ChatMessage[], toolCalls?: ToolCallDelta[]|null}} [context]
     *        Forwarded into the `cost:updated` event payload so the
     *        cost-recorder (1.2.1) can attribute per-tool spend.
     *        Existing consumers (model-manager.updateCostTracker) ignore.
     */
    _trackUsage(usage, modelId, context) {
        if (!usage) return;

        // 1.8.5 — single shape-tolerant extractor, mirrored in
        // cost-recorder.js so the live State.sessionCost can't drift on
        // field coverage with the persisted ConvCost.
        const {
            inputTokens,
            outputTokens,
            cachedTokens,
            reasoningTokens,
            cacheReadTokens,
            cacheCreationTokens,
        } = extractUsage(usage);

        // 1.6.4 — stash the wire-level prompt size so ChatSummarizer.shouldSummarize()
        // can gate on real token count rather than estimated message count.
        State.lastExchangeTokens = {
            prompt: inputTokens,
            cached: cachedTokens,
            ts: Date.now(),
        };

        State.sessionCost.totalInputTokens += inputTokens;
        State.sessionCost.totalOutputTokens += outputTokens;
        State.sessionCost.cachedInputTokens += cachedTokens;
        State.sessionCost.reasoningTokens += reasoningTokens;
        // 1.8.5 — defensive `|| 0` keeps live sessions from poisoning to
        // NaN when older browser sessions reload the page mid-stream and
        // pick up a sessionCost shape that predates these fields.
        State.sessionCost.cacheReadTokens     = (State.sessionCost.cacheReadTokens     || 0) + cacheReadTokens;
        State.sessionCost.cacheCreationTokens = (State.sessionCost.cacheCreationTokens || 0) + cacheCreationTokens;
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

        // 1.3.18 — forward the last Composer run's tool-definition token
        // metrics so the cost-recorder can persist them per turn. Reading
        // from `LLMTools._lastMetrics` (a sidecar slot set in
        // `getToolsForRole()`) rather than `LLMDebug._current` because
        // `endExchange()` clears `_current` before this runs. Defaults to
        // 0 when no Composer ran (e.g. first request before tools registry
        // populates) so the cost-store sums stay clean.
        const m = LLMTools._lastMetrics;
        EventBus.emit('cost:updated', {
            usage,
            sessionCost: State.sessionCost,
            modelId,
            messages: context?.messages,
            toolCalls: context?.toolCalls,
            toolDefTokens: m?.admitted ?? 0,
            toolDefBaseline: m?.baseline ?? 0,
            toolDefUnfiltered: m?.unfiltered ?? 0,
        });
    },

    /**
     * Process an SSE stream from the LLM.
     * @param {Response} response
     * @param {((token: string, full: string) => void)|null} onToken
     * @param {boolean} [hasTools=false]
     * @returns {Promise<LLMChatResult>}
     */
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
        let thinkEndTag = '</think>';  // set dynamically when opening tag found
        let hasToolCallsInResponse = false;
        let streamError = null;

        // Reasoning capture (1.3.1): accumulate <think>/<thinking> content
        // into a separate field rather than discarding it. The split-across-
        // chunks case (closing tag straddling SSE boundaries) is the
        // duplicated-preamble bug; explicit accumulation closes it.
        let reasoningContent = '';
        let reasoningStartedAt = null;
        let reasoningEndedAt = null;

        // Idle-timeout: reset per chunk arrival at the reader.read() boundary,
        // not at onToken — keep-alives, tool-call deltas, and think-tag chunks
        // all count as network activity even when no visible token reaches the UI.
        const idleMs = State.settings.llmIdleTimeout || 90000;
        let idleTimer = null;
        let idleTimedOut = false;
        const armIdle = (ms) => {
            if (idleTimer !== null) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                idleTimedOut = true;
                try {
                    if (this.abortController) this.abortController.abort();
                } catch (_) { /* swallow — controller may already be nulled */ }
            }, ms ?? idleMs);
        };
        const clearIdle = () => {
            if (idleTimer !== null) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
        };

        // Arm the idle timer at start with a generous initial window (3× normal).
        // This gives the LLM time to produce its first token for complex reasoning,
        // large context, or slow providers. After the first chunk arrives, we reset
        // to the normal timeout — gaps between chunks indicate a truly stalled connection.
        armIdle(idleMs * 3);

        try {
            while (true) {
                let readResult;
                try {
                    readResult = await reader.read();
                } catch (err) {
                    if (idleTimedOut) {
                        throw new Error(`Idle timeout (${Math.round(idleMs/1000)}s) — no tokens received`);
                    }
                    throw err;
                }
                const { done, value } = readResult;
                if (done) break;

                // Reset the idle timer to the normal timeout on every chunk arrival.
                armIdle();

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

                        // Think-block split (only when no tool calls).
                        // Reasoning is captured into reasoningContent rather than
                        // discarded — closes the duplicated-preamble streaming bug
                        // by construction (admissibility, not accumulation).
                        if (!hasToolCallsInResponse && !hasTools) {
                            if (inThinkBlock) {
                                thinkBuffer += chunk;
                                const endIdx = thinkBuffer.indexOf(thinkEndTag);
                                if (endIdx >= 0) {
                                    // Capture reasoning up to the closing tag
                                    reasoningContent += thinkBuffer.slice(0, endIdx);
                                    chunk = thinkBuffer.slice(endIdx + thinkEndTag.length);
                                    inThinkBlock = false;
                                    reasoningEndedAt = Date.now();
                                    LLMDebug.logThink('think-end', `Exited think block, remaining: "${chunk.slice(0, 60)}"`);
                                    thinkBuffer = '';
                                } else {
                                    // Closing tag not yet seen — flush all but the
                                    // last 11 chars (max len of "</thinking>") to
                                    // reasoning; keep the tail as a possible
                                    // straddling tag prefix.
                                    if (thinkBuffer.length > 12) {
                                        reasoningContent += thinkBuffer.slice(0, -11);
                                        thinkBuffer = thinkBuffer.slice(-11);
                                    }
                                    continue;
                                }
                            }

                            // Detect <think> or <thinking> open tags
                            const thinkMatch = chunk.match(/<think(?:ing)?>/i);
                            if (thinkMatch) {
                                const startIdx = thinkMatch.index;
                                const openTag = thinkMatch[0];
                                thinkEndTag = openTag.replace('<', '</');  // </think> or </thinking>
                                const before = chunk.slice(0, startIdx);
                                const afterStart = chunk.slice(startIdx + openTag.length);
                                const endIdx = afterStart.indexOf(thinkEndTag);
                                if (reasoningStartedAt === null) reasoningStartedAt = Date.now();
                                if (endIdx >= 0) {
                                    // Complete block in one chunk
                                    if (reasoningContent.length > 0) reasoningContent += '\n\n';
                                    reasoningContent += afterStart.slice(0, endIdx);
                                    reasoningEndedAt = Date.now();
                                    chunk = before + afterStart.slice(endIdx + thinkEndTag.length);
                                    LLMDebug.logThink('think-complete', `Complete think block in one chunk, kept: "${chunk.slice(0, 60)}"`);
                                } else {
                                    if (reasoningContent.length > 0) reasoningContent += '\n\n';
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
                                if (tc.function?.name && !toolCalls[tc.index].function.name) toolCalls[tc.index].function.name = tc.function.name;
                                if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
                            }
                        }
                    }
                }
                if (streamError) break;
            }
        } finally {
            clearIdle();
        }

        if (streamError) {
            throw streamError;
        }

        // If the stream ended mid-think (model cut off without closing tag),
        // flush whatever's in thinkBuffer as reasoning so it isn't lost.
        if (inThinkBlock && thinkBuffer.length > 0) {
            reasoningContent += thinkBuffer;
            reasoningEndedAt = Date.now();
        }

        let reasoning = null;
        const trimmed = reasoningContent.trim();
        if (trimmed.length > 0) {
            reasoning = {
                provider: State.settings.apiProvider || null,
                format: 'tag',
                content: trimmed,
                started_at: reasoningStartedAt,
                ended_at: reasoningEndedAt || reasoningStartedAt,
            };
        }

        return {
            content,
            reasoning,
            toolCalls: toolCalls.length > 0 ? toolCalls.filter(Boolean) : null,
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

/**
 * 1.3.18 — sum the per-tool token cost across an OpenAI-shape definition
 * list. Resolves each entry through the `Catalog` so `metadata.cost_estimate`
 * (`approxTokens(name+description) + approxTokens(schema)`) is the same
 * number the Composer sums into `result.tokens_used`. Tools the Catalog
 * cannot resolve fall back to a JSON-stringify length proxy so kill-switch
 * runs (whose tools never touch the Composer) still produce a defensible
 * baseline.
 *
 * @param {ToolDefinition[]} defs
 * @returns {number}
 */
function sumDefCosts(defs) {
    if (!Array.isArray(defs) || defs.length === 0) return 0;
    let total = 0;
    for (const d of defs) {
        const name = d?.function?.name;
        const td = name ? Catalog.getByName(name) : null;
        if (td) {
            total += td.metadata.cost_estimate;
            continue;
        }
        // Fallback: ~4 chars/token proxy on the JSON-stringified definition.
        // Mirrors `approxTokens` in catalog.js for unresolvable entries.
        try {
            total += Math.ceil(JSON.stringify(d).length / 4);
        } catch {
            // Unstringifiable — skip.
        }
    }
    return total;
}

/**
 * Thin facade over ToolRegistry — used by the chat loop to fetch
 * tool definitions with role-based filtering applied.
 */
export const LLMTools = {
    /** @returns {ToolDefinition[]} All registered tool definitions (unfiltered) */
    get definitions() {
        const defs = ToolRegistry.getDefinitions();
        console.log('[LLMTools] Fetching definitions from registry, count:', defs.length);
        return defs;
    },

    /**
     * Run the Composer for the active role, or report that it isn't
     * applicable. Pure read of registry + profile + flag; no diagnostics
     * emitted (callers that drive the LLM exchange decide whether to
     * stamp `LLMDebug`).
     *
     * @returns {{ result: import('../intelligence/tools/contracts.js').ToolAdmissionResult|null, composerActive: boolean, role: string }}
     * @private
     */
    _runComposer() {
        const role = State.settings.role;

        if (isToolsComposeDisabled()) {
            return { result: null, composerActive: false, role };
        }

        const useComposer = role === 'coder'
            && Array.isArray(CODER_V1.tools.static)
            && CODER_V1.tools.static.length > 0;

        if (!useComposer) {
            return { result: null, composerActive: false, role };
        }

        // 1.3.17 / Tools PR 4 — thread the per-conversation TaskLedger so
        // the Composer can re-admit non-static tools the model invoked on
        // a prior turn (`source: 'sticky'`). `getOrCreateLedger(null, ...)`
        // returns null, so a missing/empty conversation id stays
        // backwards-compatible with the 1.3.14 behavior.
        const conversationId = Storage.get('activeConversation', null);
        const ledger = getOrCreateLedger(conversationId, CODER_V1.name);

        const result = composeAdmission({
            task: 'chat',
            query: null,
            budget_tokens: CODER_V1.tools.budget_tokens,
            profile_static: CODER_V1.tools.static,
            task_ledger: ledger,
            user_groups: [role],
            discovery_call: null,
            expansion_mode: CODER_V1.tools.expansion_mode,
        });

        return { result, composerActive: true, role };
    },

    /**
     * Get tools for the active role.
     *
     * Two paths:
     *
     *   1. **Composer path** (default, 1.3.14+) — when a profile with a
     *      populated `tools.static` set is active and the
     *      `?toolsCompose=off` URL flag is *not* set, the static set is
     *      resolved through the `js/intelligence/tools/` Composer:
     *      authorization gate via `metadata.authorization.required_groups`,
     *      budget packing, skip-not-throw on unresolved names. Diagnostics
     *      land in `LLMDebug` for the next exchange.
     *
     *   2. **Legacy path** (kill-switch via `?toolsCompose=off`, plus the
     *      fallback when no profile carries a static set) — the pre-1.3.14
     *      behavior: every registered tool, role-filtered, every call.
     *
     * The roadmap §1.4.0 removability check requires the kill-switch.
     *
     * @returns {ToolDefinition[]}
     */
    getToolsForRole() {
        const defs = ToolRegistry.getDefinitions();
        console.log('[LLMTools] getToolsForRole: registry has', defs.length, 'tools');

        if (defs.length === 0) {
            console.warn('[LLMTools] ⚠️ ToolRegistry is empty! Tools may not be registered yet.');
            this._lastMetrics = null;
            return [];
        }

        // Plan Mode (github#25) — applied at the end of whichever branch
        // assembles the result. The filter is name-based because the
        // Composer's renderForLLM output is OpenAI-shape and strips the
        // registry's `readOnly` flag; we look up read-only-ness in the
        // registry by tool name to stay consistent across both paths.
        const planMode = getPlanMode();
        const readOnlyNames = planMode
            ? new Set(defs.filter(d => d.readOnly === true).map(d => d.function?.name).filter(Boolean))
            : null;
        const applyPlanModeFilter = (toolList) => {
            if (!planMode || !readOnlyNames) return toolList;
            const filtered = toolList.filter(t => {
                // Legacy path: raw registry def with `function.name`. Composer
                // path: OpenAI shape `{type, function: {name, ...}}`. Both
                // expose the name in the same place.
                const name = t?.function?.name;
                return typeof name === 'string' && readOnlyNames.has(name);
            });
            console.log('[LLMTools] Plan Mode active — filtered to', filtered.length, '/', toolList.length, 'read-only tools');
            return filtered;
        };

        // 1.16.0 — LLM-authored automation Phase 1.
        // Drop `submit_script_for_approval` from the per-turn tool list
        // when the resolved profile + settings overlay reports
        // `scriptAutomation.enabled === false`. Profile default is
        // coder=on / chat=off; settings overlay
        // (`State.settings.scriptAutomation.enabled`) wins when set.
        // The tool stays in the registry — the filter just prevents the
        // model from seeing it on this turn. Per
        // DESIGN-llm-authored-automation.md §"Failure Modes" row
        // *"Profile has scriptAutomation.enabled: false"*.
        const _scriptRole = State?.settings?.role || null;
        const scriptCfg = resolveScriptAutomationConfig(_scriptRole);
        const scriptOverlay = State?.settings?.scriptAutomation;
        const scriptEnabled = (scriptOverlay && typeof scriptOverlay.enabled === 'boolean')
            ? scriptOverlay.enabled
            : scriptCfg.enabled;
        const applyScriptAutomationFilter = (toolList) => {
            if (scriptEnabled) return toolList;
            return toolList.filter(t => t?.function?.name !== 'submit_script_for_approval');
        };

        // 1.22.0 — In-editor preview & verify Tier 1.
        // Drop the three preview tools (`preview_start`, `preview_stop`,
        // `preview_list`) from the per-turn tool list when the resolved
        // profile + settings overlay reports `preview.enabled === false`.
        // Profile default is coder=on / chat=off; settings overlay
        // (`State.settings.preview.enabled`) wins when set.
        // Mirror of `applyScriptAutomationFilter` above. Per
        // DESIGN-preview.md §"Profile / tool admission gating": catalog
        // admission via `coder.v1.tools.static` is the first gate; this
        // runtime filter is the second so the user can switch the
        // surface off without changing role.
        const _previewRole = State?.settings?.role || null;
        const previewCfg = resolvePreviewConfig(_previewRole);
        const previewOverlay = State?.settings?.preview;
        const previewEnabled = (previewOverlay && typeof previewOverlay.enabled === 'boolean')
            ? previewOverlay.enabled
            : previewCfg.enabled;
        const PREVIEW_TOOL_NAMES = new Set(['preview_start', 'preview_stop', 'preview_list']);
        const applyPreviewToolFilter = (toolList) => {
            if (previewEnabled) return toolList;
            return toolList.filter(t => !PREVIEW_TOOL_NAMES.has(t?.function?.name));
        };

        // 1.3.18 — baseline = what THIS request would have shipped without
        // the Composer (role-filtered legacy set). Unfiltered = ungated whole
        // registry. Both computed from `Catalog` so `metadata.cost_estimate`
        // (`approxTokens(name+description) + approxTokens(schema)`) is the
        // single source of truth for per-tool size — same number the Composer
        // sums into `result.tokens_used`.
        const baseline = sumDefCosts(Roles.filterTools(defs));
        const unfiltered = sumDefCosts(defs);

        const { result, composerActive, role } = this._runComposer();

        if (!composerActive) {
            const filtered = Roles.filterTools(defs);
            const filteredCost = sumDefCosts(filtered);
            const reason = isToolsComposeDisabled() ? 'kill-switch' : `no profile static set for role ${role}`;
            console.log('[LLMTools] Legacy path (', reason, '):', filtered.length, 'tools,', filteredCost, 'tokens (0% reduction)');
            // Emit metrics on the legacy path too so the dashboard zeroes
            // correctly — `admitted === baseline` ⇒ 0% reduction. Useful
            // diagnostic when `?toolsCompose=off` is flipped.
            this._lastMetrics = {
                admitted: filteredCost,
                baseline: filteredCost,
                unfiltered,
                role,
                composerActive: false,
            };
            return applyPreviewToolFilter(applyScriptAutomationFilter(applyPlanModeFilter(filtered)));
        }

        const reductionPct = baseline > 0
            ? ((baseline - result.tokens_used) / baseline) * 100
            : 0;

        // Stash diagnostics + token-cost baseline for the upcoming exchange.
        LLMDebug.attachToolDiagnostics({
            ...result.diagnostics,
            tokens_used: result.tokens_used,
            tool_def_tokens: result.tokens_used,
            tool_def_baseline: baseline,
            tool_def_unfiltered: unfiltered,
        });

        // 1.3.18 — sidecar metrics consumed by `_trackUsage()` after the
        // exchange finalizes (`LLMDebug._current` is null by then). Module-
        // level slot, single-conversation: overwritten on each composer run.
        this._lastMetrics = {
            admitted: result.tokens_used,
            baseline,
            unfiltered,
            role,
            composerActive: true,
        };

        const evictedCount = result.diagnostics.evicted_count || 0;
        const tokensEvicted = result.diagnostics.tokens_evicted || 0;
        console.log(
            '[LLMTools] Composer admitted', result.admitted.length,
            '(', result.diagnostics.static_admitted, 'static +',
            result.diagnostics.sticky_admitted, 'sticky)',
            '/', CODER_V1.tools.static.length, 'static declared;',
            'tool defs:', result.tokens_used, '/', baseline, 'tokens (',
            reductionPct.toFixed(1), '% reduction vs role-filter baseline);',
            evictedCount > 0 ? `evicted ${evictedCount} for ${tokensEvicted}t;` : '',
            'unresolved:', result.diagnostics.unresolved_static.join(',') || 'none'
        );

        return applyPreviewToolFilter(applyScriptAutomationFilter(applyPlanModeFilter(renderForLLM(result))));
    },

    /**
     * 1.3.18 — last Composer run's token metrics, set as a side effect of
     * `getToolsForRole()`. Read by `_trackUsage()` to forward into the
     * `cost:updated` event payload (the cost-recorder needs them per-turn).
     *
     * Single-slot: overwritten on each call; `null` when the registry is
     * empty. Reading from `LLMDebug._current` would be wrong because
     * `endExchange()` clears `_current` before `_trackUsage()` runs.
     *
     * @type {{admitted: number, baseline: number, unfiltered: number, role: string, composerActive: boolean}|null}
     */
    _lastMetrics: null,

    /**
     * Get the admitted `ToolDef[]` for the active role — the same admission
     * result that `getToolsForRole()` renders to the OpenAI tool-array, but
     * exposed as full `ToolDef`s so callers (notably `buildSystemPrompt()`)
     * can describe the admitted tools by name + description.
     *
     * Roadmap §1.3.15: closes the gap between what the Composer admits
     * (`renderForLLM` → API tools array) and what the system prompt claims
     * the model has access to.
     *
     * Re-resolves through `Catalog.getById()` so a registry mutation
     * between admit and lookup yields the registered shape (or drops the
     * tool silently — same contract as `renderForLLM`).
     *
     * Returns `{ admittedDefs: [], composerActive: false }` for non-coder
     * roles or when the kill-switch is engaged. Callers should fall back
     * to a static enumeration in that case.
     *
     * @returns {{ admittedDefs: import('../intelligence/tools/contracts.js').ToolDef[], composerActive: boolean }}
     */
    getAdmittedTools() {
        const defs = ToolRegistry.getDefinitions();
        if (defs.length === 0) {
            return { admittedDefs: [], composerActive: false };
        }

        const { result, composerActive } = this._runComposer();
        if (!composerActive) {
            return { admittedDefs: [], composerActive: false };
        }

        /** @type {import('../intelligence/tools/contracts.js').ToolDef[]} */
        const admittedDefs = [];
        for (const a of result.admitted) {
            const td = Catalog.getById(a.tool_id);
            if (td) admittedDefs.push(td);
        }
        return { admittedDefs, composerActive: true };
    }
};

// ============================================
// HIGH-LEVEL FUNCTIONS
// ============================================

/**
 * Generate a code edit based on a user request.
 * @param {string} request
 * @param {((token: string, full: string) => void)|null} [onToken=null]
 * @returns {Promise<LLMChatResult & {code: string}>}
 */
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
        maxTokens: resolveMaxTokens(undefined, 'edit')
    });

    const codeMatch = result.content.match(/```[\w]*\n([\s\S]*?)```/);
    return {
        ...result,
        code: codeMatch ? codeMatch[1].trim() : result.content
    };
}

/**
 * Generate a conventional commit message from changed files.
 * @param {Array<{path: string, content: string, originalContent: string}>|null} [changedFiles=null]
 * @returns {Promise<string>}
 */
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
        { role: 'system', content: 'You are a git commit message generator. Output ONLY the commit message — no thinking, no explanation, no quotes, no code fences. One line, conventional commit format (feat:, fix:, refactor:, docs:, chore:, etc).' },
        { role: 'user', content: commitPrompt }
    ], {
        model: commitModel,
        stream: false,
        temperature: 0.3
    });

    // Prefer .content (think-blocks stripped) over .rawContent
    let raw = (result.content || result.rawContent || '').trim();
    // Strip markdown code fences some models wrap commit messages in
    raw = raw.replace(/^```[\w]*\n?/gm, '').replace(/\n?```$/gm, '').trim();
    // Strip surrounding quotes
    return raw.replace(/^["']|["']$/g, '').trim();
}

/**
 * Analyze an issue and generate recommendations.
 * @param {{title: string, body: string, labels?: Array<{name: string}|string>}} issue
 * @param {((token: string, full: string) => void)|null} [onToken=null]
 * @returns {Promise<string>}
 */
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
        maxTokens: resolveMaxTokens(undefined, 'notes')
    });

    return result.content;
}
