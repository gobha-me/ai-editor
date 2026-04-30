// @ts-check
/**
 * `@memory` chip — Preact mount wrapper + module-local controller for
 * the inline memory-citation picker (Memory PR #8, the last user-facing
 * surface in §1.3.0).
 *
 * Behavior: typing `@memory` in the chat input opens a popover above the
 * textarea with the user's memories (user + workspace scopes). The
 * textarea retains focus throughout — `js/chat/input.js` is the
 * controller for keystrokes, calling `setChipQuery`/`navigateChip`/
 * `selectChipActive`/`hideChip` as the user types and presses keys. The
 * Preact tree subscribes to module-local state via a tiny pub-sub
 * (`_subscribeChip`) and re-renders.
 *
 * Wire format: `[memory:<key>]` markdown reference (PR #8 decision).
 * The token is visible to the LLM and resolved via `memory_recall`. No
 * invisible structured tags. See `docs/DESIGN-memory.md` §"Chat Citation
 * Wire Format" and `match.js` for the formatter.
 *
 * Decision §9 (`docs/ROADMAP.md`): Preact + htm is allowed for new
 * state-heavy chat surfaces. The chip is the third Preact consumer
 * after the Memory tab (PR #5) and consent card (PR #6); the active-
 * tools chip row (1.4.0) and profile picker (2.0) follow.
 *
 * @since 1.3.0 (Memory PR #8)
 * @module chat/memory-chip
 */

import { State, EventBus } from '../core.js';
import { mountPreact } from '../utils/preact-mount.js';
import {
    list,
    getOrCreateUserOwnerId,
    MEMORY_EVENTS,
} from '../intelligence/memory/index.js';
import { filterMemories } from './memory-chip/match.js';

const ROOT_ID = 'memoryChipRoot';
const RESULT_LIMIT = 8;

/**
 * @typedef {Object} ChipState
 * @property {boolean}                visible
 * @property {string}                 query
 * @property {Array<object>}          results
 * @property {number}                 selectedIndex
 * @property {((rec: object) => void)|null}  onSelect
 * @property {(() => void)|null}              onClose
 */

/** @type {ChipState} */
const _state = {
    visible: false,
    query: '',
    results: [],
    selectedIndex: 0,
    onSelect: null,
    onClose: null,
};

/** @type {Array<object>} */
let _allMemories = [];

/** @type {Set<(s: ChipState) => void>} */
const _listeners = new Set();

/** @type {(() => void) | null} */
let _memEventOff = null;

/** @type {(() => void) | null} */
let _cleanup = null;

let _mounting = false;

/* -------------------------------------------------------------------------- */
/* Pub-sub for the Preact tree                                                */
/* -------------------------------------------------------------------------- */

/** @returns {ChipState} */
export function _getChipState() {
    return _state;
}

/**
 * Subscribe to controller-state updates. Returns an unsubscribe fn.
 * Notifications fire on every state change (visible toggle, query
 * update, navigation, results refresh).
 *
 * @param {(s: ChipState) => void} fn
 * @returns {() => void}
 */
export function _subscribeChip(fn) {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
}

