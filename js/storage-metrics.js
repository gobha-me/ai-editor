/**
 * AI Editor — Storage Metrics
 *
 * Provides a detailed breakdown of browser storage usage:
 *   - Origin-level quota (navigator.storage.estimate)
 *   - localStorage per-category breakdown with visual bars
 *   - Per-key drill-down sorted by size
 *   - Cleanup actions per category
 */

import { Storage, State, EventBus } from './core.js';
import { ContextManager } from './context-manager.js';

// ============================================
// CATEGORY DEFINITIONS
// ============================================

const CATEGORIES = [
    { id: 'chat',       label: 'Chat History',   color: '#58a6ff', match: k => /^(chatHistory|chatPruneStash|chatSummaryInfo)$/.test(k) },
    { id: 'drafts',     label: 'Drafts',         color: '#f0883e', match: k => k.startsWith('draft-') },
    { id: 'settings',   label: 'Settings',       color: '#8b949e', match: k => /^(settings|pluginState)$/.test(k) },
    { id: 'models',     label: 'Model Cache',    color: '#bc8cff', match: k => k === 'models' },
    { id: 'embeddings', label: 'Embeddings',     color: '#3fb950', match: k => k.startsWith('embeddings-index-') },
    { id: 'ui',         label: 'UI State',       color: '#484f58', match: k => /^(chatHidden|chatWidth|previewWidthPct|sidebarHidden|sidebarWidth|searchHistory)$/.test(k) },
];

// PREFIX removed in 0.9.11 — Storage.keys() handles namespacing

// ============================================
// MEASUREMENT
// ============================================

/**
 * Measure all storage entries from the in-memory cache.
 * Returns sorted array of { key, bytes, category }.
 */
function measureStorage() {
    const items = [];

    for (const key of Storage.keys()) {
        const value = Storage.get(key);
        // Estimate serialized size (key in IDB + JSON value)
        // Use same UTF-16 estimate as before for consistency
        const serialized = JSON.stringify(value) || '';
        const bytes = (key.length + serialized.length) * 2;

        const cat = CATEGORIES.find(c => c.match(key));
        items.push({
            key,
            bytes,
            category: cat ? cat.id : 'other',
        });
    }
    items.sort((a, b) => b.bytes - a.bytes);
    return items;
}

/**
 * Aggregate items into per-category totals.
 */
function aggregateByCategory(items) {
    const totals = {};
    for (const cat of CATEGORIES) {
        totals[cat.id] = { label: cat.label, color: cat.color, bytes: 0, count: 0 };
    }
    totals.other = { label: 'Other', color: '#6e7681', bytes: 0, count: 0 };

    for (const item of items) {
        const bucket = totals[item.category] || totals.other;
        bucket.bytes += item.bytes;
        bucket.count++;
    }
    return totals;
}

/**
 * Get origin-level storage estimate.
 */
async function getOriginEstimate() {
    if (navigator.storage && navigator.storage.estimate) {
        try {
            const est = await navigator.storage.estimate();
            return { usage: est.usage || 0, quota: est.quota || 0 };
        } catch {
            return null;
        }
    }
    return null;
}

// ============================================
// FORMATTING
// ============================================

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function pct(value, total) {
    if (!total) return 0;
    return Math.min(100, (value / total) * 100);
}

// ============================================
// RENDERING
// ============================================

/**
 * Render the full storage metrics panel.
 * Called when the Storage tab becomes active.
 */
export async function renderStorageMetrics() {
    const items = measureStorage();
    const totals = aggregateByCategory(items);
    const totalBytes = items.reduce((sum, i) => sum + i.bytes, 0);

    // Origin quota
    const estimate = await getOriginEstimate();
    _renderQuota(estimate, totalBytes);

    // Category bars
    _renderCategoryBars(totals, totalBytes);

    // Total label
    const totalLabel = document.getElementById('storageTotalLabel');
    if (totalLabel) {
        const backend = Storage.isIDBActive ? 'IndexedDB' : 'localStorage';
        totalLabel.textContent = `${formatBytes(totalBytes)} across ${items.length} keys (${backend})`;
    }

    // Per-key list (top 20)
    _renderKeyList(items.slice(0, 20), totalBytes);

    // Cleanup actions
    _renderCleanupActions(totals, items);
}

function _renderQuota(estimate, storageBytes) {
    const bar = document.getElementById('storageQuotaFill');
    const label = document.getElementById('storageQuotaLabel');
    if (!bar || !label) return;

    if (estimate && estimate.quota > 0) {
        const p = pct(estimate.usage, estimate.quota);
        bar.style.width = `${p}%`;
        bar.style.background = p > 90 ? 'var(--danger)' : p > 70 ? 'var(--warning)' : 'var(--accent)';
        const backend = Storage.isIDBActive ? 'IndexedDB (primary) + localStorage (fallback)' : 'localStorage only';
        label.textContent = `${formatBytes(estimate.usage)} used of ${formatBytes(estimate.quota)} (${p.toFixed(1)}%) — ${backend}`;
    } else {
        bar.style.width = '0%';
        label.textContent = `Storage API not available. Estimated: ~${formatBytes(storageBytes)}`;
    }
}

