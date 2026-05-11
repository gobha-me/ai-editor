/**
 * Left Pane Rail — Touch 3 sidebar layout (2.11.0); consumer of the
 * `rail-views` SlotManager slot kind (2.23.0, Decision 1 of
 * docs/DESIGN-git-providers-and-ui-extensions.md §"Decisions").
 *
 * Replaces the stacked, resizable Files / Issues / PRs sections with a
 * vertical icon rail plus a single content area that swaps between views.
 * The rail button column is built from `rail-views` contributions
 * (read via `SlotManager.getContributions('rail-views')`); each
 * contribution carries `{view: {id, label, icon, badge?, priority?,
 * headerActions?}, render(container), refreshEvent?}`. The four built-in
 * views (Files / Issues / Pull Requests / Branches) register at boot
 * from `BUILTIN_VIEWS` — opting out via `SlotManager.hasViewId(id)` so a
 * provider that already claimed the same `view.id` wins.
 *
 * **Body rendering (2.24.0).** The rail owns the body path end-to-end:
 * on every `rebuild()` it wipes the `[data-rail-view-container]` children
 * of `.lp__rail-content`, recreates a wrapper per contribution (header
 * from `view.label` + optional `view.headerActions`; body from a freshly
 * created `<div class="lp__rail-view-body">`), and invokes `c.render(body)`.
 * Built-in views' `render` callbacks set up the legacy inner panel structure
 * (`#fileTree`, `#issuesPanel`, `#prsPanel`, `#branchPanel`) so existing
 * callers that look up those IDs via `document.getElementById(...)` find
 * them post-render. The static `<div data-rail-view-container>` HTML
 * scaffolding deleted from `html/sidebar.html` at 2.24.0.
 *
 * The active view persists across reloads in `localStorage` under
 * `leftPaneRail.activeView` — a `view.id` string. When the persisted id
 * is no longer registered (e.g. a provider that contributed it was
 * removed), the active view falls back to the first contribution's id.
 *
 * Badge counts are re-evaluated by calling `view.badge()` on every rail
 * re-render. Contributions wire `refreshEvent` (e.g. `'issues:refresh'`)
 * — when that fires, the rail's button column re-renders (so the badge
 * picks up the latest count) and the contribution's `render(body)` runs
 * again for dynamic containers.
 *
 * Header actions: a `view.headerActions` array of `{id, icon, onClick,
 * title?, ariaLabel?}` entries renders an action-button row in the view's
 * header. The rail attaches a single delegated click listener on
 * `.lp__rail-content` keyed on `data-rail-header-action="${viewId}:${actionId}"`,
 * stable across rebuilds since `.lp__rail-content` itself never tears down.
 *
 * Pattern mirrors `js/ui/branch-panel.js` (1.12.0 extraction A) and
 * `js/ui/issue-list.js` (1.13.0 extraction B): pure renderer
 * (`renderRailButtonsHtml`) is HTML-in / HTML-out, no DOM; mount + event
 * delegation lives in `mountLeftPaneRail()`.
 */

import { State, EventBus, Storage } from '../core.js';
import { escapeAttr, escapeHtml } from '../utils/html.js';
import { SlotManager } from '../slot-manager.js';
import { renderFileTree } from '../file-tree.js';
import {
    renderIssues,
    renderPullRequests,
    refreshIssues,
    refreshPullRequests,
} from '../project-manager.js';
import { renderBranchPanel } from './branch-panel.js';
import { openNewBranchModal } from './branch.js';
import { openNewFileModal } from './file-create.js';
import { Git } from '../git.js';

const STORAGE_KEY = 'leftPaneRail.activeView';
const VIEW_ATTR = 'data-rail-view';
const BTN_ATTR = 'data-rail-btn';

const RAIL_BUTTONS_ID = 'leftPaneRailButtons';
const RAIL_CONTENT_SEL = '.lp__rail-content';
const VIEW_CONTAINER_SEL = '[data-rail-view-container]';

