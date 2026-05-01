/**
 * Help slide-out — 1.3.10 Touch 2 net-new surface (PR 6 of facelift arc).
 *
 * Right-edge drawer per `docs/design/touch-2-facelift/project/help.jsx`.
 * Replaces the 6-tab `#helpModal` and inherits the 1.3.9 `.slide-out`
 * shell. Left-rail nav with grouped pages; data-driven Hotkeys page;
 * search-all across all 10 docs; Plugin SDK / Tools / Roles / Memory /
 * Architecture / Changelog pages lazy-load existing markdown.
 *
 * Lifecycle template mirrors `js/debug-slideout.js` (1.3.9): single
 * `init` wires the close button + Esc + backdrop click + nav clicks
 * + search input; `open(pageId?)` activates the overlay; `close()`
 * deactivates.
 */

import { VERSION } from '../version.js';
import { renderGettingStarted } from './pages/getting-started.js';
import { renderHotkeys, wireHotkeysPage } from './pages/hotkeys.js';
import { renderCommandPalette } from './pages/command-palette.js';
import { renderThemes } from './pages/themes.js';
import { renderMarkdownPage } from './pages/markdown-pages.js';
import { buildSearchIndex, search } from './search-index.js';
import { escapeHtml } from '../utils/html.js';
import { Icon } from '../ui/icons.js';

// Nav groups + items (display order). Matches help.jsx navItems.
// `icon` is now a key into the Icon module (1.3.11 — Lucide swap).
const NAV_ITEMS = [
    { id: 'getting-started', label: 'Getting started', icon: 'Sparkles',   group: '' },
    { id: 'hotkeys',         label: 'Hotkeys',         icon: 'Hash',       group: '' },
    { id: 'command-palette', label: 'Command palette', icon: 'Search',     group: '' },
    { id: 'plugin-sdk',      label: 'Plugin SDK',      icon: 'Box',        group: 'Building' },
    { id: 'tools',           label: 'Tools API',       icon: 'Settings',   group: 'Building' },
    { id: 'themes',          label: 'Themes',          icon: 'Palette',    group: 'Building' },
    { id: 'roles',           label: 'Roles',           icon: 'AtSign',     group: 'Concepts' },
    { id: 'memory',          label: 'Memory',          icon: 'Brain',      group: 'Concepts' },
    { id: 'architecture',    label: 'Architecture',    icon: 'Server',     group: 'Concepts' },
    { id: 'changelog',       label: 'Changelog',       icon: 'GitBranch',  group: 'Reference' },
];

const STATIC_PAGES = new Set(['getting-started', 'hotkeys', 'command-palette', 'themes']);
const MARKDOWN_PAGES = new Set(['plugin-sdk', 'tools', 'roles', 'memory', 'architecture', 'changelog']);

// Slide-out state (module-singleton, mirrors debug-slideout.js).
let _activePage = 'getting-started';
let _initialized = false;
let _searchTimeout = 0;
let _indexBuilt = false;

// ============================================
// Init — wire button + DOM listeners
// ============================================

export function initHelpSlideOut() {
    if (_initialized) return;
    _initialized = true;

    const overlay = document.getElementById('helpSlideOut');
    if (!overlay) return;

    // Backdrop click closes
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeHelpSlideOut();
    });

    document.getElementById('helpCloseBtn')?.addEventListener('click', closeHelpSlideOut);

    // Esc closes (only when this overlay is on top — match the debug pattern)
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('active')) {
            closeHelpSlideOut();
        }
    });

    // Topbar Help button — re-wires the existing #btnHelp from header.html.
    // The previous `onclick="window.openHelpModal()"` still works via the
    // back-compat alias `window.openHelpModal = openHelpSlideOut` set at
    // module load below; this listener just adds direct binding too.
    const btn = document.getElementById('btnHelp');
    if (btn) {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            openHelpSlideOut();
        });
    }

    _renderNav();
    _wireSearch();

    // Set the platform-aware key hint on the search input.
    const isMac = /mac|darwin/i.test(navigator.platform || '');
    const hint = document.getElementById('helpSearchHint');
    if (hint) hint.textContent = isMac ? '⌘/' : 'Ctrl+/';

    // Footer meta
    const meta = document.getElementById('helpFootMeta');
    if (meta) meta.textContent = `v${VERSION}`;
}

