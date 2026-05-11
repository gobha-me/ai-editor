/**
 * SlotManager — declarative UI extension renderer.
 *
 * Contract: docs/DESIGN-git-providers-and-ui-extensions.md §4 (lines 193-633).
 * Six named slots; per-contribution try/catch; sort by (priority ?? 50)
 * ascending with insertion-stable ties; schema version `'1.1'` is the only
 * value the v1 renderer accepts. Plugin/provider contributions return either
 * an HTMLElement (mounted via appendChild — safe) or a string (mounted via
 * insertAdjacentHTML — plugin is responsible for sanitizing).
 *
 * `applyProviderContributions()` consumes GitProviderRegistry.getAllContributions()
 * and registers each panel. The slot's `contribution kind` (flat vs structured)
 * determines what shape is acceptable; entries missing the required shape are
 * silently skipped (forward-compat) — every git provider today declares panel
 * metadata without renderers, and the rails ship before that migration.
 *
 * Slot kinds (per §4 "Slot catalog" Contribution-kind column):
 *
 *   - **Flat** (`sidebar-panels`, `settings-connections`, `editor-toolbar`,
 *     `chat-input-row`, `status-bar`): contribution carries `render` (or a
 *     static string/HTMLElement). SlotManager mounts into the matching
 *     `<div data-slot="...">` element on `renderSlot`. `render()` is invoked
 *     zero-arg.
 *
 *   - **Structured** (`rail-views`, 2026-05-11 Rail v2 reconciliation): the
 *     slot's owning renderer is the consumer — Rail v2 reads contributions
 *     via `getContributions('rail-views')` and renders them itself.
 *     SlotManager validates the structured shape (`view: {id, label, icon,
 *     badge?, priority?}` + `render(container)`) at `contribute` time,
 *     enforces `view.id` collision-skip, sorts by `view.priority ?? 50`,
 *     and emits `EventBus.emit('slot:rail-views:changed')` so the consumer
 *     can re-render. SlotManager does NOT touch the DOM for structured
 *     slots — the consumer owns the mount path.
 */
import { EventBus } from './core.js';
import { GitProviderRegistry } from './git-providers/registry.js';

const KNOWN_SLOTS = new Set([
    'sidebar-panels',
    'settings-connections',
    'editor-toolbar',
    'chat-input-row',
    'status-bar',
    'rail-views',
]);

/**
 * Structured slots delegate rendering to an owning consumer that reads
 * contributions via `getContributions()` and listens for `slot:<id>:changed`.
 * The contract per slot is checked by `_validateStructuredContribution`.
 */
const STRUCTURED_SLOTS = new Set(['rail-views']);

const KNOWN_VERSIONS = new Set(['1.1']);

/**
 * Validate a contribution against the structured slot's shape contract.
 * Returns null on success, or a string reason on failure.
 *
 * @param {string} slotId
 * @param {object} contribution
 * @returns {string|null}
 */
function _validateStructuredContribution(slotId, contribution) {
    if (slotId === 'rail-views') {
        const v = contribution?.view;
        if (!v || typeof v !== 'object') return 'missing view shape';
        if (typeof v.id !== 'string' || v.id.length === 0) return 'view.id must be a non-empty string';
        if (typeof v.label !== 'string' || v.label.length === 0) return 'view.label must be a non-empty string';
        if (typeof v.icon !== 'string') return 'view.icon must be a string (inline SVG)';
        if (v.badge != null && typeof v.badge !== 'function') return 'view.badge must be a function or omitted';
        if (v.priority != null && typeof v.priority !== 'number') return 'view.priority must be a number or omitted';
        if (v.headerActions != null) {
            if (!Array.isArray(v.headerActions)) return 'view.headerActions must be an array or omitted';
            for (let i = 0; i < v.headerActions.length; i++) {
                const a = v.headerActions[i];
                if (!a || typeof a !== 'object') return `view.headerActions[${i}] must be an object`;
                if (typeof a.id !== 'string' || a.id.length === 0) return `view.headerActions[${i}].id must be a non-empty string`;
                if (typeof a.icon !== 'string') return `view.headerActions[${i}].icon must be a string`;
                if (typeof a.onClick !== 'function') return `view.headerActions[${i}].onClick must be a function`;
            }
        }
        if (typeof contribution.render !== 'function') return 'render(container) must be a function for structured slots';
        return null;
    }
    return null;
}

/**
 * Pull the priority off a contribution. Structured contributions read
 * `view.priority`; flat ones read top-level `priority`. Defaults to 50.
 *
 * @param {object} c
 * @returns {number}
 */
function _priorityOf(c) {
    if (c?.view && typeof c.view.priority === 'number') return c.view.priority;
    if (typeof c?.priority === 'number') return c.priority;
    return 50;
}

