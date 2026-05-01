// ============================================
// SETTINGS — PLUGINS TAB
// ============================================

import { Plugins, EventBus } from '../core.js';
import { escapeHtml, escapeAttr } from '../utils/html.js';
import { installPlugin, uninstallPlugin, getInstalledPlugins } from '../plugin-loader.js';
import { getUserPlugins } from '../plugin-editor.js';

// Re-render the Plugins tab when plugin button registration changes,
// but only if the tab is currently visible (avoid spurious DOM work).
// 1.3.6 — actions surfaced as a "Toolbar actions" subsection here, not
// the deleted top-bar dropdown.
function _refreshIfVisible() {
    const container = document.getElementById('pluginsList');
    if (container && container.offsetParent !== null) populatePluginsTab();
}
EventBus.on('plugin:buttonRegistered', _refreshIfVisible);
EventBus.on('plugin:enabledChanged', _refreshIfVisible);

/**
 * Populate the Plugins tab with install UI + all registered plugins.
 * Shows enable/disable toggles, description, config fields,
 * and an install-from-URL section for external plugins.
 */
export function populatePluginsTab() {
    const container = document.getElementById('pluginsList');
    if (!container) return;

    const plugins = Plugins.list();
    const installed = getInstalledPlugins();
    const installedIds = new Set(installed.map(p => p.pluginId));
    const userPlugins = getUserPlugins();
    const userIds = new Set(Object.keys(userPlugins));

    // ------------------------------------------
    // Install section (uses .connection-editor for container)
    // ------------------------------------------
    const installHtml = `
        <div class="connection-editor" style="margin-top: 0; margin-bottom: 1rem;">
            <div class="plugin-install-title">Install Plugin from URL</div>
            <div class="plugin-install-row">
                <input type="text" id="pluginInstallUrl"
                    placeholder="https://example.com/my-plugin.js">
                <button type="button" class="btn btn-primary" id="btnInstallPlugin">
                    Install
                </button>
            </div>
            <div class="plugin-install-status" id="pluginInstallStatus"></div>
            <div class="plugin-install-hint" style="display: flex; justify-content: space-between; align-items: center;">
                <span>External plugins use <code>window.AIEditor</code> to access Plugins, EventBus, State, etc.</span>
                <button type="button" class="btn btn-primary" id="btnCreatePlugin" style="white-space: nowrap; margin-left: 0.5rem;">
                    🧩 Create Plugin
                </button>
            </div>
        </div>
    `;

    // ------------------------------------------
    // Toolbar actions section (1.3.6)
    // Plugin-registered buttons formerly lived in the top-bar `⚡` dropdown;
    // they now surface here. List is empty when no plugin has registered an
    // action — the section header collapses with it.
    // ------------------------------------------
    const toolbarButtons = Plugins.getButtons();
    let toolbarHtml = '';
    if (toolbarButtons.length > 0) {
        toolbarHtml = `<div class="plugin-section-header">Toolbar actions</div>`;
        toolbarHtml += toolbarButtons.map((b, i) => `
            <div class="connection-card" data-plugin-toolbar-row="${i}">
                <div class="connection-card-icon">${escapeHtml(b.icon || '⚡')}</div>
                <div class="connection-card-info">
                    <div class="connection-card-label">${escapeHtml(b.label || 'Action')}</div>
                    <div class="connection-card-meta">Registered by ${escapeHtml(b.pluginId)}</div>
                </div>
                <div class="connection-card-actions">
                    <button type="button" data-plugin-toolbar-run="${i}" title="Run action">▶</button>
                </div>
            </div>
        `).join('');
        toolbarHtml += '<div style="margin-bottom: 1rem;"></div>';
    }

    // ------------------------------------------
    // Installed external plugins section
    // ------------------------------------------
    let externalHtml = '';
    if (installed.length > 0) {
        externalHtml = `<div class="plugin-section-header">Installed from URL</div>`;
        externalHtml += installed.map(entry => {
            const hasError = !!entry.error;
            const statusIcon = hasError
                ? '<span style="color: var(--error);" title="Load error">⚠</span>'
                : '<span style="color: var(--success);" title="Loaded">●</span>';
            const meta = hasError
                ? `<span style="color: var(--error);">Error: ${escapeHtml(entry.error)}</span>`
                : escapeHtml(entry.url);
            return `
                <div class="connection-card" data-ext-plugin-url="${escapeAttr(entry.url)}">
                    <div class="connection-card-icon">📦</div>
                    <div class="connection-card-info">
                        <div class="connection-card-label">${statusIcon} ${escapeHtml(entry.name || entry.pluginId || 'Unknown')}</div>
                        <div class="connection-card-meta plugin-external-meta">${meta}</div>
                    </div>
                    <div class="connection-card-actions">
                        <button type="button" class="danger" data-uninstall-url="${escapeAttr(entry.url)}" title="Uninstall">✕</button>
                    </div>
                </div>
            `;
        }).join('');
        externalHtml += '<div style="margin-bottom: 1rem;"></div>';
    }

    // ------------------------------------------
    // User-created plugins section
    // ------------------------------------------
    let userHtml = '';
    const userEntries = Object.entries(userPlugins);
    if (userEntries.length > 0) {
        userHtml = `<div class="plugin-section-header">User-Created Plugins</div>`;
        userHtml += userEntries.map(([id, entry]) => {
            const plugin = Plugins.get(id);
            const enabled = plugin?.enabled ?? false;
            const statusDot = enabled
                ? '<span style="color: var(--success);" title="Enabled">●</span>'
                : '<span style="color: var(--text-muted);" title="Disabled">○</span>';
            return `
                <div class="connection-card" data-user-plugin-id="${escapeAttr(id)}">
                    <div class="connection-card-icon">✏️</div>
                    <div class="connection-card-info">
                        <div class="connection-card-label">${statusDot} ${escapeHtml(entry.name || id)}</div>
                        <div class="connection-card-meta plugin-external-meta">Saved ${new Date(entry.savedAt).toLocaleDateString()}</div>
                    </div>
                    <div class="connection-card-actions">
                        <button type="button" data-edit-plugin="${escapeAttr(id)}" title="Edit">✏️</button>
                    </div>
                </div>
            `;
        }).join('');
        userHtml += '<div style="margin-bottom: 1rem;"></div>';
    }

    // ------------------------------------------
    // All registered plugins section
    // ------------------------------------------
    let builtinHtml = '';
    if (plugins.length > 0) {
        builtinHtml = `<div class="plugin-section-header">All Plugins</div>`;
        builtinHtml += plugins.map(p => {
            const isExternal = installedIds.has(p.id);
            const disabledClass = p.enabled ? '' : ' disabled';
            const statusDot = p.enabled
                ? '<span style="color: var(--success);" title="Enabled">●</span>'
                : '<span style="color: var(--text-muted);" title="Disabled">○</span>';
            const icon = isExternal ? '📦'
                : p.id.includes('billing') ? '💰'
                : p.id.includes('cross') ? '🔀'
                : p.id.includes('venice') ? '🌊'
                : '🧩';

            // Build config fields HTML
            const configFields = (p.configSchema || []).map(field => {
                const value = p.config?.[field.key] || '';
                const escapedValue = escapeAttr(typeof value === 'string' ? value : JSON.stringify(value));
                const type = field.type === 'password' ? 'password' : field.type === 'textarea' ? 'textarea' : 'text';

                if (type === 'textarea') {
                    return `
                        <div class="form-group">
                            <label>${escapeHtml(field.label)}:</label>
                            <textarea data-plugin-id="${escapeAttr(p.id)}" data-config-key="${escapeAttr(field.key)}"
                                placeholder="${escapeAttr(field.placeholder || '')}"
                                rows="3">${escapeHtml(typeof value === 'string' ? value : JSON.stringify(value, null, 2))}</textarea>
                            ${field.help ? `<small>${escapeHtml(field.help)}</small>` : ''}
                        </div>
                    `;
                }

                return `
                    <div class="form-group">
                        <label>${escapeHtml(field.label)}:</label>
                        <input type="${type}" data-plugin-id="${escapeAttr(p.id)}" data-config-key="${escapeAttr(field.key)}"
                            value="${escapedValue}" placeholder="${escapeAttr(field.placeholder || '')}">
                        ${field.help ? `<small>${escapeHtml(field.help)}</small>` : ''}
                    </div>
                `;
            }).join('');

            const hasConfig = (p.configSchema || []).length > 0;

            return `
                <div class="connection-card${disabledClass}" data-plugin-card="${escapeAttr(p.id)}">
                    <div class="connection-card-icon">${icon}</div>
                    <div class="connection-card-info">
                        <div class="connection-card-label">${statusDot} ${escapeHtml(p.name)}${isExternal ? ' <span class="plugin-badge-external">(external)</span>' : ''}</div>
                        <div class="connection-card-meta">v${escapeHtml(p.version || '1.0')}${p.author ? ` · by ${escapeHtml(p.author)}` : ''} · ${escapeHtml(p.description || '')}</div>
                    </div>
                    <div class="connection-card-actions">
                        ${hasConfig ? `<button type="button" data-plugin-expand="${escapeAttr(p.id)}" title="Configure">⚙️</button>` : ''}
                        <button data-plugin-toggle="${escapeAttr(p.id)}" title="${p.enabled ? 'Disable' : 'Enable'}">${p.enabled ? '✅' : '⬜'}</button>
                    </div>
                </div>
                ${hasConfig ? `
                <div class="plugin-config-panel connection-editor" id="pluginConfig-${escapeAttr(p.id)}" style="display: none;">
                    ${configFields}
                </div>
                ` : ''}
            `;
        }).join('');
    }

    // Empty state
    if (plugins.length === 0 && installed.length === 0 && userEntries.length === 0) {
        container.innerHTML = installHtml + `
            <div class="connections-empty">
                <div class="connections-empty-icon">🧩</div>
                <div>No plugins registered.</div>
                <div style="margin-top: 0.25rem; font-size: var(--font-sm);">Place plugin files in <code>plugins/</code>, install from URL, or create one above.</div>
            </div>
        `;
        _wireInstallButton(container);
        _wireCreateButton(container);
        return;
    }

    container.innerHTML = installHtml + toolbarHtml + externalHtml + userHtml + builtinHtml;

    // ------------------------------------------
    // Wire event handlers
    // ------------------------------------------
    _wireInstallButton(container);
    _wireCreateButton(container);

    // Toolbar action run buttons
    container.querySelectorAll('[data-plugin-toolbar-run]').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.pluginToolbarRun, 10);
            if (toolbarButtons[idx]?.onClick) toolbarButtons[idx].onClick();
        });
    });

    // Uninstall buttons
    container.querySelectorAll('[data-uninstall-url]').forEach(el => {
        el.addEventListener('click', async () => {
            const url = el.dataset.uninstallUrl;
            const { showConfirm } = await import('../ui/dialogs.js');
            if (!await showConfirm('Uninstall this plugin? It will be disabled immediately and fully removed on reload.', { title: 'Uninstall Plugin', okLabel: 'Uninstall', variant: 'danger' })) return;
            const result = uninstallPlugin(url);
            if (result.success) {
                window.showToast?.('Plugin uninstalled — reload to fully remove', 'success');
            } else {
                window.showToast?.(result.error, 'error');
            }
            populatePluginsTab();
        });
    });

    // Enable/disable toggles
    container.querySelectorAll('[data-plugin-toggle]').forEach(el => {
        el.addEventListener('click', () => {
            const pluginId = el.dataset.pluginToggle;
            const plugin = Plugins.get(pluginId);
            if (!plugin) return;
            const newState = !plugin.enabled;
            Plugins.setEnabled(pluginId, newState);
            populatePluginsTab();
        });
    });

    // Config expand buttons
    container.querySelectorAll('[data-plugin-expand]').forEach(el => {
        el.addEventListener('click', () => {
            const panel = document.getElementById(`pluginConfig-${el.dataset.pluginExpand}`);
            if (panel) {
                panel.style.display = panel.style.display === 'none' ? '' : 'none';
            }
        });
    });

    // Config field changes (save on blur)
    container.querySelectorAll('[data-plugin-id][data-config-key]').forEach(el => {
        const save = () => {
            const pluginId = el.dataset.pluginId;
            const key = el.dataset.configKey;
            const currentConfig = Plugins.getConfig(pluginId);
            let value = el.tagName === 'TEXTAREA' ? el.value : el.value;
            if (el.tagName === 'TEXTAREA') {
                try { value = JSON.parse(value); } catch { /* keep as string */ }
            }
            currentConfig[key] = value;
            Plugins.setConfig(pluginId, currentConfig);
        };
        el.addEventListener('blur', save);
        el.addEventListener('change', save);
    });
}

