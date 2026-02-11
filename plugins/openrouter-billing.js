/**
 * Plugin: OpenRouter Billing Dashboard
 *
 * Uses the same API key configured in LLM Settings — no separate key needed.
 *
 * Data tiers (graceful degradation based on key type):
 *   Regular API key:
 *     GET /api/v1/key — usage (all-time, daily, weekly, monthly), key limits
 *
 *   Provisioning key (superset — unlocks full dashboard):
 *     GET /api/v1/credits      — real account balance
 *     GET /api/v1/activity     — per-model per-day breakdown
 */

import { Plugins, State } from '../js/core.js';

const PLUGIN_ID = 'openrouter-billing';
const MODAL_ID  = 'openrouter-billing-modal';
const MAX_DAYS_BACK = 30;

// ═══════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════

let selectedDate = null;    // Date at midnight local
let dayCache     = {};      // 'YYYY-MM-DD' → activity rows[]
let keyCache     = null;    // /key response
let creditsCache = null;    // /credits response (null if unavailable)
let hasProvKey   = null;    // null = unknown, true/false after first fetch

// ═══════════════════════════════════════════
// PLUGIN
// ═══════════════════════════════════════════

const OpenRouterBillingPlugin = {
    id: PLUGIN_ID,
    name: 'OpenRouter Billing',
    version: '1.0.0',
    description: 'Usage dashboard for OpenRouter — uses your configured API key',
    author: 'Jeff',
    defaultEnabled: false,
    hooks: [],

    defaultConfig: {},
    configSchema: [],

    async init() {
        Plugins.registerButton(PLUGIN_ID, {
            icon: '📊',
            label: 'OpenRouter Billing',
            onClick: () => window.openPluginModal(MODAL_ID)
        });

        Plugins.registerModal(PLUGIN_ID, {
            id: MODAL_ID,
            title: '📊 OpenRouter Billing',
            width: '900px',
            render: (container) => renderDashboard(container)
        });

        console.log('[openrouter-billing] Initialized v1');
        return {};
    }
};

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════

function getEndpoint() {
    return (State.settings.llmEndpoint || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
}

function getApiKey() {
    return State.settings.llmApiKey || '';
}

function authHeaders() {
    return { 'Authorization': `Bearer ${getApiKey()}` };
}

function midnight(d) { const c = new Date(d); c.setHours(0, 0, 0, 0); return c; }
function dkey(d) { return d.toISOString().slice(0, 10); }

function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtUsd(n) {
    if (n >= 100)  return '$' + n.toFixed(2);
    if (n >= 1)    return '$' + n.toFixed(4);
    if (n >= 0.01) return '$' + n.toFixed(4);
    return '$' + n.toFixed(6);
}

function fmtTok(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
    return String(n);
}

function card(label, value, c1, c2) {
    return `<div style="background: linear-gradient(135deg, ${c1} 0%, ${c2} 100%); padding: 0.6rem 0.75rem; border-radius: 6px; color: white;">
        <div style="font-size: 10px; opacity: 0.8; text-transform: uppercase; letter-spacing: 0.5px;">${label}</div>
        <div style="font-size: 1.1rem; font-weight: 700; margin-top: 0.15rem; word-break: break-word;">${value}</div>
    </div>`;
}

function th() { return 'padding: 0.3rem 0.5rem; font-weight: 600;'; }
function td() { return 'padding: 0.3rem 0.5rem; border-bottom: 1px solid var(--border);'; }

function msgBox(title, sub, color) {
    return `<div style="text-align: center; padding: 2rem; color: ${color || 'var(--text-muted)'};">${title}<br><small>${sub || ''}</small></div>`;
}

// ═══════════════════════════════════════════
// DASHBOARD SHELL
// ═══════════════════════════════════════════

function renderDashboard(container) {
    selectedDate = midnight(new Date());

    if (!getApiKey()) {
        container.innerHTML = msgBox('⚠️ No API key configured.', 'Set your OpenRouter API key in Settings → LLM.', 'var(--text-warning, #f0ad4e)');
        return;
    }

    container.innerHTML = `
        <div id="orb-root" style="font-size: var(--font-md, 13px);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
                <div style="display: flex; align-items: center; gap: 0.4rem;">
                    <button type="button" id="orb-prev" class="btn btn-secondary" style="padding: 0.2rem 0.5rem; font-size: 12px;" title="Previous day">◀</button>
                    <span id="orb-date" style="font-weight: 600; min-width: 170px; text-align: center; font-size: 13px;"></span>
                    <button type="button" id="orb-next" class="btn btn-secondary" style="padding: 0.2rem 0.5rem; font-size: 12px;" title="Next day">▶</button>
                </div>
                <button type="button" class="btn btn-secondary" id="orb-refresh" style="font-size: 11px; padding: 0.2rem 0.5rem;">🔄</button>
            </div>
            <div id="orb-content"></div>
        </div>
    `;

    container.querySelector('#orb-prev').addEventListener('click', () => navDay(-1));
    container.querySelector('#orb-next').addEventListener('click', () => navDay(1));
    container.querySelector('#orb-refresh').addEventListener('click', () => {
        delete dayCache[dkey(selectedDate)];
        keyCache = null;
        creditsCache = null;
        hasProvKey = null;
        fetchAndRender();
    });

    syncDayPicker();
    fetchAndRender();
}

function navDay(delta) {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + delta);

    const today  = midnight(new Date());
    const oldest = new Date(today);
    oldest.setDate(oldest.getDate() - MAX_DAYS_BACK);

    if (d > today || d < oldest) return;
    selectedDate = d;
    syncDayPicker();
    fetchAndRender();
}

