/**
 * AI Editor - Template Loader
 * Loads HTML templates from separate files to keep index.html thin
 */

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
        const response = await fetch(`html/${name}.html`);
        
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
        'modals'
    ]);
    
    // Build the main layout structure
    const html = `
        ${templates.get('header')}
        <main class="main-content">
            ${templates.get('sidebar')}
            <div class="resize-handle resize-handle-sidebar" id="resizeHandleSidebar" title="Drag to resize sidebar"></div>
            ${templates.get('editor-panel')}
            <div class="resize-handle resize-handle-chat" id="resizeHandleChat" title="Drag to resize chat"></div>
            ${templates.get('chat-panel')}
        </main>
        ${templates.get('modals')}
    `;
    
    appContainer.innerHTML = html;
    console.log('Application layout loaded');
}