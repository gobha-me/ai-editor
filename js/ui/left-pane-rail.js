/**
 * Left Pane Rail — Touch 3 sidebar layout (2.11.0); consumer of the
 * `rail-views` SlotManager slot kind (2.23.0, Decision 1 of
 * docs/DESIGN-git-providers-and-ui-extensions.md §"Decisions").
 *
 * Replaces the stacked, resizable Files / Issues / PRs sections with a
 * vertical icon rail plus a single content area that swaps between views.
 * The rail button column is built from `rail-views` contributions
 * (read via `SlotManager.getContributions('rail-views')`); each
 * contribution carries `{view: {id, label, icon, badge?, priority?},
 * render(container), refreshEvent?}`. The four built-in views
 * (Files / Issues / Pull Requests / Branches) register at boot from
 * `BUILTIN_VIEWS` — opting out via `SlotManager.hasViewId(id)` so a
 * provider that already claimed the same `view.id` wins.
 *
 * **Body rendering is transitional in 2.23.0.** A static
 * `<div data-rail-view-container="X">` block in `html/sidebar.html` is
 * preferred over the contribution's `render(body)` — if the static
 * container exists, the contribution's render is skipped and the existing
 * imperative renderers (`renderFileTree`, `project-manager.renderIssues`,
 * `renderPullRequests`, `branch-panel.renderBranchPanel`) keep populating
 * the body. For contributions whose `view.id` has NO matching static
 * container, the rail dynamically creates a `<div data-rail-view-container>`
 * wrapper inside `.lp__rail-content` and invokes `render(body)` per the
 * contract. The full body-migration of the four built-ins (and deletion
 * of the static blocks) is a follow-on minor.
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
 * Pattern mirrors `js/ui/branch-panel.js` (1.12.0 extraction A) and
 * `js/ui/issue-list.js` (1.13.0 extraction B): pure renderer
 * (`renderRailButtonsHtml`) is HTML-in / HTML-out, no DOM; mount + event
 * delegation lives in `mountLeftPaneRail()`.
 */

import { State, EventBus, Storage } from '../core.js';
import { escapeAttr, escapeHtml } from '../utils/html.js';
import { SlotManager } from '../slot-manager.js';

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

/**
 * Built-in rail views. Registered as `rail-views` contributions in
 * `mountLeftPaneRail()`; opting out per-id when a provider has already
 * claimed the same `view.id` (per Decision 1's override path).
 *
 * `render: () => {}` is a no-op stub: the static
 * `<div data-rail-view-container>` blocks in `html/sidebar.html` already
 * hold the body content for these four built-ins, and Rail v2 prefers
 * the static container when one exists (see module header). The stub
 * keeps the SlotManager contract satisfied (`render` must be a function);
 * the full body-migration is a follow-on patch.
 */
const BUILTIN_VIEWS = [
    {
        pluginId: 'core.files',
        view: {
            id: 'files',
            label: 'Files',
            icon: SVG_FILES,
            priority: 10,
        },
        render: () => {},
    },
    {
        pluginId: 'core.issues',
        view: {
            id: 'issues',
            label: 'Issues',
            icon: SVG_ISSUES,
            badge: () => Array.isArray(State.issues) ? State.issues.length : 0,
            priority: 20,
        },
        render: () => {},
        refreshEvent: 'issues:refresh',
    },
    {
        pluginId: 'core.prs',
        view: {
            id: 'prs',
            label: 'Pull Requests',
            icon: SVG_PRS,
            badge: () => Array.isArray(State.pullRequests) ? State.pullRequests.length : 0,
            priority: 30,
        },
        render: () => {},
        refreshEvent: 'prs:refresh',
    },
    {
        pluginId: 'core.branches',
        view: {
            id: 'branches',
            label: 'Branches',
            icon: SVG_BRANCHES,
            priority: 40,
        },
        render: () => {},
    },
];

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

        // Create dynamic view containers for contributions that have no
        // static `[data-rail-view-container]` block in the HTML shell.
        // Built-in views map onto the existing static blocks; provider
        // contributions create their own dynamic wrappers.
        if (railContent) {
            // Remove dynamic wrappers we may have created on a prior pass.
            railContent.querySelectorAll('[data-rail-view-dynamic="1"]').forEach(el => el.remove());

            for (const c of contribs) {
                const existing = railContent.querySelector(`[data-rail-view-container="${CSS.escape(c.view.id)}"]`);
                if (existing) continue;

                const wrapper = document.createElement('div');
                wrapper.className = 'lp__rail-view lp__pane lp__pane--rail';
                wrapper.setAttribute('data-rail-view-container', c.view.id);
                wrapper.setAttribute('data-rail-view-dynamic', '1');
                wrapper.setAttribute('role', 'tabpanel');
                wrapper.setAttribute('aria-label', c.view.label);

                const header = document.createElement('div');
                header.className = 'lp2__pane-h';
                const title = document.createElement('span');
                title.className = 'lp2__pane-title';
                title.textContent = c.view.label;
                header.appendChild(title);
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
