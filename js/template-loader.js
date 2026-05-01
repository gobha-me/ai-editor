/**
 * AI Editor - Template Loader
 * Loads HTML templates from separate files to keep index.html thin
 */

import { VERSION, APP_NAME } from './version.js';

// Cache loaded templates to avoid redundant fetches
const templateCache = new Map();

/**
 * Load a template from /html/ directory
 * @param {string} name - Template name without .html extension
 * @param {boolean} useCache - Use cached version if available (default: true)
 * @returns {Promise<string>} HTML content
 */
export async function loadTemplate(name, useCache = true) {
    // Check cache first
    if (useCache && templateCache.has(name)) {
        return templateCache.get(name);
    }

    try {
        const response = await fetch(`./html/${name}.html`);
        
        if (!response.ok) {
            throw new Error(`Failed to load template '${name}': ${response.status} ${response.statusText}`);
        }
        
        const html = await response.text();
        
        // Cache for future use
        templateCache.set(name, html);
        
        return html;
    } catch (error) {
        console.error(`Template load error for '${name}':`, error);
        throw error;
    }
}

/**
 * Load a template and inject it into a container element
 * @param {string} name - Template name
 * @param {string|HTMLElement} containerSelector - Container element or selector
 * @param {boolean} append - Append instead of replace (default: false)
 * @returns {Promise<void>}
 */
export async function injectTemplate(name, containerSelector, append = false) {
    const html = await loadTemplate(name);
    
    const container = typeof containerSelector === 'string'
        ? document.querySelector(containerSelector)
        : containerSelector;
    
    if (!container) {
        throw new Error(`Container not found: ${containerSelector}`);
    }
    
    if (append) {
        container.insertAdjacentHTML('beforeend', html);
    } else {
        container.innerHTML = html;
    }
}

/**
 * Load multiple templates in parallel
 * @param {string[]} names - Array of template names
 * @returns {Promise<Map<string, string>>} Map of name -> HTML content
 */
export async function loadTemplates(names) {
    const promises = names.map(name => 
        loadTemplate(name).then(html => [name, html])
    );
    
    const results = await Promise.all(promises);
    return new Map(results);
}

/**
 * Preload templates for better performance
 * Call this early in app initialization
 * @param {string[]} names - Template names to preload
 * @returns {Promise<void>}
 */
export async function preloadTemplates(names) {
    await loadTemplates(names);
    console.log(`Preloaded ${names.length} templates:`, names);
}

/**
 * Clear template cache (useful for development/hot-reload)
 * @param {string?} name - Specific template to clear, or null for all
 */
export function clearCache(name = null) {
    if (name) {
        templateCache.delete(name);
    } else {
        templateCache.clear();
    }
}

/**
 * Get cache statistics
 * @returns {Object} Cache info
 */
export function getCacheStats() {
    return {
        size: templateCache.size,
        templates: Array.from(templateCache.keys())
    };
}

/**
 * Build the main app layout by loading all templates
 * @returns {Promise<void>}
 */
export async function buildAppLayout() {
    console.log('Loading application templates...');
    
    const appContainer = document.getElementById('app');
    if (!appContainer) {
        throw new Error('App container #app not found');
    }
    
    // Load all templates in parallel
    const templates = await loadTemplates([
        'header',
        'sidebar',
        'editor-panel',
        'chat-panel',
        'search-panel',
        'modals',
        'debug-slideout'
    ]);
    
    // Build the main layout structure
    const html = `
        ${templates.get('header')}
        ${templates.get('search-panel')}
        <main class="main-content">
            <div class="panel-edge-tab panel-edge-tab-left" id="sidebarExpandTab" title="Show sidebar" aria-label="Expand sidebar" role="button" tabindex="0" style="display:none;">📁</div>
            ${templates.get('sidebar')}
            <div class="resize-handle resize-handle-sidebar" id="resizeHandleSidebar" title="Drag to resize sidebar" role="separator" aria-orientation="vertical" aria-label="Resize sidebar"></div>
            ${templates.get('editor-panel')}
            <div class="resize-handle resize-handle-chat" id="resizeHandleChat" title="Drag to resize chat" role="separator" aria-orientation="vertical" aria-label="Resize chat panel"></div>
            ${templates.get('chat-panel')}
            <div class="panel-edge-tab panel-edge-tab-right" id="chatExpandTab" title="Show chat" aria-label="Expand chat" role="button" tabindex="0" style="display:none;">💬</div>
        </main>
        ${templates.get('modals')}
        ${templates.get('debug-slideout')}
    `;
    
    appContainer.innerHTML = html;
    
    // Inject dynamic values after DOM is ready
    const appNameEl = document.getElementById('appName');
    const versionEl = document.getElementById('appVersion');
    const welcomeAppNameEl = document.getElementById('welcomeAppName');
    
    if (appNameEl) appNameEl.textContent = APP_NAME;
    if (versionEl) versionEl.textContent = `v${VERSION}`;
    if (welcomeAppNameEl) welcomeAppNameEl.textContent = APP_NAME;
    
    console.log('Application layout loaded');
}
