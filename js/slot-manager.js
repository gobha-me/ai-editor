/**
 * AI Editor - Slot Manager
 * 
 * Declarative UI extension system. Core layout defines named slots via
 * `data-slot="name"` attributes. Plugins and providers register contributions
 * that render into those slots.
 * 
 * Design principle: LLM-friendly. An LLM can read a contribution manifest
 * and understand what it does without tracing DOM manipulation or event wiring.
 * 
 * Usage:
 *   // In HTML template:
 *   <div data-slot="sidebar-panels"></div>
 * 
 *   // In provider/plugin manifest:
 *   contributes: {
 *     panels: [{
 *       id: 'my-panel',
 *       slot: 'sidebar-panels',
 *       title: 'My Panel',
 *       render: (state) => '<div>...</div>',
 *       priority: 10
 *     }]
 *   }
 * 
 *   // Registration:
 *   SlotManager.contribute('sidebar-panels', {
 *     pluginId: 'gitea',
 *     id: 'gitea-issues',
 *     priority: 10,
 *     render: () => renderIssuesPanel()
 *   });
 */

import { EventBus } from './core.js';

const SlotManager = {
    /** @type {Map<string, Array<{pluginId: string, id: string, priority: number, render: Function|string}>>} */
    _contributions: new Map(),

    /** @type {Set<string>} Known slot names for validation */
    _knownSlots: new Set(),

    // ========================================
    // SLOT DECLARATION
    // ========================================

    /**
     * Declare a known slot. Called by core during layout initialization.
     * Slots can also be auto-discovered from DOM.
     */
    declareSlot(slotId) {
        this._knownSlots.add(slotId);
        if (!this._contributions.has(slotId)) {
            this._contributions.set(slotId, []);
        }
    },

    /**
     * Auto-discover slots from the current DOM.
     * Call after template injection.
     */
    discoverSlots() {
        const elements = document.querySelectorAll('[data-slot]');
        elements.forEach(el => {
            this.declareSlot(el.dataset.slot);
        });
        console.log(`[SlotManager] Discovered ${elements.length} slot(s):`,
            Array.from(this._knownSlots));
    },

    // ========================================
    // CONTRIBUTIONS
    // ========================================

    /**
     * Register a UI contribution for a slot.
     * 
     * @param {string} slotId - Target slot name
     * @param {Object} contribution
     * @param {string} contribution.pluginId - Owning plugin/provider ID
     * @param {string} contribution.id - Unique contribution ID
     * @param {number} [contribution.priority=50] - Sort order (lower = first)
     * @param {Function|string} contribution.render - Returns HTML string or HTMLElement
     * @param {Object} [contribution.config] - Additional config (collapsible, title, icon, etc.)
     */
    contribute(slotId, contribution) {
        if (!this._contributions.has(slotId)) {
            this._contributions.set(slotId, []);
        }

        // Remove existing contribution with same id (re-registration)
        const list = this._contributions.get(slotId);
        const existing = list.findIndex(c => c.id === contribution.id);
        if (existing !== -1) {
            list.splice(existing, 1);
        }

        list.push({
            priority: 50,
            ...contribution
        });

        // Sort by priority
        list.sort((a, b) => a.priority - b.priority);

        // Re-render the slot if it exists in DOM
        this.renderSlot(slotId);

        console.log(`[SlotManager] ✅ ${contribution.pluginId}/${contribution.id} → ${slotId}`);
    },

    /**
     * Register multiple contributions from a provider's contributes manifest.
     * Convenience wrapper for providers that declare panels in their manifest.
     * 
     * @param {string} pluginId - Provider/plugin ID
     * @param {Object} contributes - The contributes object from manifest
     */
    registerContributions(pluginId, contributes) {
        if (!contributes) return;

        // Register panel contributions
        if (contributes.panels) {
            for (const panel of contributes.panels) {
                this.contribute(panel.slot || 'sidebar-panels', {
                    pluginId,
                    id: panel.id,
                    priority: panel.priority || 50,
                    render: panel.render || null,
                    config: {
                        title: panel.title,
                        icon: panel.icon,
                        collapsible: panel.collapsible !== false,
                        refreshEvent: panel.refreshEvent
                    }
                });
            }
        }

        // Settings contributions go into settings slot
        if (contributes.settings) {
            for (const setting of contributes.settings) {
                this.contribute('settings-provider-fields', {
                    pluginId,
                    id: `${pluginId}-setting-${setting.id}`,
                    priority: setting.priority || 50,
                    config: setting
                });
            }
        }
    },

    // ========================================
    // RENDERING
    // ========================================

    /**
     * Render all contributions into a slot's DOM element.
     */
    renderSlot(slotId) {
        const container = document.querySelector(`[data-slot="${slotId}"]`);
        if (!container) return;

        const contributions = this._contributions.get(slotId) || [];
        container.innerHTML = '';

        for (const c of contributions) {
            let el;

            if (typeof c.render === 'function') {
                el = c.render(c.config);
            } else if (typeof c.render === 'string') {
                el = c.render;
            } else if (c.config) {
                // Auto-generate a collapsible panel from config
                el = this._renderPanel(c);
            }

            if (!el) continue;

            if (typeof el === 'string') {
                container.insertAdjacentHTML('beforeend', el);
            } else if (el instanceof HTMLElement) {
                container.appendChild(el);
            }
        }
    },

    /**
     * Re-render all known slots.
     */
    renderAll() {
        for (const slotId of this._contributions.keys()) {
            this.renderSlot(slotId);
        }
    },

    /**
     * Remove all contributions from a specific plugin/provider.
     */
    removeByPlugin(pluginId) {
        for (const [slotId, contribs] of this._contributions) {
            this._contributions.set(slotId,
                contribs.filter(c => c.pluginId !== pluginId)
            );
            this.renderSlot(slotId);
        }
    },

    // ========================================
    // HELPERS
    // ========================================

    /**
     * Auto-generate a collapsible sidebar panel from config.
     * Used when a contribution has config but no custom render function.
     */
    _renderPanel(contribution) {
        const { config, id } = contribution;
        if (!config || !config.title) return null;

        const bodyId = `${id}-body`;
        return `
            <div class="sidebar-section sidebar-section-bottom" data-contribution="${id}">
                <div class="sidebar-header sidebar-header-collapsible" data-collapse="${bodyId}">
                    <span>▾ ${config.icon || ''} ${config.title}</span>
                    ${config.refreshEvent ? `
                        <button title="Refresh" onclick="event.stopPropagation(); 
                            document.dispatchEvent(new CustomEvent('slot:refresh', { detail: '${config.refreshEvent}' }))">
                            🔄
                        </button>
                    ` : ''}
                </div>
                <div class="sidebar-collapse-body" id="${bodyId}">
                    <div id="${id}-content" style="padding: 0.75rem; color: var(--text-muted); font-size: 12px;">
                        Loading...
                    </div>
                </div>
            </div>
        `;
    },

    /**
     * Get statistics about registered slots and contributions.
     */
    getStats() {
        const stats = { slots: this._knownSlots.size, contributions: {} };
        for (const [slot, contribs] of this._contributions) {
            stats.contributions[slot] = contribs.map(c => ({
                id: c.id,
                plugin: c.pluginId,
                priority: c.priority
            }));
        }
        return stats;
    }
};

// Wire up refresh events from slot panels
document.addEventListener('slot:refresh', (e) => {
    EventBus.emit(e.detail);
});

export { SlotManager };
