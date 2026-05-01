/**
 * Plugin: Release Sync
 * 
 * Mirrors releases from one git provider to another. Designed for workflows
 * where CI/CD creates releases on a private Gitea instance and you want
 * the release notes published publicly on GitHub.
 * 
 * Syncs tag name, release name, body (release notes), draft/prerelease flags.
 * Does NOT sync binary assets.
 * 
 * Configuration (via Settings → Plugins):
 *   mappings: JSON array of { sourceConnection, sourceRepo, targetConnection, targetRepo }
 * 
 * Example:
 *   [{
 *     "sourceConnection": "gitea-private",
 *     "sourceRepo": "xcaliber/ai-editor",
 *     "targetConnection": "github-public",
 *     "targetRepo": "gobha-me/ai-editor"
 *   }]
 */

import { Plugins, EventBus, State } from '../js/core.js';
import { GitProviderRegistry } from '../js/git-providers/index.js';
import { ToolRegistry } from '../js/tools/registry.js';

const PLUGIN_ID = 'release-sync';
const MODAL_ID = 'release-sync-modal';

// ============================================
// CORE SYNC ENGINE
// ============================================

/**
 * Resolve a connection + repo from config.
 * @returns {{ provider, connection, owner, repo }} or null
 */
function resolveEndpoint(connLabel, repoPath) {
    const connections = GitProviderRegistry.listConnections(true);
    const conn = connections.find(c => c.label === connLabel || c.id === connLabel);
    if (!conn) return null;

    const { provider, connection } = GitProviderRegistry.resolve(conn.id);
    const [owner, repo] = repoPath.split('/');
    return { provider, connection, owner, repo };
}

/**
 * Get the active mapping for the current project (if any).
 */
