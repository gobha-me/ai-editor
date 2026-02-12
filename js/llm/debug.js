/**
 * LLM Debug Logger
 * Ring-buffer that captures raw SSE data, parsed deltas, think-block filter
 * decisions, and final results for every LLM exchange.
 * Rendered by the 🔬 Debug Modal in index.html.
 * Extracted from llm.js in 0.9.13.
 */

import { EventBus } from '../core.js';

// ============================================
// LLM DEBUG LOGGER
// ============================================

export const LLMDebug = {
    exchanges: [],
    maxExchanges: 50,
    _current: null,

    /** Start a new exchange. Called at top of LLM.chat(). */
    startExchange(requestBody) {
        const exchange = {
            id: Date.now(),
            ts: new Date().toISOString(),
            model: requestBody.model,
            stream: requestBody.stream,
            toolsSent: requestBody.tools?.length || 0,
            msgCount: requestBody.messages?.length || 0,
            messages: requestBody.messages?.map(m => ({
                role: m.role,
                preview: typeof m.content === 'string'
                    ? m.content.slice(0, 150) + (m.content.length > 150 ? '…' : '')
                    : (m.content === null ? '<null>' : '<array>'),
                hasToolCalls: !!m.tool_calls,
                toolCallId: m.tool_call_id || null
            })),
            chunks: [],
            thinkEvents: [],
            result: null,
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
            atChunk: this._current.chunks.length
        });
    },

    /** Finalize the current exchange with the result. */
    endExchange(result) {
        if (!this._current) return;
        this._current.result = {
            contentLen: result.content?.length || 0,
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
            
            lines.push('--- MESSAGES ---');
            for (const m of (ex.messages || [])) {
                let desc = `[${m.role}]`;
                if (m.hasToolCalls) desc += ' (has tool_calls)';
                if (m.toolCallId) desc += ` (tool_call_id: ${m.toolCallId})`;
                desc += ` ${m.preview}`;
                lines.push(desc);
            }
            lines.push('');

            lines.push(`--- RAW SSE CHUNKS (${ex.chunks.length}) ---`);
            for (const c of ex.chunks) {
                lines.push(`RAW: ${c.raw}`);
                if (c.parsed) lines.push(`  → ${JSON.stringify(c.parsed)}`);
            }
            lines.push('');

            if (ex.thinkEvents.length > 0) {
                lines.push(`--- THINK BLOCK EVENTS (${ex.thinkEvents.length}) ---`);
                for (const t of ex.thinkEvents) {
                    lines.push(`  [chunk ${t.atChunk}] ${t.event}: ${t.detail}`);
                }
                lines.push('');
            }

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