function syncDayPicker() {
    const el = document.getElementById('orb-date');
    if (el) el.textContent = selectedDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

    const today  = midnight(new Date());
    const oldest = new Date(today);
    oldest.setDate(oldest.getDate() - MAX_DAYS_BACK);

    const prev = document.getElementById('orb-prev');
    const next = document.getElementById('orb-next');
    if (prev) prev.disabled = (selectedDate <= oldest);
    if (next) next.disabled = (selectedDate >= today);
}

// ═══════════════════════════════════════════
// FETCH
// ═══════════════════════════════════════════

async function fetchAndRender() {
    const content = document.getElementById('orb-content');
    if (!content) return;

    const endpoint = getEndpoint();
    const headers  = authHeaders();

    try {
        content.innerHTML = msgBox('⏳', 'Fetching account data…');

        // 1. /key — always works with any API key
        if (!keyCache) {
            const r = await fetch(`${endpoint}/key`, { headers });
            if (!r.ok) throw new Error(`/key: ${r.status} ${r.statusText}`);
            keyCache = (await r.json()).data || {};
        }

        // 2. /credits — probe once to detect provisioning key
        if (hasProvKey === null) {
            try {
                const r = await fetch(`${endpoint}/credits`, { headers });
                if (r.ok) {
                    creditsCache = (await r.json()).data || {};
                    hasProvKey = true;
                } else {
                    hasProvKey = false;
                }
            } catch {
                hasProvKey = false;
            }
        }

        // 3. /activity?date= — provisioning key only
        const key = dkey(selectedDate);
        if (hasProvKey && !dayCache[key]) {
            content.innerHTML = msgBox('⏳', 'Fetching activity data…');
            try {
                const r = await fetch(`${endpoint}/activity?date=${key}`, { headers });
                if (r.ok) {
                    const json = await r.json();
                    dayCache[key] = json.data || [];
                } else {
                    dayCache[key] = [];
                }
            } catch {
                dayCache[key] = [];
            }
        }

        renderContent(content);

    } catch (err) {
        content.innerHTML = msgBox('❌ ' + esc(err.message), 'Check your API key and connection.', 'var(--text-danger, #d9534f)');
    }
}

// ═══════════════════════════════════════════
// AGGREGATION
// ═══════════════════════════════════════════

