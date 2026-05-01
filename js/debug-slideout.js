/**
 * Debug slide-out — 1.3.9 Touch 2 net-new surface
 *
 * Right-edge drawer per `docs/design/touch-2-facelift/project/debug.jsx`.
 * Replaces the 1.3.6 dropdown bridge (`#tbDebugDropdown`) plus the
 * legacy `#errorLogModal` and `#llmDebugModal`. Five tabs:
 *
 *   - Logs       — live `ErrorLogger.logs` stream + level filter
 *   - Connections — git providers (reuses `statusFor` from the 1.3.8
 *                   Settings → Connections tab) + active AI model
 *   - Indexer    — `ContextManager` queue + last batch + re-index
 *   - AI         — `LLMDebug.exchanges` table; click row to expand
 *                   the per-exchange detail rendered by the existing
 *                   `renderExchangeDetail` (factored from
 *                   `js/llm-debug-modal.js` so we don't duplicate)
 *   - Plugins    — `Plugins.list()` + `PluginErrors` ring buffer
 *
 * Head row provides Pause stream (suppresses live re-renders, but
 * underlying capture continues so the bug-report flow works after
 * unpause) and Copy bundle (one-click clipboard JSON for paste-into-
 * issue flows). Esc closes.
 *
 * The slide-out subscribes to EventBus events (passive) instead of
 * polling — same pattern as `index-indicator.js` and
 * `connections-tab.js`.
 */

import { EventBus, Storage, Plugins, State } from './core.js';
import { ErrorLogger } from './error-logger.js';
import { LLMDebug } from './llm.js';
import { renderExchangeDetail } from './llm-debug-modal.js';
import { GitProviderRegistry } from './git.js';
import { statusFor as connStatusFor } from './settings/connections-tab.js';
import { ContextManager } from './context-manager.js';
import { escapeHtml } from './utils/html.js';
import { VERSION } from './version.js';

// ============================================
// In-memory plugin lifecycle error buffer
// ============================================

const PLUGIN_ERROR_LIMIT = 50;
/** @type {Array<{name: string, pluginId: string, msg: string, ts: string}>} */
const _pluginErrors = [];

/** Capture a plugin lifecycle error. Wired from `js/plugin-loader.js`
 *  install/load and from `core.js` Plugins.init via the
 *  `plugin:initError` EventBus event. */
export function recordPluginError({ pluginId, name, msg }) {
    _pluginErrors.push({
        pluginId: pluginId || name || '?',
        name: name || pluginId || '?',
        msg: String(msg || ''),
        ts: new Date().toISOString()
    });
    if (_pluginErrors.length > PLUGIN_ERROR_LIMIT) _pluginErrors.shift();
    EventBus.emit('plugin:errorRecorded');
}

export function getPluginErrors() {
    return _pluginErrors.slice();
}

// ============================================
// Slide-out state
// ============================================

let _activeTab = 'logs';
let _paused = false;
let _expandedExchangeId = null;
let _sessionStartedAt = Date.now();
let _sessionTimer = 0;
let _initialized = false;

const TABS = ['logs', 'conn', 'indexer', 'ai', 'plugins'];

// Indexer last-batch snapshot (set on context:indexComplete)
let _lastIndexerEvent = null;

// ============================================
// Init — wire button + event subscriptions
// ============================================

