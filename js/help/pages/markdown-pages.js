/**
 * Markdown-backed pages — six pages that lazy-load existing docs/ files
 * (or root CHANGELOG.md) via the shared markdown loader.
 *
 * Each page returns a Promise<void>; the caller passes the panel
 * element and the page renders into it. Caching lives in
 * markdown-loader.js so subsequent visits are instant.
 */

import { renderDocInto } from '../markdown-loader.js';

export const DOC_PATHS = {
    'plugin-sdk':   'docs/PLUGIN.md',
    'tools':        'docs/TOOLS.md',
    'roles':        'docs/ROLES_AND_TOOLS.md',
    'memory':       'docs/DESIGN-memory.md',
    'architecture': 'docs/ARCHITECTURE.md',
    'changelog':    'CHANGELOG.md',
};

export function renderMarkdownPage(panel, pageId) {
    const path = DOC_PATHS[pageId];
    if (!path) {
        panel.innerHTML = `<div class="help__doc-error">Unknown page: ${pageId}</div>`;
        return Promise.resolve();
    }
    return renderDocInto(panel, path);
}
