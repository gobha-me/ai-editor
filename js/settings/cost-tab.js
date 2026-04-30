// @ts-check
/**
 * Settings → Cost tab (1.2.1).
 *
 * Renders the cost dashboard: live session card, 30-day SVG bar chart,
 * per-conversation list (linkable), per-tool breakdown for the active
 * conversation, budget alerts. Vanilla DOM — Memory tab in 1.3.0 is
 * the first Preact target, not this.
 *
 * @module settings/cost-tab
 */

import { State, EventBus } from '../core.js';
import { ConversationManager } from '../chat/conversations.js';
import {
    getConvCost,
    getDailySeries,
    getBudget,
    setBudget,
    getTodaySpend,
    getMonthSpend,
} from '../intelligence/cost/index.js';
import { escapeHtml, escapeAttr } from '../utils/html.js';

/** Selectors used in multiple places — kept in one spot for grep. */
const SEL = {
    session: 'costSessionGrid',
    chart: 'costChartContainer',
    chartTotal: 'costChartTotal',
    chartHover: 'costChartHover',
    convList: 'costConversationsList',
    convCount: 'costConversationsCount',
    toolsList: 'costToolsList',
    budgetDaily: 'settingCostBudgetDaily',
    budgetMonthly: 'settingCostBudgetMonthly',
    budgetDailyHint: 'costBudgetDailyHint',
    budgetMonthlyHint: 'costBudgetMonthlyHint',
    btnSaveBudget: 'btnSaveCostBudget',
    providerNote: 'costProviderNote',
};

let _wired = false;

/**
 * Wire event listeners + button handlers. Idempotent; only the first
 * call attaches DOM/EventBus listeners. Subsequent calls re-render.
 */
export function initCostTab() {
    populateCostTab();

    if (_wired) return;
    _wired = true;

    const btn = document.getElementById(SEL.btnSaveBudget);
    if (btn) btn.addEventListener('click', _onSaveBudget);

    EventBus.on('cost:updated', _onCostUpdated);
    EventBus.on('conversation:loaded', populateCostTab);
    EventBus.on('conversation:deleted', populateCostTab);
}

/** Re-render every section. Cheap — synchronous Storage reads. */
export function populateCostTab() {
    if (!document.getElementById(SEL.session)) return; // tab not yet in DOM
    _renderSessionCard();
    _renderChart();
    _renderConversationsList();
    _renderToolsList();
    _renderBudget();
    _renderProviderNote();
}

// ============================================
// Live session card
// ============================================

function _renderSessionCard() {
    const grid = document.getElementById(SEL.session);
    if (!grid) return;
    const sc = State.sessionCost || {};
    const cells = [
        ['Total cost', _fmtUSD(sc.totalCost || 0)],
        ['Input tokens', _fmtTokens(sc.totalInputTokens || 0)],
        ['Output tokens', _fmtTokens(sc.totalOutputTokens || 0)],
        ['Cached input', _fmtTokens(sc.cachedInputTokens || 0)],
        ['Cache savings', _fmtUSD(sc.cacheSavings || 0)],
        ['Reasoning', _fmtTokens(sc.reasoningTokens || 0)],
        ['Requests', String(sc.requests || 0)],
    ];
    grid.innerHTML = cells.map(([label, value]) => `
        <div style="display: flex; flex-direction: column; gap: 0.15rem;">
            <span style="font-size: var(--font-sm); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">${escapeHtml(label)}</span>
            <span style="font-size: var(--font-base); font-weight: 600;">${escapeHtml(value)}</span>
        </div>
    `).join('');
}

// ============================================
// 30-day chart (SVG, no chart lib)
// ============================================

