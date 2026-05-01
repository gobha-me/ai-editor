/**
 * Kbd renderer — vanilla JS port of the help.jsx Kbd React component.
 *
 * Renders a key combo as `<span class="kbd-combo">` containing one
 * `<kbd class="help-kbd">` per token. Mac shows glyphs (⌘ ⇧ ⌥ etc.)
 * with no `+` separators; Windows/Linux shows words (Ctrl, Shift, Alt)
 * with `+` separators. Combos read from `js/help/hotkey-registry.js`
 * use the same token vocabulary as `help.jsx` (mod / shift / alt /
 * enter / esc / tab / space / arrows / single chars).
 */

import { escapeHtml } from '../utils/html.js';

const MAC_MAP = {
    mod: '⌘', shift: '⇧', alt: '⌥', ctrl: '⌃',
    enter: '↵', esc: 'Esc', tab: 'Tab', space: 'Space',
    up: '↑', down: '↓', left: '←', right: '→',
    backspace: '⌫', del: '⌦', delete: '⌦',
    slash: '/', comma: ',', period: '.', semicolon: ';',
    plus: '+', minus: '−', equals: '=',
    home: 'Home', end: 'End', pageup: 'PgUp', pagedown: 'PgDn',
};

const WIN_MAP = {
    mod: 'Ctrl', shift: 'Shift', alt: 'Alt', ctrl: 'Ctrl',
    enter: 'Enter', esc: 'Esc', tab: 'Tab', space: 'Space',
    up: '↑', down: '↓', left: '←', right: '→',
    backspace: 'Backspace', del: 'Delete', delete: 'Delete',
    slash: '/', comma: ',', period: '.', semicolon: ';',
    plus: '+', minus: '−', equals: '=',
    home: 'Home', end: 'End', pageup: 'PgUp', pagedown: 'PgDn',
};

function labelFor(token, plat) {
    const map = plat === 'mac' ? MAC_MAP : WIN_MAP;
    if (Object.prototype.hasOwnProperty.call(map, token)) return map[token];
    if (token.length === 1) return token.toUpperCase();
    if (/^f\d{1,2}$/i.test(token)) return token.toUpperCase();
    return token;
}

/**
 * Render a combo array (e.g. `['mod', 'shift', 'k']`) as HTML string.
 * @param {string[]} combo
 * @param {'mac'|'win'} plat
 * @returns {string}
 */
export function renderKbd(combo, plat) {
    if (!Array.isArray(combo) || combo.length === 0) return '';
    const showPlus = plat !== 'mac';
    const parts = combo.map((token, i) => {
        const label = labelFor(token, plat);
        const sep = (i > 0 && showPlus) ? '<span class="kbd-plus">+</span>' : '';
        return `${sep}<kbd class="help-kbd">${escapeHtml(label)}</kbd>`;
    });
    return `<span class="kbd-combo">${parts.join('')}</span>`;
}