// Lucide-shape inline SVGs — same family + stroke pattern as
// js/ui/branch-panel.js (24×24 viewBox, round caps/joins).
const SVG_FILES = '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
const SVG_ISSUES = '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
const SVG_PRS = '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v8"/><circle cx="18" cy="18" r="3"/></svg>';
const SVG_BRANCHES = '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';

// Header-action icons — moved from the deleted static `<div data-rail-view-container>`
// blocks in html/sidebar.html (2.24.0).
const SVG_REFRESH = '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>';
const SVG_ZIP_UPLOAD = '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 16-9 5-9-5V8l9-5 9 5v8Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/></svg>';
const SVG_NEW_FILE = '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 12v6M9 15h6"/></svg>';
const SVG_PLUS = '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const SVG_DOWNLOAD_ZIP = '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/></svg>';
const SVG_RELEASE = '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>';

/**
 * Files body inner skeleton — `<div id="filesNowStrip">` is the Now-strip
 * mount point (2.17.0) populated by `js/ui/now-strip.js#mountNowStrip()`;
 * `<div id="fileTree">` is the legacy file-tree container the imperative
 * `renderFileTree()` writes into. Kept identity-stable so `js/accessibility.js`
 * `initFileTreeKeyboard()` and other `document.getElementById('fileTree')`
 * callers find them after the body re-renders.
 */
const FILES_BODY_HTML =
    '<div id="filesNowStrip" class="lp2__now" hidden></div>' +
    '<div class="file-tree" id="fileTree">' +
        '<div style="padding: 1rem; color: var(--text-muted); text-align: center;">' +
            'Select a project to browse files' +
        '</div>' +
    '</div>';

const ISSUES_BODY_HTML =
    '<div class="issues-panel" id="issuesPanel" role="list" aria-label="Issues">' +
        '<div style="padding: 0.75rem; color: var(--text-muted); font-size: 12px;">' +
            'No issues loaded' +
        '</div>' +
    '</div>';

const PRS_BODY_HTML =
    '<div class="prs-panel" id="prsPanel" role="list" aria-label="Pull requests">' +
        '<div style="padding: 0.75rem; color: var(--text-muted); font-size: 12px;">' +
            'No pull requests' +
        '</div>' +
    '</div>';

const BRANCHES_BODY_HTML =
    '<div class="branch-panel" id="branchPanel" role="list" aria-label="Branches">' +
        '<div class="branch-panel__empty" style="padding: 0.5rem 0.25rem; color: var(--text-muted); font-size: var(--font-xs, 0.75rem);">' +
            'No project loaded' +
        '</div>' +
    '</div>';

/**
 * Built-in priority anchors for the four core rail views. Exported so a
 * provider contribution can declare a priority *relative to* a built-in
 * (e.g. between Issues=20 and PRs=30 picks 25) instead of guessing
 * from a magic-number table. SlotManager sorts ascending; the spacing
 * (10 between built-ins, 50+ default for new contributions) leaves room
 * for provider-shipped views to slot anywhere in the order.
 *
 * Cross-references: `docs/DESIGN-git-providers-and-ui-extensions.md` §4
 * (slot priorities).
 */
export const BUILTIN_PRIORITY = Object.freeze({
    files: 10,
    issues: 20,
    prs: 30,
    branches: 40,
});

/**
 * Built-in rail views. Registered as `rail-views` contributions in
 * `mountLeftPaneRail()`; opting out per-id when a provider has already
 * claimed the same `view.id` (per Decision 1's override path).
 *
 * Each `render(body)` populates the legacy inner panel structure (so
 * `document.getElementById('issuesPanel')` etc. still find their mount
 * post-render) and delegates to the imperative renderer for the data
 * pass. `view.headerActions` declares the per-view header buttons —
 * delegated clicks routed by `data-rail-header-action="${viewId}:${actionId}"`.
 *
 * Priorities are read from `BUILTIN_PRIORITY` so a future renumbering
 * touches the named anchor, not four scattered call sites.
 */
