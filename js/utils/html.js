/**
 * HTML Escape Utilities
 * 
 * Single source of truth for HTML/attribute escaping.
 * Replaces duplicated escapeHtml implementations across
 * file-tree, quick-open, diff-viewer, secondary-pane,
 * project-manager, settings-manager, and chat/messages.
 * 
 * SECURITY: Every string derived from external sources (Git APIs,
 * LLM responses, file names, branch names, user input) MUST pass
 * through escapeHtml() before innerHTML assignment, or escapeAttr()
 * before insertion into HTML attribute values.
 * 
 * @module utils/html
 */

/**
 * Escape a string for safe insertion into HTML content.
 * Handles null/undefined gracefully.
 * 
 * @param {*} text - Value to escape (coerced to string)
 * @returns {string} HTML-safe string
 */
export function escapeHtml(text) {
    if (text == null) return '';
    const str = String(text);
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

/**
 * Escape a string for safe insertion into an HTML attribute value.
 * Covers &, ", <, >, and ' (single quote for unquoted/single-quoted attrs).
 * 
 * @param {*} text - Value to escape (coerced to string)
 * @returns {string} Attribute-safe string
 */
export function escapeAttr(text) {
    if (text == null) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