// ============================================
// Open / close
// ============================================

export function openHelpSlideOut(pageId) {
    const overlay = document.getElementById('helpSlideOut');
    if (!overlay) return;
    if (pageId && (STATIC_PAGES.has(pageId) || MARKDOWN_PAGES.has(pageId))) {
        _activePage = pageId;
    }
    _renderActivePage();
    _markActiveNav();
    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');

    // Build search index lazily on first open. Failures are logged but
    // don't block — the index can be partially populated.
    if (!_indexBuilt) {
        _indexBuilt = true;
        buildSearchIndex().catch(err => {
            console.warn('[help] Search index build failed:', err);
        });
    }
}

export function closeHelpSlideOut() {
    const overlay = document.getElementById('helpSlideOut');
    if (!overlay) return;
    overlay.classList.remove('active');
    overlay.setAttribute('aria-hidden', 'true');

    // Clear search input on close so reopening doesn't show stale results.
    const input = document.getElementById('helpSearchInput');
    if (input && input.value) {
        input.value = '';
        // Re-render the previously active page.
        _renderActivePage();
    }
}

// Back-compat aliases — the old #helpModal had window.openHelpModal /
// window.closeHelpModal callable from inline `onclick=`. Repoint to the
// new functions so nothing breaks.
if (typeof window !== 'undefined') {
    window.openHelpModal = openHelpSlideOut;
    window.closeHelpModal = closeHelpSlideOut;
}

// ============================================
// Nav rendering
// ============================================

function _renderNav() {
    const list = document.getElementById('helpNavList');
    if (!list) return;

    const groups = [];
    let currentGroup = null;
    for (const item of NAV_ITEMS) {
        if (item.group !== currentGroup) {
            currentGroup = item.group;
            groups.push({ group: currentGroup, items: [] });
        }
        groups[groups.length - 1].items.push(item);
    }

    list.innerHTML = groups.map(g => {
        const titleHtml = g.group
            ? `<div class="help__nav-group-title">${escapeHtml(g.group)}</div>`
            : '';
        const itemsHtml = g.items.map(it => `
            <button type="button" class="help__nav-item" data-help-page="${escapeHtml(it.id)}">
                <span class="help__nav-item-icon" aria-hidden="true">${Icon[it.icon] || ''}</span>
                <span>${escapeHtml(it.label)}</span>
            </button>
        `).join('');
        return `<div class="help__nav-group">${titleHtml}${itemsHtml}</div>`;
    }).join('');

    list.querySelectorAll('[data-help-page]').forEach(btn => {
        btn.addEventListener('click', () => {
            _selectPage(btn.dataset.helpPage);
        });
    });
}

function _markActiveNav() {
    const list = document.getElementById('helpNavList');
    if (!list) return;
    list.querySelectorAll('[data-help-page]').forEach(btn => {
        const active = btn.dataset.helpPage === _activePage;
        btn.classList.toggle('help__nav-item--active', active);
    });
}

function _selectPage(pageId) {
    if (!STATIC_PAGES.has(pageId) && !MARKDOWN_PAGES.has(pageId)) return;
    _activePage = pageId;

    // Clearing the search input when clicking a nav item swaps from
    // search results back into the page view.
    const input = document.getElementById('helpSearchInput');
    if (input && input.value) input.value = '';

    _markActiveNav();
    _renderActivePage();

    // Scroll content back to top so the user sees the heading first.
    const content = document.getElementById('helpContent');
    if (content) content.scrollTop = 0;
}

