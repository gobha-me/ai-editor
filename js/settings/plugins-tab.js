// ============================================
// SETTINGS — PLUGINS TAB
// ============================================

import { Plugins } from '../core.js';
import { escapeHtml, escapeAttr } from '../utils/html.js';
import { installPlugin, uninstallPlugin, getInstalledPlugins } from '../plugin-loader.js';

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
            <div class="plugin-install-hint">
                External plugins use <code>window.AIEditor</code> to access Plugins, EventBus, State, etc.
            </div>
        </div>
    `;

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
    if (plugins.length === 0 && installed.length === 0) {
        container.innerHTML = installHtml + `
            <div class="connections-empty">
                <div class="connections-empty-icon">🧩</div>
                <div>No plugins registered.</div>
                <div style="margin-top: 0.25rem; font-size: var(--font-sm);">Place plugin files in <code>plugins/</code> or install from URL above.</div>
            </div>
        `;
        _wireInstallButton(container);
        return;
    }

    container.innerHTML = installHtml + externalHtml + builtinHtml;

    // ------------------------------------------
    // Wire event handlers
    // ------------------------------------------
    _wireInstallButton(container);

    // Uninstall buttons
    container.querySelectorAll('[data-uninstall-url]').forEach(el => {
        el.addEventListener('click', () => {
            const url = el.dataset.uninstallUrl;
            if (!confirm('Uninstall this plugin? It will be disabled immediately and fully removed on reload.')) return;
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

    const doInstall = async () => {
        const url = input.value.trim();
        if (!url) {
            if (status) {
                status.textContent = 'Enter a plugin URL';
                status.style.color = 'var(--warning)';
            }
            return;
        }

        btn.disabled = true;
        btn.textContent = 'Installing…';
        if (status) {
            status.textContent = 'Fetching plugin…';
            status.style.color = 'var(--text-secondary)';
        }

        const result = await installPlugin(url);

        btn.disabled = false;
        btn.textContent = 'Install';

        if (result.success) {
            if (status) {
                status.textContent = `Installed: ${result.name}`;
                status.style.color = 'var(--success)';
            }
            input.value = '';
            window.showToast?.(`Plugin installed: ${result.name}`, 'success');
            populatePluginsTab();
        } else {
            if (status) {
                status.textContent = `Error: ${result.error}`;
                status.style.color = 'var(--error)';
            }
        }
    };

    btn.addEventListener('click', doInstall);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doInstall();
    });
}