function _notify() {
    for (const fn of Array.from(_listeners)) {
        try { fn(_state); } catch (e) { console.warn('[memory-chip] listener error:', e); }
    }
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

function _currentWorkspaceId() {
    const p = State && State.currentProject;
    if (!p || !p.connectionId || !p.owner || !p.repo) return null;
    return `${p.connectionId}/${p.owner}/${p.repo}`;
}

async function _loadAll() {
    try {
        const userOwner = getOrCreateUserOwnerId();
        const wsId = _currentWorkspaceId();
        const calls = [list({ scope: 'user', owner_id_or_workspace_id: userOwner })];
        if (wsId) calls.push(list({ scope: 'workspace', owner_id_or_workspace_id: wsId }));
        const lists = await Promise.all(calls);
        _allMemories = ([]).concat(...lists);
    } catch (e) {
        console.warn('[memory-chip] memory load failed:', e);
        _allMemories = [];
    }
    _refilter();
}

function _refilter() {
    _state.results = filterMemories(_allMemories, _state.query, RESULT_LIMIT);
    if (_state.selectedIndex >= _state.results.length) _state.selectedIndex = 0;
    _notify();
}

function _attachMemoryEvents() {
    if (_memEventOff) return;
    const offs = [
        EventBus.on(MEMORY_EVENTS.CREATED, () => { _loadAll(); }),
        EventBus.on(MEMORY_EVENTS.UPDATED, () => { _loadAll(); }),
        EventBus.on(MEMORY_EVENTS.DELETED, () => { _loadAll(); }),
    ];
    _memEventOff = () => {
        for (const off of offs) {
            try { off(); } catch { /* swallow */ }
        }
    };
}

function _detachMemoryEvents() {
    if (!_memEventOff) return;
    try { _memEventOff(); } catch { /* swallow */ }
    _memEventOff = null;
}

/* -------------------------------------------------------------------------- */
/* Public controller surface                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Open the chip. Idempotent — if already visible, just refreshes the
 * `onSelect` / `onClose` callbacks. The textarea keeps focus; the
 * caller drives queries and navigation through the controller fns
 * below.
 *
 * @param {{ onSelect?: (rec: object) => void, onClose?: () => void }} [opts]
 * @returns {Promise<void>}
 */
export async function showChip(opts = {}) {
    const { onSelect, onClose } = opts;
    if (_mounting) return;
    if (_state.visible) {
        if (onSelect) _state.onSelect = onSelect;
        if (onClose) _state.onClose = onClose;
        return;
    }
    const root = (typeof document !== 'undefined') ? document.getElementById(ROOT_ID) : null;
    if (!root) {
        console.warn(`[memory-chip] mount target #${ROOT_ID} not found`);
        return;
    }
    _state.visible = true;
    _state.onSelect = onSelect || null;
    _state.onClose = onClose || null;
    _state.query = '';
    _state.selectedIndex = 0;
    _attachMemoryEvents();
    _mounting = true;
    try {
        await _loadAll();
        const { MemoryChip } = await import('./memory-chip/MemoryChip.js');
        _cleanup = await mountPreact(root, MemoryChip, {});
    } catch (err) {
        console.error('[memory-chip] mount failed:', err);
        if (root) root.innerHTML = '';
        _state.visible = false;
        _detachMemoryEvents();
        _notify();
    } finally {
        _mounting = false;
    }
}

/**
 * Close the chip and run any registered `onClose` callback. Safe to
 * call when nothing is mounted (no-op).
 *
 * @returns {void}
 */
export function hideChip() {
    if (!_state.visible && !_cleanup) return;
    const onClose = _state.onClose;
    _state.visible = false;
    _state.query = '';
    _state.results = [];
    _state.selectedIndex = 0;
    _state.onSelect = null;
    _state.onClose = null;
    _detachMemoryEvents();
    if (_cleanup) {
        try { _cleanup(); } catch (e) { console.warn('[memory-chip] unmount error:', e); }
        _cleanup = null;
    }
    _notify();
    if (typeof onClose === 'function') {
        try { onClose(); } catch (e) { console.warn('[memory-chip] onClose error:', e); }
    }
}

/**
 * Update the picker filter. Re-runs `filterMemories` against the
 * already-loaded memory set; resets the selected row to 0.
 *
 * @param {string} q
 * @returns {void}
 */
export function setChipQuery(q) {
    if (!_state.visible) return;
    _state.query = typeof q === 'string' ? q : '';
    _state.selectedIndex = 0;
    _refilter();
}

/**
 * Move the selection. Wraps both edges so ↑ at the first row jumps to
 * the last and ↓ at the last jumps back to the first.
 *
 * @param {"up"|"down"} direction
 * @returns {void}
 */
export function navigateChip(direction) {
    if (!_state.visible || _state.results.length === 0) return;
    const n = _state.results.length;
    const d = direction === 'up' ? -1 : 1;
    _state.selectedIndex = ((_state.selectedIndex + d) % n + n) % n;
    _notify();
}

/**
 * Resolve the currently-highlighted row: invoke the registered
 * `onSelect` callback with the record, then close the chip. Returns
 * the resolved record (or `null` if no row is highlighted / chip is
 * closed).
 *
 * @returns {object | null}
 */
export function selectChipActive() {
    if (!_state.visible) return null;
    const r = _state.results[_state.selectedIndex];
    if (!r) return null;
    const onSelect = _state.onSelect;
    hideChip();
    if (typeof onSelect === 'function') {
        try { onSelect(r); } catch (e) { console.warn('[memory-chip] onSelect error:', e); }
    }
    return r;
}

/** @returns {boolean} */
export function isChipVisible() {
    return _state.visible;
}

/* -------------------------------------------------------------------------- */
/* Test seams                                                                 */
/* -------------------------------------------------------------------------- */

/** Drop every controller mutation. Tests call this in beforeEach. */
export function _resetForTests() {
    _detachMemoryEvents();
    _allMemories = [];
    _state.visible = false;
    _state.query = '';
    _state.results = [];
    _state.selectedIndex = 0;
    _state.onSelect = null;
    _state.onClose = null;
    _listeners.clear();
    _cleanup = null;
    _mounting = false;
}

/**
 * Skip the `_loadAll` round-trip and seed the controller's memory
 * list directly. Does NOT trigger a refilter — the test exercises the
 * public surface (`setChipQuery`, etc.) and asserts on the resulting
 * state. This way the seam can prove that `setChipQuery` is a no-op
 * when the chip is invisible.
 *
 * @param {Array<object>} rows
 * @returns {void}
 */
export function _setMemoriesForTests(rows) {
    _allMemories = Array.isArray(rows) ? rows.slice() : [];
}

/**
 * Force the controller into "visible" without mounting Preact. Used by
 * the controller test so assertions can call `setChipQuery` / `navigate`
 * without standing up a DOM. Pass `true` to switch on, `false` to clear.
 *
 * @param {boolean} v
 * @returns {void}
 */
export function _setVisibleForTests(v) {
    _state.visible = !!v;
    if (!_state.visible) {
        _state.results = [];
        _state.query = '';
        _state.selectedIndex = 0;
    }
    _notify();
}
