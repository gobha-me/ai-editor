// @ts-check
/**
 * Commit-modal "Workspace settings" section (1.4.4).
 *
 * Mirrors `commit-memory-section.js`. Single pending file at most
 * (`.aieditor/settings.json`), so simpler than memory's variable list:
 * one row, one diff toggle, one set of escape-hatch buttons on
 * protected branches.
 *
 * Two surface variants:
 *
 *   - Flow 3A (unprotected branch): `commit-section--mem` panel
 *     auto-stages the pending JSON. Show diff toggle reveals the file
 *     content prefixed with `+ `.
 *   - Flow 3B (protected branch): `commit-section--warn` panel — same
 *     pending file as a disabled, unstageable warning, with two
 *     escape-hatch buttons ("Keep pending" / "Discard").
 *
 * @since 1.4.4
 * @module ui/commit-workspace-settings-section
 */

import { escapeAttr } from '../utils/html.js';
import {
    getPendingContent,
    discardPendingWrites,
} from '../intelligence/workspace-settings/index.js';

/**
 * @typedef {Object} WorkspaceSettingsSectionProps
 * @property {boolean} isProtected
 * @property {string[]} pendingPaths
 * @property {string} [branch]
 */

/**
 * Render the section. Returns `''` when there are no pending paths.
 *
 * @param {WorkspaceSettingsSectionProps} props
 * @returns {string}
 */
export function renderWorkspaceSettingsSection({ isProtected, pendingPaths, branch }) {
    if (!Array.isArray(pendingPaths) || pendingPaths.length === 0) return '';

    const rows = pendingPaths.map((p, i) => _renderRow(p, i, { isProtected })).join('');
    const branchLabel = escapeAttr(branch || '');

    if (isProtected) {
        return `
            <div class="commit-section commit-section--warn" data-ws-section="warn">
                <div class="commit-section__head">
                    <span class="commit-section__title commit-section__title--warn">⚠ Workspace settings can't be staged here</span>
                    <span class="commit-section__count">on protected branch</span>
                </div>
                <p class="commit-section__hint">
                    Pending workspace-settings updates won't be committed to
                    <code class="branch-row__name">${branchLabel}</code> —
                    these usually land alongside the feature branch that introduced them.
                </p>
                ${rows}
                <div class="commit-section__actions">
                    <button type="button" class="mem-btn mem-btn--ghost" data-ws-action="keepPending">Keep pending</button>
                    <button type="button" class="mem-btn mem-btn--ghost" data-ws-action="discard">Discard</button>
                </div>
            </div>
        `;
    }

    return `
        <div class="commit-section commit-section--mem" data-ws-section="mem">
            <div class="commit-section__head">
                <span class="commit-section__title commit-section__title--mem">◆ Workspace settings</span>
                <span class="commit-section__count">auto-staged</span>
            </div>
            ${rows}
        </div>
    `;
}

function _renderRow(path, index, { isProtected }) {
    const safePath = escapeAttr(path);
    const checkboxAttrs = isProtected
        ? `disabled aria-disabled="true"`
        : `checked data-ws-path="${safePath}"`;
    const rowClass = isProtected
        ? 'commit-file commit-file--mem is-disabled'
        : 'commit-file commit-file--mem';
    const diffLink = `<a class="src-link commit-file__diff-toggle" data-ws-diff-toggle="${index}" data-ws-path-for-diff="${safePath}" role="button" tabindex="0">Show diff</a>`;

    return `
        <label class="${rowClass}">
            <input type="checkbox" ${checkboxAttrs}>
            <code class="path">${safePath}</code>
            ${diffLink}
        </label>
        <pre class="commit-mem-diff" data-ws-diff-target="${index}" hidden></pre>
    `;
}

/**
 * Format a pending file's content as `+ ` prefixed lines for the
 * Show diff preview. Pending workspace-settings file is treated as an
 * add for preview purposes (true diff vs HEAD is out of scope here).
 *
 * @param {string} content
 * @returns {string}
 */
export function formatPendingDiff(content) {
    if (!content) return '';
    return content
        .split('\n')
        .map((line) => `+ ${line}`)
        .join('\n');
}

/**
 * Bind click handlers. Idempotent — replaces previous listener.
 *
 * @param {HTMLElement} rootEl
 * @param {{ closeModal?: () => void }} [callbacks]
 * @returns {void}
 */
export function wireWorkspaceSettingsSection(rootEl, callbacks = {}) {
    if (!rootEl) return;

    if (rootEl._wsSectionHandler) {
        rootEl.removeEventListener('click', rootEl._wsSectionHandler);
        rootEl._wsSectionHandler = null;
    }

    const handler = (ev) => {
        const target = ev.target;
        if (!(target instanceof HTMLElement)) return;

        const action = target.dataset.wsAction;
        if (action) {
            ev.preventDefault();
            _handleAction(action, rootEl, callbacks);
            return;
        }

        const diffToggle = target.closest('[data-ws-diff-toggle]');
        if (diffToggle instanceof HTMLElement) {
            ev.preventDefault();
            _toggleDiff(diffToggle, rootEl);
        }
    };

    rootEl.addEventListener('click', handler);
    rootEl._wsSectionHandler = handler;
}

function _toggleDiff(toggleEl, rootEl) {
    const idx = toggleEl.dataset.wsDiffToggle;
    const path = toggleEl.dataset.wsPathForDiff;
    const pre = rootEl.querySelector(`[data-ws-diff-target="${idx}"]`);
    if (!(pre instanceof HTMLElement)) return;

    const open = !pre.hidden;
    if (open) {
        pre.hidden = true;
        toggleEl.textContent = 'Show diff';
        return;
    }

    if (!pre.textContent) {
        const content = path ? getPendingContent(path) : null;
        pre.textContent = content ? formatPendingDiff(content) : '(no content)';
    }
    pre.hidden = false;
    toggleEl.textContent = 'Hide diff';
}

function _handleAction(action, rootEl, callbacks) {
    switch (action) {
        case 'keepPending': {
            if (typeof callbacks.closeModal === 'function') callbacks.closeModal();
            return;
        }
        case 'discard': {
            const paths = _collectVisiblePaths(rootEl);
            const dropped = discardPendingWrites(paths);
            const section = rootEl.querySelector('[data-ws-section]');
            if (section instanceof HTMLElement) section.remove();
            if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
                window.showToast(
                    `Discarded ${dropped.length} pending workspace settings ${dropped.length === 1 ? 'file' : 'files'}.`,
                    'info',
                );
            }
            return;
        }
        default:
            return;
    }
}

function _collectVisiblePaths(rootEl) {
    const codes = rootEl.querySelectorAll('.commit-file--mem .path');
    return Array.from(codes).map((el) => el.textContent || '').filter(Boolean);
}
