// @ts-check
/**
 * Sessions sync — per-conversation Git-native projection of chat history
 * to `.aieditor/sessions/<id>.json`. Mirrors the pending-buffer pattern
 * from `js/intelligence/memory/file-layer.js` but with two key
 * differences:
 *
 *   1. **Per-conversation opt-in.** Memory's repo mode is workspace-wide
 *      (every workspace-scope record projects to a file). Sessions are
 *      raw transcripts that may carry secrets / stack traces / scratch
 *      thinking the user never planned to commit, so the opt-in is
 *      per-conversation (`synced: boolean` on each index entry). A
 *      conversation that is not flagged contributes nothing to the
 *      pending buffer; the directory `.aieditor/sessions/` only exists
 *      in the repo if the user explicitly turned at least one
 *      conversation on.
 *
 *   2. **JSON, not Markdown.** Sessions aren't human-curated facts;
 *      JSON keeps the schema honest and round-trips message arrays /
 *      tool calls / reasoning blocks unambiguously.
 *
 * **Consistency model:** mirrors memory's eventually-consistent shape.
 * The mutation listener (`conversation:saved`, `conversation:renamed`,
 * `conversation:syncToggled`, `conversation:deleted`) reads the freshly
 * persisted payload from `Storage` and rewrites the corresponding
 * pending entry. `getPendingContent(path)` returns the most recently
 * regenerated content; consumers (commit modal) read it well after the
 * mutation that triggered it.
 *
 * @module chat/sessions-sync
 */

import { Storage, EventBus } from '../core.js';

const FILE_LAYER_ROOT = '.aieditor/sessions';

/** Schema version embedded in every serialized session file. Bump on breaking shape changes. */
const SCHEMA_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Module state                                                               */
/* -------------------------------------------------------------------------- */

/** @type {Map<string, string>} path → serialized JSON content */
let _pendingFiles = new Map();

/** @type {{ warnings: Array<Object> }} */
let _diagnostics = { warnings: [] };

/** Active workspace id (`${connectionId}/${owner}/${repo}`) or null. */
let _activeWorkspaceId = null;

/** Whether the layer is currently subscribed and active. */
let _enabled = false;

/** @type {Array<() => void>} EventBus unsubscribers. */
let _unsubscribers = [];

/** Injected git client (defaults to lazy-loaded `Git`); test seam. */
let _gitClient = null;

/* -------------------------------------------------------------------------- */
/* Public API — paths                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Path for a single session file.
 * @param {string} id
 * @returns {string}
 */
export function sessionPath(id) {
    return `${FILE_LAYER_ROOT}/${id}.json`;
}

/* -------------------------------------------------------------------------- */
/* Public API — pure serialization                                            */
/* -------------------------------------------------------------------------- */

/**
 * Serialize a conversation index entry + payload to the JSON content
 * written to `.aieditor/sessions/<id>.json`. Field order is stable for
 * byte-determinism — the same conversation produces the same bytes
 * across runs.
 *
 * @param {{
 *   id: string,
 *   title: string,
 *   createdAt: number,
 *   updatedAt: number,
 *   messageCount?: number,
 * }} indexEntry
 * @param {{
 *   messages: Array<Object>,
 *   summaryInfo?: Object|null,
 *   pruneStash?: Object|null,
 * }} payload
 * @param {{ syncedBy?: string, lastSyncedAt?: number }} [meta]
 * @returns {string}
 */
export function serialize(indexEntry, payload, meta = {}) {
    const out = {
        schema_version: SCHEMA_VERSION,
        id: indexEntry.id,
        title: indexEntry.title || '',
        createdAt: indexEntry.createdAt,
        updatedAt: indexEntry.updatedAt,
        messageCount: typeof indexEntry.messageCount === 'number'
            ? indexEntry.messageCount
            : (Array.isArray(payload && payload.messages) ? payload.messages.length : 0),
        messages: Array.isArray(payload && payload.messages) ? payload.messages : [],
        summaryInfo: payload && payload.summaryInfo != null ? payload.summaryInfo : null,
        pruneStash: payload && payload.pruneStash != null ? payload.pruneStash : null,
        synced_by: typeof meta.syncedBy === 'string' && meta.syncedBy ? meta.syncedBy : 'user:local',
        last_synced_at: typeof meta.lastSyncedAt === 'number' ? meta.lastSyncedAt : Date.now(),
    };
    return JSON.stringify(out, null, 2) + '\n';
}