const BUILTIN_VIEWS = [
    {
        pluginId: 'core.files',
        view: {
            id: 'files',
            label: 'Files',
            icon: SVG_FILES,
            priority: BUILTIN_PRIORITY.files,
            headerActions: [
                {
                    id: 'refresh',
                    icon: SVG_REFRESH,
                    title: 'Refresh file tree',
                    ariaLabel: 'Refresh file tree',
                    onClick: () => {
                        EventBus.emit('tree:refresh');
                        EventBus.emit('branches:refresh');
                        window.showToast?.('Refreshing files & branches…', 'info');
                    },
                },
                {
                    id: 'zipUpload',
                    icon: SVG_ZIP_UPLOAD,
                    title: 'Upload Zip',
                    ariaLabel: 'Upload zip file',
                    onClick: () => { window.openZipUpload?.(); },
                },
                {
                    id: 'newFile',
                    icon: SVG_NEW_FILE,
                    title: 'New File',
                    ariaLabel: 'Create new file',
                    onClick: () => openNewFileModal(),
                },
            ],
        },
        render: (body) => {
            body.innerHTML = FILES_BODY_HTML;
            // Skip the renderer until a project has been loaded — the static
            // placeholder ("Select a project to browse files") otherwise gets
            // immediately overwritten with "No files found" pre-load.
            if (Array.isArray(State.fileTree) && State.fileTree.length > 0) {
                renderFileTree(body.querySelector('#fileTree'));
            }
        },
    },
    {
        pluginId: 'core.issues',
        view: {
            id: 'issues',
            label: 'Issues',
            icon: SVG_ISSUES,
            badge: () => Array.isArray(State.issues) ? State.issues.length : 0,
            priority: BUILTIN_PRIORITY.issues,
            headerActions: [
                {
                    id: 'refresh',
                    icon: SVG_REFRESH,
                    title: 'Refresh',
                    ariaLabel: 'Refresh issues',
                    onClick: () => refreshIssues(),
                },
            ],
        },
        render: (body) => {
            body.innerHTML = ISSUES_BODY_HTML;
            if (Array.isArray(State.issues) && State.issues.length > 0) {
                renderIssues(body.querySelector('#issuesPanel'));
            }
        },
        refreshEvent: 'issues:refresh',
    },
    {
        pluginId: 'core.prs',
        view: {
            id: 'prs',
            label: 'Pull Requests',
            icon: SVG_PRS,
            badge: () => Array.isArray(State.pullRequests) ? State.pullRequests.length : 0,
            priority: BUILTIN_PRIORITY.prs,
            headerActions: [
                {
                    id: 'newPr',
                    icon: SVG_PLUS,
                    title: 'Create Pull Request',
                    ariaLabel: 'Create pull request',
                    onClick: () => { window.openCreatePRModal?.(); },
                },
                {
                    id: 'refresh',
                    icon: SVG_REFRESH,
                    title: 'Refresh',
                    ariaLabel: 'Refresh pull requests',
                    onClick: () => refreshPullRequests(),
                },
            ],
        },
        render: (body) => {
            body.innerHTML = PRS_BODY_HTML;
            if (Array.isArray(State.pullRequests) && State.pullRequests.length > 0) {
                renderPullRequests(body.querySelector('#prsPanel'));
            }
        },
        refreshEvent: 'prs:refresh',
    },
    {
        pluginId: 'core.branches',
        view: {
            id: 'branches',
            label: 'Branches',
            icon: SVG_BRANCHES,
            priority: BUILTIN_PRIORITY.branches,
            headerActions: [
                {
                    id: 'newBranch',
                    icon: SVG_PLUS,
                    title: 'New Branch',
                    ariaLabel: 'Create new branch',
                    onClick: () => openNewBranchModal(),
                },
                {
                    id: 'downloadZip',
                    icon: SVG_DOWNLOAD_ZIP,
                    title: 'Download project as zip',
                    ariaLabel: 'Download project as zip',
                    onClick: () => _downloadProjectArchive(),
                },
                {
                    id: 'release',
                    icon: SVG_RELEASE,
                    title: 'Release Manager',
                    ariaLabel: 'Release manager',
                    onClick: () => { window.openReleaseModal?.(); },
                },
            ],
        },
        render: (body) => {
            body.innerHTML = BRANCHES_BODY_HTML;
            if (State.currentProject && Array.isArray(State.branches) && State.branches.length > 0) {
                renderBranchPanel(body.querySelector('#branchPanel'));
            }
        },
    },
];