function getActiveMapping() {
    const config = Plugins.getConfig(PLUGIN_ID);
    let mappings = [];
    try {
        const raw = config?.mappings || '[]';
        mappings = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch { return null; }

    if (!mappings.length || !State.currentProject) return null;

    const currentRepo = `${State.currentProject.owner}/${State.currentProject.repo}`;
    return mappings.find(m =>
        m.sourceRepo === currentRepo ||
        m.sourceRepo === State.currentProject.repo
    ) || null;
}

/**
 * Compare releases between source and target, sync missing ones.
 * @param {boolean} all - If false, only sync the latest missing release
 * @returns {Object} Sync result summary
 */
async function syncReleases(all = false) {
    const mapping = getActiveMapping();
    if (!mapping) {
        return { error: 'No release sync mapping configured for this project. Configure in Settings → Plugins → Release Sync.' };
    }

    const source = resolveEndpoint(mapping.sourceConnection, mapping.sourceRepo);
    if (!source) {
        return { error: `Source connection "${mapping.sourceConnection}" not found. Check plugin config.` };
    }
    const target = resolveEndpoint(mapping.targetConnection, mapping.targetRepo);
    if (!target) {
        return { error: `Target connection "${mapping.targetConnection}" not found. Check plugin config.` };
    }

    try {
        // Fetch both release lists
        const [sourceReleases, targetReleases] = await Promise.all([
            source.provider.listReleases(source.connection, source.owner, source.repo),
            target.provider.listReleases(target.connection, target.owner, target.repo)
        ]);

        const targetTags = new Set(targetReleases.map(r => r.tag));

        // Find releases that exist on source but not on target
        const missing = sourceReleases.filter(r => !targetTags.has(r.tag));

        if (missing.length === 0) {
            return {
                success: true,
                source: mapping.sourceRepo,
                target: mapping.targetRepo,
                source_count: sourceReleases.length,
                target_count: targetReleases.length,
                synced: 0,
                message: 'All releases already synced — nothing to do.'
            };
        }

        // If not syncing all, only take the latest missing release (first in list = newest)
        const toSync = all ? missing : [missing[0]];

        const results = [];
        for (const release of toSync) {
            try {
                const created = await target.provider.createRelease(
                    target.connection, target.owner, target.repo, {
                        tag: release.tag,
                        name: release.name,
                        body: release.body,
                        draft: release.draft,
                        prerelease: release.prerelease
                    }
                );
                results.push({ tag: release.tag, url: created.url, status: 'created' });
            } catch (e) {
                results.push({ tag: release.tag, status: 'failed', error: e.message });
            }
        }

        const synced = results.filter(r => r.status === 'created').length;
        const failed = results.filter(r => r.status === 'failed').length;

        return {
            success: failed === 0,
            source: mapping.sourceRepo,
            target: mapping.targetRepo,
            source_count: sourceReleases.length,
            target_count: targetReleases.length,
            total_missing: missing.length,
            synced,
            failed,
            results,
            message: all
                ? `Synced ${synced} of ${missing.length} missing releases${failed ? ` (${failed} failed)` : ''}.`
                : `Synced release ${toSync[0].tag}${missing.length > 1 ? ` (${missing.length - 1} more missing — use all=true to sync all)` : ''}.`,
            ...(missing.length > toSync.length ? {
                remaining: missing.length - toSync.length,
                hint: `${missing.length - toSync.length} older releases not synced. Call sync_releases with all=true to sync everything.`
            } : {})
        };

    } catch (error) {
        return { error: `Release sync failed: ${error.message}` };
    }
}

/**
 * Get comparison data without syncing (for the UI).
 */
async function getComparisonData() {
    const mapping = getActiveMapping();
    if (!mapping) return null;

    const source = resolveEndpoint(mapping.sourceConnection, mapping.sourceRepo);
    const target = resolveEndpoint(mapping.targetConnection, mapping.targetRepo);
    if (!source || !target) return null;

    const [sourceReleases, targetReleases] = await Promise.all([
        source.provider.listReleases(source.connection, source.owner, source.repo),
        target.provider.listReleases(target.connection, target.owner, target.repo)
    ]);

    const targetTags = new Set(targetReleases.map(r => r.tag));

    return {
        mapping,
        source: sourceReleases.map(r => ({
            ...r,
            synced: targetTags.has(r.tag)
        })),
        target: targetReleases,
        missing: sourceReleases.filter(r => !targetTags.has(r.tag))
    };
}

// ============================================
// MODAL UI
// ============================================

function escapeHtml(str) {
    const el = document.createElement('span');
    el.textContent = str || '';
    return el.innerHTML;
}

async function renderModal(container) {
    container.innerHTML = `
        <div id="rs-root" style="font-size: var(--font-md, 13px);">
            <div id="rs-content" style="color: var(--text-muted);">Loading releases…</div>
        </div>
    `;

    const contentEl = document.getElementById('rs-content');

    try {
        const data = await getComparisonData();

        if (!data) {
            contentEl.innerHTML = `
                <div style="padding: 1rem; color: var(--warning);">
                    ⚠️ No mapping configured for the current project.<br>
                    <span style="color: var(--text-muted); font-size: 12px;">
                        Go to Settings → Plugins → Release Sync to add a mapping.
                    </span>
                </div>
            `;
            return;
        }

        const missingCount = data.missing.length;
        const statusBadge = missingCount === 0
            ? '<span style="color: var(--success);">✅ All synced</span>'
            : `<span style="color: var(--warning);">⚠️ ${missingCount} missing</span>`;

        contentEl.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
                <div>
                    <span style="color: var(--text-muted);">${escapeHtml(data.mapping.sourceRepo)}</span>
                    <span style="margin: 0 0.5rem;">→</span>
                    <span style="color: var(--text-muted);">${escapeHtml(data.mapping.targetRepo)}</span>
                    <span style="margin-left: 0.75rem;">${statusBadge}</span>
                </div>
                <div style="display: flex; gap: 0.5rem;">
                    ${missingCount > 0 ? `
                        <button class="btn btn-primary" id="rs-sync-latest" style="font-size: 11px; padding: 0.25rem 0.6rem;">
                            Sync Latest
                        </button>
                        ${missingCount > 1 ? `
                            <button class="btn btn-secondary" id="rs-sync-all" style="font-size: 11px; padding: 0.25rem 0.6rem;">
                                Sync All (${missingCount})
                            </button>
                        ` : ''}
                    ` : ''}
                    <button class="btn btn-secondary" id="rs-refresh" style="font-size: 11px; padding: 0.25rem 0.6rem;">🔄</button>
                </div>
            </div>
            <div style="max-height: 400px; overflow-y: auto;">
                <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
                    <thead>
                        <tr style="border-bottom: 1px solid var(--border-color); color: var(--text-muted);">
                            <th style="text-align: left; padding: 0.3rem 0.5rem;">Tag</th>
                            <th style="text-align: left; padding: 0.3rem 0.5rem;">Name</th>
                            <th style="text-align: left; padding: 0.3rem 0.5rem;">Date</th>
                            <th style="text-align: center; padding: 0.3rem 0.5rem;">Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${data.source.map(r => `
                            <tr style="border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.05));">
                                <td style="padding: 0.3rem 0.5rem; font-family: var(--font-mono);">${escapeHtml(r.tag)}</td>
                                <td style="padding: 0.3rem 0.5rem;">${escapeHtml(r.name)}</td>
                                <td style="padding: 0.3rem 0.5rem; color: var(--text-muted);">${r.createdAt ? new Date(r.createdAt).toLocaleDateString() : '—'}</td>
                                <td style="padding: 0.3rem 0.5rem; text-align: center;">
                                    ${r.synced
                                        ? '<span style="color: var(--success);">✅</span>'
                                        : '<span style="color: var(--warning);">⏳</span>'
                                    }
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
            <div id="rs-status" style="margin-top: 0.5rem; font-size: 11px; color: var(--text-muted);"></div>
        `;

        // Wire up buttons
        const refreshBtn = document.getElementById('rs-refresh');
        if (refreshBtn) refreshBtn.addEventListener('click', () => renderModal(container));

        const syncLatestBtn = document.getElementById('rs-sync-latest');
        if (syncLatestBtn) syncLatestBtn.addEventListener('click', async () => {
            const statusEl = document.getElementById('rs-status');
            syncLatestBtn.disabled = true;
            syncLatestBtn.textContent = 'Syncing…';
            statusEl.textContent = 'Syncing latest release…';
            try {
                const result = await syncReleases(false);
                statusEl.innerHTML = result.error
                    ? `<span style="color: var(--danger);">❌ ${escapeHtml(result.error)}</span>`
                    : `<span style="color: var(--success);">✅ ${escapeHtml(result.message)}</span>`;
                // Refresh table after short delay
                setTimeout(() => renderModal(container), 1500);
            } catch (e) {
                statusEl.innerHTML = `<span style="color: var(--danger);">❌ ${escapeHtml(e.message)}</span>`;
                syncLatestBtn.disabled = false;
                syncLatestBtn.textContent = 'Sync Latest';
            }
        });

        const syncAllBtn = document.getElementById('rs-sync-all');
        if (syncAllBtn) syncAllBtn.addEventListener('click', async () => {
            const statusEl = document.getElementById('rs-status');
            syncAllBtn.disabled = true;
            syncAllBtn.textContent = 'Syncing…';
            statusEl.textContent = `Syncing ${missingCount} releases…`;
            try {
                const result = await syncReleases(true);
                statusEl.innerHTML = result.error
                    ? `<span style="color: var(--danger);">❌ ${escapeHtml(result.error)}</span>`
                    : `<span style="color: var(--success);">✅ ${escapeHtml(result.message)}</span>`;
                setTimeout(() => renderModal(container), 1500);
            } catch (e) {
                statusEl.innerHTML = `<span style="color: var(--danger);">❌ ${escapeHtml(e.message)}</span>`;
                syncAllBtn.disabled = false;
                syncAllBtn.textContent = `Sync All (${missingCount})`;
            }
        });

    } catch (error) {
        contentEl.innerHTML = `<span style="color: var(--danger);">❌ ${escapeHtml(error.message)}</span>`;
    }
}

// ============================================
// PLUGIN MANIFEST
// ============================================

const ReleaseSyncPlugin = {
    id: PLUGIN_ID,
    name: 'Release Sync',
    version: '1.0.0',
    description: 'Mirror releases from a private git provider to a public one (tag + release notes, no assets)',
    author: 'Jeff',
    defaultEnabled: false,
    hooks: [],

    defaultConfig: {
        mappings: '[]'
    },

    configSchema: [
        {
            key: 'mappings',
            label: 'Repo Mappings (JSON)',
            type: 'textarea',
            placeholder: '[{"sourceConnection":"gitea-private","sourceRepo":"xcaliber/ai-editor","targetConnection":"github-public","targetRepo":"gobha-me/ai-editor"}]',
            help: 'JSON array. sourceConnection/sourceRepo = where CI/CD creates releases. targetConnection/targetRepo = where to publish them publicly.'
        }
    ],

    async init() {
        // Register UI button + modal
        Plugins.registerButton(PLUGIN_ID, {
            // icon omitted — picks up the Lucide fallback in
            // settings/plugins-tab.js (1.3.11 Touch 2 PROBE: UI uses Lucide,
            // emoji is reserved for user content)
            label: 'Release Sync',
            onClick: () => window.openPluginModal(MODAL_ID)
        });

        Plugins.registerModal(PLUGIN_ID, {
            id: MODAL_ID,
            title: 'Release Sync',
            width: '700px',
            render: (container) => renderModal(container)
        });

        // Register LLM tool
        ToolRegistry.register('sync_releases', async ({ all = false } = {}) => {
            return syncReleases(all);
        }, {
            type: 'function',
            function: {
                name: 'sync_releases',
                description: 'Sync releases from the source git provider (e.g., private Gitea) to the target (e.g., public GitHub). Copies tag name, release name, and release notes. By default syncs only the latest missing release — use all=true to sync all missing releases.',
                parameters: {
                    type: 'object',
                    properties: {
                        all: {
                            type: 'boolean',
                            description: 'If true, sync ALL missing releases. If false (default), sync only the latest missing release.'
                        }
                    },
                    required: []
                }
            },
            roles: 'all'
        });

        console.log('[release-sync] Initialized');
        return {};
    }
};

Plugins.register(ReleaseSyncPlugin);

export default ReleaseSyncPlugin;
