/**
 * Hotkeys page — data-driven from `js/help/hotkey-registry.js`.
 *
 * Renders one section per group with platform-aware Kbd glyphs. The
 * platform toggle button (mac ↔ win/linux) writes to localStorage via
 * `js/help/platform.js` and re-renders the page.
 */

import { hotkeysByGroup } from '../hotkey-registry.js';
import { renderKbd } from '../kbd.js';
import { getPlatform, togglePlatform } from '../platform.js';
import { escapeHtml } from '../../utils/html.js';

export function renderHotkeys() {
    const plat = getPlatform();
    const groups = hotkeysByGroup();

    const platLabel = plat === 'mac' ? 'macOS' : 'Windows / Linux';
    const otherLabel = plat === 'mac' ? 'Windows / Linux' : 'macOS';

    const sectionsHtml = groups.map(g => {
        const rowsHtml = g.keys.map(hk => `
            <div class="help__hk-row">
                ${renderKbd(hk.combo, plat)}
                <span class="help__hk-desc">${escapeHtml(hk.desc)}</span>
            </div>
        `).join('');
        return `
            <section class="help__hk-group">
                <h2 class="help__h2">${escapeHtml(g.title)}</h2>
                <div class="help__hk-list">${rowsHtml}</div>
            </section>
        `;
    }).join('');

    return `
        <article class="help__article">
            <div class="help__crumbs">Reference <span class="help__crumb-sep">›</span> Hotkeys</div>
            <h1 class="help__h1">Hotkeys</h1>
            <p class="help__lede">Showing ${escapeHtml(platLabel)} keys.
                <button type="button" class="help__plat-toggle" data-help-platform-toggle>
                    switch to ${escapeHtml(otherLabel)}
                </button>
            </p>
            ${sectionsHtml}
        </article>
    `;
}

/** Wire the platform toggle button after rendering. Call this after the
 *  HTML is in the DOM. The page passes a re-render callback that flips
 *  storage and rebuilds the page. */
export function wireHotkeysPage(panel, rerender) {
    const btn = panel.querySelector('[data-help-platform-toggle]');
    if (btn) {
        btn.addEventListener('click', () => {
            togglePlatform();
            rerender();
        });
    }
}
