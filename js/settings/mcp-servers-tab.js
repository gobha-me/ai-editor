// ============================================
// SETTINGS — MCP SERVERS TAB (1.4.2)
//
// Mirrors the connections-tab.js shape — same Add/Edit/Test/Remove
// vocabulary, same in-modal editor pattern. Servers configured here
// enter the Catalog under `mcp.<serverId>` via the bundled
// `plugins/mcp-bridge.js`; tools reach the model only via discovery
// (find_tool / list_tools_by_category) + sticky admission so adding a
// server costs ~0 baseline tokens.
// ============================================

import { EventBus } from '../core.js';
import { MCPServerRegistry } from '../mcp/registry.js';
import { MCP_CATALOG, categoryIcon, catalogEntryToStarter } from '../mcp/catalog.js';
import { escapeHtml, escapeAttr } from '../utils/html.js';

let _editingServerId = null;

function statusFor(server) {
    if (!server.enabled) return { kind: 'disabled', label: 'disabled' };
    if (server._unreachable) return { kind: 'warn', label: 'unreachable' };
    if (!server.url) return { kind: 'warn', label: 'no URL' };
    return { kind: 'ok', label: 'ready' };
}

/**
 * Format roles for display in the server list row.
 * @param {string|string[]} roles
 * @returns {string}
 */
function formatRoles(roles) {
    if (!roles || roles === 'all') return '🔓 all roles';
    if (Array.isArray(roles)) {
        if (roles.length === 0) return '🔓 all roles';
        if (roles.includes('all')) return '🔓 all roles';
        const shortNames = roles.map(r => {
            const map = { full: 'Full', coder: 'Coder', pm: 'PM', reviewer: 'Reviewer', 'plugin-dev': 'Plugin' };
            return map[r] || r;
        });
        return `🔒 ${shortNames.join(', ')}`;
    }
    return `🔒 ${roles}`;
}

export function initMCPServersTab() {
    renderMCPServersList();

    const addBtn = document.getElementById('btnAddMCPServer');
    if (addBtn) addBtn.onclick = () => showServerEditor(null);

    const cancelBtn = document.getElementById('btnCancelMCPServer');
    if (cancelBtn) cancelBtn.onclick = hideServerEditor;

    const saveBtn = document.getElementById('btnSaveMCPServer');
    if (saveBtn) saveBtn.onclick = saveServerFromEditor;

    const testBtn = document.getElementById('btnTestMCPServer');
    if (testBtn) testBtn.onclick = testServerFromEditor;

    const list = document.getElementById('mcpServersList');
    if (list) {
        list.addEventListener('click', (ev) => {
            const action = ev.target.closest('[data-mcp-action]');
            if (!action) return;
            const id = action.dataset.mcpId;
            const kind = action.dataset.mcpAction;
            if (kind === 'edit') showServerEditor(id);
            else if (kind === 'remove') removeServer(id);
            else if (kind === 'toggle') toggleServer(id);
        });
    }

    const browseBtn = document.getElementById('btnBrowseMCPCatalog');
    if (browseBtn) browseBtn.onclick = openCatalogBrowser;

    const closeCatalogBtn = document.getElementById('btnCloseMCPCatalog');
    if (closeCatalogBtn) closeCatalogBtn.onclick = closeCatalogBrowser;

    const catalogList = document.getElementById('mcpCatalogList');
    if (catalogList) {
        catalogList.addEventListener('click', (ev) => {
            const action = ev.target.closest('[data-mcp-catalog-id]');
            if (!action) return;
            onCatalogPick(action.dataset.mcpCatalogId);
        });
    }
}

function renderMCPServersList() {
    const container = document.getElementById('mcpServersList');
    if (!container) return;

    const servers = MCPServerRegistry.listServers();
    if (servers.length === 0) {
        container.innerHTML = `<div class="conn__empty">No MCP servers configured. Click <strong>+ Add MCP Server</strong> to connect one.</div>`;
        return;
    }

    container.innerHTML = servers.map(server => renderRow(server)).join('');
}

function renderRow(server) {
    const status = statusFor(server);
    const idAttr = escapeAttr(server.id);
    const disabledClass = server.enabled ? '' : ' conn__row--disabled';
    const url = server.url || '—';
    const toolCount = server._toolCount || 0;
    const toolWord = toolCount === 1 ? 'tool' : 'tools';
    const toolMeta = server.enabled ? `${toolCount} ${toolWord} loaded` : 'disabled';
    const rolesMeta = formatRoles(server.roles);

    return `
        <div class="conn__row${disabledClass}" data-mcp-id="${idAttr}">
            <div class="conn__row-main">
                <div class="conn__row-name">
                    ${escapeHtml(server.label || server.id)}
                </div>
                <div class="conn__row-meta">
                    <span class="conn__url">🔗 ${escapeHtml(url)}</span>
                    <span class="conn__sep">·</span>
                    <span>${escapeHtml(server.transport || 'streamable-http')}</span>
                    <span class="conn__sep">·</span>
                    <span>${escapeHtml(toolMeta)}</span>
                    <span class="conn__sep">·</span>
                    <span class="conn__roles">${rolesMeta}</span>
                </div>
            </div>
            <div class="conn__row-right">
                <span class="conn__status conn__status--${status.kind}">
                    <span class="conn__status-dot"></span> ${escapeHtml(status.label)}
                </span>
                <button type="button" class="conn__row-action" data-mcp-action="toggle" data-mcp-id="${idAttr}" title="${server.enabled ? 'Disable' : 'Enable'}">${server.enabled ? '⏸' : '▶'}</button>
                <button type="button" class="conn__row-action" data-mcp-action="edit" data-mcp-id="${idAttr}" title="Edit">✏️</button>
                <button type="button" class="conn__row-action conn__row-action--danger" data-mcp-action="remove" data-mcp-id="${idAttr}" title="Remove">🗑</button>
            </div>
        </div>
    `;
}