/**
 * Wire the install button and URL input.
 * @param {HTMLElement} container
 */
function _wireInstallButton(container) {
    const btn = container.querySelector('#btnInstallPlugin');
    const input = container.querySelector('#pluginInstallUrl');
    const status = container.querySelector('#pluginInstallStatus');
    if (!btn || !input) return;

    const setStatusText = (text, color) => {
        if (!status) return;
        status.textContent = text;
        status.style.color = color;
    };

    const doInstall = async (options = {}) => {
        const url = input.value.trim();
        if (!url) {
            setStatusText('Enter a plugin URL', 'var(--warning)');
            return;
        }

        btn.disabled = true;
        btn.textContent = 'Installing…';
        setStatusText('Fetching plugin…', 'var(--text-secondary)');

        const result = await installPlugin(url, options);

        btn.disabled = false;
        btn.textContent = 'Install';

        if (result.success) {
            if (status) status.innerHTML = '';
            setStatusText(`Installed: ${result.name}`, 'var(--success)');
            input.value = '';
            window.showToast?.(`Plugin installed: ${result.name}`, 'success');
            populatePluginsTab();
            return;
        }

        if (result.requiresConfirmation && Array.isArray(result.invisibleUnicodeFindings)) {
            _renderInvisibleUnicodeWarning(status, result.invisibleUnicodeFindings, () => {
                doInstall({ confirmedInvisibleUnicode: true });
            });
            return;
        }

        setStatusText(`Error: ${result.error}`, 'var(--error)');
    };

    btn.addEventListener('click', () => doInstall());
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doInstall();
    });
}