function _renderChart() {
    const container = document.getElementById(SEL.chart);
    const totalEl = document.getElementById(SEL.chartTotal);
    const hoverEl = document.getElementById(SEL.chartHover);
    if (!container) return;

    const series = getDailySeries(30);
    const max = series.reduce((m, p) => Math.max(m, p.entry.cost || 0), 0);
    const total = series.reduce((s, p) => s + (p.entry.cost || 0), 0);
    if (totalEl) totalEl.textContent = `${_fmtUSD(total)} (30d)`;

    if (max === 0) {
        container.innerHTML = `
            <div style="height: 90px; display: flex; align-items: center; justify-content: center; color: var(--text-muted); font-size: var(--font-sm); border: 1px dashed var(--border); border-radius: 4px;">
                No spend recorded yet. Make a request to see usage here.
            </div>`;
        if (hoverEl) hoverEl.textContent = '';
        return;
    }

    const W = 600;
    const H = 90;
    const PAD_BOTTOM = 14;
    const barW = W / series.length - 2;
    const innerH = H - PAD_BOTTOM;

    const bars = series.map((p, i) => {
        const x = i * (W / series.length) + 1;
        const pct = max === 0 ? 0 : (p.entry.cost / max);
        const h = Math.max(pct * innerH, p.entry.cost > 0 ? 2 : 0);
        const y = innerH - h;
        const color = p.entry.cost > 0 ? 'var(--accent)' : 'var(--border)';
        return `<rect class="cost-bar" data-idx="${i}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="1" fill="${color}" />`;
    }).join('');

    const labels = `
        <text x="0" y="${H - 1}" font-size="9" fill="var(--text-muted)">${escapeHtml(series[0].date.slice(5))}</text>
        <text x="${W}" y="${H - 1}" text-anchor="end" font-size="9" fill="var(--text-muted)">${escapeHtml(series[series.length - 1].date.slice(5))}</text>
    `;

    container.innerHTML = `
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width: 100%; height: 90px; display: block;">
            ${bars}
            ${labels}
        </svg>
    `;

    container.querySelectorAll('.cost-bar').forEach((rect) => {
        rect.addEventListener('mouseenter', () => {
            const idx = Number((/** @type {SVGRectElement} */(rect)).dataset.idx);
            const p = series[idx];
            if (!p || !hoverEl) return;
            const providers = Object.entries(p.entry.byProvider || {})
                .map(([k, v]) => `${escapeHtml(k)}: ${_fmtUSD(v.cost)}`)
                .join(', ');
            hoverEl.textContent = `${p.date} · ${_fmtUSD(p.entry.cost)} · ${p.entry.requests || 0} req${providers ? ` · ${providers}` : ''}`;
        });
        rect.addEventListener('mouseleave', () => {
            if (hoverEl) hoverEl.textContent = '';
        });
    });
}

// ============================================
// Conversations list
// ============================================

function _renderConversationsList() {
    const list = document.getElementById(SEL.convList);
    const count = document.getElementById(SEL.convCount);
    if (!list) return;

    const conversations = ConversationManager.list();
    const activeId = ConversationManager.getActiveId();

    /** @type {Array<{id: string, title: string, updatedAt: number, cost: number, tokens: number, isActive: boolean, hasRecord: boolean}>} */
    const rows = conversations.map((c) => {
        const cc = getConvCost(c.id);
        return {
            id: c.id,
            title: c.title || 'New Chat',
            updatedAt: c.updatedAt,
            cost: cc?.cost || 0,
            tokens: (cc?.inputTokens || 0) + (cc?.outputTokens || 0),
            isActive: c.id === activeId,
            hasRecord: !!cc,
        };
    });
    rows.sort((a, b) => b.cost - a.cost);

    const tracked = rows.filter((r) => r.hasRecord).length;
    if (count) count.textContent = `${tracked} tracked`;

    if (rows.length === 0) {
        list.innerHTML = `<div style="padding: 1rem; color: var(--text-muted); font-size: var(--font-sm); text-align: center;">No conversations yet.</div>`;
        return;
    }

    list.innerHTML = `
        <table style="width: 100%; border-collapse: collapse; font-size: var(--font-md);">
            <thead>
                <tr style="position: sticky; top: 0; background: var(--bg-secondary); z-index: 1;">
                    <th style="padding: 0.4rem 0.5rem; text-align: left; border-bottom: 1px solid var(--border);">Conversation</th>
                    <th style="padding: 0.4rem 0.5rem; text-align: right; border-bottom: 1px solid var(--border);">Tokens</th>
                    <th style="padding: 0.4rem 0.5rem; text-align: right; border-bottom: 1px solid var(--border);">Cost</th>
                </tr>
            </thead>
            <tbody>
                ${rows.map((r) => `
                    <tr class="cost-conv-row" data-conv-id="${escapeAttr(r.id)}" style="cursor: pointer; ${r.isActive ? 'background: var(--bg-tertiary);' : ''}">
                        <td style="padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--border);">
                            <div style="font-weight: ${r.isActive ? 600 : 400};">${escapeHtml(r.title)}${r.isActive ? ' <span style="color: var(--text-muted); font-size: var(--font-sm);">· active</span>' : ''}</div>
                            <div style="font-size: var(--font-sm); color: var(--text-muted);">${escapeHtml(_fmtRelative(r.updatedAt))}${r.hasRecord ? '' : ' · no records'}</div>
                        </td>
                        <td style="padding: 0.4rem 0.5rem; text-align: right; border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums;">${escapeHtml(_fmtTokens(r.tokens))}</td>
                        <td style="padding: 0.4rem 0.5rem; text-align: right; border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums; font-weight: 600;">${escapeHtml(_fmtUSD(r.cost))}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;

    list.querySelectorAll('.cost-conv-row').forEach((row) => {
        row.addEventListener('click', () => {
            const id = (/** @type {HTMLElement} */(row)).dataset.convId;
            if (!id || id === ConversationManager.getActiveId()) return;
            ConversationManager.load(id);
            // Render path uses chat module; keep a soft re-render here too.
            populateCostTab();
        });
    });
}

// ============================================
// Per-tool list (active conversation)
// ============================================

