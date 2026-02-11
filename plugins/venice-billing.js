/**
 * Plugin: Venice.ai Billing Dashboard
 * 
 * Registers a toolbar button that opens a modal showing Venice.ai
 * billing analytics: balances, usage breakdown by model, token costs,
 * and time-based filtering.
 * 
 * API Endpoints used:
 *   GET /api/v1/api_keys/rate_limits  — balances, tier, rate limits, epoch
 *   GET /api/v1/billing/usage         — detailed SKU-level usage (paginated)
 * 
 * Configuration (Settings → Plugins):
 *   veniceUrl:     Venice API base URL (default: https://api.venice.ai)
 *   adminApiKey:   Admin-scoped API key for billing access
 */

import { Plugins } from '../js/core.js';

const PLUGIN_ID = 'venice-billing';
const MODAL_ID = 'venice-billing-modal';

const VeniceBillingPlugin = {
    id: PLUGIN_ID,
    name: 'Venice.ai Billing',
    version: '1.0.0',
    description: 'Dashboard showing Venice.ai balances, usage analytics, and cost breakdown by model',
    author: 'Jeff',

    hooks: [],

    defaultConfig: {
        veniceUrl: 'https://api.venice.ai',
        adminApiKey: ''
    },

    configSchema: [
        {
            key: 'veniceUrl',
            label: 'Venice API URL',
            type: 'text',
            placeholder: 'https://api.venice.ai',
            help: 'Base URL for the Venice API'
        },
        {
            key: 'adminApiKey',
            label: 'Admin API Key',
            type: 'password',
            placeholder: 'Your Venice admin API key',
            help: 'Requires an Admin-scoped key for billing endpoints'
        }
    ],

    async init(config) {
        Plugins.registerButton(PLUGIN_ID, {
            icon: '💰',
            label: 'Venice Billing',
            onClick: () => window.openPluginModal(MODAL_ID)
        });

        Plugins.registerModal(PLUGIN_ID, {
            id: MODAL_ID,
            title: '💰 Venice.ai Billing Dashboard',
            width: '850px',
            render: (container) => renderBillingDashboard(container)
        });

        console.log('[venice-billing] Initialized');
        return {};
    }
};

// ============================================
// STATE
// ============================================

let currentRange = 'today';  // today | 7d | 30d | custom
let cachedUsage = null;

// ============================================
// DASHBOARD RENDER
// ============================================

function renderBillingDashboard(container) {
    container.innerHTML = `
        <div id="vb-root" style="font-size: var(--font-md, 13px);">
            <!-- Controls -->
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; flex-wrap: wrap; gap: 0.5rem;">
                <div style="display: flex; gap: 0.25rem;" id="vb-range-btns">
                    <button class="btn btn-secondary vb-range-btn active" data-range="today" style="font-size: 11px; padding: 0.2rem 0.5rem;">Today</button>
                    <button class="btn btn-secondary vb-range-btn" data-range="7d" style="font-size: 11px; padding: 0.2rem 0.5rem;">7 Days</button>
                    <button class="btn btn-secondary vb-range-btn" data-range="30d" style="font-size: 11px; padding: 0.2rem 0.5rem;">30 Days</button>
                    <button class="btn btn-secondary vb-range-btn" data-range="all" style="font-size: 11px; padding: 0.2rem 0.5rem;">All Time</button>
                </div>
                <div style="display: flex; gap: 0.25rem; align-items: center;">
                    <select id="vb-currency" style="font-size: 11px; padding: 0.2rem 0.3rem;">
                        <option value="DIEM">DIEM</option>
                        <option value="USD">USD</option>
                        <option value="Both">Both</option>
                    </select>
                    <button class="btn btn-secondary" id="vb-refresh" style="font-size: 11px; padding: 0.2rem 0.5rem;">🔄 Refresh</button>
                </div>
            </div>
            <!-- Content -->
            <div id="vb-content">
                <div style="text-align: center; padding: 2rem; color: var(--text-muted);">Loading…</div>
            </div>
        </div>
    `;

    // Wire range buttons
    container.querySelectorAll('.vb-range-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            container.querySelectorAll('.vb-range-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentRange = btn.dataset.range;
            cachedUsage = null;
            fetchAndRender();
        });
    });

    container.querySelector('#vb-currency')?.addEventListener('change', () => {
        cachedUsage = null;
        fetchAndRender();
    });
    container.querySelector('#vb-refresh')?.addEventListener('click', () => {
        cachedUsage = null;
        fetchAndRender();
    });

    fetchAndRender();
}

