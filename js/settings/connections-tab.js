// ============================================
// SETTINGS — CONNECTIONS TAB
// ============================================

import { GitProviderRegistry } from '../git-providers/index.js';
import { escapeHtml, escapeAttr } from '../utils/html.js';

/** Currently editing connection ID (null = new) */
let _editingConnectionId = null;

/**
 * Initialize the Connections tab: render list, wire up buttons.
 */
export function initConnectionsTab() {
    renderConnectionsList();

    const addBtn = document.getElementById('btnAddConnection');
    if (addBtn) addBtn.onclick = () => showConnectionEditor(null);

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
}

/**
 * Render the connections list from the GitProviderRegistry.
 */
function renderConnectionsList() {
    const container = document.getElementById('connectionsList');
    if (!container) return;

    const connections = GitProviderRegistry.listConnections().filter(c => {
        const p = GitProviderRegistry.get(c.provider);
        return !p?.hidden;
    });

    if (connections.length === 0) {
        container.innerHTML = `
            <div class="connections-empty">
                <div class="connections-empty-icon">🔌</div>
                <div>No connections configured yet.</div>
                <div style="margin-top: 0.25rem; font-size: var(--font-sm);">Add a git provider to get started.</div>
            </div>
        `;
        return;
    }

    container.innerHTML = connections.map(conn => {
        const provider = GitProviderRegistry.get(conn.provider);
        const icon = provider ? provider.icon : '📦';
        const providerName = provider ? provider.name : conn.provider;
        const disabledClass = conn.enabled ? '' : ' disabled';
        const statusDot = conn.enabled
            ? '<span style="color: var(--success);" title="Enabled">●</span>'
            : '<span style="color: var(--text-muted);" title="Disabled">○</span>';

        return `
            <div class="connection-card${disabledClass}" data-conn-id="${escapeAttr(conn.id)}">
                <div class="connection-card-icon">${icon}</div>
                <div class="connection-card-info">
                    <div class="connection-card-label">${statusDot} ${escapeHtml(conn.label)}</div>
                    <div class="connection-card-meta">${escapeHtml(providerName)} · ${escapeHtml(conn.url || '—')}</div>
                </div>
                <div class="connection-card-actions">
                    <button onclick="window._editConnection('${escapeAttr(conn.id)}')" title="Edit">✏️</button>
                    <button class="danger" onclick="window._removeConnection('${escapeAttr(conn.id)}')" title="Remove">🗑️</button>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Show the connection editor form for adding or editing.
 * @param {string|null} connId - null = new connection
 */
function showConnectionEditor(connId) {
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
        title.textContent = 'New Connection';
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
    renderConnectionsList();
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
    const colors = { success: 'var(--success)', error: 'var(--error)', info: 'var(--text-muted)' };
    el.style.display = 'block';
    el.style.color = colors[type] || 'var(--text-primary)';
    el.textContent = message;
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
    renderConnectionsList();
    window.showToast('Connection removed', 'success');
}

// Expose for onclick handlers in rendered HTML
window._editConnection = (connId) => showConnectionEditor(connId);
window._removeConnection = removeConnection;
