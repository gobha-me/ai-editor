/**
 * Browser smoke tests for the Help slide-out (1.3.10).
 *
 * Pins the integration contract:
 *   - openHelpSlideOut() activates the overlay; closeHelpSlideOut()
 *     deactivates it.
 *   - Nav renders 11 items grouped per the design (3 ungrouped + Building 3
 *     + Concepts 4 + Reference 1).
 *   - Clicking a nav item swaps the active page.
 *   - Hotkeys page renders rows from the registry.
 *   - Search input populates results when the index is mocked.
 *   - Esc inside the input clears it without closing the slide-out.
 *
 * Test isolation: snapshot the document state, mount a fixture, and
 * remove it on teardown. Registry / search state is reset via the
 * exposed `__test_resetState`.
 */

import {
    initHelpSlideOut,
    openHelpSlideOut,
    closeHelpSlideOut,
    NAV_ITEMS_FOR_TEST,
    __test_renderActivePage,
    __test_selectPage,
    __test_resetState,
} from '../js/help/index.js';

const { T } = window;

T.suite('Help slide-out — 1.3.10 Touch 2 layout');

// ----- DOM scaffold (mirrors html/help-slideout.html + the topbar btn) -----

const fixture = document.createElement('div');
fixture.id = 'helpSlideOutFixture';
fixture.innerHTML = `
    <button id="btnHelp" title="Help (F1)">❓</button>
    <div class="slide-out-overlay" id="helpSlideOut" aria-hidden="true">
        <aside class="slide-out slide-out--wide">
            <div class="help">
                <div class="help__head">
                    <div class="help__title" id="helpSlideOutTitle"><span>Help</span></div>
                    <div class="help__head-spacer"></div>
                    <button id="helpCloseBtn">✕</button>
                </div>
                <div class="help__body">
                    <aside class="help__nav">
                        <div class="help__search-wrap">
                            <input type="search" id="helpSearchInput">
                            <kbd id="helpSearchHint">⌘/</kbd>
                        </div>
                        <div id="helpNavList"></div>
                    </aside>
                    <div class="help__content" id="helpContent"></div>
                </div>
                <div class="help__foot">
                    <span class="help__foot-meta" id="helpFootMeta"></span>
                </div>
            </div>
        </aside>
    </div>
`;
document.body.appendChild(fixture);

// ----- Init the slide-out (wires button + nav + search + close) -----

__test_resetState();
initHelpSlideOut();

// ----- 1. Open via openHelpSlideOut() -----

openHelpSlideOut();
const overlay = document.getElementById('helpSlideOut');
T.assert(overlay.classList.contains('active'), 'openHelpSlideOut() activates the overlay');
T.eq(overlay.getAttribute('aria-hidden'), 'false', 'Overlay aria-hidden flips to false when active');

// ----- 2. Nav renders 11 items in 4 groups -----
// 1.14.1 — Security entry joined the Concepts group when SECURITY.md was
// registered as a help page so cross-doc links from PLUGIN.md route in-app.

T.eq(NAV_ITEMS_FOR_TEST.length, 11, 'NAV_ITEMS contains all 11 design items');

const navBtns = [...document.querySelectorAll('[data-help-page]')];
T.eq(navBtns.length, 11, 'Nav rendered 11 buttons');

const expectedIds = [
    'getting-started', 'hotkeys', 'command-palette',
    'plugin-sdk', 'tools', 'themes',
    'roles', 'memory', 'architecture', 'security',
    'changelog',
];
T.deepEq(
    navBtns.map(b => b.dataset.helpPage),
    expectedIds,
    'Nav items render in design order'
);

const groupTitles = [...document.querySelectorAll('.help__nav-group-title')].map(el => el.textContent.trim());
T.deepEq(groupTitles, ['Building', 'Concepts', 'Reference'],
    'Three group titles render (the first group has no title)');

// ----- 3. Default page is Getting started -----

const content = document.getElementById('helpContent');
T.assert(content.textContent.includes('Getting started'),
    'Default page is Getting started');

// ----- 4. Selecting the Hotkeys page renders rows from the registry -----

__test_selectPage('hotkeys');
T.assert(content.querySelector('.help__hk-list') !== null,
    'Hotkeys page renders at least one .help__hk-list');
const hkRows = content.querySelectorAll('.help__hk-row');
T.assert(hkRows.length >= 30, `Hotkeys page renders all 30+ registry rows (got ${hkRows.length})`);

// Active nav item flips to hotkeys
const activeNav = document.querySelector('.help__nav-item--active');
T.eq(activeNav?.dataset.helpPage, 'hotkeys', 'Active nav highlight follows the selected page');

// ----- 5. Platform toggle button is wired -----

const platToggle = content.querySelector('[data-help-platform-toggle]');
T.assert(platToggle !== null, 'Hotkeys page renders a platform toggle button');

// ----- 6. Selecting Themes renders the static themes page -----

__test_selectPage('themes');
T.assert(content.textContent.includes('--tk-'),
    'Themes page mentions the --tk-* token contract');

// ----- 7. Esc inside search input clears it without closing the slide-out -----

const input = document.getElementById('helpSearchInput');
input.value = 'foo';
const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
input.dispatchEvent(esc);
T.eq(input.value, '', 'Esc inside search input clears the input');
T.assert(overlay.classList.contains('active'),
    'Esc inside the search input does not close the slide-out');

// ----- 8. Close via closeHelpSlideOut() -----

closeHelpSlideOut();
T.assert(!overlay.classList.contains('active'), 'closeHelpSlideOut() deactivates the overlay');
T.eq(overlay.getAttribute('aria-hidden'), 'true', 'aria-hidden flips back to true on close');

// ----- 9. Close button click also closes -----

openHelpSlideOut();
T.assert(overlay.classList.contains('active'), 'Re-open works after close');
document.getElementById('helpCloseBtn').click();
T.assert(!overlay.classList.contains('active'), 'Close button click deactivates the overlay');

// ----- 10. Backdrop click closes -----

openHelpSlideOut();
overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
// The handler checks `e.target === overlay`; dispatching directly on overlay
// makes target === overlay so the close fires.
T.assert(!overlay.classList.contains('active'), 'Clicking the backdrop closes the overlay');

// ----- Teardown -----

closeHelpSlideOut();
__test_resetState();
fixture.remove();