/**
 * Branches view "Download project as zip" header action handler. Routes
 * through `Git.downloadArchive` (provider archive API — fast and includes
 * the host's view of the branch HEAD). Lifted from the deleted
 * `safeAdd('btnDownloadZip', ...)` block in `js/app.js` (2.24.0).
 */
async function _downloadProjectArchive() {
    if (!State.currentProject) {
        window.showToast?.('No project loaded', 'warning');
        return;
    }
    const { owner, repo } = State.currentProject;
    const branch = State.currentBranch || 'main';
    try {
        window.showToast?.(`Downloading ${owner}/${repo} @ ${branch}…`, 'info');
        const blob = await Git.downloadArchive(owner, repo, branch);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${repo}-${branch}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        window.showToast?.('Download started', 'success');
    } catch (err) {
        console.error('[Rail v2] downloadArchive failed:', err);
        window.showToast?.(`Download failed: ${err.message}`, 'error');
    }
}

/**
 * Pure: render a header-action button. Exported for tests.
 *
 * @param {string} viewId
 * @param {{id: string, icon: string, title?: string, ariaLabel?: string}} action
 * @returns {string}
 */
export function renderHeaderActionHtml(viewId, action) {
    const title = action.title ?? action.id;
    const ariaLabel = action.ariaLabel ?? title;
    return (
        `<button type="button"`
        + ` data-rail-header-action="${escapeAttr(viewId)}:${escapeAttr(action.id)}"`
        + ` title="${escapeAttr(title)}"`
        + ` aria-label="${escapeAttr(ariaLabel)}">${action.icon}</button>`
    );
}

/**
 * Pure: render the rail icon column from a list of view descriptors.
 * Exported for tests.
 *
 * @param {Object} opts
 * @param {string} opts.activeView - the `view.id` currently active.
 * @param {Array<{id: string, label: string, icon: string, badgeCount?: number}>} opts.views
 * @returns {string}
 */
export function renderRailButtonsHtml({ activeView, views }) {
    return (views || []).map(item => {
        const isActive = item.id === activeView;
        const badgeCount = Number(item.badgeCount || 0);
        const badge = badgeCount > 0
            ? `<span class="lp__rail-badge">${escapeHtml(String(badgeCount))}</span>`
            : '';
        return (
            `<button type="button"`
            + ` class="lp__rail-btn${isActive ? ' lp__rail-btn--active' : ''}"`
            + ` ${BTN_ATTR}="${escapeAttr(item.id)}"`
            + ` title="${escapeAttr(item.label)}"`
            + ` aria-label="${escapeAttr(item.label)}"`
            + ` aria-pressed="${isActive ? 'true' : 'false'}">`
            + `${item.icon}${badge}`
            + `</button>`
        );
    }).join('');
}

/**
 * Pure: derive the active rail view from the registered contributions,
 * a persisted preference, and a default fallback. Exported for tests.
 *
 * @param {Array<{view: {id: string}}>} contribs
 * @param {string|null} stored
 * @returns {string|null} — the chosen view.id, or null when no
 *   contributions are registered (rail renders empty).
 */
export function resolveActiveView(contribs, stored) {
    if (!contribs || contribs.length === 0) return null;
    if (stored && contribs.some(c => c.view?.id === stored)) return stored;
    return contribs[0].view.id;
}

/**
 * Read the persisted active-view id (or null when localStorage is empty
 * / unavailable). The mount path passes this to `resolveActiveView` so
 * the chosen-view logic is testable as a pure function.
 *
 * @returns {string|null}
 */
