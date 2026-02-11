/**
 * Plugin: Venice.ai Billing Dashboard v2
 *
 * Fixes from v1:
 *   - Fetches ALL pages for accurate daily totals (v1 capped at 5 pages, missing ~73% of data)
 *   - Removed currency dropdown — shows both DIEM + USD (DIEM burns first per epoch, then USD overages)
 *   - Fixed model name extraction for cache-input / cache-write SKUs
 *   - Day picker replaces range buttons — accurate 24hr view, navigable up to 30 days back
 *   - Paginated transaction log grouped by request (bottom section)
 *   - Parallel page fetching in batches of 5 for speed
 *
 * API Endpoints:
 *   GET /api/v1/api_keys/rate_limits  — balances, tier, rate limits, epoch
 *   GET /api/v1/billing/usage         — detailed SKU-level usage (paginated, no currency filter = both)
 */

import { Plugins } from '../js/core.js';

const PLUGIN_ID = 'venice-billing';
const MODAL_ID  = 'venice-billing-modal';

const API_PAGE_SIZE    = 500;
const FETCH_BATCH_SIZE = 5;
const MAX_DAYS_BACK    = 30;
const LOG_PAGE_SIZE    = 30;   // requests per page in transaction log

// ═══════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════

let selectedDate = null;   // Date at midnight local
let dayCache     = {};     // 'YYYY-MM-DD' → Entry[]
let rlCache      = null;   // rate-limit data (current, not per-day)
let logPage      = 1;

// ═══════════════════════════════════════════
// PLUGIN
// ═══════════════════════════════════════════

const VeniceBillingPlugin = {
    id: PLUGIN_ID,
    name: 'Venice.ai Billing',
    version: '2.0.0',
    description: 'Daily billing dashboard with accurate totals and browsable transaction history',
    author: 'Jeff',
    hooks: [],

    defaultConfig: {
        veniceUrl: 'https://api.venice.ai',
        adminApiKey: ''
    },

    configSchema: [
        { key: 'veniceUrl',   label: 'Venice API URL', type: 'text',     placeholder: 'https://api.venice.ai', help: 'Base URL for the Venice API' },
        { key: 'adminApiKey', label: 'Admin API Key',  type: 'password', placeholder: 'Your Venice admin API key', help: 'Requires an Admin-scoped key for billing endpoints' }
    ],

    async init() {
        Plugins.registerButton(PLUGIN_ID, {
            icon: '💰',
            label: 'Venice Billing',
            onClick: () => window.openPluginModal(MODAL_ID)
        });

        Plugins.registerModal(PLUGIN_ID, {
            id: MODAL_ID,
            title: '💰 Venice.ai Billing',
            width: '900px',
            render: (container) => renderDashboard(container)
        });

        console.log('[venice-billing] Initialized v2');
        return {};
    }
};

// ═══════════════════════════════════════════
// DASHBOARD SHELL
// ═══════════════════════════════════════════