export function initDebugSlideOut() {
    if (_initialized) return;
    _initialized = true;

    const btn = document.getElementById('btnDebugMenu');
    if (btn) {
        btn.removeAttribute('aria-haspopup');
        btn.removeAttribute('aria-expanded');
        btn.addEventListener('click', () => openDebugSlideOut());
    }

    const overlay = document.getElementById('debugSlideOut');
    if (!overlay) return;

    // Backdrop click closes (but not clicks inside the panel)
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeDebugSlideOut();
    });

    document.getElementById('debugCloseBtn')?.addEventListener('click', closeDebugSlideOut);
    document.getElementById('debugPauseBtn')?.addEventListener('click', _togglePause);
    document.getElementById('debugCopyBundleBtn')?.addEventListener('click', copyDiagnosticBundle);

    // Tab switching
    overlay.querySelectorAll('[data-debug-tab]').forEach(btn => {
        btn.addEventListener('click', () => _selectTab(btn.dataset.debugTab));
    });

    // Esc closes
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('active')) {
            closeDebugSlideOut();
        }
    });

    // Live event subscriptions (filtered by _paused at render time)
    EventBus.on('error:logged', () => _onLiveEvent('logs'));
    EventBus.on('debug:exchange', () => _onLiveEvent('ai'));
    EventBus.on('debug:exchangeDone', () => _onLiveEvent('ai'));
    EventBus.on('context:indexStart', (d) => { _lastIndexerEvent = { type: 'start', ts: Date.now(), data: d }; _onLiveEvent('indexer'); });
    EventBus.on('context:indexProgress', (d) => { _lastIndexerEvent = { type: 'progress', ts: Date.now(), data: d }; _onLiveEvent('indexer'); });
    EventBus.on('context:indexComplete', (d) => { _lastIndexerEvent = { type: 'complete', ts: Date.now(), data: d }; _onLiveEvent('indexer'); });
    EventBus.on('context:indexError', (d) => { _lastIndexerEvent = { type: 'error', ts: Date.now(), data: d }; _onLiveEvent('indexer'); });
    EventBus.on('context:pauseChanged', () => _onLiveEvent('indexer'));
    EventBus.on('plugin:registered', () => _onLiveEvent('plugins'));
    EventBus.on('plugin:initialized', () => _onLiveEvent('plugins'));
    EventBus.on('plugin:errorRecorded', () => { _onLiveEvent('plugins'); _refreshTabCounts(); });
    EventBus.on('plugin:initError', (d) => recordPluginError(d));
    EventBus.on('chat:cleared', () => { _sessionStartedAt = Date.now(); });

    _refreshTabCounts();
}

function _onLiveEvent(tab) {
    if (_paused) return;
    _refreshTabCounts();
    const overlay = document.getElementById('debugSlideOut');
    if (!overlay?.classList.contains('active')) return;
    if (_activeTab === tab) _renderActive();
}

// ============================================
// Open / close
// ============================================

export function openDebugSlideOut(tab) {
    const overlay = document.getElementById('debugSlideOut');
    if (!overlay) return;
    if (tab && TABS.includes(tab)) _activeTab = tab;
    _selectTab(_activeTab, /* skipRender */ true);
    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');
    _renderActive();
    _refreshSessionLabel();
    if (!_sessionTimer) {
        _sessionTimer = window.setInterval(_refreshSessionLabel, 30_000);
    }
}

export function closeDebugSlideOut() {
    const overlay = document.getElementById('debugSlideOut');
    if (!overlay) return;
    overlay.classList.remove('active');
    overlay.setAttribute('aria-hidden', 'true');
    if (_sessionTimer) {
        window.clearInterval(_sessionTimer);
        _sessionTimer = 0;
    }
}

function _refreshSessionLabel() {
    const label = document.getElementById('debugSessionLabel');
    if (!label) return;
    const mins = Math.floor((Date.now() - _sessionStartedAt) / 60_000);
    label.textContent = `active · ${mins}m`;
}

function _selectTab(tab, skipRender = false) {
    if (!TABS.includes(tab)) return;
    _activeTab = tab;
    const overlay = document.getElementById('debugSlideOut');
    if (!overlay) return;
    overlay.querySelectorAll('[data-debug-tab]').forEach(btn => {
        const active = btn.dataset.debugTab === tab;
        btn.classList.toggle('debug__tab--active', active);
        btn.setAttribute('aria-selected', String(active));
    });
    overlay.querySelectorAll('[data-debug-panel]').forEach(p => {
        p.hidden = p.dataset.debugPanel !== tab;
    });
    if (!skipRender) _renderActive();
}

function _togglePause() {
    _paused = !_paused;
    const btn = document.getElementById('debugPauseBtn');
    if (btn) {
        btn.textContent = _paused ? '▶' : '⏸';
        btn.title = _paused ? 'Resume stream' : 'Pause stream';
        btn.setAttribute('aria-label', _paused ? 'Resume stream' : 'Pause stream');
        btn.setAttribute('aria-pressed', String(_paused));
        btn.classList.toggle('debug__head-btn--active', _paused);
    }
    if (!_paused) _renderActive();
}

// ============================================
// Tab counts (head badges)
// ============================================

function _refreshTabCounts() {
    const errs = ErrorLogger.logs.filter(l => l.type === 'ERROR' || l.type === 'UNHANDLED REJECTION').length;
    _setCount('debugTabCountLogs', errs, errs > 0);
    const conns = GitProviderRegistry.listConnections().length;
    _setCount('debugTabCountConn', conns, false);
    _setCount('debugTabCountAI', LLMDebug.exchanges.length, false);
    _setCount('debugTabCountPlugins', _pluginErrors.length, _pluginErrors.length > 0);
}