function showServerEditor(serverId, starter) {
    _editingServerId = serverId;
    const editor = document.getElementById('mcpServerEditor');
    const title = document.getElementById('mcpServerEditorTitle');
    const result = document.getElementById('mcpServerTestResult');
    if (!editor) return;

    if (serverId) {
        const server = MCPServerRegistry.getServer(serverId);
        if (!server) return;
        if (title) title.textContent = 'Edit MCP Server';
        document.getElementById('mcpEditLabel').value = server.label || '';
        document.getElementById('mcpEditUrl').value = server.url || '';
        document.getElementById('mcpEditToken').value = server.token || '';
        document.getElementById('mcpEditTransport').value = server.transport || 'streamable-http';
        document.getElementById('mcpEditEnabled').checked = server.enabled !== false;
        setRolesCheckboxes(server.roles);
    } else {
        if (title) title.textContent = 'New MCP Server';
        document.getElementById('mcpEditLabel').value = starter?.label ?? '';
        document.getElementById('mcpEditUrl').value = starter?.url ?? '';
        document.getElementById('mcpEditToken').value = starter?.token ?? '';
        document.getElementById('mcpEditTransport').value = starter?.transport ?? 'streamable-http';
        document.getElementById('mcpEditEnabled').checked = starter?.enabled !== false;
        setRolesCheckboxes(starter?.roles ?? 'all');
    }
    if (result) result.style.display = 'none';
    editor.style.display = 'block';
}

function hideServerEditor() {
    const editor = document.getElementById('mcpServerEditor');
    if (editor) editor.style.display = 'none';
    _editingServerId = null;
}

/**
 * Set the role checkboxes based on the server's roles value.
 * @param {string|string[]} roles
 */
function setRolesCheckboxes(roles) {
    const container = document.getElementById('mcpEditRoles');
    if (!container) return;
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    const isAll = !roles || roles === 'all' || (Array.isArray(roles) && roles.includes('all'));
    checkboxes.forEach(cb => {
        cb.checked = isAll || (Array.isArray(roles) && roles.includes(cb.value));
    });
}

/**
 * Read the current state of the role checkboxes.
 * @returns {string|string[]}
 */
function getRolesFromCheckboxes() {
    const container = document.getElementById('mcpEditRoles');
    if (!container) return 'all';
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    const checked = Array.from(checkboxes).filter(cb => cb.checked).map(cb => cb.value);
    if (checked.length === 0 || checked.length === checkboxes.length) return 'all';
    return checked;
}

