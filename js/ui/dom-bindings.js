/**
 * DomBindings — DOM event-listener registry that survives post-init DOM
 * mutations. 2.44.0.1 (2026-Q2 audit sweep entry [ST][M] at
 * `docs/audit-2026-Q2/inventory.md` §app-boot — `safeAdd pattern + bareword
 * global reference fragility in setupEventListeners`).
 *
 * Replaces the pre-2.44.0.1 closure-local `safeAdd(id, event, handler)`
 * helper in `js/app.js#setupEventListeners` (~31 wirings that silently
 * dropped any button absent from the boot-time DOM, with a warn-and-skip
 * — the 2.23.0 rail migration tripped this exact failure mode). Mirrors
 * the 2.36.0 `HotkeyRegistry` / `bindHotkey` pattern: a closure-local
 * helper graduates to a module with a registry, keeps a 1:1 API shape,
 * and gains an idempotency guard plus a slot-aware re-wire path.
 *
 * Load-bearing for plugin-mounted buttons. Any contribution-driven
 * element mounted into a SlotManager slot AFTER `init()` runs is invisible
 * to the boot-time `getElementById` lookup; `rewireUnboundElements()`
 * re-walks the unbound entries on `slot:rail-views:changed` and attaches
 * the deferred listeners when the element materializes.
 *
 * Shape:
 *   id        DOM element id (string; matched via document.getElementById)
 *   event     listener event name ('click', 'change', 'keydown', ...)
 *   handler   the listener function
 *   wired     true once addEventListener has fired for this entry; the
 *             rewire pass walks entries where wired === false
 */

/** @typedef {{
 *   id: string,
 *   event: string,
 *   handler: (e?: Event) => void,
 *   wired: boolean
 * }} DomBinding */

/** @type {DomBinding[]} */
const _bindings = [];

/** Internal: record + attempt immediate attach. Throws on duplicate
 *  `(id, event)` registration — same-id guard mirrors `bindHotkey`. */
function _register(id, event, handler) {
    if (typeof id !== 'string' || id.length === 0) {
        throw new TypeError(`dom-bindings: id must be a non-empty string (got ${typeof id})`);
    }
    if (typeof event !== 'string' || event.length === 0) {
        throw new TypeError(`dom-bindings: event must be a non-empty string (got ${typeof event})`);
    }
    if (typeof handler !== 'function') {
        throw new TypeError(`dom-bindings: handler for "${id}" (${event}) is not a function`);
    }
    if (_bindings.some(b => b.id === id && b.event === event)) {
        throw new Error(`dom-bindings: (${id}, ${event}) already bound`);
    }
    const entry = { id, event, handler, wired: false };
    _bindings.push(entry);
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener(event, handler);
        entry.wired = true;
    }
}

/**
 * Register a click listener for a DOM element by id. 1:1 replacement for
 * the pre-2.44.0.1 `safeAdd(id, 'click', handler)` helper in `js/app.js`.
 * If the element isn't in the boot-time DOM, the binding is recorded with
 * `wired: false` and the listener attaches when `rewireUnboundElements()`
 * runs next (typically on `slot:rail-views:changed`).
 *
 * @param {string} id
 * @param {(e?: Event) => void} handler
 */
export function bindClick(id, handler) {
    _register(id, 'click', handler);
}

/**
 * Register a listener for any DOM event by id. General form used for the
 * `'change'` and `'keydown'` cases that the click-specialized helper
 * doesn't cover.
 *
 * @param {string} id
 * @param {string} event
 * @param {(e?: Event) => void} handler
 */
export function bindEvent(id, event, handler) {
    _register(id, event, handler);
}

/**
 * Walk the unbound entries (`wired === false`), retry `getElementById`,
 * and attach the listener when the element is present. Idempotent: a
 * binding that's already wired is left alone. Safe to call on every
 * `slot:rail-views:changed` emission.
 */
export function rewireUnboundElements() {
    for (const b of _bindings) {
        if (b.wired) continue;
        const el = document.getElementById(b.id);
        if (!el) continue;
        el.addEventListener(b.event, b.handler);
        b.wired = true;
    }
}

/**
 * Diagnostic: returns the ids of bindings still awaiting their DOM
 * element. Empty array means every registered binding is attached.
 *
 * @returns {string[]}
 */
export function listUnboundIds() {
    return _bindings.filter(b => !b.wired).map(b => b.id);
}

/**
 * Snapshot of the registered bindings, in registration order. Mutation
 * of the return value does not affect the registry.
 *
 * @returns {DomBinding[]}
 */
export function listBindings() {
    return _bindings.slice();
}

/** Test-only access to the internal store — mirrors `SlotManager._contributions`. */
export const _bindings_for_tests = _bindings;

/**
 * Test-only reset. Not for production use — would defeat the one-shot
 * registration contract.
 */
export function _resetForTests() {
    _bindings.length = 0;
}
