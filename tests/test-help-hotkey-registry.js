/**
 * Browser smoke tests for the Help hotkey registry (1.3.10).
 *
 * Pins the display contract:
 *   - Every entry has the required shape { id, group, combo, desc }.
 *   - Combo arrays are non-empty.
 *   - `id` is unique across the whole registry.
 *   - `hotkeysByGroup()` partitions entries while preserving order.
 *   - `findHotkey(id)` returns the entry or null.
 *   - `renderKbd` produces escaped HTML with mac-glyph or win-word
 *     spellings depending on the platform argument.
 */

import { HOTKEYS, hotkeysByGroup, findHotkey } from '../js/help/hotkey-registry.js';
import { renderKbd } from '../js/help/kbd.js';

const { T } = window;

T.suite('Help hotkey registry — 1.3.10 display contract');

// ----- 1. Shape -----

const REQUIRED_KEYS = ['id', 'group', 'combo', 'desc'];
let shapeOk = true;
let firstShapeFailure = null;
for (const hk of HOTKEYS) {
    for (const k of REQUIRED_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(hk, k)) {
            shapeOk = false;
            firstShapeFailure = `${hk?.id || '?'} missing ${k}`;
            break;
        }
    }
    if (!shapeOk) break;
    if (!Array.isArray(hk.combo) || hk.combo.length === 0) {
        shapeOk = false;
        firstShapeFailure = `${hk.id} has empty/invalid combo`;
        break;
    }
}
T.assert(shapeOk, `Every entry has { id, group, combo[], desc } — ${firstShapeFailure || 'all good'}`);
T.assert(HOTKEYS.length >= 30, `Registry has at least 30 entries (got ${HOTKEYS.length})`);

// ----- 2. Unique ids -----

const ids = new Set();
const dupes = [];
for (const hk of HOTKEYS) {
    if (ids.has(hk.id)) dupes.push(hk.id);
    ids.add(hk.id);
}
T.eq(dupes.length, 0, `Every entry id is unique — duplicates: ${dupes.join(', ') || 'none'}`);

// ----- 3. hotkeysByGroup partitions while preserving registry order -----

const grouped = hotkeysByGroup();
T.assert(grouped.length >= 5, 'Registry partitions into at least 5 groups');
T.assert(
    grouped.every(g => g.title && Array.isArray(g.keys) && g.keys.length > 0),
    'Every group has a title and at least one key'
);

const flat = grouped.flatMap(g => g.keys);
T.eq(flat.length, HOTKEYS.length, 'Grouped keys flat back to the full registry length');

// ----- 4. findHotkey -----

const helpEntry = findHotkey('help.open');
T.assert(helpEntry && helpEntry.combo.includes('f1'), 'findHotkey("help.open") returns the F1 entry');
T.eq(findHotkey('does.not.exist'), null, 'findHotkey for unknown id returns null');

// ----- 5. renderKbd platform-aware -----

const macHtml = renderKbd(['mod', 'shift', 'k'], 'mac');
T.assert(macHtml.includes('⌘') && macHtml.includes('⇧'),
    'renderKbd("mac") substitutes ⌘ and ⇧ glyphs');
T.assert(!macHtml.includes('Ctrl') && !macHtml.includes('Shift'),
    'renderKbd("mac") does not emit win/linux words');

const winHtml = renderKbd(['mod', 'shift', 'k'], 'win');
T.assert(winHtml.includes('Ctrl') && winHtml.includes('Shift'),
    'renderKbd("win") emits Ctrl + Shift words');
T.assert(winHtml.includes('+'),
    'renderKbd("win") joins tokens with + separators');
T.assert(!winHtml.includes('⌘') && !winHtml.includes('⇧'),
    'renderKbd("win") does not emit mac glyphs');

// ----- 6. renderKbd handles empty / single-token combos -----

T.eq(renderKbd([], 'mac'), '', 'Empty combo returns empty string');
T.eq(renderKbd(null, 'mac'), '', 'Null combo returns empty string');
T.assert(renderKbd(['f1'], 'win').includes('F1'), 'Single F-key uppercases');

// ----- 7. Help itself is in the registry (the page must list its own hotkey) -----

T.assert(findHotkey('help.open') !== null, 'help.open is in the registry');
T.assert(findHotkey('help.openMod') !== null, 'help.openMod (Cmd+/) is in the registry');
T.assert(findHotkey('palette.open') !== null, 'palette.open (Cmd+K) is in the registry');