// ============================================
// DATA FETCHING
// ============================================

async function fetchAndRender() {
    const content = document.getElementById('vb-content');
    if (!content) return;

    const config = Plugins.getConfig(PLUGIN_ID);
    const baseUrl = (config.veniceUrl || 'https://api.venice.ai').replace(/\/+$/, '');
    const apiKey = config.adminApiKey;

    if (!apiKey) {
        content.innerHTML = `
            <div style="text-align: center; padding: 2rem; color: var(--text-warning, #f0ad4e);">
                ⚠️ No Admin API Key configured.<br>
                <small>Go to Settings → Plugins → Venice.ai Billing to add your key.</small>
            </div>
        `;
        return;
    }

    content.innerHTML = `<div style="text-align: center; padding: 2rem; color: var(--text-muted);">⏳ Fetching billing data…</div>`;

    const headers = { 'Authorization': `Bearer ${apiKey}` };
    const currency = document.getElementById('vb-currency')?.value || 'DIEM';

    try {
        // Fetch balances + rate limits
        const rlRes = await fetch(`${baseUrl}/api/v1/api_keys/rate_limits`, { headers });
        if (!rlRes.ok) throw new Error(`Rate limits: ${rlRes.status} ${rlRes.statusText}`);
        const rlData = (await rlRes.json()).data || {};

        // Fetch usage data (paginated — grab up to 5 pages for dashboard)
        const { startDate, endDate } = getDateRange(currentRange);
        
        let usageEntriesDiem = [];
        let usageEntriesUsd = [];
        const maxPages = 5;

        // If "Both" is selected, fetch both DIEM and USD separately
        if (currency === 'Both') {
            // Fetch DIEM data
            let page = 1;
            while (page <= maxPages) {
                const params = new URLSearchParams({
                    currency: 'DIEM',
                    limit: '500',
                    page: String(page),
                    sortOrder: 'desc'
                });
                if (startDate) params.set('startDate', startDate);
                if (endDate) params.set('endDate', endDate);

                const usageRes = await fetch(`${baseUrl}/api/v1/billing/usage?${params}`, { headers });
                if (!usageRes.ok) {
                    if (usageRes.status === 403 || usageRes.status === 401) {
                        throw new Error('Billing endpoint requires Admin API key');
                    }
                    throw new Error(`Usage: ${usageRes.status} ${usageRes.statusText}`);
                }
                const usageJson = await usageRes.json();
                const entries = usageJson.data || [];
                usageEntriesDiem.push(...entries);

                const pagination = usageJson.pagination;
                if (!pagination || page >= (pagination.totalPages || 1)) break;
                page++;
            }

            // Fetch USD data
            page = 1;
            while (page <= maxPages) {
                const params = new URLSearchParams({
                    currency: 'USD',
                    limit: '500',
                    page: String(page),
                    sortOrder: 'desc'
                });
                if (startDate) params.set('startDate', startDate);
                if (endDate) params.set('endDate', endDate);

                const usageRes = await fetch(`${baseUrl}/api/v1/billing/usage?${params}`, { headers });
                if (!usageRes.ok) {
                    if (usageRes.status === 403 || usageRes.status === 401) {
                        throw new Error('Billing endpoint requires Admin API key');
                    }
                    throw new Error(`Usage: ${usageRes.status} ${usageRes.statusText}`);
                }
                const usageJson = await usageRes.json();
                const entries = usageJson.data || [];
                usageEntriesUsd.push(...entries);

                const pagination = usageJson.pagination;
                if (!pagination || page >= (pagination.totalPages || 1)) break;
                page++;
            }

            renderDashboard(content, rlData, usageEntriesDiem, usageEntriesUsd, currency);
        } else {
            // Single currency mode
            const usageEntries = [];
            let page = 1;
            while (page <= maxPages) {
                const params = new URLSearchParams({
                    currency,
                    limit: '500',
                    page: String(page),
                    sortOrder: 'desc'
                });
                if (startDate) params.set('startDate', startDate);
                if (endDate) params.set('endDate', endDate);

                const usageRes = await fetch(`${baseUrl}/api/v1/billing/usage?${params}`, { headers });
                if (!usageRes.ok) {
                    if (usageRes.status === 403 || usageRes.status === 401) {
                        throw new Error('Billing endpoint requires Admin API key');
                    }
                    throw new Error(`Usage: ${usageRes.status} ${usageRes.statusText}`);
                }
                const usageJson = await usageRes.json();
                const entries = usageJson.data || [];
                usageEntries.push(...entries);

                const pagination = usageJson.pagination;
                if (!pagination || page >= (pagination.totalPages || 1)) break;
                page++;
            }

            renderDashboard(content, rlData, usageEntries, null, currency);
        }
    } catch (err) {
        content.innerHTML = `
            <div style="text-align: center; padding: 2rem; color: var(--text-danger, #d9534f);">
                ❌ ${esc(err.message)}<br>
                <small>Check your API key and connection settings.</small>
            </div>
        `;
    }
}

