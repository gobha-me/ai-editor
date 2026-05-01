// ============================================
// LLM DEBUG MODAL
// ============================================

import { LLMDebug } from './llm.js';
import { EventBus } from './core.js';

function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Render the per-exchange Compactor diagnostics block. Returns HTML
 * suitable for splicing into the per-exchange details panel. Designed
 * to be the load-bearing surface for "what did compression actually
 * do this turn?" per ROADMAP §1.2.0.
 *
 * @param {object} diag  CompressionResult.diagnostics
 * @returns {string}
 */
function renderCompressionDiagnostics(diag) {
    const ratio = typeof diag.compression_ratio === 'number'
        ? (diag.compression_ratio * 100).toFixed(1) + '%'
        : 'n/a';
    const evictedCount = (diag.evicted_ids || []).length;
    const replacedCount = (diag.replaced_ids || []).length;
    const summarizedCount = (diag.summarized_spans || []).length;

    let html = '';
    html += `<details style="margin: 0.5rem 0; border-left: 2px solid #6bf; padding-left: 0.5rem;" open>`;
    html += `<summary style="cursor: pointer; color: #6bf;"><strong>📉 Compression decisions</strong> `;
    html += `<span style="color: var(--text-muted);">— ${evictedCount} evicted · ${replacedCount} replaced · ${summarizedCount} summarized · ratio ${ratio}</span>`;
    html += `</summary>`;
    html += `<div style="padding: 0.5rem 0;">`;

    // Token totals
    html += `<div>tokens_in: <strong>${diag.tokens_in}</strong> · tokens_out: <strong>${diag.tokens_out}</strong> · ratio: <strong>${ratio}</strong></div>`;

    // Rules run + per-rule decisions
    if ((diag.rules_run || []).length > 0) {
        html += `<div style="margin-top: 4px;">rules_run: ${(diag.rules_run || []).map(esc).join(', ')}</div>`;
    }
    if (diag.decisions_by_rule && Object.keys(diag.decisions_by_rule).length > 0) {
        html += `<div style="margin-top: 4px;">decisions_by_rule:</div>`;
        for (const [name, counts] of Object.entries(diag.decisions_by_rule)) {
            const parts = [];
            for (const [k, v] of Object.entries(counts || {})) {
                if (v > 0) parts.push(`${k}=${v}`);
            }
            html += `<div style="padding-left: 1rem;">${esc(name)}: ${parts.join(' · ') || '(no decisions)'}</div>`;
        }
    }

    // rules_skipped — the load-bearing diagnostic.
    if ((diag.rules_skipped || []).length > 0) {
        html += `<div style="margin-top: 4px; color: #fa0;">rules_skipped:</div>`;
        for (const s of diag.rules_skipped) {
            html += `<div style="padding-left: 1rem; color: #fa0;">${esc(s.rule)}: ${esc(s.reason)} · ${s.count} turns</div>`;
        }
    }

    // Evicted ids
    if ((diag.evicted_ids || []).length > 0) {
        html += `<details style="margin-top: 4px;"><summary style="cursor: pointer;">evicted_ids (${diag.evicted_ids.length})</summary>`;
        for (const e of diag.evicted_ids) {
            html += `<div style="padding-left: 1rem; font-family: monospace;">${esc(e.id)} · ${esc(e.rule)} · ${esc(e.reason)}</div>`;
        }
        html += `</details>`;
    }

    // Replaced ids
    if ((diag.replaced_ids || []).length > 0) {
        html += `<details style="margin-top: 4px;"><summary style="cursor: pointer;">replaced_ids (${diag.replaced_ids.length})</summary>`;
        for (const r of diag.replaced_ids) {
            html += `<div style="padding-left: 1rem; font-family: monospace;">${esc(r.id)} · ${esc(r.rule)} · ${esc(r.reason)}</div>`;
        }
        html += `</details>`;
    }

    // Summarized spans
    if ((diag.summarized_spans || []).length > 0) {
        html += `<div style="margin-top: 4px;">summarized_spans:</div>`;
        for (const s of diag.summarized_spans) {
            html += `<div style="padding-left: 1rem; font-family: monospace;">${esc(s.first_id)}..${esc(s.last_id)} · ${s.span_length} turns · ${Math.round(s.latency_ms)}ms</div>`;
        }
    }

    // Warnings
    if ((diag.warnings || []).length > 0) {
        html += `<div style="margin-top: 4px; color: #fa0;">warnings: ${diag.warnings.map(esc).join(', ')}</div>`;
    }

    // Rule errors
    if ((diag.rule_errors || []).length > 0) {
        html += `<div style="margin-top: 4px; color: #f66;">rule_errors:</div>`;
        for (const e of diag.rule_errors) {
            html += `<div style="padding-left: 1rem; color: #f66;">${esc(e.rule)}: ${esc(e.error)}</div>`;
        }
    }

    // Latency
    if (diag.latency_per_rule_ms && Object.keys(diag.latency_per_rule_ms).length > 0) {
        const parts = [];
        for (const [name, ms] of Object.entries(diag.latency_per_rule_ms)) {
            parts.push(`${esc(name)}=${ms.toFixed(2)}ms`);
        }
        html += `<div style="margin-top: 4px; color: var(--text-muted);">latency: ${parts.join(' · ')}`;
        if (diag.summarizer_latency_ms > 0) {
            html += ` · summarizer=${diag.summarizer_latency_ms.toFixed(0)}ms`;
        }
        html += `</div>`;
    }

    html += `</div></details>`;
    return html;
}