function aggregateActivity(rows) {
    const models = {};
    let totalCost = 0, totalRequests = 0;
    let totalPrompt = 0, totalCompletion = 0, totalReasoning = 0;

    for (const r of rows) {
        const name = r.model || 'unknown';
        if (!models[name]) {
            models[name] = {
                cost: 0, byokCost: 0, requests: 0,
                promptTokens: 0, completionTokens: 0, reasoningTokens: 0,
                providers: new Set()
            };
        }
        const m = models[name];
        m.cost             += r.usage || 0;
        m.byokCost         += r.byok_usage_inference || 0;
        m.requests         += r.requests || 0;
        m.promptTokens     += r.prompt_tokens || 0;
        m.completionTokens += r.completion_tokens || 0;
        m.reasoningTokens  += r.reasoning_tokens || 0;
        if (r.provider_name) m.providers.add(r.provider_name);

        totalCost       += r.usage || 0;
        totalRequests   += r.requests || 0;
        totalPrompt     += r.prompt_tokens || 0;
        totalCompletion += r.completion_tokens || 0;
        totalReasoning  += r.reasoning_tokens || 0;
    }

    return { models, totalCost, totalRequests, totalPrompt, totalCompletion, totalReasoning, totalTokens: totalPrompt + totalCompletion };
}

// ═══════════════════════════════════════════
// RENDER CONTENT
// ═══════════════════════════════════════════

