// @ts-check
/**
 * Settings → Workspace Settings tab (1.4.4).
 *
 * Vanilla DOM (not Preact) — small surface: a toggle + status row +
 * override list + diagnostics. Mirrors the connections-tab.js init
 * pattern. The tab UI is the per-workspace opt-in surface for the
 * `.aieditor/settings.json` projection; the toggle persists to
 * localStorage via `setOptedIn`, then enables/disables the file layer
 * for the active workspace.
 *
 * @since 1.4.4
 * @module settings/workspace-settings-tab
 */

import { State, EventBus } from '../core.js';
import { escapeHtml, escapeAttr } from '../utils/html.js';
import {
    isOptedIn,
    setOptedIn,
    isEnabled,
    enable as enableFileLayer,
    disable as disableFileLayer,
    loadFromGit,
    getAppliedOverrides,
    getOriginalGlobal,
    getDiagnostics,
    clearDiagnostics,
    resetToGlobal,
} from '../intelligence/workspace-settings/index.js';

let _bound = false;
let _changeUnsub = null;

function _currentWorkspaceId() {
    const p = State.currentProject;
    if (!p || !p.connectionId || !p.owner || !p.repo) return null;
    return `${p.connectionId}/${p.owner}/${p.repo}`;
}

function _currentBranchIsProtected() {
    const branches = Array.isArray(State.branches) ? State.branches : [];
    const cur = branches.find((b) => b && b.name === State.currentBranch);
    return cur ? Boolean(cur.protected) : false;
}

/**
 * Initialize the tab. Idempotent — safe to call on every modal open.
 *
 * @returns {void}
 */
export function initWorkspaceSettingsTab() {
    render();

    if (_bound) return;
    _bound = true;

    const root = document.getElementById('tabWorkspaceSettings');
    if (!root) return;

    root.addEventListener('click', _onClick);
    root.addEventListener('change', _onChange);

    if (_changeUnsub) { try { _changeUnsub(); } catch { /* ignore */ } }
    _changeUnsub = EventBus.on('workspaceSettings:changed', () => render());
}

async function _onChange(ev) {
    const target = ev.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.id !== 'workspaceSettingsToggle') return;

    const wsId = _currentWorkspaceId();
    if (!wsId) {
        target.checked = false;
        window.showToast?.('Open a project before enabling workspace settings.', 'warning');
        return;
    }

    const turningOn = target.checked;
    setOptedIn(wsId, turningOn);

    if (turningOn) {
        try {
            if (!isEnabled()) await enableFileLayer(wsId);
            const p = State.currentProject;
            if (p && p.owner && p.repo) {
                await loadFromGit({ owner: p.owner, repo: p.repo, branch: State.currentBranch || 'main' });
            }
            window.showToast?.('Workspace settings enabled for this project.', 'success');
        } catch (err) {
            console.error('[workspace-settings-tab] enable failed:', err);
            window.showToast?.(`Enable failed: ${err && err.message ? err.message : err}`, 'error');
        }
    } else {
        try {
            disableFileLayer();
            window.showToast?.('Workspace settings disabled. Original global values restored.', 'info');
        } catch (err) {
            console.error('[workspace-settings-tab] disable failed:', err);
        }
    }

    render();
}

function _onClick(ev) {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;

    const resetBtn = target.closest('[data-ws-reset]');
    if (resetBtn instanceof HTMLElement) {
        ev.preventDefault();
        const key = resetBtn.dataset.wsReset || '';
        if (key) {
            resetToGlobal(key);
            window.showToast?.(`"${key}" reset to global value.`, 'success');
            render();
        }
        return;
    }

    if (target.id === 'btnWorkspaceSettingsClearDiagnostics') {
        ev.preventDefault();
        clearDiagnostics();
        render();
    }
}