/**
 * Render the per-exchange Composer admission diagnostics block. Mirrors
 * `renderCompressionDiagnostics` shape so the AI tab reads consistently
 * across the two intelligence subsystems with debug surfaces today.
 *
 * Captures the §1.4.0 measurement contract: tool-definition tokens
 * (admitted vs role-filtered baseline vs ungated registry), with the
 * % reduction that gates promotion. The `?toolsCompose=off` kill-switch
 * path emits `admitted == baseline`, so this widget reads `0% reduction`
 * — verifiable in two clicks during the live demo.
 *
 * @param {object} diag  Composer ToolDiagnostics extended with
 *   `tokens_used` / `tool_def_tokens` / `tool_def_baseline` / `tool_def_unfiltered`.
 * @returns {string}
 * @since 1.3.18
 */
function renderToolDiagnostics(diag) {
    const admitted   = diag.tool_def_tokens     ?? diag.tokens_used ?? 0;
    const baseline   = diag.tool_def_baseline   ?? 0;
    const unfiltered = diag.tool_def_unfiltered ?? 0;
    const totalAdmitted = (diag.static_admitted || 0) + (diag.sticky_admitted || 0) + (diag.discovery_admitted || 0);

    const pctVsBaseline = baseline > 0
        ? ((baseline - admitted) / baseline) * 100
        : 0;
    const pctVsUnfiltered = unfiltered > 0
        ? ((unfiltered - admitted) / unfiltered) * 100
        : 0;

    let html = '';
    html += `<details style="margin: 0.5rem 0; border-left: 2px solid #6f6; padding-left: 0.5rem;" open>`;
    html += `<summary style="cursor: pointer; color: #6f6;"><strong>🛠️ Tool admission</strong> `;
    html += `<span style="color: var(--text-muted);">— ${totalAdmitted} admitted (${diag.static_admitted || 0} static + ${diag.sticky_admitted || 0} sticky) · ${admitted} tokens · ${pctVsBaseline.toFixed(1)}% reduction</span>`;
    html += `</summary>`;
    html += `<div style="padding: 0.5rem 0;">`;

    html += `<div>tool defs: <strong>${admitted}</strong> / <strong>${baseline}</strong> tokens `;
    html += `(<strong>${pctVsBaseline.toFixed(1)}%</strong> reduction vs role-filter baseline)</div>`;
    html += `<div>tool defs: <strong>${admitted}</strong> / <strong>${unfiltered}</strong> tokens `;
    html += `(<strong>${pctVsUnfiltered.toFixed(1)}%</strong> reduction vs ungated registry)</div>`;

    if (diag.suppressed > 0) {
        html += `<div style="margin-top: 4px; color: #fa0;">suppressed: ${diag.suppressed}</div>`;
    }

    if (Array.isArray(diag.unresolved_static) && diag.unresolved_static.length > 0) {
        html += `<div style="margin-top: 4px; color: #fa0;">unresolved_static (${diag.unresolved_static.length}): `;
        html += diag.unresolved_static.map(esc).join(', ') + `</div>`;
    }

    html += `</div></details>`;
    return html;
}

