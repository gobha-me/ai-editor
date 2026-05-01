/**
 * Plugin Loader
 * 
 * Dynamic plugin installation from URLs.
 * 
 * External plugins use window.AIEditor instead of ES module imports:
 *   const { Plugins, EventBus, State } = window.AIEditor;
 *   Plugins.register({ id: 'my-plugin', name: 'My Plugin', ... });
 * 
 * Flow:
 *   1. User pastes URL in Settings → Plugins → Install
 *   2. fetch(url) → blob URL → dynamic import()
 *   3. Verify Plugins.register() was called
 *   4. Save URL to Storage for reload persistence
 *   5. Init the plugin
 */

import { Plugins, Storage, EventBus } from './core.js';

/** Storage key for installed external plugin list */
const STORAGE_KEY = 'installedPlugins';

/**
 * @typedef {Object} InstalledPlugin
 * @property {string} url       - Source URL
 * @property {string} pluginId  - Registered plugin ID
 * @property {string} name      - Human-readable name
 * @property {string} installedAt - ISO timestamp
 * @property {string} [error]   - Last load error if any
 */

/**
 * Get the list of installed external plugins.
 * @returns {InstalledPlugin[]}
 */
export function getInstalledPlugins() {
    return Storage.get(STORAGE_KEY) || [];
}

/**
 * Save the installed list.
 * @param {InstalledPlugin[]} list
 */
function _saveList(list) {
    Storage.set(STORAGE_KEY, list);
}

/**
 * Install a plugin from a URL.
 * Fetches the JS, loads it via blob import, verifies registration.
 *
 * Pre-install scan: rejects with `requiresConfirmation: true` if the source
 * contains invisible Unicode (glassworm / Trojan Source / zero-width).
 * Caller can re-invoke with `{ confirmedInvisibleUnicode: true }` to bypass.
 *
 * @param {string} url - URL to a .js plugin file
 * @param {{confirmedInvisibleUnicode?: boolean}} [options]
 * @returns {Promise<{success: boolean, pluginId?: string, name?: string, error?: string,
 *                   requiresConfirmation?: boolean, invisibleUnicodeFindings?: Array}>}
 */
export async function installPlugin(url, options = {}) {
    url = url.trim();
    if (!url) {
        return { success: false, error: 'URL is required' };
    }

    // Check for duplicates
    const existing = getInstalledPlugins();
    if (existing.find(p => p.url === url)) {
        return { success: false, error: 'Plugin already installed from this URL' };
    }

    // Snapshot current registrations to detect new ones
    const beforeIds = new Set(Plugins.list().map(p => p.id));

    try {
        // Fetch the plugin source
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const source = await response.text();

        // Basic validation — should reference AIEditor or Plugins.register
        if (!source.includes('Plugins') && !source.includes('AIEditor')) {
            throw new Error('File does not appear to be an AI Editor plugin');
        }

        // Invisible-Unicode scan — gate before exec on a tampered source.
        if (!options.confirmedInvisibleUnicode) {
            const { scan } = await import('./security/invisible-unicode.js');
            const findings = scan(source);
            if (findings.length > 0) {
                return {
                    success: false,
                    requiresConfirmation: true,
                    invisibleUnicodeFindings: findings,
                    error: `Source contains ${findings.length} invisible Unicode character(s) — review before installing`
                };
            }
        }

        // Load via blob URL to avoid CORS issues with import()
        const blob = new Blob([source], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);

        try {
            await import(/* webpackIgnore: true */ blobUrl);
        } finally {
            URL.revokeObjectURL(blobUrl);
        }

        // Find newly registered plugin
        const afterIds = Plugins.list().map(p => p.id);
        const newId = afterIds.find(id => !beforeIds.has(id));

        if (!newId) {
            throw new Error('Plugin loaded but did not call Plugins.register()');
        }

        // Get the manifest
        const plugin = Plugins.get(newId);
        const name = plugin?.manifest?.name || newId;

        // Init the plugin
        await Plugins.init(newId);

        // Save to storage
        existing.push({
            url,
            pluginId: newId,
            name,
            installedAt: new Date().toISOString(),
            error: null
        });
        _saveList(existing);

        EventBus.emit('plugin:installed', { url, pluginId: newId, name });
        console.log(`[plugin-loader] Installed: ${name} (${newId}) from ${url}`);

        return { success: true, pluginId: newId, name };

    } catch (err) {
        console.error(`[plugin-loader] Failed to install from ${url}:`, err);
        EventBus.emit('plugin:initError', { pluginId: url, name: url, msg: err.message });
        return { success: false, error: err.message };
    }
}

/**
 * Uninstall an external plugin by URL.
 * Removes from saved list and disables (cannot fully unregister from Plugins).
 * 
 * @param {string} url
 * @returns {{success: boolean, error?: string}}
 */
export function uninstallPlugin(url) {
    const list = getInstalledPlugins();
    const idx = list.findIndex(p => p.url === url);
    if (idx === -1) {
        return { success: false, error: 'Plugin not found' };
    }

    const entry = list[idx];

    // Disable the plugin (can't truly unregister without reload)
    if (entry.pluginId) {
        Plugins.setEnabled(entry.pluginId, false);
    }

    list.splice(idx, 1);
    _saveList(list);

    EventBus.emit('plugin:uninstalled', { url, pluginId: entry.pluginId });
    console.log(`[plugin-loader] Uninstalled: ${entry.name} — reload to fully remove`);

    return { success: true };
}

/**
 * Load all previously installed external plugins on startup.
 * Called during app init, after settings are loaded.
 * 
 * @returns {Promise<{loaded: number, failed: number}>}
 */
export async function loadInstalledPlugins() {
    const list = getInstalledPlugins();
    if (list.length === 0) return { loaded: 0, failed: 0 };

    console.log(`[plugin-loader] Loading ${list.length} installed plugin(s)...`);

    let loaded = 0;
    let failed = 0;

    for (const entry of list) {
        // Snapshot before
        const beforeIds = new Set(Plugins.list().map(p => p.id));

        try {
            const response = await fetch(entry.url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const source = await response.text();

            const blob = new Blob([source], { type: 'application/javascript' });
            const blobUrl = URL.createObjectURL(blob);
            try {
                await import(/* webpackIgnore: true */ blobUrl);
            } finally {
                URL.revokeObjectURL(blobUrl);
            }

            // Find the newly registered ID (might differ from saved if plugin changed)
            const afterIds = Plugins.list().map(p => p.id);
            const newId = afterIds.find(id => !beforeIds.has(id));
            if (newId) {
                entry.pluginId = newId;
                entry.name = Plugins.get(newId)?.manifest?.name || newId;
                await Plugins.init(newId);
            }

            entry.error = null;
            loaded++;
            console.log(`[plugin-loader] Loaded: ${entry.name} from ${entry.url}`);

        } catch (err) {
            entry.error = err.message;
            failed++;
            console.warn(`[plugin-loader] Failed to load ${entry.url}: ${err.message}`);
            EventBus.emit('plugin:initError', {
                pluginId: entry.pluginId || entry.url,
                name: entry.name || entry.url,
                msg: err.message,
            });
        }
    }

    // Persist any updated metadata / error states
    _saveList(list);

    return { loaded, failed };
}