function _renderCategoryBars(totals, totalBytes) {
    const container = document.getElementById('storageCategoryBars');
    if (!container) return;

    // Stacked bar
    const sorted = Object.values(totals).filter(t => t.bytes > 0).sort((a, b) => b.bytes - a.bytes);

    const stackedSegments = sorted.map(t =>
        `<div title="${t.label}: ${formatBytes(t.bytes)}" style="width: ${pct(t.bytes, totalBytes)}%; height: 100%; background: ${t.color}; min-width: ${t.bytes > 0 ? '2px' : '0'};"></div>`
    ).join('');

    const legend = sorted.map(t =>
        `<div style="display: flex; align-items: center; gap: 0.3rem; font-size: var(--font-sm);">
            <span style="width: 10px; height: 10px; border-radius: 2px; background: ${t.color}; flex-shrink: 0;"></span>
            <span style="color: var(--text-secondary);">${t.label}</span>
            <span style="color: var(--text-muted); margin-left: auto;">${formatBytes(t.bytes)} (${t.count})</span>
        </div>`
    ).join('');

    container.innerHTML = `
        <div style="height: 16px; background: var(--bg-tertiary); border-radius: 4px; overflow: hidden; display: flex; margin-bottom: 0.5rem;">
            ${stackedSegments}
        </div>
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 0.2rem;">
            ${legend}
        </div>
    `;
}

function _renderKeyList(items, totalBytes) {
    const container = document.getElementById('storageKeyList');
    if (!container) return;

    if (items.length === 0) {
        container.innerHTML = '<div style="color: var(--text-muted); font-size: var(--font-sm);">No data stored</div>';
        return;
    }

    const catMap = {};
    for (const c of CATEGORIES) catMap[c.id] = c;
    catMap.other = { label: 'Other', color: '#6e7681' };

    // Separate embeddings for special rendering
    const embeddingItems = items.filter(i => i.category === 'embeddings');
    const otherItems = items.filter(i => i.category !== 'embeddings');

    let html = '';

    // Embeddings indexes — detailed view
    if (embeddingItems.length > 0) {
        html += `<div style="margin-bottom: 0.5rem; font-size: var(--font-sm); font-weight: 600; color: var(--text-secondary);">Embedding Indexes</div>`;
        for (const item of embeddingItems) {
            html += _renderEmbeddingIndex(item, totalBytes, catMap.embeddings);
        }
        if (otherItems.length > 0) {
            html += `<div style="margin: 0.5rem 0; font-size: var(--font-sm); font-weight: 600; color: var(--text-secondary);">Other Items</div>`;
        }
    }

    // Regular items
    for (const item of otherItems) {
        const cat = catMap[item.category] || catMap.other;
        const barWidth = pct(item.bytes, totalBytes);
        const displayKey = item.key.length > 60 ? item.key.slice(0, 57) + '…' : item.key;
        html += `
            <div style="display: flex; align-items: center; gap: 0.5rem; padding: 0.2rem 0; font-size: var(--font-sm); border-bottom: 1px solid var(--bg-tertiary);">
                <span style="width: 8px; height: 8px; border-radius: 2px; background: ${cat.color}; flex-shrink: 0;" title="${cat.label}"></span>
                <span style="flex: 1; font-family: var(--font-mono); font-size: var(--font-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary);" title="${_escapeAttr(item.key)}">${_escapeHtml(displayKey)}</span>
                <div style="width: 80px; height: 6px; background: var(--bg-tertiary); border-radius: 3px; flex-shrink: 0;">
                    <div style="width: ${barWidth}%; height: 100%; background: ${cat.color}; border-radius: 3px; min-width: ${item.bytes > 0 ? '2px' : '0'};"></div>
                </div>
                <span style="width: 60px; text-align: right; color: var(--text-muted); font-size: var(--font-xs); flex-shrink: 0;">${formatBytes(item.bytes)}</span>
            </div>
        `;
    }

    container.innerHTML = html;

    // Wire per-index delete buttons
    container.querySelectorAll('.btn-delete-embedding').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const key = btn.dataset.key;
            const projectName = key.replace('embeddings-index-', '');
            if (!confirm(`Delete embedding index for "${projectName}"?`)) return;

            Storage.remove(key);

            // If this was the active in-memory index, clear it
            if (ContextManager._indexedProject === projectName) {
                ContextManager._fileIndex.clear();
                ContextManager._indexedProject = null;
            }

            renderStorageMetrics();
        });
    });
}

/**
 * Render a single embedding index with detailed stats.
 */