/**
 * Render an inline warning band when the plugin source contains invisible
 * Unicode characters. Replaces the status text with a richer affordance
 * including "Install anyway" / "Cancel".
 *
 * @param {HTMLElement} status — the #pluginInstallStatus element
 * @param {Array<{codepoint: number, name: string, line: number, col: number}>} findings
 * @param {() => void} onProceed — callback when the user clicks "Install anyway"
 */
function _renderInvisibleUnicodeWarning(status, findings, onProceed) {
    if (!status) return;
    status.innerHTML = '';
    status.style.color = '';

    const band = document.createElement('div');
    band.className = 'plugin-install-warning-band';
    band.style.cssText = [
        'border: 1px solid var(--error)',
        'background: color-mix(in srgb, var(--error) 12%, transparent)',
        'border-radius: 4px',
        'padding: 0.6rem 0.75rem',
        'margin-top: 0.5rem',
        'display: flex',
        'flex-direction: column',
        'gap: 0.5rem',
        'font-size: 0.92em'
    ].join(';');

    const heading = document.createElement('div');
    heading.style.cssText = 'color: var(--error); font-weight: 600;';
    heading.textContent = `⚠ Source contains ${findings.length} invisible Unicode character${findings.length === 1 ? '' : 's'}`;
    band.appendChild(heading);

    const detail = document.createElement('div');
    detail.style.cssText = 'color: var(--text-secondary); font-family: var(--font-mono); font-size: 0.9em; line-height: 1.5;';
    const preview = findings.slice(0, 3)
        .map(f => `• L${f.line}:${f.col} ${f.name} (U+${f.codepoint.toString(16).toUpperCase().padStart(4, '0')})`)
        .join('\n');
    detail.textContent = findings.length > 3
        ? `${preview}\n… and ${findings.length - 3} more`
        : preview;
    detail.style.whiteSpace = 'pre-line';
    band.appendChild(detail);

    const help = document.createElement('div');
    help.style.cssText = 'color: var(--text-muted); font-size: 0.88em;';
    help.innerHTML = 'These chars can hide malicious code (glassworm, Trojan Source). See <code>docs/SECURITY.md</code>. Cancel unless you trust the source.';
    band.appendChild(help);

    const actions = document.createElement('div');
    actions.style.cssText = 'display: flex; gap: 0.5rem; justify-content: flex-end;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.className = 'btn-secondary';
    cancelBtn.addEventListener('click', () => {
        status.innerHTML = '';
        status.textContent = 'Install cancelled';
        status.style.color = 'var(--text-muted)';
    });

    const proceedBtn = document.createElement('button');
    proceedBtn.textContent = 'Install anyway';
    proceedBtn.className = 'btn-danger';
    proceedBtn.style.cssText = 'background: var(--error); color: var(--text-primary); border: none; padding: 0.35rem 0.75rem; border-radius: 3px; cursor: pointer;';
    proceedBtn.addEventListener('click', () => {
        status.innerHTML = '';
        onProceed();
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(proceedBtn);
    band.appendChild(actions);

    status.appendChild(band);
}

/**
 * Wire the Create Plugin button and Edit buttons for user plugins.
 * @param {HTMLElement} container
 */
function _wireCreateButton(container) {
    container.querySelector('#btnCreatePlugin')?.addEventListener('click', async () => {
        const { openPluginEditor } = await import('../plugin-editor.js');
        window.closeSettings?.();
        openPluginEditor(null);
    });

    container.querySelectorAll('[data-edit-plugin]').forEach(el => {
        el.addEventListener('click', async () => {
            const id = el.dataset.editPlugin;
            const { openPluginEditor } = await import('../plugin-editor.js');
            window.closeSettings?.();
            openPluginEditor(id);
        });
    });
}
