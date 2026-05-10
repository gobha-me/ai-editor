/**
 * Project Switcher Popover — Touch 3 zip-flow (2.20.0)
 *
 * Vanilla-DOM popover anchored to the kebab `#btnProjectActions` button in the
 * sidebar header. Two sections:
 *
 *   Bring in
 *     · Clone from URL  (disabled, "Coming soon")
 *     · Import .zip     → opens existing #zipUploadModal via window.openZipUpload
 *
 *   Take out
 *     · Export project  → exportProjectAsZip on the active project's current branch
 *     · Export branch   → exportBranchAsZip on the active project's current branch
 *
 * The popover is a sibling element rendered hidden in sidebar.html; this module
 * paints its inner HTML once on first open and toggles `hidden` thereafter.
 * Outside-click + Escape + window-blur close it. Active-project checks gate
 * the Export entries — they show a toast if there's no project loaded.
 *
 * NOTE: `Project switcher selection` lives on the live `<select>` — the popover
 * is a pure actions surface, not a competing selector.
 */
import { State } from '../core.js';
import { exportProjectAsZip, exportBranchAsZip } from '../zip-export.js';

const SVG_CLONE = '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>';
const SVG_IMPORT = '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/></svg>';
const SVG_EXPORT = '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m6 9 6 6 6-6"/><path d="M3 21h18"/></svg>';
const SVG_BRANCH = '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';

let _wired = false;
let _outsideListener = null;

function renderMenu() {
    const branch = State.currentBranch || 'main';
    const projectLabel = State.currentProject
        ? `${State.currentProject.repo} · ${branch}`
        : 'No project loaded';
    return (
        `<div class="zip-menu__sec">` +
            `<div class="zip-menu__head">Bring in</div>` +
            `<button type="button" class="zip-menu__row" role="menuitem" disabled title="Coming in a later release">` +
                `${SVG_CLONE}<span class="zip-menu__label">Clone from URL</span>` +
                `<span class="zip-menu__meta">soon</span>` +
            `</button>` +
            `<button type="button" class="zip-menu__row" role="menuitem" data-action="importZip">` +
                `${SVG_IMPORT}<span class="zip-menu__label">Import .zip</span>` +
                `<span class="zip-menu__meta">file picker</span>` +
            `</button>` +
        `</div>` +
        `<div class="zip-menu__sec">` +
            `<div class="zip-menu__head">Take out</div>` +
            `<button type="button" class="zip-menu__row" role="menuitem" data-action="exportProject">` +
                `${SVG_EXPORT}<span class="zip-menu__label">Export project as .zip</span>` +
                `<span class="zip-menu__meta">${escape(projectLabel)}</span>` +
            `</button>` +
            `<button type="button" class="zip-menu__row" role="menuitem" data-action="exportBranch">` +
                `${SVG_BRANCH}<span class="zip-menu__label">Export branch as .zip</span>` +
                `<span class="zip-menu__meta">${escape(branch)}</span>` +
            `</button>` +
        `</div>`
    );
}

function escape(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}

function isOpen() {
    const menu = document.getElementById('projectActionsMenu');
    return menu && !menu.hidden;
}

function closeMenu() {
    const menu = document.getElementById('projectActionsMenu');
    const btn = document.getElementById('btnProjectActions');
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
    if (_outsideListener) {
        document.removeEventListener('click', _outsideListener, true);
        document.removeEventListener('keydown', _onKeydown, true);
        window.removeEventListener('blur', closeMenu);
        _outsideListener = null;
    }
}

function _onKeydown(e) {
    if (e.key === 'Escape') {
        closeMenu();
        document.getElementById('btnProjectActions')?.focus();
    }
}

function openMenu() {
    const menu = document.getElementById('projectActionsMenu');
    const btn = document.getElementById('btnProjectActions');
    if (!menu || !btn) return;

    menu.innerHTML = renderMenu();
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');

    // Outside-click + Escape close
    _outsideListener = (e) => {
        if (menu.contains(e.target)) return;
        if (e.target === btn || btn.contains(e.target)) return;
        closeMenu();
    };
    document.addEventListener('click', _outsideListener, true);
    document.addEventListener('keydown', _onKeydown, true);
    window.addEventListener('blur', closeMenu);
}

async function handleAction(action) {
    closeMenu();
    if (action === 'importZip') {
        if (typeof window.openZipUpload === 'function') {
            window.openZipUpload();
        }
        return;
    }

    if (action === 'exportProject' || action === 'exportBranch') {
        if (!State.currentProject) {
            window.showToast?.('No project loaded — open a project first', 'warning');
            return;
        }
        const { owner, repo } = State.currentProject;
        const branch = State.currentBranch || 'main';
        const exporter = action === 'exportProject' ? exportProjectAsZip : exportBranchAsZip;
        const label = action === 'exportProject' ? `project ${repo}` : `branch "${branch}"`;
        window.showToast?.(`Exporting ${label}…`, 'info');

        try {
            const { showConfirm } = await import('../ui/dialogs.js');
            const result = await exporter({
                owner, repo, branch,
                confirm: async ({ fileCount, totalBytes }) => {
                    const mb = (totalBytes / (1024 * 1024)).toFixed(1);
                    return showConfirm(
                        `Export ${fileCount} files (${mb} MB) — this may take a moment. Continue?`,
                        { title: 'Large export', okLabel: 'Export', cancelLabel: 'Cancel' }
                    );
                },
            });
            if (result) {
                window.showToast?.(`Downloaded ${result.filename}`, 'success');
            }
        } catch (err) {
            console.error('[switcher-menu] Export failed:', err);
            window.showToast?.(`Export failed: ${err.message || err}`, 'error');
        }
    }
}

/**
 * Wire the kebab button and the menu's delegated click handler. Idempotent.
 */
export function mountSwitcherMenu() {
    if (_wired) return;
    const btn = document.getElementById('btnProjectActions');
    const menu = document.getElementById('projectActionsMenu');
    if (!btn || !menu) return;
    _wired = true;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isOpen()) {
            closeMenu();
        } else {
            openMenu();
        }
    });

    menu.addEventListener('click', (e) => {
        const row = e.target.closest('[data-action]');
        if (!row) return;
        const action = row.getAttribute('data-action');
        if (action) handleAction(action);
    });
}