function _renderEmbeddingIndex(item, totalBytes, cat) {
    // Parse stored index for metadata
    let meta = null;
    try {
        meta = Storage.get(item.key);
    } catch { /* ignore */ }

    const barWidth = pct(item.bytes, totalBytes);
    const projectName = item.key.replace('embeddings-index-', '');

    // Extract stats
    const fileCount = meta?.files?.length || '?';
    const builtAt = meta?.timestamp ? _timeAgo(meta.timestamp) : 'unknown';
    const queryCount = meta?.queryCount || 0;
    const lastQueried = meta?.lastQueried ? _timeAgo(meta.lastQueried) : 'never';

    // Usage badge
    let usageBadge;
    if (queryCount === 0) {
        usageBadge = `<span style="background: var(--danger); color: #fff; padding: 0.1rem 0.4rem; border-radius: 3px; font-size: var(--font-xs);">unused</span>`;
    } else if (queryCount < 5) {
        usageBadge = `<span style="background: var(--warning); color: #000; padding: 0.1rem 0.4rem; border-radius: 3px; font-size: var(--font-xs);">${queryCount} queries</span>`;
    } else {
        usageBadge = `<span style="background: var(--success); color: #fff; padding: 0.1rem 0.4rem; border-radius: 3px; font-size: var(--font-xs);">${queryCount} queries</span>`;
    }

    return `
        <div class="embedding-index-card" style="border: 1px solid var(--bg-tertiary); border-radius: 4px; padding: 0.4rem 0.5rem; margin-bottom: 0.3rem;">
            <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.3rem;">
                <span style="width: 8px; height: 8px; border-radius: 2px; background: ${cat.color}; flex-shrink: 0;"></span>
                <span style="flex: 1; font-family: var(--font-mono); font-size: var(--font-xs); color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${_escapeAttr(projectName)}">${_escapeHtml(projectName)}</span>
                ${usageBadge}
                <span style="color: var(--text-muted); font-size: var(--font-xs);">${formatBytes(item.bytes)}</span>
                <button type="button" class="btn-icon-danger btn-delete-embedding" data-key="${_escapeAttr(item.key)}" title="Delete this index">&times;</button>
            </div>
            <div style="display: flex; gap: 1rem; font-size: var(--font-xs); color: var(--text-muted);">
                <span>${fileCount} files</span>
                <span>built ${builtAt}</span>
                <span>last queried: ${lastQueried}</span>
            </div>
            <div style="height: 4px; background: var(--bg-tertiary); border-radius: 2px; margin-top: 0.3rem;">
                <div style="width: ${barWidth}%; height: 100%; background: ${cat.color}; border-radius: 2px; min-width: 2px;"></div>
            </div>
        </div>
    `;
}

/**
 * Human-readable relative time.
 */
function _timeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return `${Math.floor(days / 30)}mo ago`;
}

function _renderCleanupActions(totals, items) {
    const container = document.getElementById('storageCleanupActions');
    if (!container) return;

    const actions = [];

    if (totals.chat.bytes > 0) {
        actions.push({ label: `Clear Chat (${formatBytes(totals.chat.bytes)})`, category: 'chat',
            keys: ['chatHistory', 'chatPruneStash', 'chatSummaryInfo'] });
    }
    if (totals.drafts.bytes > 0) {
        actions.push({ label: `Clear Drafts (${formatBytes(totals.drafts.bytes)})`, category: 'drafts',
            keys: items.filter(i => i.category === 'drafts').map(i => i.key) });
    }
    if (totals.embeddings.bytes > 0) {
        actions.push({ label: `Clear Embeddings (${formatBytes(totals.embeddings.bytes)})`, category: 'embeddings',
            keys: items.filter(i => i.category === 'embeddings').map(i => i.key) });
    }
    if (totals.models.bytes > 0) {
        actions.push({ label: `Clear Model Cache (${formatBytes(totals.models.bytes)})`, category: 'models',
            keys: ['models'] });
    }

    container.innerHTML = actions.map((a, i) =>
        `<button type="button" class="btn btn-secondary btn-sm storage-cleanup-btn" data-idx="${i}">${_escapeHtml(a.label)}</button>`
    ).join('');

    if (actions.length === 0) {
        container.innerHTML = '<span style="font-size: var(--font-sm); color: var(--text-muted);">Nothing to clean up</span>';
    }

    // Wire handlers
    container.querySelectorAll('.storage-cleanup-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const action = actions[parseInt(btn.dataset.idx)];
            if (!action) return;

            if (!confirm(`Clear all ${action.category} data? This cannot be undone.`)) return;

            for (const key of action.keys) {
                Storage.remove(key);
            }

            // Post-cleanup side effects
            if (action.category === 'chat') {
                State.chatHistory = [];
                EventBus.emit('chat:cleared');
            }

            // Re-render
            renderStorageMetrics();
        });
    });
}

// ============================================
// UTILITIES
// ============================================

function _escapeHtml(str) {
    const el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
}

function _escapeAttr(str) {
    return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
