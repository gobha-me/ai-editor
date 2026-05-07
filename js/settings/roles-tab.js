// ============================================
// SETTINGS — ROLES TAB
// ============================================

import { State, Roles } from '../core.js';
import { ToolRegistry } from '../tools/registry.js';
import { escapeHtml, escapeAttr } from '../utils/html.js';

/**
 * Populate role selection cards and wire click handlers.
 */
export function populateRoleCards() {
    const container = document.getElementById('roleCards');
    if (!container) {
        console.warn('[Settings] roleCards container not found, skipping role cards population');
        return;
    }
    
    const currentRole = State.settings.role || 'full';
    
    container.innerHTML = Roles.list().map(role => `
        <div class="role-card ${role.id === currentRole ? 'active' : ''}" data-role="${escapeAttr(role.id)}">
            <div class="role-card-icon">${escapeHtml(role.icon)}</div>
            <div class="role-card-name">${escapeHtml(role.name)}</div>
            <div class="role-card-desc">${escapeHtml(role.description)}</div>
        </div>
    `).join('');

    // Click handlers
    container.querySelectorAll('.role-card').forEach(card => {
        card.onclick = () => {
            container.querySelectorAll('.role-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            updateRoleToolsList(card.dataset.role);
        };
    });

    updateRoleToolsList(currentRole);

    // Plan Mode auto-engage checkbox (github#25, 1.10.0). Persist
    // immediately on toggle so the setting survives even if the user
    // closes the modal without clicking Save (matches the "settings
    // are live" behavior of the other checkboxes here).
    const autoPlanEl = document.getElementById('autoPlanOnIssueStart');
    if (autoPlanEl) {
        autoPlanEl.checked = !!State.settings.autoPlanOnIssueStart;
        autoPlanEl.onchange = () => {
            State.settings.autoPlanOnIssueStart = !!autoPlanEl.checked;
        };
    }
}

/**
 * Update the tools list display for a given role.
 */
export function updateRoleToolsList(roleId) {
    const role = Roles.get(roleId);
    const label = document.getElementById('roleToolsLabel');
    const list = document.getElementById('roleToolsList');
    
    if (!label || !list) {
        console.warn('[Settings] roleToolsLabel or roleToolsList not found, skipping tools list update');
        return;
    }
    
    label.textContent = role.name;
    
    // Get all tool definitions from registry
    const allTools = ToolRegistry.getDefinitions();
    
    if (allTools.length === 0) {
        list.innerHTML = '<div style="color: var(--text-muted); padding: 0.5rem 0;">No tools loaded yet. Tools register when chat initializes.</div>';
        return;
    }
    
    // Get tools filtered for this role
    const roleTools = ToolRegistry.getToolsForRole(roleId);
    const roleToolNames = new Set(roleTools.map(t => t.function?.name || t.name));
    
    list.innerHTML = allTools.map(tool => {
        const name = tool.function?.name || tool.name;
        const desc = tool.function?.description || '';
        const enabled = roleToolNames.has(name);
        const roles = tool._registeredRoles || ['unknown'];
        
        return `<div class="role-tool-item ${enabled ? 'enabled' : 'disabled'}">
            <span>${enabled ? '✅' : '⬜'}</span>
            <span><strong>${escapeHtml(name)}</strong> — ${escapeHtml(desc.slice(0, 60))}${desc.length > 60 ? '…' : ''}</span>
            <span style="font-size: var(--font-xs); color: var(--text-muted); margin-left: auto;">[${escapeHtml(roles.join(', '))}]</span>
        </div>`;
    }).join('');

    // Show count
    const enabledCount = roleTools.length;
    const tokenSavings = (allTools.length - enabledCount) * 120;
    list.insertAdjacentHTML('beforeend', `
        <div style="margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--border); color: var(--text-muted); font-size: var(--font-sm);">
            ${enabledCount} of ${allTools.length} tools active${tokenSavings > 0 ? ` · ~${tokenSavings.toLocaleString()} fewer prompt tokens vs full` : ''}
        </div>
    `);
}
