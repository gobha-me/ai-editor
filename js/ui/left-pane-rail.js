/**
 * Left Pane Rail — Touch 3 sidebar layout (2.11.0).
 *
 * Replaces the stacked, resizable Files / Issues / PRs sections with a
 * vertical icon rail (4 verbs: Files, Issues, Pull Requests, Branches)
 * plus a single content area that swaps between the four views. The
 * existing component mount points (`#fileTree`, `#issuesPanel`, `#prsPanel`,
 * `#branchPanel`) are preserved inside the new view shells so the renderers
 * that target them by id (project-manager.renderIssues, file-tree.render…)
 * keep working unchanged.
 *
 * The active view persists across reloads in `localStorage` under
 * `leftPaneRail.activeView`. The badge counts on the Issues / PRs rail
 * buttons refresh on `issues:refresh` / `prs:refresh` events.
 *
 * Pattern mirrors `js/ui/branch-panel.js` (1.12.0 extraction A) and
 * `js/ui/issue-list.js` (1.13.0 extraction B): pure renderer
 * (`renderRailButtonsHtml`) is HTML-in / HTML-out, no DOM; mount + event
 * delegation lives in `mountLeftPaneRail()`.
 */

import { State, EventBus, Storage } from '../core.js';
import { escapeAttr, escapeHtml } from '../utils/html.js';

const STORAGE_KEY = 'leftPaneRail.activeView';
const DEFAULT_VIEW = 'files';
const VIEW_ATTR = 'data-rail-view';
const BTN_ATTR = 'data-rail-btn';

const RAIL_BUTTONS_ID = 'leftPaneRailButtons';
const VIEW_CONTAINER_SEL = '[data-rail-view-container]';

// Lucide-shape inline SVGs — same family + stroke pattern as
// js/ui/branch-panel.js (24×24 viewBox, round caps/joins).
const SVG_FILES = '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
const SVG_ISSUES = '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
const SVG_PRS = '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v8"/><circle cx="18" cy="18" r="3"/></svg>';
const SVG_BRANCHES = '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';

const RAIL_ITEMS = [
    { id: 'files',    label: 'Files',         icon: SVG_FILES },
    { id: 'issues',   label: 'Issues',        icon: SVG_ISSUES,   badgeKey: 'issues' },
    { id: 'prs',      label: 'Pull Requests', icon: SVG_PRS,      badgeKey: 'prs' },
    { id: 'branches', label: 'Branches',      icon: SVG_BRANCHES },
];

const VALID_VIEW_IDS = new Set(RAIL_ITEMS.map(it => it.id));

/**
 * Render the rail icon column as an HTML string.
 *
 * Pure — exported for tests. Does not touch the DOM.
 *
 * @param {Object} opts
 * @param {string} opts.activeView - one of 'files'|'issues'|'prs'|'branches'
 * @param {Object<string, number>} [opts.badges] - badge counts keyed by id
 * @returns {string}
 */
export function renderRailButtonsHtml({ activeView, badges = {} }) {
    return RAIL_ITEMS.map(item => {
        const isActive = item.id === activeView;
        const badgeCount = item.badgeKey ? Number(badges[item.badgeKey] || 0) : 0;
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
 * Read the persisted active view, defaulting to `'files'` on first load
 * or when the stored value is unknown.
 *
 * @returns {string}
 */
export function readActiveView() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored && VALID_VIEW_IDS.has(stored)) return stored;
    } catch (_) { /* localStorage unavailable */ }
    return DEFAULT_VIEW;
}

/**
 * Compute the badge count map from current State. Pure helper for tests.
 *
 * @param {Object} state - object with `issues` and `pullRequests` arrays
 * @returns {Object<string, number>}
 */
export function computeBadges(state) {
    return {
        issues: Array.isArray(state?.issues) ? state.issues.length : 0,
        prs: Array.isArray(state?.pullRequests) ? state.pullRequests.length : 0,
    };
}

/**
 * Mount the rail: render buttons, set initial view visibility, wire click
 * delegation + persistence + badge refresh listeners.
 *
 * Idempotent — calling twice replaces listeners cleanly via DOM attachment.
 */
export function mountLeftPaneRail() {
    const railHost = document.getElementById(RAIL_BUTTONS_ID);
    if (!railHost) {
        // The sidebar markup was not loaded; nothing to mount.
        return;
    }

    const activeView = readActiveView();
    railHost.innerHTML = renderRailButtonsHtml({
        activeView,
        badges: computeBadges(State),
    });
    _applyActiveView(activeView);

    // Click delegation on the rail host.
    railHost.addEventListener('click', (e) => {
        const btn = e.target.closest(`[${BTN_ATTR}]`);
        if (!btn || !railHost.contains(btn)) return;
        const next = btn.getAttribute(BTN_ATTR);
        if (!VALID_VIEW_IDS.has(next)) return;
        setActiveView(next);
    });

    // Refresh badge counts when issues/PRs change. Re-render only the rail
    // buttons (cheap) — view content is rendered by its own components.
    const refresh = () => {
        const current = readActiveView();
        railHost.innerHTML = renderRailButtonsHtml({
            activeView: current,
            badges: computeBadges(State),
        });
    };
    EventBus.on('issues:refresh', refresh);
    EventBus.on('prs:refresh', refresh);

    // One-time migration: clear the now-obsolete `sidebarSectionSizes`
    // localStorage entry so we don't leak storage across releases.
    try { Storage.remove?.('sidebarSectionSizes'); } catch (_) { /* ignore */ }
}

/**
 * Switch the active rail view. Persists to localStorage and toggles
 * visibility on the four rail-view containers.
 *
 * @param {string} viewId
 */
export function setActiveView(viewId) {
    if (!VALID_VIEW_IDS.has(viewId)) return;
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