function _setCount(id, n, warn) {
    const el = document.getElementById(id);
    if (!el) return;
    if (n > 0) {
        el.textContent = String(n);
        el.hidden = false;
        el.classList.toggle('debug__tab-count--warn', !!warn);
    } else {
        el.hidden = true;
    }
}

// ============================================
// Render dispatcher
// ============================================

function _renderActive() {
    const panel = document.querySelector(`[data-debug-panel="${_activeTab}"]`);
    if (!panel) return;
    switch (_activeTab) {
        case 'logs':    panel.innerHTML = _renderLogs(); break;
        case 'conn':    panel.innerHTML = _renderConn(); break;
        case 'indexer': panel.innerHTML = _renderIndexer(); break;
        case 'ai':      panel.innerHTML = _renderAI(); _wireAIRows(panel); break;
        case 'plugins': panel.innerHTML = _renderPlugins(); break;
    }
}

// ============================================
// Logs tab
// ============================================

let _logLevel = 'all';

function _renderLogs() {
    const levels = ['all', 'debug', 'info', 'warn', 'error'];
    const chips = levels.map(l => {
        const cls = ['debug__chip'];
        if (l === _logLevel) cls.push('debug__chip--active');
        if (l !== 'all') cls.push(`debug__chip--${l}`);
        return `<button type="button" class="${cls.join(' ')}" data-log-level="${l}">${l}</button>`;
    }).join('');

    const filtered = _filterLogs(ErrorLogger.logs, _logLevel);
    const rows = filtered.length === 0
        ? `<div class="debug__log-empty">No log entries${_logLevel === 'all' ? '' : ` at level "${escapeHtml(_logLevel)}"`} yet.</div>`
        : filtered.slice(-300).map(e => {
            const lvl = _normalizeLevel(e.type);
            const time = (e.timestamp || '').slice(11, 19);
            const src = e.file || _srcFromType(e.type);
            return `<div class="debug__log-row">
                <span class="debug__log-time">${escapeHtml(time)}</span>
                <span class="debug__log-level debug__log-level--${lvl}">${escapeHtml(lvl)}</span>
                <span class="debug__log-src" title="${escapeHtml(src)}">${escapeHtml(src)}</span>
                <span class="debug__log-msg">${escapeHtml(_truncate(e.message, 400))}</span>
            </div>`;
        }).reverse().join('');

    setTimeout(() => {
        document.querySelectorAll('[data-log-level]').forEach(btn => {
            btn.addEventListener('click', () => {
                _logLevel = btn.dataset.logLevel;
                _renderActive();
            });
        });
    }, 0);

    return `
        <div class="debug__bar">
            <div class="debug__filter-group">${chips}</div>
        </div>
        <div class="debug__log">${rows}</div>
    `;
}

function _normalizeLevel(type) {
    const t = String(type || '').toUpperCase();
    if (t === 'ERROR' || t === 'UNHANDLED REJECTION') return 'error';
    if (t === 'WARN') return 'warn';
    if (t === 'LOG') return 'info';
    if (t === 'DEBUG') return 'debug';
    return 'info';
}

function _srcFromType(type) {
    const t = String(type || '').toUpperCase();
    if (t === 'UNHANDLED REJECTION') return 'rejection';
    if (t === 'ERROR') return 'error';
    return 'console';
}

function _filterLogs(logs, level) {
    if (level === 'all') return logs;
    return logs.filter(l => _normalizeLevel(l.type) === level);
}

function _truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n) + '…' : s;
}

// ============================================
// Connections tab
// ============================================

function _renderConn() {
    const providers = GitProviderRegistry.list().filter(p => !p.hidden);
    const conns = GitProviderRegistry.listConnections();
    const provGroups = providers.map(p => {
        const rows = conns.filter(c => c.provider === p.id);
        if (rows.length === 0) return '';
        return rows.map(c => _renderConnRow(c, p)).join('');
    }).join('');

    const aiModel = State?.settings?.llmModel || State?.settings?.embeddingModel || '';
    const aiProvider = State?.settings?.llmProvider || State?.settings?.provider || 'ai provider';
    const aiBlock = `
        <div class="debug__section-title">AI providers · ${aiModel ? '1 configured' : 'none configured'}</div>
        <div class="debug__conn">
            <div class="debug__conn-row">
                <span class="conn__status conn__status--${aiModel ? 'ok' : 'disabled'}"><span class="conn__status-dot"></span></span>
                <div class="debug__conn-name">${escapeHtml(aiProvider)}</div>
                <div class="debug__conn-url">${escapeHtml(aiModel || 'no model selected')}</div>
            </div>
            <div class="debug__conn-meta">${LLMDebug.exchanges.length} exchange(s) recorded this session</div>
        </div>
    `;

    return `
        <div class="debug__section-title">Git providers · ${conns.length} connected</div>
        ${provGroups || '<div class="debug__log-empty">No git connections configured. Use Settings → Connections to add one.</div>'}
        ${aiBlock}
    `;
}

