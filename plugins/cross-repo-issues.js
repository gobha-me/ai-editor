/**
 * Plugin: Cross-Repo Issues
 * 
 * Routes issue operations to a different git provider connection than
 * the active code repository. Designed for workflows where code lives
 * on one provider (e.g., Gitea) but public issues are managed on
 * another (e.g., GitHub).
 * 
 * Uses the 'resolveIssueConnection' hook in the Git facade to intercept
 * issue API calls and redirect them to the configured connection/repo.
 * 
 * Configuration (via Settings → Plugins):
 *   mappings: JSON array of { codeRepo, issueConnection, issueRepo }
 * 
 * Example mapping:
 *   [
 *     {
 *       "codeRepo": "jeff/ai-editor",
 *       "issueConnection": "github-public",
 *       "issueRepo": "jeff/ai-editor"
 *     }
 *   ]
 * 
 * codeRepo: The owner/repo as shown in the project selector (code side)
 * issueConnection: The connection label or ID to route issues through
 * issueRepo: The owner/repo on the issue provider (may differ from code repo)
 */

import { Plugins, EventBus, State } from '../js/core.js';
import { GitProviderRegistry } from '../js/git-providers/index.js';

const CrossRepoIssuesPlugin = {
    id: 'cross-repo-issues',
    name: 'Cross-Repo Issues',
    version: '1.0.0',
    description: 'Route issues to a different provider/repo than the active code repository',
    author: 'Jeff',

    hooks: ['resolveIssueConnection'],

    defaultConfig: {
        mappings: '[]'
    },

    configSchema: [
        {
            key: 'mappings',
            label: 'Repo Mappings (JSON)',
            type: 'textarea',
            placeholder: '[{"codeRepo":"owner/repo","issueConnection":"github-conn-label","issueRepo":"owner/repo"}]',
            help: 'JSON array. codeRepo = active project, issueConnection = connection label/ID for issues, issueRepo = owner/repo on issue provider'
        }
    ],

    async init(config) {
        console.log('[cross-repo-issues] Initialized');
        return {};
    },

    /**
     * Hook: resolveIssueConnection
     * 
     * Called by Git.listIssues, Git.getIssue, etc. before making the API call.
     * If the current project matches a mapping, swaps the provider/connection/repo.
     */
    async resolveIssueConnection(ctx, instance, config) {
        // Parse mappings
        let mappings = [];
        try {
            const raw = config?.mappings || '[]';
            mappings = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (e) {
            console.warn('[cross-repo-issues] Invalid mappings JSON:', e.message);
            return ctx;  // Pass through unchanged
        }

        if (!mappings.length || !State.currentProject) return ctx;

        const currentRepo = `${ctx.owner}/${ctx.repo}`;

        // Find matching mapping
        const mapping = mappings.find(m =>
            m.codeRepo === currentRepo ||
            m.codeRepo === ctx.repo  // Allow shorthand without owner
        );

        if (!mapping) return ctx;  // No mapping for this repo

        // Find the target connection by label or ID
        const connections = GitProviderRegistry.listConnections(true);  // enabled only
        const targetConn = connections.find(c =>
            c.label === mapping.issueConnection ||
            c.id === mapping.issueConnection
        );

        if (!targetConn) {
            console.warn(`[cross-repo-issues] Connection not found: "${mapping.issueConnection}"`);
            return ctx;
        }

        // Resolve the target provider
        try {
            const { provider, connection } = GitProviderRegistry.resolve(targetConn.id);
            const [issueOwner, issueRepo] = (mapping.issueRepo || currentRepo).split('/');

            console.log(`[cross-repo-issues] Routing issues: ${currentRepo} → ${issueOwner}/${issueRepo} via ${targetConn.label}`);

            return {
                provider,
                connection,
                owner: issueOwner,
                repo: issueRepo,
                redirected: true
            };
        } catch (e) {
            console.error('[cross-repo-issues] Failed to resolve target connection:', e.message);
            return ctx;
        }
    }
};

Plugins.register(CrossRepoIssuesPlugin);

export default CrossRepoIssuesPlugin;