function _renderToolsList() {
    const list = document.getElementById(SEL.toolsList);
    if (!list) return;

    const activeId = ConversationManager.getActiveId();
    const cc = activeId ? getConvCost(activeId) : null;
    const tools = cc?.byTool || {};
    const entries = Object.entries(tools).sort((a, b) => b[1].calls - a[1].calls);

    if (entries.length === 0) {
        list.innerHTML = `<div style="padding: 0.5rem; color: var(--text-muted); font-size: var(--font-sm);">No tool calls recorded for the active conversation.</div>`;
        return;
    }

    list.innerHTML = `
        <table style="width: 100%; border-collapse: collapse; font-size: var(--font-md);">
            <thead>
                <tr>
                    <th style="padding: 0.3rem 0.5rem; text-align: left; border-bottom: 1px solid var(--border); font-size: var(--font-sm); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">Tool</th>
                    <th style="padding: 0.3rem 0.5rem; text-align: right; border-bottom: 1px solid var(--border); font-size: var(--font-sm); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">Calls</th>
                    <th style="padding: 0.3rem 0.5rem; text-align: right; border-bottom: 1px solid var(--border); font-size: var(--font-sm); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">Est. tokens</th>
                </tr>
            </thead>
            <tbody>
                ${entries.map(([name, spend]) => `
                    <tr>
                        <td style="padding: 0.3rem 0.5rem; border-bottom: 1px solid var(--border); font-family: var(--font-mono); font-size: var(--font-sm);">${escapeHtml(name)}</td>
                        <td style="padding: 0.3rem 0.5rem; text-align: right; border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums;">${spend.calls}</td>
                        <td style="padding: 0.3rem 0.5rem; text-align: right; border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums;">${escapeHtml(_fmtTokens(spend.estTokens))}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

// ============================================
// Budget
// ============================================

function _renderBudget() {
    const dailyEl = /** @type {HTMLInputElement|null} */(document.getElementById(SEL.budgetDaily));
    const monthlyEl = /** @type {HTMLInputElement|null} */(document.getElementById(SEL.budgetMonthly));
    if (!dailyEl || !monthlyEl) return;

    const b = getBudget();
    dailyEl.value = b.daily != null ? String(b.daily) : '';
    monthlyEl.value = b.monthly != null ? String(b.monthly) : '';

    const dailyHint = document.getElementById(SEL.budgetDailyHint);
    const monthlyHint = document.getElementById(SEL.budgetMonthlyHint);
    const todaySpent = getTodaySpend();
    const monthSpent = getMonthSpend();

    if (dailyHint) {
        dailyHint.textContent = b.daily != null
            ? `Today: ${_fmtUSD(todaySpent)} of ${_fmtUSD(b.daily)}`
            : `Today: ${_fmtUSD(todaySpent)}`;
    }
    if (monthlyHint) {
        monthlyHint.textContent = b.monthly != null
            ? `This month: ${_fmtUSD(monthSpent)} of ${_fmtUSD(b.monthly)}`
            : `This month: ${_fmtUSD(monthSpent)}`;
    }
}

function _onSaveBudget() {
    const dailyEl = /** @type {HTMLInputElement|null} */(document.getElementById(SEL.budgetDaily));
    const monthlyEl = /** @type {HTMLInputElement|null} */(document.getElementById(SEL.budgetMonthly));
    if (!dailyEl || !monthlyEl) return;

    const daily = dailyEl.value === '' ? null : parseFloat(dailyEl.value);
    const monthly = monthlyEl.value === '' ? null : parseFloat(monthlyEl.value);
    setBudget({ daily, monthly });
    _renderBudget();
    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
        window.showToast('Budget saved', 'success');
    }
}

// ============================================
// Provider note
// ============================================

function _renderProviderNote() {
    const el = document.getElementById(SEL.providerNote);
    if (!el) return;

    const provider = State.settings.apiProvider || '';
    if (provider === 'venice') {
        el.innerHTML = `
            For your live Venice account balance and per-SKU breakdown, use the
            <strong>Venice billing</strong> toolbar button. This tab tracks tokens locally
            across every provider you use.
        `;
    } else {
        el.innerHTML = `
            Cost is computed from each provider's reported token usage and the per-million-token
            prices set under the <strong>Models</strong> tab. Providers without pricing
            (for example, local Ollama) report tokens but show $0.
        `;
    }
}

// ============================================
// Live updates
// ============================================

function _onCostUpdated() {
    // Only re-render if the modal is open AND the Cost tab is active —
    // cheap synchronous renders, but no point thrashing the DOM otherwise.
    const modal = document.getElementById('settingsModal');
    if (!modal || !modal.classList.contains('active')) return;
    const costTab = document.getElementById('tabCost');
    if (!costTab || !costTab.classList.contains('active')) return;
    populateCostTab();
}

// ============================================
// Formatters
// ============================================

function _fmtUSD(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '$0.00';
    if (n === 0) return '$0.00';
    if (n < 0.01) return '<$0.01';
    return `$${n.toFixed(2)}`;
}

function _fmtTokens(n) {
    if (typeof n !== 'number' || !isFinite(n) || n === 0) return '0';
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(2)}M`;
}

function _fmtRelative(ts) {
    if (!ts) return '—';
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString();
}