function _renderConnRow(conn, provider) {
    const status = connStatusFor(conn);
    const url = conn.url || provider.fixedUrl || '';
    const warnClass = status.kind !== 'ok' ? 'debug__conn--warn' : '';
    const errLine = conn._unreachable
        ? `<div class="debug__conn-err">${escapeHtml(status.label)}</div>`
        : '';
    return `
        <div class="debug__conn ${warnClass}">
            <div class="debug__conn-row">
                <span class="conn__status conn__status--${status.kind}"><span class="conn__status-dot"></span></span>
                <div class="debug__conn-name">${escapeHtml(conn.label || conn.id)}</div>
                <div class="debug__conn-url">${escapeHtml(url)}</div>
            </div>
            <div class="debug__conn-meta">${escapeHtml(provider.name || conn.provider)} · ${conn.token ? 'token set' : 'no token'} · ${conn.enabled ? 'enabled' : 'disabled'}</div>
            ${errLine}
        </div>
    `;
}

// ============================================
// Indexer tab
// ============================================

function _renderIndexer() {
    const indexed = ContextManager._fileIndex?.size ?? 0;
    const progress = ContextManager._indexProgress;
    const indexing = !!ContextManager._indexing;
    const paused = !!ContextManager.paused;
    const total = progress?.total || indexed || 0;
    const current = progress?.current || indexed;
    const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : (indexed > 0 ? 100 : 0);

    const statusValue = indexing
        ? (paused ? 'paused' : 'indexing…')
        : (indexed > 0 ? 'idle' : '—');
    const statusOk = !indexing || !paused;

    const lastBatchHtml = _lastIndexerEvent
        ? `
        <div class="debug__section-title">Last event · ${escapeHtml(new Date(_lastIndexerEvent.ts).toLocaleTimeString())}</div>
        <div class="debug__batch">
            <div class="debug__batch-row"><span>type</span><span>${escapeHtml(_lastIndexerEvent.type)}</span></div>
            ${Object.entries(_lastIndexerEvent.data || {}).slice(0, 6).map(([k, v]) =>
                `<div class="debug__batch-row"><span>${escapeHtml(k)}</span><span>${escapeHtml(_fmtVal(v))}</span></div>`
            ).join('')}
        </div>`
        : '';

    return `
        <div class="debug__stat-row">
            <div class="debug__stat">
                <div class="debug__stat-label">Status</div>
                <div class="debug__stat-value ${statusOk ? 'debug__stat-value--ok' : ''}">${escapeHtml(statusValue)}</div>
            </div>
            <div class="debug__stat">
                <div class="debug__stat-label">Indexed</div>
                <div class="debug__stat-value">${indexed}${total ? ` / ${total}` : ''}</div>
            </div>
            <div class="debug__stat">
                <div class="debug__stat-label">Project</div>
                <div class="debug__stat-value" style="font-size: var(--font-sm);">${escapeHtml(_truncate(ContextManager._indexedProject || State?.currentProject || '—', 22))}</div>
            </div>
            <div class="debug__stat">
                <div class="debug__stat-label">Paused</div>
                <div class="debug__stat-value">${paused ? 'yes' : 'no'}</div>
            </div>
        </div>
        <div class="debug__progress">
            <div class="debug__progress-fill" style="width: ${pct}%;"></div>
        </div>
        ${lastBatchHtml}
        <button type="button" class="debug__btn" id="debugIndexerReindex">Re-index from scratch</button>
        ${_wireIndexerBtn()}
    `;
}

function _fmtVal(v) {
    if (v == null) return '—';
    if (typeof v === 'object') return JSON.stringify(v).slice(0, 40);
    return String(v);
}