export const SlotManager = {
    _contributions: new Map(),
    _subscriptions: new Map(),

    contribute(slotId, contribution) {
        if (!KNOWN_SLOTS.has(slotId)) {
            console.warn('[SlotManager] unknown slot', { slotId, pluginId: contribution?.pluginId });
            return;
        }
        const version = contribution?.version ?? '1.1';
        if (!KNOWN_VERSIONS.has(version)) {
            console.warn('[SlotManager] unrecognized version', {
                slotId,
                pluginId: contribution?.pluginId,
                version,
            });
            return;
        }

        // Structured slots: validate shape, enforce view.id collision-skip.
        if (STRUCTURED_SLOTS.has(slotId)) {
            const reason = _validateStructuredContribution(slotId, contribution);
            if (reason) {
                console.warn('[SlotManager] invalid structured contribution', {
                    slotId,
                    pluginId: contribution?.pluginId,
                    reason,
                });
                return;
            }
            if (slotId === 'rail-views' && this.hasViewId(contribution.view.id)) {
                console.warn('[SlotManager] rail-views id collision', {
                    viewId: contribution.view.id,
                    pluginId: contribution.pluginId,
                });
                return;
            }
        }

        if (!this._contributions.has(slotId)) {
            this._contributions.set(slotId, []);
        }
        const entry = {
            pluginId: contribution.pluginId,
            render: contribution.render,
            priority: contribution.priority,
            view: contribution.view,
            version,
            refreshEvent: contribution.refreshEvent,
        };
        this._contributions.get(slotId).push(entry);
        this._contributions.get(slotId).sort((a, b) => _priorityOf(a) - _priorityOf(b));

        if (entry.refreshEvent) {
            const unsub = EventBus.on(entry.refreshEvent, () => this.renderSlot(slotId));
            if (!this._subscriptions.has(entry.pluginId)) {
                this._subscriptions.set(entry.pluginId, []);
            }
            this._subscriptions.get(entry.pluginId).push(unsub);
        }

        this.renderSlot(slotId);
    },

    renderSlot(slotId) {
        // Structured slots: owner consumer handles rendering — notify and bail.
        if (STRUCTURED_SLOTS.has(slotId)) {
            EventBus.emit(`slot:${slotId}:changed`);
            return;
        }

        const container = document.querySelector(`[data-slot="${slotId}"]`);
        if (!container) return;
        container.innerHTML = '';
        const entries = this._contributions.get(slotId) || [];
        for (const c of entries) {
            if (c.render == null) continue;
            try {
                const el = typeof c.render === 'function' ? c.render() : c.render;
                if (el == null) continue;
                if (typeof el === 'string') {
                    container.insertAdjacentHTML('beforeend', el);
                } else if (typeof HTMLElement !== 'undefined' && el instanceof HTMLElement) {
                    container.appendChild(el);
                }
            } catch (error) {
                console.error('[SlotManager] render failed', {
                    pluginId: c.pluginId,
                    slotId,
                    error,
                });
            }
        }
    },

    renderAll() {
        for (const slotId of this._contributions.keys()) {
            this.renderSlot(slotId);
        }
    },

    removeByPlugin(pluginId) {
        const unsubs = this._subscriptions.get(pluginId);
        if (unsubs) {
            for (const off of unsubs) {
                try { off(); } catch (e) { /* listener already detached */ }
            }
            this._subscriptions.delete(pluginId);
        }
        for (const [slotId, contribs] of this._contributions) {
            this._contributions.set(
                slotId,
                contribs.filter(c => c.pluginId !== pluginId)
            );
            this.renderSlot(slotId);
        }
    },

    /**
     * Return the (priority-sorted) contributions for a slot. Consumers of
     * structured slots use this to read their data. Returns a shallow copy
     * so callers can iterate without mutating the internal store.
     *
     * @param {string} slotId
     * @returns {Array}
     */
    getContributions(slotId) {
        const entries = this._contributions.get(slotId) || [];
        return entries.slice();
    },

    /**
     * Has any `rail-views` contribution already claimed this view.id?
     * Built-in rail views can call this before contributing to opt out
     * when a provider has already taken the same id. Pairs with the
     * automatic collision-skip in `contribute`.
     *
     * @param {string} viewId
     * @returns {boolean}
     */
    hasViewId(viewId) {
        const entries = this._contributions.get('rail-views') || [];
        return entries.some(c => c.view?.id === viewId);
    },
};

export function applyProviderContributions() {
    const { panels } = GitProviderRegistry.getAllContributions();
    for (const p of panels) {
        // Flat-slot entries need a `render`. Structured-slot entries are
        // validated inside contribute() — pass them through so the warning
        // (if invalid) surfaces consistently.
        const slot = p.slot;
        const isStructured = STRUCTURED_SLOTS.has(slot);
        if (!isStructured && p.render == null) continue;
        SlotManager.contribute(slot, {
            pluginId: p.providerId,
            render: p.render,
            priority: p.priority,
            view: p.view,
            version: p.version,
            refreshEvent: p.refreshEvent,
        });
    }
}