// ============================================
// Page rendering dispatcher
// ============================================

function _renderActivePage() {
    const panel = document.getElementById('helpContent');
    if (!panel) return;

    if (_activePage === 'getting-started') {
        panel.innerHTML = renderGettingStarted();
    } else if (_activePage === 'hotkeys') {
        panel.innerHTML = renderHotkeys();
        wireHotkeysPage(panel, () => {
            panel.innerHTML = renderHotkeys();
            wireHotkeysPage(panel, () => _renderActivePage());
        });
    } else if (_activePage === 'command-palette') {
        panel.innerHTML = renderCommandPalette();
    } else if (_activePage === 'themes') {
        panel.innerHTML = renderThemes();
    } else if (MARKDOWN_PAGES.has(_activePage)) {
        renderMarkdownPage(panel, _activePage);
    }
}

// ============================================
// Search
// ============================================

function _wireSearch() {
    const input = document.getElementById('helpSearchInput');
    if (!input) return;

    input.addEventListener('input', () => {
        const q = input.value;
        if (_searchTimeout) clearTimeout(_searchTimeout);
        _searchTimeout = window.setTimeout(() => _runSearch(q), 150);
    });

    // Esc inside the input clears it; let the document-level Esc close.
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && input.value) {
            e.stopPropagation();
            input.value = '';
            _renderActivePage();
        }
    });
}

function _runSearch(query) {
    const panel = document.getElementById('helpContent');
    if (!panel) return;
    const q = String(query || '').trim();
    if (q.length < 2) {
        // Empty / single-char query — fall back to active page.
        _renderActivePage();
        return;
    }

    const results = search(q);

    if (results.length === 0) {
        panel.innerHTML = `
            <article class="help__article help__article--search">
                <div class="help__crumbs">Search results <span class="help__crumb-sep">›</span> <span class="help__mono">${escapeHtml(q)}</span></div>
                <h1 class="help__h1">No results for <span class="help__mono help__h1-mono">"${escapeHtml(q)}"</span></h1>
                <p class="help__lede help__lede--search">Try a different word, or browse the nav on the left.</p>
            </article>
        `;
        return;
    }

    const rowsHtml = results.map(r => `
        <button type="button" class="help__result" data-help-page="${escapeHtml(r.docId)}">
            <div class="help__result-head">
                <span class="help__result-tag">${escapeHtml(r.docTitle)}</span>
                <span class="help__result-sep" aria-hidden="true">›</span>
                <span class="help__result-section">${escapeHtml(r.section)}</span>
            </div>
            <div class="help__result-snippet">${r.snippet}</div>
        </button>
    `).join('');

    panel.innerHTML = `
        <article class="help__article help__article--search">
            <div class="help__crumbs">Search results <span class="help__crumb-sep">›</span> <span class="help__mono">${escapeHtml(q)}</span></div>
            <h1 class="help__h1">${results.length} result${results.length === 1 ? '' : 's'} for <span class="help__mono help__h1-mono">"${escapeHtml(q)}"</span></h1>
            <p class="help__lede help__lede--search">across ${_index_doc_count()} docs · ranked by relevance</p>
            <div class="help__results">${rowsHtml}</div>
        </article>
    `;

    panel.querySelectorAll('[data-help-page]').forEach(btn => {
        btn.addEventListener('click', () => {
            _selectPage(btn.dataset.helpPage);
        });
    });
}

function _index_doc_count() {
    return STATIC_PAGES.size + MARKDOWN_PAGES.size;
}

// ============================================
// Test seams
// ============================================

export const __test_renderActivePage = _renderActivePage;
export const __test_selectPage = _selectPage;
export const __test_runSearch = _runSearch;
export const __test_resetState = () => {
    _activePage = 'getting-started';
    _initialized = false;
    _indexBuilt = false;
};
export const NAV_ITEMS_FOR_TEST = NAV_ITEMS;
