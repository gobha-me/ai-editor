// ============================================
// SETTINGS — PLUGINS TAB
// ============================================

import { Plugins } from '../core.js';
import { escapeHtml, escapeAttr } from '../utils/html.js';

/**
 * Populate the Plugins tab with all registered plugins.
 * Shows enable/disable toggles, description, and config fields.
 */
export function populatePluginsTab() {
    const container = document.getElementById('pluginsList');
    if (!container) return;

    const plugins = Plugins.list();

    if (plugins.length === 0) {
        container.innerHTML = `
            <div class="connections-empty">
                <div class="connections-empty-icon">🧩</div>
                <div>No plugins registered.</div>
                <div style="margin-top: 0.25rem; font-size: var(--font-sm);">Place plugin files in the <code>plugins/</code> directory.</div>
            </div>
        `;
        return;
    }

    container.innerHTML = plugins.map(p => {
        const disabledClass = p.enabled ? '' : ' disabled';
        const statusDot = p.enabled
            ? '<span style="color: var(--success);" title="Enabled">●</span>'
            : '<span style="color: var(--text-muted);" title="Disabled">○</span>';
        const icon = p.id.includes('billing') ? '💰' : p.id.includes('cross') ? '🔀' : p.id.includes('venice') ? '🌊' : '🧩';

        // Build config fields HTML
        const configFields = (p.configSchema || []).map(field => {
            const value = p.config?.[field.key] || '';
            const escapedValue = escapeAttr(typeof value === 'string' ? value : JSON.stringify(value));
            const type = field.type === 'password' ? 'password' : field.type === 'textarea' ? 'textarea' : 'text';

            if (type === 'textarea') {
                return `
                    <div class="form-group" style="margin-bottom: 0.5rem;">
                        <label style="font-size: var(--font-sm);">${escapeHtml(field.label)}:</label>
                        <textarea data-plugin-id="${escapeAttr(p.id)}" data-config-key="${escapeAttr(field.key)}"
                            placeholder="${escapeAttr(field.placeholder || '')}"
                            rows="3" style="width: 100%; font-size: var(--font-sm); font-family: var(--font-mono); resize: vertical;">${escapeHtml(typeof value === 'string' ? value : JSON.stringify(value, null, 2))}</textarea>
                        ${field.help ? `<small style="color: var(--text-muted);">${escapeHtml(field.help)}</small>` : ''}
                    </div>
                `;
            }

            return `
                <div class="form-group" style="margin-bottom: 0.5rem;">
                    <label style="font-size: var(--font-sm);">${escapeHtml(field.label)}:</label>
                    <input type="${type}" data-plugin-id="${escapeAttr(p.id)}" data-config-key="${escapeAttr(field.key)}"
                        value="${escapedValue}" placeholder="${escapeAttr(field.placeholder || '')}"
                        style="font-size: var(--font-sm);">
                    ${field.help ? `<small style="color: var(--text-muted);">${escapeHtml(field.help)}</small>` : ''}
                </div>
            `;
        }).join('');

        const hasConfig = (p.configSchema || []).length > 0;

        return `
            <div class="connection-card${disabledClass}" data-plugin-card="${escapeAttr(p.id)}">
                <div class="connection-card-icon">${icon}</div>
                <div class="connection-card-info">
                    <div class="connection-card-label">${statusDot} ${escapeHtml(p.name)}</div>
                    <div class="connection-card-meta">v${escapeHtml(p.version || '1.0')}${p.author ? ` · by ${escapeHtml(p.author)}` : ''} · ${escapeHtml(p.description || '')}</div>
                </div>
                <div class="connection-card-actions">
                    ${hasConfig ? `<button type="button" data-plugin-expand="${escapeAttr(p.id)}" title="Configure">⚙️</button>` : ''}
                    <button data-plugin-toggle="${escapeAttr(p.id)}" title="${p.enabled ? 'Disable' : 'Enable'}">${p.enabled ? '✅' : '⬜'}</button>
                </div>
            </div>
            ${hasConfig ? `
            <div class="plugin-config-panel" id="pluginConfig-${escapeAttr(p.id)}" style="display: none; margin: -0.25rem 0 0.5rem 0; padding: 0.75rem; background: var(--bg-primary); border: 1px solid var(--border); border-top: none; border-radius: 0 0 6px 6px;">
                ${configFields}
            </div>
            ` : ''}
        `;
    }).join('');

    // Wire enable/disable toggles
    container.querySelectorAll('[data-plugin-toggle]').forEach(el => {
        el.addEventListener('click', () => {
            const pluginId = el.dataset.pluginToggle;
            const plugin = Plugins.get(pluginId);
            if (!plugin) return;
            const newState = !plugin.enabled;
            Plugins.setEnabled(pluginId, newState);
            populatePluginsTab();  // Re-render to update visual state
        });
    });

    // Wire config expand buttons
    container.querySelectorAll('[data-plugin-expand]').forEach(el => {
        el.addEventListener('click', () => {
            const panel = document.getElementById(`pluginConfig-${el.dataset.pluginExpand}`);
            if (panel) {
                panel.style.display = panel.style.display === 'none' ? '' : 'none';
            }
        });
    });

    // Wire config field changes (save on blur)
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
