// ============================================
// SETTINGS — PROFILE TAB (was Roles, retired at 2.0.0)
// ============================================

import { State } from '../core.js';
import { ToolRegistry } from '../tools/registry.js';
import { escapeHtml, escapeAttr } from '../utils/html.js';
import { Profiles } from '../profiles/registry.js';
import { getActiveProfileName } from '../profiles/resolve.js';

/**
 * Populate the Profile tab — picker + tools list + Plan-Mode checkbox.
 *
 * **2.0.0 — slice 3 of path-to-2.0.0.** The legacy role-card grid
 * retired alongside the chat-panel role selector; the profile picker
 * is the only configuration surface. The function name is preserved
 * for `settings-manager.js`'s call site (renaming would be a churn-
 * only diff); the body now wires only the picker + the tools-list
 * readout + the Plan-Mode auto-engage checkbox.
 */
export function populateRoleCards() {
    populateProfilePicker();

    // Plan Mode auto-engage checkbox (github#25, 1.10.0). Persist
    // immediately on toggle so the setting survives even if the user
    // closes the modal without clicking Save.
    const autoPlanEl = /** @type {HTMLInputElement|null} */ (document.getElementById('autoPlanOnIssueStart'));
    if (autoPlanEl) {
        autoPlanEl.checked = !!State.settings.autoPlanOnIssueStart;
        autoPlanEl.onchange = () => {
            State.settings.autoPlanOnIssueStart = !!autoPlanEl.checked;
        };
    }
}

/**
 * Populate the profile picker `<select>` and wire its change handler.
 *
 * **2.0.0 — slice 3.** The pre-2.0.0 `(use role)` sentinel option
 * retired with the role selector; the picker now writes profile names
 * directly. Default option is `chat.v1` (first entry in
 * `Profiles.list()`); fresh installs and unmigrated reads resolve
 * through `getActiveProfileName({}) === 'chat.v1'`.
 */
function populateProfilePicker() {
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('settingProfilePicker'));
    if (!select) return;

    const currentProfile = State.settings.profile || 'chat.v1';
    const opts = Profiles.list().map(p => ({ value: p.name, label: `${p.label} — ${p.name}` }));

    select.innerHTML = opts.map(o =>
        `<option value="${escapeAttr(o.value)}"${o.value === currentProfile ? ' selected' : ''}>${escapeHtml(o.label)}</option>`
    ).join('');

    // Live state: persist the picker change immediately + refresh the
    // tools list + readout. Mirrors the autoPlanOnIssueStart pattern.
    select.onchange = () => {
        State.settings.profile = select.value;
        updateProfileToolsList(select.value);
        updateActiveProfileReadout();
    };

    updateProfileToolsList(currentProfile);
    updateActiveProfileReadout();
}

/**
 * Refresh the "Active profile: …" readout next to the picker. Reads
 * the live DOM state (picker's current value), so it doesn't need
 * `collectAndSave` to have run yet.
 */
function updateActiveProfileReadout() {
    const out = document.getElementById('activeProfileReadout');
    if (!out) return;

    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('settingProfilePicker'));
    const settingsView = { profile: select?.value || null };
    out.textContent = getActiveProfileName(settingsView);
}

/**
 * Update the tools list display for a given profile.
 *
 * **2.0.0 — slice 3 rename.** Was `updateRoleToolsList(roleId)`
 * pre-2.0.0; now keyed on profile name. Element IDs
 * (`roleToolsLabel`, `roleToolsList`) preserved — CSS / HTML still
 * references them and renaming would be churn-only.
 *
 * @param {string} profileName
 */
export function updateProfileToolsList(profileName) {
    const profile = Profiles.get(profileName);
    const label = document.getElementById('roleToolsLabel');
    const list = document.getElementById('roleToolsList');

    if (!label || !list) {
        console.warn('[Settings] roleToolsLabel or roleToolsList not found, skipping tools list update');
        return;
    }

    const entry = Profiles.list().find(e => e.name === profileName);
    label.textContent = entry ? entry.label : profileName;

    // Get all tool definitions from registry
    const allTools = ToolRegistry.getDefinitions();

    if (allTools.length === 0) {
        list.innerHTML = '<div style="color: var(--text-muted); padding: 0.5rem 0;">No tools loaded yet. Tools register when chat initializes.</div>';
        return;
    }

    // Tools admitted under the active profile — single source of truth
    // is `Profiles.filterTools` (the same call backing per-turn admission
    // and the runtime tool-execute gate).
    const profileTools = ToolRegistry.getToolsForProfile(profileName);
    const profileToolNames = new Set(profileTools.map(t => t.function?.name || t.name));

    list.innerHTML = allTools.map(tool => {
        const name = tool.function?.name || tool.name;
        const desc = tool.function?.description || '';
        const enabled = profileToolNames.has(name);
        // 2.54.0 (gitea#438) — admission inverted; tools no longer carry
        // `_registeredRoles`. The trailing chip shows the tool's category
        // (e.g. `code.file.read` from the catalog adapter) instead of the
        // retired group tags. Tools without a category fall through to
        // 'misc'.
        const category = tool.category || 'misc';

        return `<div class="role-tool-item ${enabled ? 'enabled' : 'disabled'}">
            <span>${enabled ? '✅' : '⬜'}</span>
            <span><strong>${escapeHtml(name)}</strong> — ${escapeHtml(desc.slice(0, 60))}${desc.length > 60 ? '…' : ''}</span>
            <span style="font-size: var(--font-xs); color: var(--text-muted); margin-left: auto;">[${escapeHtml(category)}]</span>
        </div>`;
    }).join('');

    // Show count
    const enabledCount = profileTools.length;
    const tokenSavings = (allTools.length - enabledCount) * 120;
    list.insertAdjacentHTML('beforeend', `
        <div style="margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--border); color: var(--text-muted); font-size: var(--font-sm);">
            ${enabledCount} of ${allTools.length} tools active${tokenSavings > 0 ? ` · ~${tokenSavings.toLocaleString()} fewer prompt tokens vs full` : ''}
        </div>
    `);
}