function renderDashboard(container) {
    selectedDate = new Date();
    selectedDate.setHours(0, 0, 0, 0);
    logPage = 1;

    container.innerHTML = `
        <div id="vb-root" style="font-size: var(--font-md, 13px);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
                <div style="display: flex; align-items: center; gap: 0.4rem;">
                    <button id="vb-prev" class="btn btn-secondary" style="padding: 0.2rem 0.5rem; font-size: 12px;" title="Previous day">◀</button>
                    <span id="vb-date" style="font-weight: 600; min-width: 170px; text-align: center; font-size: 13px;"></span>
                    <button id="vb-next" class="btn btn-secondary" style="padding: 0.2rem 0.5rem; font-size: 12px;" title="Next day">▶</button>
                </div>
                <button class="btn btn-secondary" id="vb-refresh" style="font-size: 11px; padding: 0.2rem 0.5rem;">🔄</button>
            </div>
            <div id="vb-content"></div>
        </div>
    `;

    container.querySelector('#vb-prev').addEventListener('click', () => navDay(-1));
    container.querySelector('#vb-next').addEventListener('click', () => navDay(1));
    container.querySelector('#vb-refresh').addEventListener('click', () => {
        delete dayCache[dkey(selectedDate)];
        rlCache = null;
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
    logPage = 1;
    syncDayPicker();
    fetchAndRender();
}

function syncDayPicker() {
    const el = document.getElementById('vb-date');
    if (el) el.textContent = selectedDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

    const today  = midnight(new Date());
    const oldest = new Date(today);
    oldest.setDate(oldest.getDate() - MAX_DAYS_BACK);

    const prev = document.getElementById('vb-prev');
    const next = document.getElementById('vb-next');
    if (prev) prev.disabled = (selectedDate <= oldest);
    if (next) next.disabled = (selectedDate >= today);
}

// ═══════════════════════════════════════════
// FETCH
// ═══════════════════════════════════════════

async function fetchAndRender() {
    const content = document.getElementById('vb-content');
    if (!content) return;

    const config  = Plugins.getConfig(PLUGIN_ID);
    const baseUrl = (config.veniceUrl || 'https://api.venice.ai').replace(/\/+$/, '');
    const apiKey  = config.adminApiKey;

    if (!apiKey) {
        content.innerHTML = msgBox('⚠️ No Admin API Key configured.', 'Settings → Plugins → Venice.ai Billing', 'var(--text-warning, #f0ad4e)');
        return;
    }

    const headers = { 'Authorization': `Bearer ${apiKey}` };
    const key = dkey(selectedDate);

    try {
        // Rate limits (current account state — fetch once per session)
        if (!rlCache) {
            content.innerHTML = msgBox('⏳', 'Fetching account data…');
            const r = await fetch(`${baseUrl}/api/v1/api_keys/rate_limits`, { headers });
            if (!r.ok) throw new Error(`Rate limits: ${r.status} ${r.statusText}`);
            rlCache = (await r.json()).data || {};
        }

        // Usage for selected day (cached per day key)
        if (!dayCache[key]) {
            const start = selectedDate.toISOString();
            const end   = new Date(selectedDate.getTime() + 86400000).toISOString();

            content.innerHTML = msgBox('⏳', 'Fetching usage… <span id="vb-prog"></span>');

            // Page 1 → learn totalPages
            const first = await fetchPage(baseUrl, headers, start, end, 1);
            const all   = [...(first.data || [])];
            const total = first.pagination?.totalPages || 1;
            prog(1, total);

            // Remaining pages in parallel batches
            for (let b = 2; b <= total; b += FETCH_BATCH_SIZE) {
                const batch = [];
                for (let p = b; p < b + FETCH_BATCH_SIZE && p <= total; p++) {
                    batch.push(fetchPage(baseUrl, headers, start, end, p));
                }
                const results = await Promise.all(batch);
                for (const r of results) all.push(...(r.data || []));
                prog(Math.min(b + FETCH_BATCH_SIZE - 1, total), total);
            }

            dayCache[key] = all;
        }

        renderContent(content, rlCache, dayCache[key]);

    } catch (err) {
        content.innerHTML = msgBox('❌ ' + esc(err.message), 'Check your API key and connection.', 'var(--text-danger, #d9534f)');
    }
}

async function fetchPage(baseUrl, headers, startDate, endDate, page) {
    const params = new URLSearchParams({ limit: String(API_PAGE_SIZE), page: String(page), sortOrder: 'desc', startDate, endDate });
    const r = await fetch(`${baseUrl}/api/v1/billing/usage?${params}`, { headers });
    if (!r.ok) {
        if (r.status === 401 || r.status === 403) throw new Error('Billing endpoint requires Admin API key');
        throw new Error(`Usage page ${page}: ${r.status}`);
    }
    return r.json();
}

function prog(cur, total) {
    const el = document.getElementById('vb-prog');
    if (el) el.textContent = total > 1 ? `(page ${cur}/${total})` : '';
}

// ═══════════════════════════════════════════
// AGGREGATION
// ═══════════════════════════════════════════

function extractModel(sku) {
    return (sku || '')
        .replace(/-llm-(?:cache-)?(?:input|output|write)-mtoken$/, '')
        .replace(/-image-.*$/, '')
        .replace(/-embedding-.*$/, '');
}

function aggregate(entries) {
    // Phase 1 — group SKU lines into requests (skip non-inference entries like credit purchases)
    const reqs = {};
    for (const e of entries) {
        const sku = e.sku || '';
        if (!sku.includes('-mtoken') && !sku.includes('-image-')) continue;
        const id  = e.inferenceDetails?.requestId || `_${e.timestamp}`;
        const amt = Math.abs(e.amount || 0);
        if (!reqs[id]) {
            reqs[id] = {
                model: extractModel(e.sku),
                currency: e.currency || 'USD',
                cost: 0,
                prompt: e.inferenceDetails?.promptTokens || 0,
                completion: e.inferenceDetails?.completionTokens || 0,
                execTime: e.inferenceDetails?.inferenceExecutionTime || 0,
                timestamp: e.timestamp,
                type: (e.sku || '').includes('embedding') ? '🔢' : (e.sku || '').includes('image') ? '🖼️' : '💬'
            };
        }
        reqs[id].cost += amt;
    }

    // Phase 2 — aggregate requests into models + totals
    const models = {};
    const totals = { USD: 0, DIEM: 0, tokens: 0, requestCount: 0, entryCount: entries.length };

    for (const rq of Object.values(reqs)) {
        if (!models[rq.model]) {
            models[rq.model] = { USD: 0, DIEM: 0, inputTokens: 0, outputTokens: 0, requestCount: 0, totalExecTime: 0, type: rq.type };
        }
        const m = models[rq.model];
        m[rq.currency]      += rq.cost;
        m.inputTokens        += rq.prompt;
        m.outputTokens       += rq.completion;
        m.requestCount++;
        m.totalExecTime      += rq.execTime;
        totals[rq.currency]  += rq.cost;
        totals.tokens        += rq.prompt + rq.completion;
        totals.requestCount++;
    }

    // Phase 3 — sorted request list for transaction log
    const reqList = Object.values(reqs).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return { models, totals, reqList };
}

// ═══════════════════════════════════════════
// RENDER CONTENT
// ═══════════════════════════════════════════

function renderContent(container, rl, entries) {
    const bal  = rl.balances || {};
    const usd  = parseFloat(bal.USD  || 0);
    const diem = parseFloat(bal.DIEM || 0);
    const tier = rl.apiTier?.id || 'unknown';
    const charged = rl.apiTier?.isCharged;

    const { models, totals, reqList } = aggregate(entries);

    // Epoch countdown
    let epochHtml = '';
    if (rl.nextEpochBegins) {
        const ms = new Date(rl.nextEpochBegins) - new Date();
        if (ms > 0) {
            epochHtml = `Epoch resets in <strong>${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m</strong>`;
        } else {
            epochHtml = `<span style="color: var(--text-success, #5cb85c);">Epoch reset recently</span>`;
        }
    }

    // Sorted models by total cost
    const sorted = Object.entries(models)
        .map(([name, d]) => ({ name, ...d, totalCost: d.USD + d.DIEM }))
        .sort((a, b) => b.totalCost - a.totalCost);

    const maxCost = sorted[0]?.totalCost || 1;

    const modelRows = sorted.map(m => {
        const avgMs = m.requestCount ? Math.round(m.totalExecTime / m.requestCount) : 0;
        const bar   = Math.max(2, (m.totalCost / maxCost) * 100);
        return `<tr>
            <td style="${td()} white-space: nowrap;">${m.type} <strong>${esc(m.name)}</strong></td>
            <td style="${td()} text-align: right;">${m.requestCount}</td>
            <td style="${td()} text-align: right; font-family: var(--font-mono, monospace); font-size: 11px;">${fmtTok(m.inputTokens)} / ${fmtTok(m.outputTokens)}</td>
            <td style="${td()} text-align: right;">${avgMs > 0 ? avgMs + 'ms' : '-'}</td>
            <td style="${td()} text-align: right; min-width: 150px;">
                <div style="display: flex; align-items: center; justify-content: flex-end; gap: 0.4rem;">
                    <div style="flex: 1; max-width: 80px; height: 6px; background: var(--bg-secondary); border-radius: 3px; overflow: hidden;">
                        <div style="width: ${bar}%; height: 100%; background: linear-gradient(90deg, #3498db, #2ecc71); border-radius: 3px;"></div>
                    </div>
                    <span style="font-family: var(--font-mono, monospace); font-size: 11px;">${fmtCost(m.USD, m.DIEM)}</span>
                </div>
            </td>
        </tr>`;
    }).join('');

    // Transaction log
    const totalLogPages = Math.max(1, Math.ceil(reqList.length / LOG_PAGE_SIZE));
    if (logPage > totalLogPages) logPage = totalLogPages;
    const pageReqs = reqList.slice((logPage - 1) * LOG_PAGE_SIZE, logPage * LOG_PAGE_SIZE);

    const logRows = pageReqs.map(rq => {
        const t = new Date(rq.timestamp);
        const time = t.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        return `<tr>
            <td style="${td()} white-space: nowrap; font-family: var(--font-mono, monospace); font-size: 11px;">${time}</td>
            <td style="${td()} white-space: nowrap;">${rq.type} ${esc(rq.model)}</td>
            <td style="${td()} text-align: right; font-family: var(--font-mono, monospace); font-size: 11px;">${fmtTok(rq.prompt)} → ${fmtTok(rq.completion)}</td>
            <td style="${td()} text-align: right; font-family: var(--font-mono, monospace); font-size: 11px;">${fmtSingle(rq.cost, rq.currency)}</td>
        </tr>`;
    }).join('');

    const pager = buildPager(logPage, totalLogPages);

    container.innerHTML = `
        <!-- Balance cards -->
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 0.5rem; margin-bottom: 0.75rem;">
            ${card('USD Balance', '$' + usd.toFixed(2),       '#1a5276', '#2471a3')}
            ${card('DIEM Balance', diem.toFixed(4),           '#6c3483', '#8e44ad')}
            ${card('Day Cost',    fmtCost(totals.USD, totals.DIEM), '#1e8449', '#27ae60')}
            ${card('Requests',    totals.requestCount.toLocaleString(), '#7d6608', '#b7950b')}
        </div>

        <!-- Tier + epoch bar -->
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; font-size: 11px; color: var(--text-muted);">
            <div>
                <span style="display: inline-block; padding: 0.1rem 0.4rem; border-radius: 3px; font-weight: 600; background: ${tier === 'paid' ? '#27ae6022' : '#95a5a622'}; color: ${tier === 'paid' ? '#27ae60' : '#95a5a6'}; text-transform: uppercase; font-size: 10px;">${esc(tier)}${charged ? ' · charged' : ''}</span>
                <span style="margin-left: 0.5rem;">${totals.entryCount.toLocaleString()} billing entries · ${fmtTok(totals.tokens)} tokens</span>
            </div>
            <div>${epochHtml}</div>
        </div>

        <!-- Model breakdown -->
        <div style="margin-bottom: 0.75rem;">
            <h4 style="margin: 0 0 0.4rem 0; font-size: var(--font-base, 13px); font-weight: 600;">📊 Cost by Model</h4>
            ${sorted.length === 0
                ? '<div style="padding: 1rem; text-align: center; color: var(--text-muted);">No usage data for this day</div>'
                : `<div style="max-height: 260px; overflow-y: auto; border: 1px solid var(--border); border-radius: 4px;">
                    <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
                        <thead><tr style="background: var(--bg-secondary); position: sticky; top: 0;">
                            <th style="${th()} text-align: left;">Model</th>
                            <th style="${th()} text-align: right;">Reqs</th>
                            <th style="${th()} text-align: right;">In / Out</th>
                            <th style="${th()} text-align: right;">Avg Latency</th>
                            <th style="${th()} text-align: right;">Cost</th>
                        </tr></thead>
                        <tbody>${modelRows}</tbody>
                    </table>
                </div>`
            }
        </div>

        <!-- Transaction log -->
        <div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem;">
                <h4 style="margin: 0; font-size: var(--font-base, 13px); font-weight: 600;">📋 Transactions</h4>
                <span style="font-size: 11px; color: var(--text-muted);">${reqList.length.toLocaleString()} requests · page ${logPage}/${totalLogPages}</span>
            </div>
            ${reqList.length === 0
                ? '<div style="padding: 1rem; text-align: center; color: var(--text-muted);">No transactions</div>'
                : `<div style="max-height: 300px; overflow-y: auto; border: 1px solid var(--border); border-radius: 4px;">
                    <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
                        <thead><tr style="background: var(--bg-secondary); position: sticky; top: 0;">
                            <th style="${th()} text-align: left;">Time</th>
                            <th style="${th()} text-align: left;">Model</th>
                            <th style="${th()} text-align: right;">In → Out</th>
                            <th style="${th()} text-align: right;">Cost</th>
                        </tr></thead>
                        <tbody>${logRows}</tbody>
                    </table>
                </div>
                ${totalLogPages > 1 ? `<div id="vb-pager" style="display: flex; justify-content: center; gap: 0.2rem; margin-top: 0.5rem;">${pager}</div>` : ''}
            `}
        </div>
    `;

    // Wire pager clicks
    container.querySelectorAll('[data-vbpage]').forEach(btn => {
        btn.addEventListener('click', () => {
            logPage = parseInt(btn.dataset.vbpage, 10);
            renderContent(container, rl, entries);
        });
    });
}

// ═══════════════════════════════════════════
// PAGINATION CONTROLS
// ═══════════════════════════════════════════

function buildPager(current, total) {
    const pages = pageRange(current, total);
    return pages.map(p => {
        if (p === '…') return `<span style="padding: 0.2rem 0.3rem; font-size: 11px; color: var(--text-muted);">…</span>`;
        const active = p === current;
        return `<button data-vbpage="${p}" class="btn btn-secondary" style="padding: 0.15rem 0.45rem; font-size: 11px; min-width: 28px; ${active ? 'font-weight: 700; text-decoration: underline;' : ''}">${p}</button>`;
    }).join('');
}

function pageRange(cur, total) {
    if (total <= 7) return seq(1, total);
    const p = [1];
    const lo = Math.max(2, cur - 1);
    const hi = Math.min(total - 1, cur + 1);
    if (lo > 2) p.push('…');
    for (let i = lo; i <= hi; i++) p.push(i);
    if (hi < total - 1) p.push('…');
    p.push(total);
    return p;
}

function seq(a, b) { return Array.from({ length: b - a + 1 }, (_, i) => a + i); }

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════

function midnight(d) { d.setHours(0, 0, 0, 0); return d; }
function dkey(d) { return d.toISOString().slice(0, 10); }

function fmtCost(usd, diem) {
    const parts = [];
    if (diem > 0.000001) parts.push(fmtNum(diem) + ' DIEM');
    if (usd  > 0.000001) parts.push('$' + fmtNum(usd));
    return parts.join(' + ') || '$0.00';
}

function fmtSingle(amount, currency) {
    if (currency === 'USD') return '$' + fmtNum(amount);
    return fmtNum(amount) + ' D';
}

function fmtNum(n) {
    if (n >= 100)  return n.toFixed(2);
    if (n >= 1)    return n.toFixed(4);
    return n.toFixed(6);
}

function fmtTok(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
    return String(n);
}

function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
// REGISTER
// ═══════════════════════════════════════════

Plugins.register(VeniceBillingPlugin);

export default VeniceBillingPlugin;
