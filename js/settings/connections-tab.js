// ============================================
// SETTINGS — CONNECTIONS TAB (1.3.8 Touch 2 layout)
//
// Provider-grouped, N-of-each-provider per
// docs/design/touch-2-facelift/project/connections.jsx.
// The shared editor form below remains the single add/edit
// surface; per-provider "Add" buttons preselect the provider
// when opening it.
// ============================================

import { GitProviderRegistry } from '../git-providers/index.js';
import { escapeHtml, escapeAttr } from '../utils/html.js';

/** Currently editing connection ID (null = new) */
let _editingConnectionId = null;

/** 2-letter glyph per provider id; falls back to first 2 chars uppercased. */
function glyphFor(providerId) {
    const map = { github: 'GH', gitea: 'GT', gitlab: 'GL', bitbucket: 'BB', local: 'ZP' };
    return map[providerId] || (providerId || '?').slice(0, 2).toUpperCase();
}

/**
 * Decide a row's status from the data we already track.
 * No `lastSyncAt` plumbing in 1.3.8 — that's 1.3.8.1's companion to the
 * aggregated repo picker, which is what actually drives `listAllRepos`.
 */
function statusFor(conn) {
    if (!conn.enabled) return { kind: 'disabled', label: 'disabled' };
    if (conn._unreachable) return { kind: 'warn', label: 'unreachable — retry' };
    if (!conn.token) return { kind: 'warn', label: 'no token' };
    return { kind: 'ok', label: 'ready' };
}

/**
 * Initialize the Connections tab: render groups, wire up editor controls.
 */
export function initConnectionsTab() {
    renderConnectionsGroups();

    const cancelBtn = document.getElementById('btnCancelConnection');
    if (cancelBtn) cancelBtn.onclick = hideConnectionEditor;

    const saveBtn = document.getElementById('btnSaveConnection');
    if (saveBtn) saveBtn.onclick = saveConnectionFromEditor;

    const testBtn = document.getElementById('btnTestConnection');
    if (testBtn) testBtn.onclick = testConnectionFromEditor;

    // Hide URL field when provider has a fixed URL
    const providerSelect = document.getElementById('connEditProvider');
    if (providerSelect) {
        providerSelect.onchange = () => {
            const provider = GitProviderRegistry.get(providerSelect.value);
            const urlGroup = document.getElementById('connEditUrlGroup');
            if (urlGroup && provider) {
                if (provider.fixedUrl) {
                    urlGroup.style.display = 'none';
                    document.getElementById('connEditUrl').value = provider.fixedUrl;
                } else {
                    urlGroup.style.display = '';
                }
            }
        };
    }

    // Event delegation for the per-group "Add ${provider}" buttons,
    // plus per-row refresh / edit / disconnect actions.
    const groups = document.getElementById('connectionsGroups');
    if (groups) {
        groups.addEventListener('click', (ev) => {
            const addBtn = ev.target.closest('[data-conn-add]');
            if (addBtn) {
                showConnectionEditor(null, addBtn.dataset.connAdd);
                return;
            }
            const action = ev.target.closest('[data-conn-action]');
            if (!action) return;
            const id = action.dataset.connId;
            const kind = action.dataset.connAction;
            if (kind === 'edit') showConnectionEditor(id);
            else if (kind === 'refresh') refreshConnection(id);
            else if (kind === 'disconnect') removeConnection(id);
        });
    }
}

/**
 * Render per-provider groups from the GitProviderRegistry. Hidden providers
 * (e.g. the in-memory zip fallback) and providers with no client are skipped
 * — Bitbucket support arrives by registering a provider, not by editing this
 * file.
 */
function renderConnectionsGroups() {
    const container = document.getElementById('connectionsGroups');
    if (!container) return;

    const providers = GitProviderRegistry.list().filter(p => !p.hidden);
    const allConns = GitProviderRegistry.listConnections();

    container.innerHTML = providers.map(provider => {
        const list = allConns.filter(c => c.provider === provider.id);
        const glyph = glyphFor(provider.id);
        const labelAttr = escapeAttr(provider.name);

        const rowsHtml = list.length === 0
            ? `<div class="conn__empty">No ${escapeHtml(provider.name)} accounts connected.</div>`
            : list.map(conn => renderRow(conn, provider)).join('');

        return `
            <div class="conn__group" data-provider="${escapeAttr(provider.id)}">
                <div class="conn__group-head">
                    <div class="conn__provider">
                        <span class="conn__provider-glyph conn__provider-glyph--${escapeAttr(provider.id)}">${escapeHtml(glyph)}</span>
                        <span class="conn__provider-label">${escapeHtml(provider.name)}</span>
                        <span class="conn__provider-count">${list.length}</span>
                    </div>
                    <button type="button" class="conn__add" data-conn-add="${escapeAttr(provider.id)}" title="Add ${labelAttr} account">
                        ＋ Add ${escapeHtml(provider.name)} account
                    </button>
                </div>
                ${rowsHtml}
            </div>
        `;
    }).join('');
}

