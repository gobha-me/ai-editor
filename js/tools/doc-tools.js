/**
 * AI Editor - Documentation Tools
 * 
 * Allows the LLM to read built-in documentation (Plugin SDK, Tools,
 * Roles, Architecture, etc.) directly from the deployed instance.
 * Works fully offline — docs are served as static files.
 * 
 * @module tools/doc-tools
 */

const DOC_MANIFEST = [
    { id: 'plugin-sdk',   path: 'docs/PLUGIN.md',          title: 'Plugin SDK & Authoring Guide' },
    { id: 'tools',        path: 'docs/TOOLS.md',            title: 'LLM Tool System Reference' },
    { id: 'roles',        path: 'docs/PROFILES_AND_TOOLS.md', title: 'Profiles & Tool Access' },
    { id: 'architecture', path: 'docs/ARCHITECTURE.md',     title: 'Editor Architecture' },
    { id: 'scan-tools',   path: 'docs/scan-tools-guide.md', title: 'Scan Tools Usage Guide' },
    { id: 'error-recovery', inline: 'Error handling in AI Editor is implemented in `js/utils/errors.js`. Use the `EditorError` class with an `ErrorCode` constant and a `recoveryHint` string; consumers compare `err.code` rather than parsing messages, and `err.recoveryHint` is rendered to the user via `js/error-logger.js`. See `docs/ARCHITECTURE.md` § `tools/registry.js` for the tool-execution error path.', title: 'Error Handling — pointer to js/utils/errors.js' },
    { id: 'plan',         path: 'docs/PLAN.md',             title: 'Future Work / Roadmap' }
];

/**
 * Register documentation tools.
 * @param {import('./registry.js').ToolRegistry} registry
 */
export function registerDocTools(registry) {

    registry.register('read_docs', async ({ doc_id }) => {
        // If no doc_id, return the manifest (list of available docs)
        if (!doc_id) {
            return {
                available_docs: DOC_MANIFEST.map(d => ({
                    id: d.id,
                    title: d.title,
                    ...(d.path ? { path: d.path } : { inline: true })
                })),
                usage: 'Call read_docs with doc_id to read a specific document. Example: read_docs({ doc_id: "plugin-sdk" })'
            };
        }

        const doc = DOC_MANIFEST.find(d => d.id === doc_id);
        if (!doc) {
            return {
                error: `Unknown doc_id: "${doc_id}". Available: ${DOC_MANIFEST.map(d => d.id).join(', ')}`,
                available_docs: DOC_MANIFEST.map(d => ({ id: d.id, title: d.title }))
            };
        }

        // Inline pointer entries return their content directly (no fetch).
        // Used for retired docs whose canonical content lives in source code.
        if (doc.inline) {
            return {
                doc_id: doc.id,
                title: doc.title,
                content: doc.inline
            };
        }

        try {
            const resp = await fetch(doc.path);
            if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);

            // Guard against nginx SPA fallback returning index.html
            const ct = resp.headers.get('content-type') || '';
            const content = await resp.text();
            if (ct.includes('text/html') || content.trimStart().startsWith('<!') || content.trimStart().startsWith('<html')) {
                return { error: `Doc file "${doc.path}" not found in deployment. The Docker image needs to be rebuilt to include docs/.` };
            }

            const lines = content.split('\n');
            return {
                doc_id: doc.id,
                title: doc.title,
                path: doc.path,
                line_count: lines.length,
                content: lines.map((l, i) => `${i + 1}: ${l}`).join('\n')
            };
        } catch (err) {
            return { error: `Failed to load ${doc.path}: ${err.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'read_docs',
            description: 'Read AI Editor documentation. Call with no arguments to list available docs, or with a doc_id to read a specific document. Available docs include the Plugin SDK, Tools reference, Roles guide, Architecture overview, and more. Use this when you need to understand how the editor works or how to build plugins.',
            parameters: {
                type: 'object',
                properties: {
                    doc_id: {
                        type: 'string',
                        description: 'Document ID to read (e.g., "plugin-sdk", "tools", "roles", "architecture"). Omit to list all available docs.'
                    }
                },
                required: []
            }
        },
        readOnly: true
    });
}
