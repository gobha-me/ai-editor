// ============================================
// LLM DEBUG MODAL
// ============================================

import { LLMDebug } from './llm.js';
import { EventBus } from './core.js';

function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderLLMDebug() {
    const container = document.getElementById('llmDebugContent');
    const countEl = document.getElementById('llmDebugCount');
    if (!container) return;

    countEl.textContent = LLMDebug.exchanges.length;

    if (LLMDebug.exchanges.length === 0) {
        container.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 2rem;">No LLM calls recorded yet. Send a chat message to start logging.</div>';
        return;
    }

    let html = '';
    for (const ex of LLMDebug.exchanges) {
        const status = ex.error ? '❌' : (ex.result?.toolCalls ? '🔧' : '✅');
        const toolInfo = ex.result?.toolCalls
            ? ` → ${ex.result.toolCalls.map(tc => tc.name).join(', ')}`
            : (ex.result ? ' → no tool_calls' : '');
        const dur = ex.durationMs ? ` ${ex.durationMs}ms` : ' …';

        html += `<details style="border-bottom: 1px solid var(--border);">`;
        html += `<summary style="padding: 0.5rem 1rem; cursor: pointer; background: var(--bg-secondary); user-select: none;">`;
        html += `<strong>${status} ${esc(ex.model)}</strong>`;
        html += ` <span style="color: var(--text-muted);">tools:${ex.toolsSent} msgs:${ex.msgCount}${dur}${esc(toolInfo)}</span>`;
        html += ` <span style="float:right; color: var(--text-muted);">${(ex.ts || '').slice(11, 19)}</span>`;
        html += `</summary>`;
        html += `<div style="padding: 0.5rem 1rem;">`;

        // Request messages
        html += `<div style="margin-bottom: 0.5rem;"><strong>📤 Request (${ex.msgCount} messages):</strong></div>`;
        for (const m of (ex.messages || [])) {
            let badge = m.role;
            if (m.hasToolCalls) badge += ' +tool_calls';
            if (m.toolCallId) badge += ` id=${m.toolCallId}`;
            html += `<div style="padding: 2px 0;"><span style="color: #6bf; font-weight: bold;">[${esc(badge)}]</span> <span style="color: var(--text-muted);">${esc(m.preview)}</span></div>`;
        }

        // Result
        html += `<div style="margin: 0.5rem 0;"><strong>📥 Result:</strong></div>`;
        if (ex.error) {
            html += `<div style="color: #f66;">ERROR: ${esc(ex.error)}</div>`;
        } else if (ex.result) {
            html += `<div>content: ${ex.result.contentLen} chars | finishReason: <strong>${esc(ex.result.finishReason || 'null')}</strong></div>`;
            if (ex.result.toolCalls) {
                html += `<div style="color: #6f6; font-weight: bold;">toolCalls: ${ex.result.toolCalls.length}</div>`;
                for (const tc of ex.result.toolCalls) {
                    html += `<div style="padding-left: 1rem;">🔧 <strong>${esc(tc.name)}</strong> (${esc(tc.id)}): <span style="color: var(--text-muted);">${esc(tc.argsPreview)}</span></div>`;
                }
            } else {
                html += `<div style="color: #fa0;">toolCalls: <strong>null</strong></div>`;
            }
            if (ex.result.contentPreview) {
                html += `<details style="margin-top: 4px;"><summary style="cursor: pointer; color: var(--text-muted);">Content preview…</summary><pre style="white-space: pre-wrap; max-height: 200px; overflow: auto; padding: 0.5rem; background: rgba(0,0,0,0.2); border-radius: 4px;">${esc(ex.result.contentPreview)}</pre></details>`;
            }
            if (ex.result.usage) {
                html += `<div style="color: var(--text-muted);">usage: ${esc(JSON.stringify(ex.result.usage))}</div>`;
            }
        } else {
            html += `<div style="color: var(--text-muted);">(pending…)</div>`;
        }

        // Think events
        if ((ex.thinkEvents || []).length > 0) {
            html += `<details style="margin-top: 4px;"><summary style="cursor: pointer; color: #fa0;">🧠 Think events (${ex.thinkEvents.length})</summary>`;
            for (const t of ex.thinkEvents) {
                html += `<div style="padding-left: 1rem;">@chunk${t.atChunk} <strong>${esc(t.event)}</strong>: ${esc(t.detail)}</div>`;
            }
            html += `</details>`;
        }

        // Raw SSE chunks
        html += `<details style="margin-top: 4px;"><summary style="cursor: pointer; color: var(--text-muted);">📡 Raw SSE chunks (${ex.chunks.length})</summary>`;
        html += `<div style="max-height: 400px; overflow: auto;">`;
        for (let i = 0; i < ex.chunks.length; i++) {
            const c = ex.chunks[i];
            const bg = c.parsed?.hasToolCalls ? 'rgba(0,255,0,0.08)' : (c.parsed?.finishReason ? 'rgba(255,200,0,0.08)' : 'transparent');
            html += `<div style="padding: 1px 0.5rem; background: ${bg}; border-bottom: 1px solid rgba(128,128,128,0.1);">`;
            html += `<span style="color: #888; min-width: 30px; display: inline-block;">${i}</span> `;
            if (c.parsed) {
                if (c.parsed.hasToolCalls) html += `<span style="color: #6f6; font-weight: bold;">🔧TC </span>`;
                if (c.parsed.hasContent) html += `<span style="color: #aaa;">📝"${esc((c.parsed.contentSnip || '').slice(0, 60))}"</span> `;
                if (c.parsed.finishReason) html += `<span style="color: #fa0;">⏹${esc(c.parsed.finishReason)}</span> `;
                if (c.parsed.hasUsage) html += `<span style="color: #6bf;">📊usage</span> `;
                if (c.parsed.toolCallDelta) html += `<span style="color: #6f6;">${esc(JSON.stringify(c.parsed.toolCallDelta).slice(0, 200))}</span>`;
            } else {
                html += `<span style="color: #888;">${esc(c.raw)}</span>`;
            }
            html += `</div>`;
        }
        html += `</div></details>`;

        html += `</div></details>`;
    }
    container.innerHTML = html;

    if (document.getElementById('llmDebugAutoScroll')?.checked) {
        container.scrollTop = container.scrollHeight;
    }
}

export function openLLMDebug() {
    renderLLMDebug();
    document.getElementById('llmDebugModal').classList.add('active');
}

export function closeLLMDebug() {
    document.getElementById('llmDebugModal').classList.remove('active');
}

export async function clearLLMDebug() {
    const { showConfirm } = await import('./ui/dialogs.js');
    if (await showConfirm('Clear all debug logs?', { title: 'Clear Logs', okLabel: 'Clear', variant: 'danger' })) {
        LLMDebug.clear();
        renderLLMDebug();
    }
}

export function copyLLMDebug() {
    const text = LLMDebug.exportText();
    navigator.clipboard.writeText(text).then(() => window.showToast?.('Debug log copied', 'success')).catch(e => console.error(e));
}

export function exportLLMDebug() {
    const text = LLMDebug.exportText();
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `llm-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
}

// Auto-refresh debug modal when open
export function initLLMDebugAutoRefresh() {
    EventBus.on('debug:exchangeDone', () => {
        if (document.getElementById('llmDebugModal')?.classList.contains('active')) {
            renderLLMDebug();
        }
    });
}