function renderRow(conn, provider) {
    const status = statusFor(conn);
    const idAttr = escapeAttr(conn.id);
    const disabledClass = conn.enabled ? '' : ' conn__row--disabled';
    const warnPip = status.kind === 'warn'
        ? '<span class="conn__warn-pip" title="Needs attention"></span>'
        : '';
    const url = conn.url || provider.fixedUrl || '—';

    return `
        <div class="conn__row${disabledClass}" data-conn-id="${idAttr}">
            <div class="conn__row-main">
                <div class="conn__row-name">
                    ${escapeHtml(conn.label || conn.id)}
                    ${warnPip}
                </div>
                <div class="conn__row-meta">
                    <span class="conn__url">🔗 ${escapeHtml(url)}</span>
                    <span class="conn__sep">·</span>
                    <span>${conn.token ? 'token saved' : 'no token'}</span>
                    <span class="conn__sep">·</span>
                    <span>${conn.enabled ? 'enabled' : 'disabled'}</span>
                </div>
            </div>
            <div class="conn__row-right">
                <span class="conn__status conn__status--${status.kind}">
                    <span class="conn__status-dot"></span> ${escapeHtml(status.label)}
                </span>
                <button type="button" class="conn__row-action" data-conn-action="edit" data-conn-id="${idAttr}" title="Edit">✏️</button>
                <button type="button" class="conn__row-action" data-conn-action="refresh" data-conn-id="${idAttr}" title="Refresh / re-authorize">🔄</button>
                <button type="button" class="conn__row-action conn__row-action--danger" data-conn-action="disconnect" data-conn-id="${idAttr}" title="Disconnect">🗑</button>
            </div>
        </div>
    `;
}

/**
 * Show the connection editor form for adding or editing.
 * @param {string|null} connId - null = new connection
 * @param {string|null} [preselectProvider] - when adding new, preselect this provider id
 */
function showConnectionEditor(connId, preselectProvider = null) {
    _editingConnectionId = connId;
    const editor = document.getElementById('connectionEditor');
    const title = document.getElementById('connectionEditorTitle');
    const result = document.getElementById('connectionTestResult');
    if (!editor) return;

    // Populate provider dropdown
    const providerSelect = document.getElementById('connEditProvider');
    const providers = GitProviderRegistry.list().filter(p => !p.hidden);
    providerSelect.innerHTML = providers.map(p =>
        `<option value="${escapeAttr(p.id)}">${p.icon} ${escapeHtml(p.name)}</option>`
    ).join('');

    if (connId) {
        // Editing existing connection
        const conn = GitProviderRegistry.listConnections().find(c => c.id === connId);
        if (!conn) return;

        title.textContent = 'Edit Connection';
        providerSelect.value = conn.provider;
        document.getElementById('connEditLabel').value = conn.label || '';
        document.getElementById('connEditUrl').value = conn.url || '';
        document.getElementById('connEditToken').value = conn.token || '';
        document.getElementById('connEditEnabled').checked = conn.enabled !== false;
    } else {
        // New connection
        title.textContent = preselectProvider
            ? `New ${GitProviderRegistry.get(preselectProvider)?.name || preselectProvider} Connection`
            : 'New Connection';
        if (preselectProvider && providers.some(p => p.id === preselectProvider)) {
            providerSelect.value = preselectProvider;
        }
        document.getElementById('connEditLabel').value = '';
        document.getElementById('connEditUrl').value = '';
        document.getElementById('connEditToken').value = '';
        document.getElementById('connEditEnabled').checked = true;
    }

    // Show/hide URL field based on provider
    const selectedProvider = GitProviderRegistry.get(providerSelect.value);
    const urlGroup = document.getElementById('connEditUrlGroup');
    if (urlGroup && selectedProvider?.fixedUrl) {
        urlGroup.style.display = 'none';
        document.getElementById('connEditUrl').value = selectedProvider.fixedUrl;
    } else if (urlGroup) {
        urlGroup.style.display = '';
    }

    // Clear test result
    if (result) result.style.display = 'none';
    editor.style.display = 'block';
}

/**
 * Hide the connection editor form.
 */
function hideConnectionEditor() {
    const editor = document.getElementById('connectionEditor');
    if (editor) editor.style.display = 'none';
    _editingConnectionId = null;
}

/**
 * Save the current connection from the editor form.
 */