export function readStoredActiveView() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        return typeof stored === 'string' && stored.length > 0 ? stored : null;
    } catch (_) {
        return null;
    }
}

/**
 * Project the rail-views contributions into the shape `renderRailButtonsHtml`
 * expects (id/label/icon/badgeCount). Badge functions are invoked here;
 * a throwing or non-number return falls back to 0 so a misbehaving plugin
 * cannot break the rail.
 *
 * @param {Array<object>} contribs
 * @returns {Array<{id: string, label: string, icon: string, badgeCount: number}>}
 */
export function projectViewsForButtons(contribs) {
    return (contribs || []).map(c => {
        let badgeCount = 0;
        if (typeof c.view?.badge === 'function') {
            try {
                const v = c.view.badge();
                badgeCount = Number.isFinite(Number(v)) ? Number(v) : 0;
            } catch (_) {
                badgeCount = 0;
            }
        }
        return {
            id: c.view.id,
            label: c.view.label,
            icon: c.view.icon,
            badgeCount,
        };
    });
}

/**
 * Mount the rail: register built-in views (opting out on collision),
 * render buttons + dynamic view bodies, set initial active view, wire
 * click delegation + persistence + refresh listeners.
 *
 * Idempotent — calling twice replaces the rail wiring cleanly via DOM
 * attachment. Built-in registration is idempotent on its own because
 * `hasViewId` blocks re-registration.
 */