function getDateRange(range) {
    const now = new Date();
    let startDate = null;
    const endDate = now.toISOString();

    switch (range) {
        case 'today': {
            const start = new Date(now);
            start.setHours(0, 0, 0, 0);
            startDate = start.toISOString();
            break;
        }
        case '7d': {
            const start = new Date(now);
            start.setDate(start.getDate() - 7);
            startDate = start.toISOString();
            break;
        }
        case '30d': {
            const start = new Date(now);
            start.setDate(start.getDate() - 30);
            startDate = start.toISOString();
            break;
        }
        case 'all':
        default:
            // No date filter
            break;
    }

    return { startDate, endDate };
}

// ============================================
// AGGREGATION
// ============================================

function aggregateUsage(entries) {
    const models = {};   // model → { inputTokens, outputTokens, inputCost, outputCost, requests, totalExecTime }
    let totalCost = 0;
    let totalTokens = 0;
    let totalRequests = new Set();

    for (const entry of entries) {
        const sku = entry.sku || '';
        const amount = Math.abs(entry.amount || 0);
        const tokens = entry.inferenceDetails?.promptTokens || entry.inferenceDetails?.completionTokens || 0;
        const execTime = entry.inferenceDetails?.inferenceExecutionTime || 0;
        const reqId = entry.inferenceDetails?.requestId;
        const isOutput = sku.includes('-output-');
        const isInput = sku.includes('-input-');

        // Extract model name from SKU: "kimi-k2-5-llm-output-mtoken" → "kimi-k2-5"
        const modelName = sku.replace(/-llm-(input|output)-mtoken$/, '')
                             .replace(/-image-.*$/, '')
                             .replace(/-embedding-.*$/, '');

        if (!models[modelName]) {
            models[modelName] = {
                inputTokens: 0, outputTokens: 0,
                inputCost: 0, outputCost: 0,
                requests: new Set(),
                totalExecTime: 0,
                skuPrefix: sku.includes('embedding') ? 'embedding' :
                           sku.includes('image') ? 'image' : 'text'
            };
        }

        const m = models[modelName];

        if (isInput) {
            m.inputTokens += entry.inferenceDetails?.promptTokens || 0;
            m.inputCost += amount;
        } else if (isOutput) {
            m.outputTokens += entry.inferenceDetails?.completionTokens || 0;
            m.outputCost += amount;
        }

        if (reqId) {
            m.requests.add(reqId);
            totalRequests.add(reqId);
        }
        m.totalExecTime += execTime;
        totalCost += amount;
        totalTokens += (entry.inferenceDetails?.promptTokens || 0) + (entry.inferenceDetails?.completionTokens || 0);
    }

    // Convert Sets to counts
    for (const m of Object.values(models)) {
        m.requestCount = m.requests.size;
        delete m.requests;
    }

    return {
        models,
        totalCost,
        totalTokens,
        totalRequests: totalRequests.size,
        entryCount: entries.length
    };
}