function _wireIndexerBtn() {
    setTimeout(() => {
        const btn = document.getElementById('debugIndexerReindex');
        if (btn) btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                await ContextManager.indexProject(true, false);
            } finally {
                btn.disabled = false;
                _renderActive();
            }
        });
    }, 0);
    return '';
}

// ============================================
// AI tab — request table
// ============================================

function _renderAI() {
    const exchanges = LLMDebug.exchanges;
    const totals = exchanges.reduce((acc, ex) => {
        const u = ex.result?.usage || {};
        acc.in += u.prompt_tokens || u.input_tokens || 0;
        acc.out += u.completion_tokens || u.output_tokens || 0;
        return acc;
    }, { in: 0, out: 0 });

    const head = `
        <div class="debug__stat-row">
            <div class="debug__stat"><div class="debug__stat-label">Requests</div><div class="debug__stat-value">${exchanges.length}</div></div>
            <div class="debug__stat"><div class="debug__stat-label">Tokens in</div><div class="debug__stat-value">${_fmtCount(totals.in)}</div></div>
            <div class="debug__stat"><div class="debug__stat-label">Tokens out</div><div class="debug__stat-value">${_fmtCount(totals.out)}</div></div>
            <div class="debug__stat"><div class="debug__stat-label">Errors</div><div class="debug__stat-value">${exchanges.filter(ex => ex.error).length}</div></div>
        </div>
    `;

    if (exchanges.length === 0) {
        return head + '<div class="debug__log-empty">No LLM exchanges yet. Send a chat message to start logging.</div>';
    }

    const rowsHtml = exchanges.slice().reverse().map(ex => {
        const tIn = ex.result?.usage?.prompt_tokens || ex.result?.usage?.input_tokens || ex.compression?.tokens_in || 0;
        const tOut = ex.result?.usage?.completion_tokens || ex.result?.usage?.output_tokens || ex.result?.contentLen || 0;
        const ms = ex.durationMs ?? '—';
        const status = ex.error ? 'error' : (ex.result ? 'ok' : 'pending');
        const pillKind = status === 'error' ? 'error' : (status === 'ok' ? 'ok' : 'warn');
        const role = (ex.messages || []).find(m => m.role === 'system') ? 'system+chat' : 'chat';
        const expanded = _expandedExchangeId === ex.id;
        const detailRow = expanded
            ? `<div class="debug__table-detail">${renderExchangeDetail(ex)}</div>`
            : '';
        return `
            <div class="debug__table-row ${expanded ? 'debug__table-row--expanded' : ''}" data-exchange-id="${ex.id}">
                <span class="debug__mono">${escapeHtml((ex.ts || '').slice(11, 19))}</span>
                <span class="debug__mono">${escapeHtml(_truncate(ex.model || '—', 22))}</span>
                <span>${escapeHtml(role)}</span>
                <span class="debug__mono" style="text-align: right;">${_fmtCount(tIn)} / ${_fmtCount(tOut)}</span>
                <span class="debug__mono" style="text-align: right;">${escapeHtml(String(ms))}</span>
                <span><span class="debug__pill debug__pill--${pillKind}">${escapeHtml(status)}</span></span>
            </div>
            ${detailRow}
        `;
    }).join('');

    return head + `
        <div class="debug__section-title">Recent requests</div>
        <div class="debug__table">
            <div class="debug__table-head">
                <span>time</span><span>model</span><span>role</span>
                <span style="text-align: right;">in / out</span>
                <span style="text-align: right;">ms</span>
                <span>status</span>
            </div>
            ${rowsHtml}
        </div>
    `;
}

function _wireAIRows(panel) {
    panel.querySelectorAll('[data-exchange-id]').forEach(row => {
        row.addEventListener('click', () => {
            const id = Number(row.dataset.exchangeId);
            _expandedExchangeId = (_expandedExchangeId === id) ? null : id;
            _renderActive();
        });
    });
}

function _fmtCount(n) {
    if (!n) return '0';
    if (n < 1000) return String(n);
    if (n < 1_000_000) return (n / 1000).toFixed(1) + 'k';
    return (n / 1_000_000).toFixed(2) + 'M';
}

// ============================================
// Plugins tab
// ============================================

