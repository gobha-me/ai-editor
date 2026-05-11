/**
 * Plugin Modal — generic container for plugin-contributed modals.
 *
 * Phase 2b of the inline-handlers migration (DESIGN-html-inline-handlers-migration.md).
 * Extracted from js/app.js — the open/close helpers + mountPluginModal owner.
 *
 * Plugins register modal definitions via `Plugins.registerModal({id, title, render})`;
 * `openPluginModal(id)` looks up the definition, renders its body into
 * `#pluginModalBody`, sets the title, and activates the overlay.
 */

import { Plugins } from './core.js';

export function openPluginModal(modalId) {
    const overlay = document.getElementById('pluginModal');
    const def = Plugins.getModal(modalId);
    if (!overlay || !def) return;

    document.getElementById('pluginModalTitle').textContent = def.title || 'Plugin';
    const content = document.getElementById('pluginModalContent');
    if (def.width && content) {
        content.style.maxWidth = def.width;
    }

    const body = document.getElementById('pluginModalBody');
    body.innerHTML = '';

    if (def.render) {
        const result = def.render(body);
        if (typeof result === 'string') body.innerHTML = result;
    }

    overlay.classList.add('active');
}

export function closePluginModal() {
    const overlay = document.getElementById('pluginModal');
    if (overlay) overlay.classList.remove('active');
}

/**
 * Bind a delegated click handler for the plugin modal's close button.
 * Idempotent — safe to call from `init()` multiple times.
 *
 * Replicates the Phase 1 `mountCommitModal` (js/ui/commit.js:116) shape.
 */
let _wired = false;
export function mountPluginModal({ onClose } = {}) {
    if (_wired) return;
    _wired = true;

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        if (!btn.closest('#pluginModal')) return;
        const action = btn.getAttribute('data-action');
        if (action === 'closePluginModal' && typeof onClose === 'function') {
            onClose();
        }
    });
}