function slugifyLabel(label) {
    return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function saveServerFromEditor() {
    const label = document.getElementById('mcpEditLabel').value.trim();
    const url = document.getElementById('mcpEditUrl').value.trim();
    const token = document.getElementById('mcpEditToken').value.trim();
    const transport = document.getElementById('mcpEditTransport').value;
    const enabled = document.getElementById('mcpEditEnabled').checked;
    const roles = getRolesFromCheckboxes();

    if (!label) {
        window.showToast('Server label is required', 'warning');
        return;
    }
    if (!url) {
        window.showToast('Server URL is required', 'warning');
        return;
    }

    if (_editingServerId) {
        MCPServerRegistry.updateServer(_editingServerId, { label, url, token, transport, enabled, roles });
        window.showToast('MCP server updated', 'success');
    } else {
        let id = slugifyLabel(label) || `mcp-${Date.now()}`;
        if (MCPServerRegistry.getServer(id)) id += `-${Date.now()}`;
        try {
            MCPServerRegistry.addServer({ id, label, url, token, transport, enabled, roles });
            window.showToast('MCP server added', 'success');
        } catch (err) {
            window.showToast(err.message || 'Failed to add server', 'error');
            return;
        }
    }

    hideServerEditor();
    renderMCPServersList();
    EventBus.emit('mcp:serversChanged', {});
}

async function testServerFromEditor() {
    const resultEl = document.getElementById('mcpServerTestResult');
    const btn = document.getElementById('btnTestMCPServer');
    if (!resultEl || !btn) return;

    const url = document.getElementById('mcpEditUrl').value.trim();
    const token = document.getElementById('mcpEditToken').value.trim();
    const transport = document.getElementById('mcpEditTransport').value;
    if (!url) {
        showTestResult(resultEl, 'error', 'URL is required to test');
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Testing...';
    showTestResult(resultEl, 'info', '⏳ Connecting...');

    try {
        const result = await MCPServerRegistry.testConnection({ url, token, transport });
        if (result.ok) {
            const name = result.serverInfo?.name || 'server';
            showTestResult(resultEl, 'success', `✅ Connected to ${name} — ${result.toolCount} tool(s) advertised`);
        } else {
            showTestResult(resultEl, 'error', `❌ ${result.error || 'Connection failed'}`);
        }
    } catch (err) {
        showTestResult(resultEl, 'error', `❌ ${err.message || String(err)}`);
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

function toggleServer(serverId) {
    const server = MCPServerRegistry.getServer(serverId);
    if (!server) return;
    MCPServerRegistry.updateServer(serverId, { enabled: !server.enabled });
    renderMCPServersList();
    EventBus.emit('mcp:serversChanged', { serverId });
}

async function removeServer(serverId) {
    const server = MCPServerRegistry.getServer(serverId);
    if (!server) return;
    const { showConfirm } = await import('../ui/dialogs.js');
    if (!await showConfirm(`Remove MCP server "${server.label}"?`, { title: 'Remove MCP Server', okLabel: 'Remove', variant: 'danger' })) return;

    MCPServerRegistry.removeServer(serverId);
    hideServerEditor();
    renderMCPServersList();
    EventBus.emit('mcp:serversChanged', { serverId });
    window.showToast('MCP server removed', 'success');
}

// ============================================
// 2.3.0 — github#27 Phase 1: Curated MCP catalog picker.
// ============================================

function openCatalogBrowser() {
    const panel = document.getElementById('mcpCatalogPanel');
    if (!panel) return;
    hideServerEditor();
    renderCatalogList();
    panel.style.display = 'block';
}

function closeCatalogBrowser() {
    const panel = document.getElementById('mcpCatalogPanel');
    if (panel) panel.style.display = 'none';
}

function renderCatalogList() {
    const container = document.getElementById('mcpCatalogList');
    if (!container) return;

    container.innerHTML = MCP_CATALOG.map(entry => {
        const alreadyAdded = !!MCPServerRegistry.getServer(entry.id);
        const tokenBadge = entry.requiresToken
            ? '<span title="Requires a bearer token or API key">🔑 token required</span>'
            : '<span title="No authentication needed">🔓 no token</span>';
        const docsLink = `<a href="${escapeAttr(entry.docsUrl)}" target="_blank" rel="noopener noreferrer">Docs ↗</a>`;
        const action = alreadyAdded
            ? `<button type="button" data-mcp-catalog-id="${escapeAttr(entry.id)}" title="Edit existing server">Already added</button>`
            : `<button type="button" data-mcp-catalog-id="${escapeAttr(entry.id)}" title="Pre-fill the add-server form">Use this server</button>`;

        return `
            <div class="connection-card">
                <div class="connection-card-icon">${categoryIcon(entry.category)}</div>
                <div class="connection-card-info">
                    <div class="connection-card-label">${escapeHtml(entry.name)}</div>
                    <div class="connection-card-meta">${escapeHtml(entry.description)}</div>
                    <div class="connection-card-meta">
                        ${escapeHtml(entry.category)} · ${escapeHtml(entry.transport)} · ${tokenBadge} · ${docsLink}
                    </div>
                </div>
                <div class="connection-card-actions">
                    ${action}
                </div>
            </div>
        `;
    }).join('');
}

function onCatalogPick(entryId) {
    const entry = MCP_CATALOG.find(e => e.id === entryId);
    if (!entry) return;

    closeCatalogBrowser();

    // Already-added → open existing record in edit mode (no duplicate, no overwrite).
    const existing = MCPServerRegistry.getServer(entry.id);
    if (existing) {
        showServerEditor(entry.id);
        if (window.showToast) {
            window.showToast(`Editing existing "${entry.name}". Remove it first to re-import from the catalog.`, 'info');
        }
        return;
    }

    showServerEditor(null, catalogEntryToStarter(entry));

    // Surface tokenHint / authNote into the existing test-result strip — already
    // styled, already in DOM, no new UI needed.
    if (entry.tokenHint || entry.authNote) {
        const resultEl = document.getElementById('mcpServerTestResult');
        if (resultEl) {
            resultEl.style.display = 'block';
            resultEl.style.color = 'var(--tk-text-muted)';
            resultEl.textContent = [entry.tokenHint, entry.authNote].filter(Boolean).join(' · ');
        }
    }
}

// Test seam.
export const __test_renderMCPServersList = renderMCPServersList;
export const __test_showServerEditor = showServerEditor;
export const __test_renderCatalogList = renderCatalogList;
export const __test_onCatalogPick = onCatalogPick;