/**
 * Parse a session file's JSON content into `{ indexEntry, payload, meta }`.
 * Returns `{ ok: false, warning }` on malformed input — caller handles
 * the warning by skipping the file (the in-IDB session is unaffected).
 *
 * @param {string} content
 * @param {{ sourcePath?: string }} [opts]
 * @returns {
 *   { ok: true, indexEntry: Object, payload: Object, meta: Object } |
 *   { ok: false, warning: Object }
 * }
 */
export function parse(content, opts = {}) {
    const sourcePath = opts.sourcePath || null;
    if (typeof content !== 'string' || content.trim().length === 0) {
        return { ok: false, warning: { type: 'empty', sourcePath } };
    }
    let raw;
    try {
        raw = JSON.parse(content);
    } catch (err) {
        return {
            ok: false,
            warning: {
                type: 'malformed_json',
                sourcePath,
                message: err && err.message ? err.message : String(err),
            },
        };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, warning: { type: 'not_an_object', sourcePath } };
    }
    if (typeof raw.id !== 'string' || raw.id.length === 0) {
        return { ok: false, warning: { type: 'missing_id', sourcePath } };
    }

    const indexEntry = {
        id: raw.id,
        title: typeof raw.title === 'string' ? raw.title : 'New Chat',
        createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
        updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
        messageCount: Number.isFinite(raw.messageCount)
            ? raw.messageCount
            : (Array.isArray(raw.messages) ? raw.messages.length : 0),
    };
    const payload = {
        messages: Array.isArray(raw.messages) ? raw.messages : [],
        summaryInfo: raw.summaryInfo != null ? raw.summaryInfo : null,
        pruneStash: raw.pruneStash != null ? raw.pruneStash : null,
    };
    const meta = {
        syncedBy: typeof raw.synced_by === 'string' ? raw.synced_by : '',
        lastSyncedAt: Number.isFinite(raw.last_synced_at) ? raw.last_synced_at : 0,
    };
    return { ok: true, indexEntry, payload, meta };
}

/* -------------------------------------------------------------------------- */
/* Public API — lifecycle                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Activate the sync layer for a specific workspace. Subscribes to
 * conversation lifecycle events; on each, regenerates the pending file
 * for the affected conversation if it's flagged `synced: true`.
 *
 * Idempotent: re-enabling against an already-active layer with the same
 * workspace is a no-op. Switching workspaces requires a `disable()` first.
 *
 * @param {string} workspaceId
 * @returns {Promise<void>}
 */
export async function enable(workspaceId) {
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
        throw new Error('sessions-sync.enable: workspaceId must be a non-empty string');
    }
    if (_enabled) {
        if (_activeWorkspaceId !== workspaceId) {
            throw new Error(
                `sessions-sync.enable: already active for workspace "${_activeWorkspaceId}"; ` +
                `disable() before switching to "${workspaceId}"`,
            );
        }
        return;
    }

    _activeWorkspaceId = workspaceId;
    _enabled = true;

    _unsubscribers.push(
        EventBus.on('conversation:saved', (e) => _onConversationChanged(e && e.id)),
        EventBus.on('conversation:renamed', (e) => _onConversationChanged(e && e.id)),
        EventBus.on('conversation:syncToggled', (e) => _onConversationChanged(e && e.id)),
        EventBus.on('conversation:deleted', (e) => _onConversationDeleted(e && e.id)),
    );

    _flushAll();
}

/**
 * Deactivate the sync layer. Unsubscribes EventBus listeners, clears
 * pending content and diagnostics. Safe to call when not enabled.
 *
 * @returns {void}
 */
export function disable() {
    for (const off of _unsubscribers) {
        try { off(); } catch { /* ignore */ }
    }
    _unsubscribers = [];
    _pendingFiles = new Map();
    _diagnostics = { warnings: [] };
    _activeWorkspaceId = null;
    _enabled = false;
}

/**
 * Read existing `.aieditor/sessions/*.json` files from the active
 * workspace's Git provider, parse each, and seed the conversation index
 * + payload storage with any sessions not already present. Run on
 * workspace mount before the user's first interaction.
 *
 * Conflict resolution: latest `updatedAt` wins. If a conversation with
 * the same id is already in the local index with a newer `updatedAt`,
 * the file is skipped (and a warning surfaces). If the file's
 * `updatedAt` is newer, the local index entry + payload are overwritten.
 *
 * @param {{
 *   owner: string,
 *   repo: string,
 *   branch?: string,
 *   gitClient?: { getFile: Function, getDirContents?: Function },
 * }} opts
 * @returns {Promise<{ seeded: number, updated: number, skipped: number, warnings: number }>}
 */
