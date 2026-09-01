/**
 * SettingsTabActivation — per-tab activation/teardown hook registry. Tab
 * modules own their lifecycle hooks instead of a parallel central list.
 *
 * Replaces the 11-branch switch statement in `js/settings-manager.js`
 * (pre-2.44.0.2 `populateSettingsForm()` lines 462-482) that dispatched
 * `tab.dataset.tab === 'tabX'` to per-tab refresh callbacks. Each tab
 * module now self-registers its on-activate (and optionally on-close)
 * handler at module-load time; `settings-manager.js` iterates the
 * registry instead of growing the switch when a new tab adds a refresh
 * hook. Side-effect registration matches the 2.44.0.1 dom-bindings
 * shape and the long-standing `js/tools/registry.js` convention.
 *
 * The inventory entry's hypothesis about parallel "per-tab persistence
 * columns" in `js/settings/persistence.js` proved inaccurate — that
 * file is one monolithic `collectAndSave()` reading DOM fields by id,
 * not a per-tab column table. The actual parallel-enumeration locus
 * was intra-file in `settings-manager.js`; this slice resolves that
 * locus and documents the persistence-side scope deferral.
 */

/** @type {Map<string, () => void>} */
const _onActivate = new Map();

/** @type {Map<string, () => void>} */
const _onClose = new Map();

function _assertId(tabId) {
    if (typeof tabId !== 'string' || tabId.length === 0) {
        throw new TypeError(
            `tab-activation-registry: tabId must be a non-empty string (got ${typeof tabId})`
        );
    }
}

function _assertHandler(tabId, kind, handler) {
    if (typeof handler !== 'function') {
        throw new TypeError(
            `tab-activation-registry: ${kind} handler for "${tabId}" is not a function`
        );
    }
}

/**
 * Register a handler that runs each time the user clicks the tab whose
 * `data-tab` attribute equals `tabId`. Throws on duplicate `tabId`
 * registration — mirrors the 2.44.0.1 `dom-bindings` idempotency guard.
 *
 * @param {string} tabId  DOM id of the `.settings-tab-content` element
 *                        (e.g. `'tabEmbeddings'`, `'tabCost'`).
 * @param {() => void} handler
 */
export function registerOnActivate(tabId, handler) {
    _assertId(tabId);
    _assertHandler(tabId, 'onActivate', handler);
    if (_onActivate.has(tabId)) {
        throw new Error(
            `tab-activation-registry: onActivate already registered for "${tabId}"`
        );
    }
    _onActivate.set(tabId, handler);
}

/**
 * Register a handler that runs when the settings modal closes. Used by
 * tabs that hold long-lived UI state (e.g. the Memory tab's Preact root)
 * which must be torn down to release subscriptions.
 *
 * @param {string} tabId
 * @param {() => void} handler
 */
export function registerOnClose(tabId, handler) {
    _assertId(tabId);
    _assertHandler(tabId, 'onClose', handler);
    if (_onClose.has(tabId)) {
        throw new Error(
            `tab-activation-registry: onClose already registered for "${tabId}"`
        );
    }
    _onClose.set(tabId, handler);
}

/**
 * Fire the on-activate handler for `tabId`, if one is registered.
 * No-op for tabs that didn't register a handler (most tabs don't need
 * per-activation work — they're populated once during the initial
 * `populateSettingsForm()` pass).
 *
 * @param {string} tabId
 */
export function dispatchOnActivate(tabId) {
    const handler = _onActivate.get(tabId);
    if (!handler) return;
    try { handler(); } catch (err) {
        console.warn(`[settings/tab-activation] onActivate("${tabId}") threw:`, err);
    }
}

/**
 * Fire every registered on-close handler. Wraps each in a try/catch so
 * one tab's teardown failure doesn't strand the modal in an open state.
 */
export function dispatchAllOnClose() {
    for (const [tabId, handler] of _onClose) {
        try { handler(); } catch (err) {
            console.warn(`[settings/tab-activation] onClose("${tabId}") threw:`, err);
        }
    }
}

/** Diagnostic: ids of tabs that registered an on-activate handler. */
export function listActivationTabs() {
    return Array.from(_onActivate.keys());
}

/** Diagnostic: ids of tabs that registered an on-close handler. */
export function listCloseTabs() {
    return Array.from(_onClose.keys());
}

/** Test-only reset — used by `tests/test-settings-tab-activation.mjs`. */
export function _resetForTests() {
    _onActivate.clear();
    _onClose.clear();
}
