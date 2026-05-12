/**
 * HotkeyBindings — document-level keyboard-shortcut dispatcher driven by
 * the `HOTKEYS` display registry in `js/help/hotkey-registry.js`. 2.36.0
 * (2026-Q2 audit sweep entry [HC][S] at `docs/audit-2026-Q2/inventory.md`
 * — `Keyboard-shortcut handlers in setupKeyboardShortcuts mirror
 * hotkey-registry.js`).
 *
 * Replaces the pre-2.36.0 hand-rolled keydown chain in `js/app.js`
 * `setupKeyboardShortcuts` (~158 LOC of `if (e.ctrlKey && e.key === 's')
 * {...}` blocks, each repeating the combo definition the Help page also
 * carries). Mirrors the 2.33.0 `ModalRegistry` pattern: every binding
 * registers once at boot via `bindHotkey({...})`; a single keydown
 * listener calls `dispatchHotkey(event)` which scans the bindings and
 * runs the first whose combo matches.
 *
 * Combo definitions are the single source of truth in `HOTKEYS`. The
 * "Keep this list in sync with the keydown block" comment that pre-dated
 * 2.36.0 retires — drift in either direction is caught by
 * `tests/test-hotkey-bindings.mjs` and the parity-check at boot.
 *
 * Combo vocabulary (mirrors `js/help/kbd.js`):
 *   `mod`      → e.ctrlKey || e.metaKey  (⌘ on mac, Ctrl elsewhere)
 *   `shift`    → e.shiftKey
 *   `alt`      → e.altKey
 *   `slash`    → e.key === '/'
 *   `comma`    → e.key === ','
 *   `esc`      → e.key === 'Escape'
 *   `f1`..`f12` (case-insensitive) → e.key === 'F1'..'F12'
 *   single char → e.key matches case-insensitive
 *
 * Modifier-strictness: a combo that omits `shift` does NOT match an event
 * with shift held (otherwise Ctrl+P would also fire on Ctrl+Shift+P).
 * Same for `alt`. The two-key alias case (Ctrl+P and Ctrl+K both opening
 * Quick Open) is handled by registering two bindings, not by relaxing
 * modifier-strictness.
 */

import { findHotkey, HOTKEYS } from '../help/hotkey-registry.js';

/** @typedef {{
 *   id: string,
 *   handler: (e?: KeyboardEvent) => void,
 *   enabled?: (e?: KeyboardEvent) => boolean
 * }} HotkeyBinding */

/** @type {HotkeyBinding[]} */
const _bindings = [];

/**
 * Register a document-bound hotkey. One-shot at boot. `id` must reference
 * an entry in `HOTKEYS` with `documentBound: true`; throws otherwise. The
 * `enabled` predicate, when present, receives the event and gates both
 * the handler call and `preventDefault()` — returning false leaves the
 * keystroke to bubble (so e.g. Ctrl+/ inside CodeMirror still toggles the
 * line comment).
 *
 * @param {{
 *   id: string,
 *   handler: (e?: KeyboardEvent) => void,
 *   enabled?: (e?: KeyboardEvent) => boolean
 * }} entry
 */
export function bindHotkey({ id, handler, enabled }) {
    const hotkey = findHotkey(id);
    if (!hotkey) {
        throw new Error(`bindHotkey: unknown HOTKEYS id "${id}"`);
    }
    if (!hotkey.documentBound) {
        throw new Error(`bindHotkey: HOTKEYS id "${id}" is not flagged documentBound`);
    }
    if (typeof handler !== 'function') {
        throw new Error(`bindHotkey: handler for "${id}" is not a function`);
    }
    if (_bindings.some(b => b.id === id)) {
        throw new Error(`bindHotkey: "${id}" already bound`);
    }
    _bindings.push({ id, handler, enabled });
}

/**
 * Dispatch a keydown event through the registered bindings. Returns true
 * if a binding fired; false if nothing matched (or a matched binding's
 * `enabled` predicate returned false).
 *
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
export function dispatchHotkey(event) {
    for (const b of _bindings) {
        const hk = findHotkey(b.id);
        if (!hk) continue;
        if (!matchCombo(hk.combo, event)) continue;
        if (b.enabled && !b.enabled(event)) return false;
        event.preventDefault();
        b.handler(event);
        return true;
    }
    return false;
}

/**
 * Match a combo (array of HOTKEYS Kbd tokens) against a KeyboardEvent.
 *
 * @param {string[]} combo
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
export function matchCombo(combo, event) {
    if (!Array.isArray(combo) || combo.length === 0) return false;

    const wantMod   = combo.includes('mod');
    const wantShift = combo.includes('shift');
    const wantAlt   = combo.includes('alt');

    const hasMod = !!(event.ctrlKey || event.metaKey);
    if (wantMod !== hasMod) return false;
    if (wantShift !== !!event.shiftKey) return false;
    if (wantAlt !== !!event.altKey) return false;

    const keyTokens = combo.filter(t => t !== 'mod' && t !== 'shift' && t !== 'alt');
    if (keyTokens.length !== 1) return false;
    return matchKey(keyTokens[0], event.key);
}

function matchKey(token, eventKey) {
    if (eventKey == null) return false;
    if (token === 'slash') return eventKey === '/';
    if (token === 'comma') return eventKey === ',';
    if (token === 'esc') return eventKey === 'Escape';
    if (/^f\d{1,2}$/i.test(token)) return eventKey.toLowerCase() === token.toLowerCase();
    return String(eventKey).toLowerCase() === String(token).toLowerCase();
}

/**
 * Snapshot of registered bindings, in registration order. Mutation of
 * the return value does not affect the registry.
 *
 * @returns {HotkeyBinding[]}
 */
export function listBindings() {
    return _bindings.slice();
}

/**
 * Test-only reset. Not for production use — would defeat the one-shot
 * registration contract.
 */
export function _resetForTests() {
    _bindings.length = 0;
}

/**
 * Diagnostic: returns the list of `HOTKEYS` ids marked `documentBound:
 * true` that have NOT been bound at the time of the call. Empty array
 * means parity holds. The boot wiring in `js/app.js#setupKeyboardShortcuts`
 * should drive this to `[]`; CI test asserts it.
 *
 * @returns {string[]}
 */
export function listMissingBindings() {
    const bound = new Set(_bindings.map(b => b.id));
    return HOTKEYS.filter(hk => hk.documentBound && !bound.has(hk.id)).map(hk => hk.id);
}