// ============================================
// RENDER DASHBOARD
// ============================================

function renderDashboard(container, rl, usageEntriesDiem, usageEntriesUsd, currency) {
    const balances = rl.balances || {};
    const usd = parseFloat(balances.USD || 0);
    const diem = parseFloat(balances.DIEM || 0);
    const tier = rl.apiTier?.id || 'unknown';
    const isCharged = rl.apiTier?.isCharged;
    const epochReset = rl.nextEpochBegins;
    const rateLimits = rl.rateLimits || [];

    // Handle "Both" mode: aggregate both currencies separately then merge
    let agg, aggDiem, aggUsd;
    if (currency === 'Both') {
        aggDiem = aggregateUsage(usageEntriesDiem);
        aggUsd = aggregateUsage(usageEntriesUsd);
        // Merge model data
        const mergedModels = {};
        
        // Add DIEM models
        for (const [name, data] of Object.entries(aggDiem.models)) {
            mergedModels[name] = {
                ...data,
                diemCost: data.inputCost + data.outputCost,
                usdCost: 0
            };
        }
        
        // Add USD models
        for (const [name, data] of Object.entries(aggUsd.models)) {
            if (mergedModels[name]) {
                mergedModels[name].usdCost = data.inputCost + data.outputCost;
            } else {
                mergedModels[name] = {
                    ...data,
                    diemCost: 0,
                    usdCost: data.inputCost + data.outputCost
                };
            }
        }
        
        agg = {
            models: mergedModels,
            totalCostDiem: aggDiem.totalCost,
            totalCostUsd: aggUsd.totalCost,
            totalTokens: aggDiem.totalTokens + aggUsd.totalTokens,
            totalRequests: aggDiem.totalRequests + aggUsd.totalRequests,
            entryCount: aggDiem.entryCount + aggUsd.entryCount
        };
    } else {
        // Single currency mode
        agg = aggregateUsage(usageEntriesDiem);
    }
    
    const sym = currency === 'USD' ? '$' : '';
    const unit = currency === 'USD' ? '' : ' DIEM';
    
    // Epoch countdown
    let epochHtml = '';
    if (epochReset) {
        const reset = new Date(epochReset);
        const diffMs = reset - new Date();
        if (diffMs > 0) {
            const hrs = Math.floor(diffMs / 3600000);
            const mins = Math.floor((diffMs % 3600000) / 60000);
            epochHtml = `Epoch resets in <strong>${hrs}h ${mins}m</strong>`;
        } else {
            epochHtml = `<span style="color: var(--text-success, #5cb85c);">Epoch reset recently</span>`;
        }
    }

    // Sort models by total cost descending
    const sortedModels = Object.entries(agg.models)
        .map(([name, data]) => {
            if (currency === 'Both') {
                return { name, ...data, totalCost: (data.diemCost || 0) + (data.usdCost || 0) };
            } else {
                return { name, ...data, totalCost: data.inputCost + data.outputCost };
            }
        })
        .sort((a, b) => b.totalCost - a.totalCost);

    // Model breakdown rows
    const modelRows = sortedModels.map(m => {
        const typeIcon = m.skuPrefix === 'embedding' ? '🔢' : m.skuPrefix === 'image' ? '🖼️' : '💬';
        const totalTok = m.inputTokens + m.outputTokens;
        const avgLatency = m.requestCount ? Math.round(m.totalExecTime / m.requestCount) : 0;

        // Cost bar (relative to highest model)
        const maxCost = sortedModels[0]?.totalCost || 1;
        const barWidth = Math.max(2, (m.totalCost / maxCost) * 100);

        // Cost cell: handle "Both" mode vs single currency
        let costCell;
        if (currency === 'Both') {
            const diemStr = m.diemCost > 0 ? `${m.diemCost.toFixed(6)} DIEM` : '-';
            const usdStr = m.usdCost > 0 ? `$${m.usdCost.toFixed(6)}` : '-';
            costCell = `
                <td style="padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--border); text-align: right; font-family: var(--font-mono, monospace); font-size: 11px;">
                    <div style="display: flex; flex-direction: column; gap: 0.1rem;">
                        <div>${diemStr}</div>
                        <div>${usdStr}</div>
                    </div>
                </td>
            `;
        } else {
            costCell = `
                <td style="padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--border); text-align: right; min-width: 140px;">
                    <div style="display: flex; align-items: center; justify-content: flex-end; gap: 0.4rem;">
                        <div style="flex: 1; max-width: 80px; height: 6px; background: var(--bg-secondary); border-radius: 3px; overflow: hidden;">
                            <div style="width: ${barWidth}%; height: 100%; background: linear-gradient(90deg, #3498db, #2ecc71); border-radius: 3px;"></div>
                        </div>
                        <span style="font-family: var(--font-mono, monospace); font-size: 11px;">${sym}${m.totalCost.toFixed(6)}${unit}</span>
                    </div>
                </td>
            `;
        }

        return `
            <tr>
                <td style="padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--border); white-space: nowrap;">
                    ${typeIcon} <strong>${esc(m.name)}</strong>
                </td>
                <td style="padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--border); text-align: right;">
                    ${m.requestCount}
                </td>
                <td style="padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--border); text-align: right; font-family: var(--font-mono, monospace); font-size: 11px;">
                    ${fmtTokens(m.inputTokens)} / ${fmtTokens(m.outputTokens)}
                </td>
                <td style="padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--border); text-align: right;">
                    ${avgLatency > 0 ? avgLatency + 'ms' : '-'}
                </td>
                ${costCell}
            </tr>
        `;
    }).join('');
    const rlRows = rateLimits.slice(0, 15).map(entry => {
        const model = entry.apiModelId || '?';
        const limits = (entry.rateLimits || []).map(l => `${l.amount} ${l.type}`).join(', ');
        return `<tr>
            <td style="padding: 0.2rem 0.5rem; border-bottom: 1px solid var(--border); font-size: 11px;">${esc(model)}</td>
            <td style="padding: 0.2rem 0.5rem; border-bottom: 1px solid var(--border); font-size: 11px;">${esc(limits)}</td>
        </tr>`;
    }).join('');

    // Balance cards - handle "Both" mode
    let periodCostCard;
    if (currency === 'Both') {
        const combinedCost = `${agg.totalCostDiem.toFixed(4)} DIEM + $${agg.totalCostUsd.toFixed(4)}`;
        periodCostCard = balanceCard('Period Cost', combinedCost, '#1e8449', '#27ae60');
    } else {
        periodCostCard = balanceCard('Period Cost', sym + agg.totalCost.toFixed(4) + unit, '#1e8449', '#27ae60');
    }

    container.innerHTML = `
        <!-- Balance Cards -->
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 0.5rem; margin-bottom: 0.75rem;">
            ${balanceCard('USD Balance', '$' + usd.toFixed(2), '#1a5276', '#2471a3')}
            ${balanceCard('DIEM Balance', diem.toFixed(4), '#6c3483', '#8e44ad')}
            ${periodCostCard}
            ${balanceCard('Requests', agg.totalRequests.toLocaleString(), '#7d6608', '#b7950b')}
        </div>

        <!-- Tier + Epoch row -->
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; font-size: 11px; color: var(--text-muted);">
            <div>
                <span style="display: inline-block; padding: 0.1rem 0.4rem; border-radius: 3px; font-weight: 600; background: ${tier === 'paid' ? '#27ae6022' : '#95a5a622'}; color: ${tier === 'paid' ? '#27ae60' : '#95a5a6'}; text-transform: uppercase; font-size: 10px;">
                    ${esc(tier)}${isCharged ? ' · charged' : ''}
                </span>
                <span style="margin-left: 0.5rem;">${agg.entryCount} billing entries · ${fmtTokens(agg.totalTokens)} total tokens</span>
            </div>
            <div>${epochHtml}</div>
        </div>

        <!-- Model Breakdown -->
        <div style="margin-bottom: 0.75rem;">
            <h4 style="margin: 0 0 0.4rem 0; font-size: var(--font-base); font-weight: 600;">📊 Cost by Model</h4>
            ${sortedModels.length === 0
                ? '<div style="padding: 1rem; text-align: center; color: var(--text-muted);">No usage data for this period</div>'
                : `
                <div style="max-height: 280px; overflow-y: auto; border: 1px solid var(--border); border-radius: 4px;">
                    <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
                        <thead>
                            <tr style="background: var(--bg-secondary); position: sticky; top: 0;">
                                <th style="padding: 0.3rem 0.5rem; text-align: left; font-weight: 600;">Model</th>
                                <th style="padding: 0.3rem 0.5rem; text-align: right; font-weight: 600;">Reqs</th>
                                <th style="padding: 0.3rem 0.5rem; text-align: right; font-weight: 600;">In / Out Tokens</th>
                                <th style="padding: 0.3rem 0.5rem; text-align: right; font-weight: 600;">Avg Latency</th>
                                <th style="padding: 0.3rem 0.5rem; text-align: right; font-weight: 600;">${currency === 'Both' ? 'DIEM / USD' : 'Cost'}</th>
                            </tr>
                        </thead>
                        <tbody>${modelRows}</tbody>
                    </table>
                </div>
            `}
        </div>

        <!-- Rate Limits (collapsible) -->
        ${rateLimits.length > 0 ? `
        <details style="margin-top: 0.5rem;">
            <summary style="cursor: pointer; font-size: var(--font-base); font-weight: 600; margin-bottom: 0.4rem;">⚡ Rate Limits (${rateLimits.length} models)</summary>
            <div style="max-height: 180px; overflow-y: auto; border: 1px solid var(--border); border-radius: 4px;">
                <table style="width: 100%; border-collapse: collapse;">
                    <thead>
                        <tr style="background: var(--bg-secondary);">
                            <th style="padding: 0.2rem 0.5rem; text-align: left; font-weight: 600; font-size: 11px;">Model</th>
                            <th style="padding: 0.2rem 0.5rem; text-align: left; font-weight: 600; font-size: 11px;">Limits</th>
                        </tr>
                    </thead>
                    <tbody>${rlRows}</tbody>
                </table>
            </div>
        </details>
        ` : ''}
    `;
}

// ============================================
// HELPERS
// ============================================

function balanceCard(label, value, colorFrom, colorTo) {
    return `
        <div style="background: linear-gradient(135deg, ${colorFrom} 0%, ${colorTo} 100%); padding: 0.6rem 0.75rem; border-radius: 6px; color: white;">
            <div style="font-size: 10px; opacity: 0.8; text-transform: uppercase; letter-spacing: 0.5px;">${label}</div>
            <div style="font-size: 1.15rem; font-weight: 700; margin-top: 0.15rem;">${value}</div>
        </div>
    `;
}

function fmtTokens(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
}

function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Register
Plugins.register(VeniceBillingPlugin);
	
export default VeniceBillingPlugin;