export function mountLeftPaneRail() {
    const railHost = document.getElementById(RAIL_BUTTONS_ID);
    if (!railHost) return;

    // Register built-in contributions — provider contributions that already
    // claimed a colliding view.id win (per Decision 1's override path).
    for (const b of BUILTIN_VIEWS) {
        if (SlotManager.hasViewId(b.view.id)) continue;
        SlotManager.contribute('rail-views', {
            pluginId: b.pluginId,
            view: b.view,
            render: b.render,
            ...(b.refreshEvent ? { refreshEvent: b.refreshEvent } : {}),
        });
    }

    const railContent = document.querySelector(RAIL_CONTENT_SEL);

    const rebuild = () => {
        const contribs = SlotManager.getContributions('rail-views');
        const activeView = resolveActiveView(contribs, readStoredActiveView());

        // Render the icon column.
        railHost.innerHTML = renderRailButtonsHtml({
            activeView,
            views: projectViewsForButtons(contribs),
        });

        // Wipe + recreate every view container per contribution. This is
        // the load-bearing change at 2.24.0: the static
        // `[data-rail-view-container]` HTML scaffolding deleted from
        // sidebar.html, so the rail now owns the body path end-to-end for
        // built-ins and provider contributions alike.
        if (railContent) {
            railContent.querySelectorAll('[data-rail-view-container]').forEach(el => el.remove());

            for (const c of contribs) {
                const wrapper = document.createElement('div');
                wrapper.className = 'lp__rail-view lp__pane lp__pane--rail';
                wrapper.setAttribute('data-rail-view-container', c.view.id);
                wrapper.setAttribute('role', 'tabpanel');
                wrapper.setAttribute('aria-label', c.view.label);

                const header = document.createElement('div');
                header.className = 'lp2__pane-h';
                const title = document.createElement('span');
                title.className = 'lp2__pane-title';
                title.textContent = c.view.label;
                header.appendChild(title);
                const actions = Array.isArray(c.view.headerActions) ? c.view.headerActions : [];
                if (actions.length > 0) {
                    const actionsHost = document.createElement('span');
                    actionsHost.className = 'lp2__pane-h-actions';
                    actionsHost.innerHTML = actions
                        .map(a => renderHeaderActionHtml(c.view.id, a))
                        .join('');
                    header.appendChild(actionsHost);
                }
                wrapper.appendChild(header);

                const body = document.createElement('div');
                body.className = 'lp__rail-view-body';
                wrapper.appendChild(body);

                railContent.appendChild(wrapper);

                try {
                    c.render(body);
                } catch (error) {
                    console.error('[Rail v2] contribution render failed', {
                        viewId: c.view.id,
                        pluginId: c.pluginId,
                        error,
                    });
                }
            }
        }

        if (activeView != null) _applyActiveView(activeView);
    };

    rebuild();

    // Re-render when contributions change (e.g. a provider adds a rail view
    // mid-session, or a plugin disables itself).
    EventBus.on('slot:rail-views:changed', rebuild);

    // Click delegation on the rail host: switch active view on rail button.
    railHost.addEventListener('click', (e) => {
        const btn = e.target.closest(`[${BTN_ATTR}]`);
        if (!btn || !railHost.contains(btn)) return;
        const next = btn.getAttribute(BTN_ATTR);
        setActiveView(next);
    });

    // Click delegation on rail content: route `data-rail-header-action="${viewId}:${actionId}"`
    // clicks back to the contribution's `view.headerActions[i].onClick`. The
    // `.lp__rail-content` element itself never tears down across `rebuild()`s,
    // so a single listener here is stable for the lifetime of the rail.
    if (railContent) {
        railContent.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-rail-header-action]');
            if (!btn || !railContent.contains(btn)) return;
            const raw = btn.getAttribute('data-rail-header-action') || '';
            const sep = raw.indexOf(':');
            if (sep < 1) return;
            const viewId = raw.slice(0, sep);
            const actionId = raw.slice(sep + 1);
            const contrib = SlotManager.getContributions('rail-views')
                .find(c => c.view?.id === viewId);
            const action = (contrib?.view?.headerActions || []).find(a => a.id === actionId);
            if (action && typeof action.onClick === 'function') {
                try { action.onClick(e); } catch (err) {
                    console.error('[Rail v2] header action onClick failed', {
                        viewId, actionId, error: err,
                    });
                }
            }
        });
    }

    // Refresh badge counts when refresh / render events fire. Re-rendering
    // the button column is cheap (~4 buttons) and avoids divergence after
    // an async fetch settles State without re-emitting :refresh.
    const refreshButtons = () => {
        const contribs = SlotManager.getContributions('rail-views');
        const activeView = resolveActiveView(contribs, readStoredActiveView());
        railHost.innerHTML = renderRailButtonsHtml({
            activeView,
            views: projectViewsForButtons(contribs),
        });
    };
    EventBus.on('issues:refresh', refreshButtons);
    EventBus.on('prs:refresh', refreshButtons);
    // Also listen on the post-fetch render channels — `*:refresh` runs
    // synchronously before `refreshIssues`/`refreshPullRequests` settles
    // their network fetch + State mutation, so the badge would otherwise
    // stay stale (e.g. count not decrementing after a PR merge).
    EventBus.on('issues:render', refreshButtons);
    EventBus.on('prs:render', refreshButtons);

    // One-time migration: clear the now-obsolete `sidebarSectionSizes`
    // localStorage entry so we don't leak storage across releases.
    try { Storage.remove?.('sidebarSectionSizes'); } catch (_) { /* ignore */ }
}

/**
 * Switch the active rail view. Persists to localStorage and toggles
 * visibility on all rail-view containers (static + dynamic).
 *
 * @param {string} viewId
 */
export function setActiveView(viewId) {
    const contribs = SlotManager.getContributions('rail-views');
    if (!contribs.some(c => c.view?.id === viewId)) return;
    try { localStorage.setItem(STORAGE_KEY, viewId); } catch (_) { /* ignore */ }
    _applyActiveView(viewId);
}

function _applyActiveView(viewId) {
    // Toggle rail-button active class.
    document.querySelectorAll(`[${BTN_ATTR}]`).forEach(btn => {
        const isActive = btn.getAttribute(BTN_ATTR) === viewId;
        btn.classList.toggle('lp__rail-btn--active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
    // Toggle view container visibility.
    document.querySelectorAll(VIEW_CONTAINER_SEL).forEach(el => {
        const isActive = el.getAttribute('data-rail-view-container') === viewId;
        el.hidden = !isActive;
    });
}