export async function loadFromGit(opts) {
    if (!opts || typeof opts.owner !== 'string' || typeof opts.repo !== 'string') {
        throw new Error('sessions-sync.loadFromGit: opts.owner and opts.repo are required');
    }
    if (!_enabled || !_activeWorkspaceId) {
        throw new Error('sessions-sync.loadFromGit: enable(workspaceId) must be called first');
    }

    const branch = opts.branch || 'main';
    const git = opts.gitClient || _gitClient || (await _getDefaultGitClient());

    let seeded = 0;
    let updated = 0;
    let skipped = 0;
    let warningCount = 0;

    // Discover paths. We accept either a directory listing API
    // (preferred — only fetches metadata) or a fallback that walks
    // already-known ids from the local index. In practice, the
    // existing Git providers expose getDirContents(); when absent we
    // skip the load (no-op) and let the user's per-conversation toggle
    // sync any conversations that already exist locally.
    let paths = [];
    if (typeof git.getDirContents === 'function') {
        try {
            const entries = await git.getDirContents(opts.owner, opts.repo, FILE_LAYER_ROOT, branch);
            if (Array.isArray(entries)) {
                paths = entries
                    .filter((e) => e && typeof e.path === 'string' && e.path.endsWith('.json'))
                    .map((e) => e.path);
            }
        } catch {
            // Treat any directory-read failure as "no sessions in repo yet."
            return { seeded: 0, updated: 0, skipped: 0, warnings: 0 };
        }
    } else {
        return { seeded: 0, updated: 0, skipped: 0, warnings: 0 };
    }

    for (const path of paths) {
        let fileContent;
        try {
            const file = await git.getFile(opts.owner, opts.repo, path, branch);
            fileContent = file && typeof file.content === 'string' ? file.content : '';
        } catch {
            continue;
        }
        if (!fileContent) continue;

        const parsed = parse(fileContent, { sourcePath: path });
        if (!parsed.ok) {
            _diagnostics.warnings.push(parsed.warning);
            warningCount++;
            continue;
        }

        const { indexEntry, payload } = parsed;

        const localIndex = Storage.get('conversations') || [];
        const existing = localIndex.find((c) => c.id === indexEntry.id);
        if (existing) {
            if ((existing.updatedAt || 0) >= indexEntry.updatedAt) {
                skipped++;
                continue;
            }
            // Remote is newer — overwrite local.
            existing.title = indexEntry.title;
            existing.createdAt = indexEntry.createdAt;
            existing.updatedAt = indexEntry.updatedAt;
            existing.messageCount = indexEntry.messageCount;
            existing.synced = true;
            Storage.set('conversations', localIndex);
            Storage.set(`conv-${indexEntry.id}`, payload);
            updated++;
        } else {
            localIndex.push({
                id: indexEntry.id,
                title: indexEntry.title,
                createdAt: indexEntry.createdAt,
                updatedAt: indexEntry.updatedAt,
                messageCount: indexEntry.messageCount,
                synced: true,
            });
            Storage.set('conversations', localIndex);
            Storage.set(`conv-${indexEntry.id}`, payload);
            seeded++;
        }
    }

    if (seeded > 0 || updated > 0) {
        EventBus.emit('conversation:hydratedFromGit', { seeded, updated });
    }

    return { seeded, updated, skipped, warnings: warningCount };
}

/* -------------------------------------------------------------------------- */
/* Public API — pending content                                               */
/* -------------------------------------------------------------------------- */

/**
 * Pending JSON content for a path, or `null` if no content is pending.
 *
 * @param {string} path
 * @returns {string|null}
 */
export function getPendingContent(path) {
    if (!_pendingFiles.has(path)) return null;
    return _pendingFiles.get(path);
}

/**
 * List every path with pending content. Sorted lexicographically.
 *
 * @returns {string[]}
 */
export function listPendingPaths() {
    return Array.from(_pendingFiles.keys()).sort();
}

/**
 * Diagnostics snapshot (defensive copy).
 *
 * @returns {{ warnings: Array<Object> }}
 */
export function getDiagnostics() {
    return { warnings: _diagnostics.warnings.slice() };
}

/** Clear accumulated diagnostics. */
export function clearDiagnostics() {
    _diagnostics = { warnings: [] };
}