/**
 * Render the per-exchange detail HTML (request, compression, result,
 * think events, raw SSE chunks). Factored out of `renderLLMDebug` in
 * 1.3.9 so the new Debug slide-out's AI tab can reuse the exact same
 * markup on row expand without duplicating the surface.
 *
 * @param {object} ex  An entry from `LLMDebug.exchanges`.
 * @returns {string}   HTML body (no outer `<details>` wrapper).
 */
export function renderExchangeDetail(ex) {
    let html = '';
    html += `<div style="padding: 0.5rem 1rem;">`;

    // Request messages
    html += `<div style="margin-bottom: 0.5rem;"><strong>📤 Request (${ex.msgCount} messages):</strong></div>`;
    for (const m of (ex.messages || [])) {
        let badge = m.role;
        if (m.hasToolCalls) badge += ' +tool_calls';
        if (m.toolCallId) badge += ` id=${m.toolCallId}`;
        html += `<div style="padding: 2px 0;"><span style="color: #6bf; font-weight: bold;">[${esc(badge)}]</span> <span style="color: var(--text-muted);">${esc(m.preview)}</span></div>`;
    }

    // 1.2.0 — Compression decisions section.
    if (ex.compression) {
        html += renderCompressionDiagnostics(ex.compression);
    }

    // 1.3.18 — Tool admission diagnostics (Composer). The slot is
    // captured since 1.3.14 but only rendered here. Surfaces the
    // §1.4.0 measurement contract: admitted vs baseline vs unfiltered.
    if (ex.tools) {
        html += renderToolDiagnostics(ex.tools);
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

    html += `</div>`;
    return html;
}

export function renderLLMDebug() {
    const container = document.getElementById('llmDebugContent');
    const countEl = document.getElementById('llmDebugCount');
    if (!container) return;

    if (countEl) countEl.textContent = LLMDebug.exchanges.length;

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
        html += renderExchangeDetail(ex);
        html += `</details>`;
    }
    container.innerHTML = html;

    if (document.getElementById('llmDebugAutoScroll')?.checked) {
        container.scrollTop = container.scrollHeight;
    }
}

// 1.3.9: the standalone LLM debug modal is retired. The exported entry
// points stay so plugins / tests / window.* shims keep working — they
// now route into the Debug slide-out's "AI" tab. The data layer
// (LLMDebug.exchanges, renderExchangeDetail, exportText) is unchanged.

export async function openLLMDebug() {
    const { openDebugSlideOut } = await import('./debug-slideout.js');
    openDebugSlideOut('ai');
}

export async function closeLLMDebug() {
    const { closeDebugSlideOut } = await import('./debug-slideout.js');
    closeDebugSlideOut();
}

export async function clearLLMDebug() {
    const { showConfirm } = await import('./ui/dialogs.js');
    if (await showConfirm('Clear all debug logs?', { title: 'Clear Logs', okLabel: 'Clear', variant: 'danger' })) {
        LLMDebug.clear();
        // The slide-out subscribes to debug events and re-renders itself.
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

// 1.3.9: auto-refresh now lives inside `js/debug-slideout.js`, which
// subscribes to `debug:exchangeDone` and re-renders the AI tab when
// it's the active tab. This shim stays exported so app.js's import
// continues to resolve; calling it is a no-op.
export function initLLMDebugAutoRefresh() {
    /* no-op — see debug-slideout.js */
}
