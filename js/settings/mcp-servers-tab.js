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
import { getRemoteCatalog } from '../mcp/catalog-fetch.js';
import { mergeCatalogs } from '../mcp/catalog-merge.js';
import { fetchRemoteDetail } from '../mcp/catalog-source.js';
import { shouldAutoTest, formatTestResultToast } from '../mcp/auto-test.js';
import { escapeHtml, escapeAttr } from '../utils/html.js';

let _editingServerId = null;
// 2.16.0 — pre-save snapshot used by the auto-test policy. Captured in
// `showServerEditor` for edit mode (null on add); cleared on
// `hideServerEditor`. Read once in `saveServerFromEditor` to decide
// whether a label-only edit can skip the connection probe.
let _preSaveSnapshot = null;

// 2.15.0 — Browse Catalog state. Module-scoped so the search input + chips
// can re-render the list without refetching the remote registry. Reset
// each time the picker is opened (cache hit makes that cheap).
let _lastMergedCatalog = /** @type {ReadonlyArray<Object>} */ ([]);
let _filterQuery = '';
let _filterSource = /** @type {'all'|'curated'|'remote'} */ ('all');
let _searchInputDebounce = null;

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

    // 2.15.0 — search input + source-filter chips wiring.
    const search = document.getElementById('mcpCatalogSearch');
    if (search) {
        search.addEventListener('input', () => {
            if (_searchInputDebounce) clearTimeout(_searchInputDebounce);
            _searchInputDebounce = setTimeout(() => {
                _filterQuery = search.value || '';
                renderCatalogList(_lastMergedCatalog);
            }, 150);
        });
    }
    const chips = document.getElementById('mcpCatalogChips');
    if (chips) {
        chips.addEventListener('click', (ev) => {
            const chip = ev.target.closest('[data-mcp-chip]');
            if (!chip) return;
            const value = chip.dataset.mcpChip;
            if (value !== 'all' && value !== 'curated' && value !== 'remote') return;
            _filterSource = value;
            renderCatalogChips();
            renderCatalogList(_lastMergedCatalog);
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
        _preSaveSnapshot = { ...server };
    } else {
        if (title) title.textContent = 'New MCP Server';
        document.getElementById('mcpEditLabel').value = starter?.label ?? '';
        document.getElementById('mcpEditUrl').value = starter?.url ?? '';
        document.getElementById('mcpEditToken').value = starter?.token ?? '';
        document.getElementById('mcpEditTransport').value = starter?.transport ?? 'streamable-http';
        document.getElementById('mcpEditEnabled').checked = starter?.enabled !== false;
        setRolesCheckboxes(starter?.roles ?? 'all');
        _preSaveSnapshot = null;
    }
    if (result) result.style.display = 'none';
    editor.style.display = 'block';
}

function hideServerEditor() {
    const editor = document.getElementById('mcpServerEditor');
    if (editor) editor.style.display = 'none';
    _editingServerId = null;
    _preSaveSnapshot = null;
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

    const wasEdit = !!_editingServerId;
    let serverId = _editingServerId;

    if (wasEdit) {
        MCPServerRegistry.updateServer(_editingServerId, { label, url, token, transport, enabled, roles });
    } else {
        let id = slugifyLabel(label) || `mcp-${Date.now()}`;
        if (MCPServerRegistry.getServer(id)) id += `-${Date.now()}`;
        try {
            MCPServerRegistry.addServer({ id, label, url, token, transport, enabled, roles });
            serverId = id;
        } catch (err) {
            window.showToast(err.message || 'Failed to add server', 'error');
            return;
        }
    }

    // Capture pre-save snapshot before `hideServerEditor` clears it. The
    // snapshot was set in `showServerEditor` for edit mode (null on add).
    const preSave = _preSaveSnapshot;
    const postSave = { id: serverId, label, url, token, transport, enabled, roles };

    hideServerEditor();
    renderMCPServersList();
    EventBus.emit('mcp:serversChanged', {});

    // 2.16.0 — github#27 Phase 2 slice 2. Auto-test on add or on a
    // url/token/transport change; surface result via toast. Skip for
    // disabled servers and label-only edits — see `mcp/auto-test.js`.
    if (shouldAutoTest({ preSave, postSave })) {
        window.showToast('MCP server saved — testing connection…', 'info');
        runAutoTest(postSave);
    } else {
        window.showToast(wasEdit ? 'MCP server updated' : 'MCP server added', 'success');
    }
}

/**
 * Probe the just-saved server and surface the outcome via a follow-up
 * toast. Runs in parallel with the bridge plugin's own reconnect (which
 * registers tools); cost is one extra `initialize` + `tools/list`
 * round-trip in exchange for an action-tied acknowledgement.
 *
 * @param {{label: string, url: string, token?: string, transport?: string}} cfg
 */
async function runAutoTest(cfg) {
    let result;
    try {
        result = await MCPServerRegistry.testConnection({
            url: cfg.url,
            token: cfg.token || '',
            transport: cfg.transport,
        });
    } catch (err) {
        result = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    const toast = formatTestResultToast({ label: cfg.label, result });
    if (window.showToast) window.showToast(toast.message, toast.kind);
    // Re-render in case the bridge's parallel reconnect mutated
    // `_unreachable` / `_toolCount` between Save and now.
    renderMCPServersList();
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
// 2.15.0 — github#27 Phase 2 slice 1: + Smithery remote registry,
// search input, source-filter chips, lazy detail fetch on pick.
// ============================================

async function openCatalogBrowser() {
    const panel = document.getElementById('mcpCatalogPanel');
    if (!panel) return;
    hideServerEditor();
    panel.style.display = 'block';

    // Reset filter state on each open so the picker starts in a clean view.
    _filterQuery = '';
    _filterSource = 'all';
    const searchEl = document.getElementById('mcpCatalogSearch');
    if (searchEl) searchEl.value = '';

    // Paint the bundled-only catalog instantly so the panel never looks
    // empty while the remote fetch is in flight (cache hit makes this
    // moot, but a cold cache + slow network would otherwise show a
    // perceptible blank panel).
    _lastMergedCatalog = mergeCatalogs(MCP_CATALOG, []);
    renderCatalogChips();
    renderCatalogList(_lastMergedCatalog);
    renderCatalogStatus({ loading: true });

    // Fetch remote in the background; reconcile on resolve.
    let result;
    try {
        result = await getRemoteCatalog({});
    } catch (err) {
        // getRemoteCatalog is no-throw — this branch should be unreachable.
        // Defensive: still render the bundled-only state and surface a hint.
        console.warn('[mcp-catalog] getRemoteCatalog rejected unexpectedly:', err);
        renderCatalogStatus({ source: 'bundled', remoteCount: 0 });
        return;
    }

    _lastMergedCatalog = mergeCatalogs(MCP_CATALOG, result.entries);
    renderCatalogList(_lastMergedCatalog);
    renderCatalogStatus({
        source: result.source,
        remoteCount: result.entries.length,
        fetchedAt: result.fetchedAt,
    });
}

function closeCatalogBrowser() {
    const panel = document.getElementById('mcpCatalogPanel');
    if (panel) panel.style.display = 'none';
}

/**
 * Render the catalog rows. Reads `_filterQuery` + `_filterSource` for
 * client-side filtering; both are cheap (O(N) over ≤108 entries).
 *
 * @param {ReadonlyArray<Object>} catalog
 */
function renderCatalogList(catalog) {
    const container = document.getElementById('mcpCatalogList');
    if (!container) return;

    const list = Array.isArray(catalog) ? catalog : [];
    const q = _filterQuery.trim().toLowerCase();
    const filtered = list.filter(entry => {
        if (_filterSource === 'curated' && entry.source !== 'bundled') return false;
        if (_filterSource === 'remote' && entry.source !== 'remote') return false;
        if (!q) return true;
        const hay = `${entry.name || ''} ${entry.description || ''} ${entry.qualifiedName || ''}`.toLowerCase();
        return hay.includes(q);
    });

    if (filtered.length === 0) {
        const reason = q ? `no matches for "${escapeHtml(q)}"` : 'no entries in this filter';
        container.innerHTML = `<div class="conn__empty">${reason}.</div>`;
        return;
    }

    container.innerHTML = filtered.map(renderCatalogRow).join('');
}

function renderCatalogRow(entry) {
    const isRemote = entry.source === 'remote';
    const alreadyAdded = !!MCPServerRegistry.getServer(entry.id);

    const tokenBadge = entry.requiresToken
        ? '<span title="Requires a bearer token or API key">🔑 token required</span>'
        : '<span title="No authentication needed">🔓 no token</span>';

    const sourceBadge = isRemote
        ? `<span class="connection-card-badge" title="Discovered via the Smithery public registry. Curated entries take precedence on collisions.">Smithery</span>`
        : `<span class="connection-card-badge connection-card-badge--curated" title="Hand-curated by the editor team. Ships with full credential hints.">Curated</span>`;

    const verifiedBadge = isRemote && entry.verified
        ? `<span class="connection-card-badge" title="Marked as verified by the registry">✓ verified</span>`
        : '';

    const popularityMeta = isRemote && entry.useCount > 0
        ? ` · <span title="Reported usage count from the registry">${formatUseCount(entry.useCount)} uses</span>`
        : '';

    const docsLink = entry.docsUrl
        ? ` · <a href="${escapeAttr(entry.docsUrl)}" target="_blank" rel="noopener noreferrer">Docs ↗</a>`
        : '';

    const transportMeta = isRemote
        ? '' // Unknown until detail fetch — don't show a misleading default.
        : ` · ${escapeHtml(entry.transport || 'streamable-http')}`;

    const action = alreadyAdded
        ? `<button type="button" data-mcp-catalog-id="${escapeAttr(entry.id)}" title="Edit existing server">Already added</button>`
        : `<button type="button" data-mcp-catalog-id="${escapeAttr(entry.id)}" title="${isRemote ? 'Fetch connection details and pre-fill the add-server form' : 'Pre-fill the add-server form'}">Use this server</button>`;

    return `
        <div class="connection-card">
            <div class="connection-card-icon">${categoryIcon(entry.category)}</div>
            <div class="connection-card-info">
                <div class="connection-card-label">${escapeHtml(entry.name)} ${sourceBadge}${verifiedBadge}</div>
                <div class="connection-card-meta">${escapeHtml(entry.description || '—')}</div>
                <div class="connection-card-meta">
                    ${escapeHtml(entry.category || 'integration')}${transportMeta} · ${tokenBadge}${popularityMeta}${docsLink}
                </div>
            </div>
            <div class="connection-card-actions">
                ${action}
            </div>
        </div>
    `;
}

function renderCatalogChips() {
    const container = document.getElementById('mcpCatalogChips');
    if (!container) return;
    const chips = [
        { v: 'all', label: 'All' },
        { v: 'curated', label: 'Curated' },
        { v: 'remote', label: 'Smithery' },
    ];
    container.innerHTML = chips.map(c =>
        `<button type="button" data-mcp-chip="${c.v}" class="catalog-chip" aria-pressed="${_filterSource === c.v}">${escapeHtml(c.label)}</button>`
    ).join('');
}

/**
 * Render the small status line under the picker — "loading…" while the
 * remote fetch is in flight, then a one-liner reporting how many remote
 * entries landed and from what tier (`fresh`, `cache`, `bundled`).
 *
 * @param {{loading?: boolean, source?: 'fresh'|'cache'|'bundled', remoteCount?: number, fetchedAt?: number}} state
 */
function renderCatalogStatus(state) {
    const el = document.getElementById('mcpCatalogStatus');
    if (!el) return;
    if (state.loading) {
        el.textContent = 'Loading remote registry…';
        el.style.display = 'block';
        return;
    }
    if (state.source === 'fresh') {
        el.textContent = `Showing ${MCP_CATALOG.length} curated + ${state.remoteCount} from Smithery (just fetched).`;
    } else if (state.source === 'cache') {
        const ageHrs = state.fetchedAt ? Math.round((Date.now() - state.fetchedAt) / 3600000) : null;
        const ageStr = ageHrs == null ? '' : ` · cached ${ageHrs}h ago`;
        el.textContent = `Showing ${MCP_CATALOG.length} curated + ${state.remoteCount} from Smithery${ageStr}.`;
    } else {
        el.textContent = `Showing ${MCP_CATALOG.length} curated entries (remote registry unavailable).`;
    }
    el.style.display = 'block';
}

function formatUseCount(n) {
    if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    return String(n);
}

async function onCatalogPick(entryId) {
    const entry = _lastMergedCatalog.find(e => e.id === entryId)
        || MCP_CATALOG.find(e => e.id === entryId);
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

    // Bundled entries already have URL + transport; pre-fill is synchronous.
    if (entry.source !== 'remote') {
        showServerEditor(null, catalogEntryToStarter(entry));
        surfaceCatalogHints(entry);
        return;
    }

    // Remote (Smithery) entry — fetch detail to resolve the connection URL.
    if (window.showToast) window.showToast(`Fetching connection details for "${entry.name}"…`, 'info');

    let detail;
    try {
        detail = await fetchRemoteDetail(entry.qualifiedName || entry.id);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (window.showToast) window.showToast(`Couldn't fetch details for "${entry.name}": ${msg}`, 'error');
        return;
    }

    if (!detail || !detail.url) {
        if (window.showToast) {
            window.showToast(`"${entry.name}" has no usable HTTP/SSE connection in the registry.`, 'warning');
        }
        return;
    }

    const enrichedEntry = { ...entry, url: detail.url, transport: detail.transport };
    showServerEditor(null, catalogEntryToStarter(enrichedEntry));
    surfaceCatalogHints(enrichedEntry);
}

/**
 * Render the entry's tokenHint / authNote into the editor's test-result
 * strip — already styled, already in DOM. Called from `onCatalogPick`
 * for both bundled and remote entries.
 */
function surfaceCatalogHints(entry) {
    if (!entry.tokenHint && !entry.authNote) return;
    const resultEl = document.getElementById('mcpServerTestResult');
    if (!resultEl) return;
    resultEl.style.display = 'block';
    resultEl.style.color = 'var(--text-muted)';
    resultEl.textContent = [entry.tokenHint, entry.authNote].filter(Boolean).join(' · ');
}

// Test seams.
export const __test_renderMCPServersList = renderMCPServersList;
export const __test_showServerEditor = showServerEditor;
export const __test_renderCatalogList = renderCatalogList;
export const __test_onCatalogPick = onCatalogPick;
export const __test_renderCatalogChips = renderCatalogChips;
export const __test_setFilter = (q, source) => {
    _filterQuery = q || '';
    if (source === 'all' || source === 'curated' || source === 'remote') _filterSource = source;
};