function _renderPlugins() {
    const plugins = Plugins.list();
    const errsByName = new Map();
    for (const e of _pluginErrors) errsByName.set(e.pluginId, e);

    const counts = {
        ok: plugins.filter(p => p.enabled && !errsByName.has(p.id)).length,
        warn: plugins.filter(p => !p.enabled).length,
        error: _pluginErrors.length,
    };

    const head = `<div class="debug__section-title">${plugins.length} plugin(s) loaded · ${counts.error} error · ${counts.warn} disabled</div>`;

    if (plugins.length === 0 && _pluginErrors.length === 0) {
        return head + '<div class="debug__log-empty">No plugins registered.</div>';
    }

    const installed = Storage.get('installedPlugins') || [];
    const versionFor = (id) => {
        const reg = Plugins.get(id);
        return reg?.manifest?.version || installed.find(p => p.pluginId === id)?.version || '';
    };

    const rows = plugins.map(p => {
        const err = errsByName.get(p.id);
        const status = err ? 'error' : (!p.enabled ? 'warn' : 'ok');
        const msg = err ? err.msg : (p.enabled ? `loaded · ${escapeHtml(p.description || '')}` : 'disabled');
        return `
            <div class="debug__plugin debug__plugin--${status}">
                <div class="debug__plugin-row">
                    <span aria-hidden="true">🧩</span>
                    <div class="debug__plugin-name">${escapeHtml(p.name || p.id)}</div>
                    <div class="debug__plugin-ver">${escapeHtml(versionFor(p.id) ? 'v' + versionFor(p.id) : '')}</div>
                    <span class="debug__pill debug__pill--${status === 'ok' ? 'ok' : status === 'warn' ? 'warn' : 'error'}">${status}</span>
                </div>
                <div class="debug__plugin-msg">${msg}</div>
            </div>
        `;
    }).join('');

    // Orphan plugin errors (recorded but plugin not in registry — failed to register)
    const orphans = _pluginErrors.filter(e => !Plugins.get(e.pluginId)).map(e => `
        <div class="debug__plugin debug__plugin--error">
            <div class="debug__plugin-row">
                <span aria-hidden="true">🧩</span>
                <div class="debug__plugin-name">${escapeHtml(e.name)}</div>
                <div class="debug__plugin-ver"></div>
                <span class="debug__pill debug__pill--error">error</span>
            </div>
            <div class="debug__plugin-msg">${escapeHtml(e.msg)}</div>
        </div>
    `).join('');

    return head + rows + orphans;
}

// ============================================
// Copy diagnostic bundle
// ============================================

export function buildDiagnosticBundle() {
    const conns = GitProviderRegistry.listConnections().map(c => ({
        id: c.id,
        provider: c.provider,
        label: c.label,
        url: c.url,
        enabled: c.enabled,
        hasToken: !!c.token,
        unreachable: !!c._unreachable,
        status: connStatusFor(c).kind,
    }));
    return {
        version: VERSION,
        ts: new Date().toISOString(),
        errors: ErrorLogger.logs.slice(-100),
        exchanges: LLMDebug.exchanges.map(ex => ({
            id: ex.id, ts: ex.ts, model: ex.model, msgCount: ex.msgCount,
            toolsSent: ex.toolsSent, durationMs: ex.durationMs,
            usage: ex.result?.usage || null,
            error: ex.error || null,
            finishReason: ex.result?.finishReason || null,
        })),
        connections: conns,
        indexer: {
            indexed: ContextManager._fileIndex?.size ?? 0,
            indexing: !!ContextManager._indexing,
            paused: !!ContextManager.paused,
            project: ContextManager._indexedProject || null,
            lastEvent: _lastIndexerEvent,
        },
        plugins: Plugins.list().map(p => ({
            id: p.id,
            name: p.name,
            version: p.version,
            enabled: p.enabled,
        })),
        pluginErrors: _pluginErrors.slice(),
    };
}

export async function copyDiagnosticBundle() {
    const bundle = buildDiagnosticBundle();
    const text = JSON.stringify(bundle, null, 2);
    try {
        await navigator.clipboard.writeText(text);
        window.showToast?.('Diagnostic bundle copied to clipboard', 'success');
    } catch (err) {
        console.error('[debug-slideout] Failed to copy bundle:', err);
        window.showToast?.('Failed to copy bundle — see console', 'error');
    }
}

// ============================================
// Test seams (1.3.9 — mirrors connections-tab)
// ============================================

export const __test_renderActive = _renderActive;
export const __test_selectTab = _selectTab;
export const __test_setLogLevel = (l) => { _logLevel = l; };
export const __test_resetState = () => {
    _activeTab = 'logs';
    _paused = false;
    _expandedExchangeId = null;
    _logLevel = 'all';
    _lastIndexerEvent = null;
    _pluginErrors.length = 0;
};