function render() {
    const root = document.getElementById('tabWorkspaceSettings');
    if (!root) return;

    const wsId = _currentWorkspaceId();
    const protectedBranch = _currentBranchIsProtected();
    const optedIn = wsId ? isOptedIn(wsId) : false;
    const active = isEnabled();

    let statusLabel;
    let statusKind;
    if (!wsId) { statusLabel = 'No project loaded'; statusKind = 'muted'; }
    else if (protectedBranch && active) { statusLabel = 'Branch protected — read-only'; statusKind = 'warn'; }
    else if (active) { statusLabel = 'Active'; statusKind = 'ok'; }
    else if (optedIn) { statusLabel = 'Opted in (waiting for project load)'; statusKind = 'muted'; }
    else { statusLabel = 'Disabled'; statusKind = 'muted'; }

    const overrides = getAppliedOverrides();
    const overrideRows = Object.keys(overrides).sort().map((key) => {
        const cur = overrides[key];
        const orig = getOriginalGlobal(key);
        return `
            <div class="ws-override-row" data-setting-key="${escapeAttr(key)}">
                <div class="ws-override-row__main">
                    <code class="ws-override-row__key">${escapeHtml(key)}</code>
                    <span class="ws-override-row__values">
                        <span class="ws-override-row__label">workspace:</span>
                        <code>${escapeHtml(_formatValue(cur))}</code>
                        <span class="ws-override-row__label">global:</span>
                        <code class="ws-override-row__global">${escapeHtml(_formatValue(orig))}</code>
                    </span>
                </div>
                <button type="button" class="btn btn-secondary btn-xs"
                        data-ws-reset="${escapeAttr(key)}"
                        ${protectedBranch ? 'disabled aria-disabled="true"' : ''}>
                    Reset to global
                </button>
            </div>
        `;
    }).join('');

    const diagnostics = getDiagnostics();
    const diagRows = diagnostics.warnings.map((w) => `
        <li class="ws-diagnostics__item">
            <span class="ws-diagnostics__type">${escapeHtml(w.type || 'warning')}</span>
            ${w.key ? `<code>${escapeHtml(w.key)}</code>` : ''}
            <span>${escapeHtml(w.message || '')}</span>
        </li>
    `).join('');

    root.innerHTML = `
        <h3>Workspace settings</h3>
        <p class="ws-help">
            <code>.aieditor/settings.json</code> overrides global settings per repo for a curated
            subset of keys (theme, UI scale, role, summarizer, etc.). Credentials and
            workstation-personal preferences are never stored here. The file is auto-staged
            on commit when this toggle is on and the current branch isn't protected.
        </p>

        <div class="form-group">
            <label class="ws-toggle">
                <input type="checkbox" id="workspaceSettingsToggle"
                       ${optedIn ? 'checked' : ''}
                       ${wsId ? '' : 'disabled aria-disabled="true"'}>
                <span>Use <code>.aieditor/settings.json</code> for this workspace</span>
            </label>
            ${wsId
                ? `<small class="ws-help">Workspace: <code>${escapeHtml(wsId)}</code></small>`
                : `<small class="ws-help">Open a project to enable.</small>`}
        </div>

        <div class="form-group">
            <label>Status:</label>
            <span class="ws-status ws-status--${statusKind}">${escapeHtml(statusLabel)}</span>
        </div>

        <div class="form-group">
            <label>Active workspace overrides
                <span class="ws-status ws-status--muted">${Object.keys(overrides).length}</span>
            </label>
            <div class="ws-override-list">
                ${overrideRows || `<div class="ws-empty">No workspace overrides yet. Edit settings in any other tab while the toggle is on — your changes will be saved per-project instead of globally.</div>`}
            </div>
        </div>

        <div class="form-group">
            <label>Diagnostics
                <span class="ws-status ws-status--muted">${diagnostics.warnings.length}</span>
                ${diagnostics.warnings.length > 0
                    ? `<button type="button" id="btnWorkspaceSettingsClearDiagnostics" class="btn btn-secondary btn-xs" style="margin-left: 0.5rem;">Clear</button>`
                    : ''}
            </label>
            ${diagRows
                ? `<ul class="ws-diagnostics">${diagRows}</ul>`
                : `<div class="ws-empty">No diagnostics. Unsafe keys (credentials, etc.) committed to <code>.aieditor/settings.json</code> by mistake would surface here.</div>`}
        </div>
    `;
}

function _formatValue(v) {
    if (v === null || v === undefined) return '(unset)';
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try { return JSON.stringify(v); } catch { return String(v); }
}

/* -------------------------------------------------------------------------- */
/* Inline decoration — across ALL settings tabs                               */
/* -------------------------------------------------------------------------- */

const DECORATION_BADGE_CLASS = 'setting-overridden__badge';
const DECORATION_GROUP_CLASS = 'setting-overridden';

/**
 * Single-pass decoration over every `[data-setting-key]` form-group in the
 * settings modal. Marks each with `.setting-overridden` (orange border-left)
 * + an inserted "Workspace" badge when its key is in
 * `getAppliedOverrides()`. Purely additive: removes its own decorations
 * when a key is no longer overridden, leaving the original DOM intact.
 *
 * Called at modal-open time and on every `workspaceSettings:changed`
 * event so the decoration stays in sync with the override map.
 *
 * @returns {void}
 */
export function decorateOverriddenControls() {
    const modal = document.getElementById('settingsModal');
    if (!modal) return;

    const overrides = getAppliedOverrides();
    const overriddenKeys = new Set(Object.keys(overrides));

    const groups = modal.querySelectorAll('[data-setting-key]');
    groups.forEach((group) => {
        if (!(group instanceof HTMLElement)) return;
        const key = group.dataset.settingKey || '';
        const isOverridden = overriddenKeys.has(key);

        if (isOverridden) {
            group.classList.add(DECORATION_GROUP_CLASS);
            let badge = group.querySelector(`.${DECORATION_BADGE_CLASS}`);
            if (!badge) {
                badge = document.createElement('span');
                badge.className = DECORATION_BADGE_CLASS;
                badge.title = 'Overridden by .aieditor/settings.json — see Workspace Settings tab to reset.';
                badge.textContent = 'Workspace';
                const firstLabel = group.querySelector('label');
                if (firstLabel) firstLabel.appendChild(badge);
                else group.appendChild(badge);
            }
        } else {
            group.classList.remove(DECORATION_GROUP_CLASS);
            const badge = group.querySelector(`.${DECORATION_BADGE_CLASS}`);
            if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
        }
    });
}
