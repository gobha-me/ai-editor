/**
 * SlotManager — declarative UI extension renderer.
 *
 * Contract: docs/DESIGN-git-providers-and-ui-extensions.md §4 (lines 193-412).
 * Five named slots; per-contribution try/catch; sort by (priority ?? 50)
 * ascending with insertion-stable ties; schema version `'1.1'` is the only
 * value the v1 renderer accepts. Plugin/provider contributions return either
 * an HTMLElement (mounted via appendChild — safe) or a string (mounted via
 * insertAdjacentHTML — plugin is responsible for sanitizing).
 *
 * `applyProviderContributions()` consumes GitProviderRegistry.getAllContributions()
 * and registers each panel that carries a `render` function. Entries without
 * a render are silently skipped — every git provider today declares panel
 * metadata without renderers, and the rails ship before that migration.
 */
import { EventBus } from './core.js';
import { GitProviderRegistry } from './git-providers/registry.js';

const KNOWN_SLOTS = new Set([
    'sidebar-panels',
    'settings-connections',
    'editor-toolbar',
    'chat-input-row',
    'status-bar',
]);

const KNOWN_VERSIONS = new Set(['1.1']);

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

        if (!this._contributions.has(slotId)) {
            this._contributions.set(slotId, []);
        }
        const entry = {
            pluginId: contribution.pluginId,
            render: contribution.render,
            priority: contribution.priority,
            version,
            refreshEvent: contribution.refreshEvent,
        };
        this._contributions.get(slotId).push(entry);
        this._contributions.get(slotId).sort((a, b) =>
            (a.priority ?? 50) - (b.priority ?? 50)
        );

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
};

export function applyProviderContributions() {
    const { panels } = GitProviderRegistry.getAllContributions();
    for (const p of panels) {
        if (p.render == null) continue;
        SlotManager.contribute(p.slot, {
            pluginId: p.providerId,
            render: p.render,
            priority: p.priority,
            version: p.version,
            refreshEvent: p.refreshEvent,
        });
    }
}