function saveConnectionFromEditor() {
    const providerId = document.getElementById('connEditProvider').value;
    const label = document.getElementById('connEditLabel').value.trim();
    const url = document.getElementById('connEditUrl').value.trim();
    const token = document.getElementById('connEditToken').value.trim();
    const enabled = document.getElementById('connEditEnabled').checked;

    if (!label) {
        window.showToast('Connection label is required', 'warning');
        return;
    }

    if (!token) {
        window.showToast('Access token is required', 'warning');
        return;
    }

    // Check if provider requires URL (not fixed)
    const provider = GitProviderRegistry.get(providerId);
    const effectiveUrl = provider?.fixedUrl || url;
    if (!effectiveUrl) {
        window.showToast('Server URL is required for this provider', 'warning');
        return;
    }

    const connData = {
        provider: providerId,
        label,
        url: effectiveUrl,
        token,
        enabled
    };

    if (_editingConnectionId) {
        // Update existing
        connData.id = _editingConnectionId;
        GitProviderRegistry.updateConnection(_editingConnectionId, connData);
        window.showToast('Connection updated', 'success');
    } else {
        // Generate a slug ID from label
        const slugId = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        connData.id = slugId || `conn-${Date.now()}`;

        // Ensure unique ID
        const existing = GitProviderRegistry.listConnections();
        if (existing.some(c => c.id === connData.id)) {
            connData.id += `-${Date.now()}`;
        }

        GitProviderRegistry.addConnection(connData);
        window.showToast('Connection added', 'success');
    }

    hideConnectionEditor();
    renderConnectionsGroups();
}

/**
 * Test the current connection settings in the editor.
 */
async function testConnectionFromEditor() {
    const resultEl = document.getElementById('connectionTestResult');
    const btn = document.getElementById('btnTestConnection');
    if (!resultEl || !btn) return;

    const providerId = document.getElementById('connEditProvider').value;
    const url = document.getElementById('connEditUrl').value.trim();
    const token = document.getElementById('connEditToken').value.trim();
    const provider = GitProviderRegistry.get(providerId);
    const effectiveUrl = provider?.fixedUrl || url;

    if (!effectiveUrl || !token) {
        showTestResult(resultEl, 'error', 'URL and token are required to test');
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Testing...';
    showTestResult(resultEl, 'info', '⏳ Connecting...');

    try {
        const result = await GitProviderRegistry.testConnection(providerId, effectiveUrl, token);
        if (result.ok) {
            showTestResult(resultEl, 'success', `✅ Connected! User: ${result.user || 'unknown'}`);
        } else {
            showTestResult(resultEl, 'error', `❌ ${result.error || 'Connection failed'}`);
        }
    } catch (err) {
        showTestResult(resultEl, 'error', `❌ ${err.message}`);
    } finally {
        btn.disabled = false;
        btn.textContent = '🧪 Test';
    }
}

function showTestResult(el, type, message) {
    const colors = { success: 'var(--tk-color-success)', error: 'var(--tk-color-error)', info: 'var(--tk-text-muted)' };
    el.style.display = 'block';
    el.style.color = colors[type] || 'var(--tk-text-primary)';
    el.textContent = message;
}

/**
 * Bypass the circuit-breaker cooldown for a single connection and re-render.
 * The next outbound listRepos call against this connection will retry.
 */
function refreshConnection(connId) {
    const conn = GitProviderRegistry.listConnections().find(c => c.id === connId);
    if (!conn) return;
    conn._forceRetry = true;
    conn._unreachable = false;
    renderConnectionsGroups();
    window.showToast(`Retry queued for ${conn.label}`, 'info');
}

/**
 * Remove a connection after confirmation.
 */
export async function removeConnection(connId) {
    const conn = GitProviderRegistry.listConnections().find(c => c.id === connId);
    if (!conn) return;

    const { showConfirm } = await import('../ui/dialogs.js');
    if (!await showConfirm(`Remove connection "${conn.label}"?`, { title: 'Remove Connection', okLabel: 'Remove', variant: 'danger' })) return;

    GitProviderRegistry.removeConnection(connId);
    hideConnectionEditor();
    renderConnectionsGroups();
    window.showToast('Connection removed', 'success');
}

// Expose for any external callers (legacy compatibility — onclick attributes
// in the old markup are gone, but other modules may invoke these).
window._editConnection = (connId) => showConnectionEditor(connId);
window._removeConnection = removeConnection;

// Test seam: lets browser smoke tests render against a fixed registry state
// without booting `initConnectionsTab` (which assumes the editor form exists).
export const __test_renderConnectionsGroups = renderConnectionsGroups;
export const __test_showConnectionEditor = showConnectionEditor;