/** Whether the layer is currently active. */
export function isEnabled() {
    return _enabled;
}

/** Active workspace id, or null when disabled. */
export function getActiveWorkspaceId() {
    return _activeWorkspaceId;
}

/**
 * Drop entries from the pending-content map without touching the
 * stored conversation. Two callers:
 *   - Commit modal auto-clear after `batchSaveFiles()` succeeds.
 *   - "Discard" button in the protected-branch escape hatch.
 *
 * @param {string[]} [paths] If omitted, drops every pending path.
 * @returns {string[]} The paths that were actually dropped.
 */
export function discardPendingSessionWrites(paths) {
    if (!_enabled) return [];
    const targets = Array.isArray(paths) ? paths : Array.from(_pendingFiles.keys());
    const dropped = [];
    for (const p of targets) {
        if (_pendingFiles.delete(p)) dropped.push(p);
    }
    if (dropped.length > 0) {
        EventBus.emit('sessions:pendingChanged', { dropped });
    }
    return dropped;
}

/* -------------------------------------------------------------------------- */
/* Boot integration                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Wire the sync layer into the project lifecycle. Called once at boot
 * from `js/app.js`. Subscribes to `project:loaded` (enable + load from
 * Git) and `project:cleared` (disable). Always installed — the
 * per-conversation `synced` flag is the only opt-in surface, so there's
 * no global URL flag gate (unlike memory's repo mode, which is
 * workspace-wide opt-in).
 *
 * @returns {void}
 */
export function installSessionsSync() {
    EventBus.on('project:loaded', async ({ connectionId, owner, repo }) => {
        try {
            const wsId = `${connectionId}/${owner}/${repo}`;
            if (_enabled && _activeWorkspaceId !== wsId) disable();
            await enable(wsId);
            // Lazy import State here — avoid a top-level cycle with core.js.
            const { State } = await import('../core.js');
            await loadFromGit({ owner, repo, branch: State.currentBranch });
        } catch (err) {
            console.error('[sessions-sync] project:loaded handler failed:', err);
        }
    });

    EventBus.on('project:cleared', () => {
        if (_enabled) disable();
    });
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function _onConversationChanged(id) {
    if (!_enabled || !id) return;
    try {
        _regenerateOne(id);
    } catch (err) {
        _diagnostics.warnings.push({
            type: 'regenerate_failed',
            id,
            message: err && err.message ? err.message : String(err),
        });
    }
}

function _onConversationDeleted(id) {
    if (!_enabled || !id) return;
    const path = sessionPath(id);
    if (_pendingFiles.delete(path)) {
        EventBus.emit('sessions:pendingChanged', { dropped: [path] });
    }
}

function _regenerateOne(id) {
    const index = Storage.get('conversations') || [];
    const entry = index.find((c) => c.id === id);
    const path = sessionPath(id);

    if (!entry) {
        // Conversation gone from local index — drop pending if present.
        _pendingFiles.delete(path);
        return;
    }
    if (!entry.synced) {
        // Per-conversation opt-in is off. Untoggling stops future syncs;
        // the already-committed remote file persists until the user
        // removes it manually. Drop from pending so this commit cycle
        // doesn't re-add it.
        _pendingFiles.delete(path);
        return;
    }

    const payload = Storage.get(`conv-${id}`) || { messages: [], summaryInfo: null, pruneStash: null };
    const content = serialize(entry, payload, {
        syncedBy: 'user:local',
        lastSyncedAt: Date.now(),
    });
    _pendingFiles.set(path, content);
}

function _flushAll() {
    const index = Storage.get('conversations') || [];
    for (const entry of index) {
        if (entry && entry.synced && entry.id) {
            try { _regenerateOne(entry.id); } catch { /* ignore */ }
        }
    }
}

/* -------------------------------------------------------------------------- */
/* Default Git client (lazy import to avoid cycle with js/git.js)             */
/* -------------------------------------------------------------------------- */

async function _getDefaultGitClient() {
    if (_gitClient) return _gitClient;
    const mod = await import('../git.js');
    _gitClient = mod.Git;
    return _gitClient;
}

/* -------------------------------------------------------------------------- */
/* Test seams                                                                 */
/* -------------------------------------------------------------------------- */

/** Test seam: inject a fake git client. */
export function _setGitClientForTests(client) {
    _gitClient = client;
}

/** Test seam: full reset of layer state. */
export function _resetForTests() {
    disable();
    _gitClient = null;
}
