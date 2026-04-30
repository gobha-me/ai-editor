// @ts-check
/**
 * Owner-id resolution for the memory subsystem.
 *
 * The store partitions records by `(scope, owner_id_or_workspace_id)`.
 * Workspace-scope owner is `${connectionId}/${owner}/${repo}` — already
 * available via `file-layer.getActiveWorkspaceId()` and the
 * `installFileLayer()` boot path. **User-scope owner needs a stable,
 * per-origin identifier.** Until 1.3.x adds a real user-id concept,
 * we generate one lazy UUID and persist it through `Storage` so all
 * user-scope memory lands in the same bucket regardless of which tab
 * wrote it.
 *
 * **This module is the single source of truth for that id.** Memory PR
 * #4 (LLM tools) and Memory PR #5 (Settings tab) used to compute the
 * user-id independently — the tools wrote to `<UUID>`, the tab read
 * from `'local'`, and the records the agent created were invisible in
 * the UI. This module unifies both call sites; future Memory PRs (#6
 * consent card, #8 @memory chip) consume it too.
 *
 * `Storage('memoryUserId')` is intentionally NOT in `Storage._TAB_SCOPED`
 * so the value is shared across tabs — user memories stay coherent
 * regardless of which tab the agent ran in.
 *
 * @module intelligence/memory/owner
 */

import { Storage } from '../../core.js';

const STORAGE_KEY = 'memoryUserId';

/**
 * Resolve (or lazily create + persist) the stable per-origin user id used
 * as `owner_id_or_workspace_id` for `scope: 'user'` memory records.
 *
 * @returns {string}
 */
export function getOrCreateUserOwnerId() {
    let id = Storage.get(STORAGE_KEY);
    if (!id || typeof id !== 'string') {
        id = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
            ? crypto.randomUUID()
            : 'u-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        Storage.set(STORAGE_KEY, id);
    }
    return id;
}