function renderContent(container) {
    const kd = keyCache || {};

    // ── Balance ──
    let balanceStr;
    if (creditsCache) {
        const remaining = (creditsCache.total_credits || 0) - (creditsCache.total_usage || 0);
        balanceStr = fmtUsd(remaining);
    } else {
        balanceStr = '—';
    }

    // ── Key stats ──
    const usage    = kd.usage || 0;
    const daily    = kd.usage_daily || 0;
    const weekly   = kd.usage_weekly || 0;
    const monthly  = kd.usage_monthly || 0;
    const limit    = kd.limit;
    const limitRem = kd.limit_remaining;
    const freeTier = kd.is_free_tier;

    // ── Activity for selected day ──
    const key         = dkey(selectedDate);
    const hasActivity = hasProvKey && dayCache[key];
    const activity    = hasActivity ? dayCache[key] : [];
    const agg         = hasActivity ? aggregateActivity(activity) : null;

    const isToday = key === dkey(midnight(new Date()));

    const dayCostStr = agg ? fmtUsd(agg.totalCost) : isToday ? fmtUsd(daily) : '—';
    const dayReqStr  = agg ? agg.totalRequests.toLocaleString() : '—';

    // ── Cards ──
    let html = `
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 0.5rem; margin-bottom: 0.75rem;">
            ${card('Balance', balanceStr, '#1a5276', '#2471a3')}
            ${card('All-Time Used', fmtUsd(usage), '#6c3483', '#8e44ad')}
            ${card('Day Cost', dayCostStr, '#1e8449', '#27ae60')}
            ${card('Day Requests', dayReqStr, '#7d6608', '#b7950b')}
        </div>
    `;

    // ── Summary bar ──
    const parts = [];
    if (monthly > 0) parts.push(`Month: ${fmtUsd(monthly)}`);
    if (weekly > 0)  parts.push(`Week: ${fmtUsd(weekly)}`);
    if (daily > 0)   parts.push(`Today: ${fmtUsd(daily)}`);
    if (limit !== null && limit !== undefined) {
        parts.push(`Key limit: ${fmtUsd(limitRem ?? 0)} / ${fmtUsd(limit)}`);
    }
    if (freeTier) parts.push('Free tier');

    html += `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; font-size: 11px; color: var(--text-muted);">
            <div>${parts.join(' · ')}</div>
            <div>${hasProvKey
                ? '<span style="color: var(--success, #5cb85c);" title="Provisioning key — full activity data">● Full access</span>'
                : '<span title="Regular API key — summary only">○ Basic key</span>'
            }</div>
        </div>
    `;

    // ── Key limit bar ──
    if (limit !== null && limit !== undefined && limitRem !== null) {
        const used = limit - (limitRem || 0);
        const pct = limit > 0 ? (used / limit) * 100 : 0;
        const color = pct > 90 ? '#e74c3c' : pct > 70 ? '#f39c12' : '#2ecc71';
        html += `
            <div style="margin-bottom: 0.75rem;">
                <div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--text-muted); margin-bottom: 0.2rem;">
                    <span>Key Credit Limit</span>
                    <span>${fmtUsd(used)} / ${fmtUsd(limit)} used (${pct.toFixed(1)}%)</span>
                </div>
                <div style="height: 6px; background: var(--bg-secondary); border-radius: 3px; overflow: hidden;">
                    <div style="width: ${Math.min(pct, 100)}%; height: 100%; background: ${color}; border-radius: 3px; transition: width 0.3s;"></div>
                </div>
            </div>
        `;
    }

    // ── Model breakdown (provisioning key only) ──
    if (agg && activity.length > 0) {
        const sorted = Object.entries(agg.models)
            .map(([name, d]) => ({ name, ...d, providers: [...d.providers] }))
            .sort((a, b) => b.cost - a.cost);

        const maxCost = sorted[0]?.cost || 1;

        const rows = sorted.map(m => {
            const bar = Math.max(2, (m.cost / maxCost) * 100);
            const provTitle = m.providers.length > 0 ? `Providers: ${m.providers.join(', ')}` : '';
            const tokStr = `${fmtTok(m.promptTokens)} → ${fmtTok(m.completionTokens)}${m.reasoningTokens > 0 ? ` (${fmtTok(m.reasoningTokens)} 🧠)` : ''}`;

            return `<tr>
                <td style="${td()} white-space: nowrap;" title="${esc(provTitle)}">💬 <strong>${esc(m.name)}</strong></td>
                <td style="${td()} text-align: right;">${m.requests}</td>
                <td style="${td()} text-align: right; font-family: var(--font-mono, monospace); font-size: 11px;">${tokStr}</td>
                <td style="${td()} text-align: right; min-width: 140px;">
                    <div style="display: flex; align-items: center; justify-content: flex-end; gap: 0.4rem;">
                        <div style="flex: 1; max-width: 80px; height: 6px; background: var(--bg-secondary); border-radius: 3px; overflow: hidden;">
                            <div style="width: ${bar}%; height: 100%; background: linear-gradient(90deg, #3498db, #2ecc71); border-radius: 3px;"></div>
                        </div>
                        <span style="font-family: var(--font-mono, monospace); font-size: 11px;">${fmtUsd(m.cost)}</span>
                    </div>
                </td>
            </tr>`;
        }).join('');

        html += `
            <div style="margin-bottom: 0.75rem;">
                <h4 style="margin: 0 0 0.4rem 0; font-size: var(--font-base, 13px); font-weight: 600;">📊 Cost by Model</h4>
                <div style="max-height: 300px; overflow-y: auto; border: 1px solid var(--border); border-radius: 4px;">
                    <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
                        <thead><tr style="background: var(--bg-secondary); position: sticky; top: 0;">
                            <th style="${th()} text-align: left;">Model</th>
                            <th style="${th()} text-align: right;">Reqs</th>
                            <th style="${th()} text-align: right;">In → Out</th>
                            <th style="${th()} text-align: right;">Cost</th>
                        </tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>
            <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 0.75rem;">
                ${agg.totalRequests.toLocaleString()} requests ·
                ${fmtTok(agg.totalTokens)} tokens
                (${fmtTok(agg.totalPrompt)}↓ ${fmtTok(agg.totalCompletion)}↑${agg.totalReasoning > 0 ? ' ' + fmtTok(agg.totalReasoning) + ' 🧠' : ''})
            </div>
        `;
    } else if (hasProvKey === true) {
        html += `
            <div style="margin-bottom: 0.75rem;">
                <h4 style="margin: 0 0 0.4rem 0; font-size: var(--font-base, 13px); font-weight: 600;">📊 Cost by Model</h4>
                <div style="padding: 1rem; text-align: center; color: var(--text-muted); border: 1px solid var(--border); border-radius: 4px;">
                    No activity data for this day
                </div>
            </div>
        `;
    }

    // ── Upgrade hint (regular API key) ──
    if (!hasProvKey) {
        html += `
            <div style="margin-top: 0.75rem; padding: 0.75rem; background: var(--bg-secondary); border-radius: 6px; font-size: 12px; color: var(--text-muted);">
                <strong>💡 Tip:</strong> Use a
                <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener" style="color: var(--accent);">provisioning key</a>
                as your API key to unlock per-model breakdown, real account balance, and day-by-day history.
                With a regular key, Balance and historical Day Cost show "—" (only aggregate usage is available).
            </div>
        `;
    }

    container.innerHTML = html;
}

// ═══════════════════════════════════════════
// REGISTER
// ═══════════════════════════════════════════

Plugins.register(OpenRouterBillingPlugin);

export default OpenRouterBillingPlugin;
