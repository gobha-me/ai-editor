// @ts-check
/**
 * Workspace-settings file layer — `.aieditor/settings.json` projection
 * over `State.settings` for safelisted keys, mirroring the memory
 * file-layer pattern shipped in 1.3.0.
 *
 * Lifecycle:
 *
 *   1. Boot wiring (in `js/app.js`) calls `installFileLayer()`, which
 *      subscribes to `project:loaded` / `project:cleared`.
 *   2. On `project:loaded` for an opted-in workspace: `enable(workspaceId)`
 *      snapshots the original global values (so we can restore on
 *      project change), then `loadFromGit({owner, repo, branch})` reads
 *      the file, strips unsafe keys, merges safelisted overrides into
 *      `State.settings`, and re-applies visual settings (theme, uiScale,
 *      etc.) so the merge is observable.
 *   3. While enabled, `recordChanges(diffMap)` (called from
 *      `js/settings/persistence.js#collectAndSave`) routes safelisted
 *      writes to the pending file map. The commit modal reads pending
 *      paths via `listPendingPaths()` + `getPendingContent()` and
 *      auto-stages on unprotected branches (Decision §4 — same gate as
 *      memory).
 *   4. On `project:cleared` or workspace switch: `disable()` restores
 *      the snapshotted global values, clears pending, unsubscribes.
 *
 * Per-workspace opt-in lives in localStorage at the key
 * `workspaceSettings.optIn` as a `{ [workspaceId]: true }` map. The
 * Settings → Workspace Settings tab toggles entries; missing entry =
 * opt-out (default).
 *
 * Removability (Decision §7): deleting this directory + the boot wiring
 * + the persistence hook + the commit-modal section reverts to 1.4.3.
 * Any committed `.aieditor/settings.json` becomes inert.
 *
 * @since 1.4.4
 * @module intelligence/workspace-settings/file-layer
 */

import { EventBus, State, Storage } from '../../core.js';
import { isSafelisted, SAFELIST } from './safelist.js';
import { serialize, parse, FILE_PATH } from './serializer.js';

const OPT_IN_STORAGE_KEY = 'workspaceSettings.optIn';

/* -------------------------------------------------------------------------- */
/* Module state                                                               */
/* -------------------------------------------------------------------------- */

/** @type {Map<string, string>} path → JSON text (single entry: FILE_PATH). */
let _pendingFiles = new Map();

/** @type {{ warnings: Array<Object> }} */
let _diagnostics = { warnings: [] };

/** Active workspace id (`${connectionId}/${owner}/${repo}`) or null. */
let _activeWorkspaceId = null;

/** Whether the layer is currently active for the workspace. */
let _enabled = false;

/**
 * Snapshot of `State.settings[key]` at enable() time, for every
 * safelisted key. Used to restore on disable() and on
 * `resetToGlobal(key)`.
 * @type {Map<string, unknown>}
 */
let _originalGlobals = new Map();

/**
 * Currently-applied workspace overrides, keyed by safelisted key. The
 * tab UI reads this to render the override list.
 * @type {Record<string, unknown>}
 */
let _appliedOverrides = {};

/** Lazy-imported visual-settings re-applier (set on first enable()). */
let _reapplyVisualSettings = null;

/** Injected git client (defaults to real `Git`); test seam. */
let _gitClient = null;

/* -------------------------------------------------------------------------- */
/* Opt-in registry — localStorage-backed                                      */
/* -------------------------------------------------------------------------- */

function _readOptInMap() {
    try {
        const raw = Storage.get(OPT_IN_STORAGE_KEY);
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            return /** @type {Record<string, boolean>} */ (raw);
        }
    } catch { /* fall through */ }
    return /** @type {Record<string, boolean>} */ ({});
}

function _writeOptInMap(map) {
    try { Storage.set(OPT_IN_STORAGE_KEY, map); } catch { /* ignore */ }
}

/**
 * Whether the given workspace is opted in to workspace-settings. Default:
 * false. The Settings tab toggles this via `setOptedIn`.
 *
 * @param {string} workspaceId
 * @returns {boolean}
 */
export function isOptedIn(workspaceId) {
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) return false;
    const map = _readOptInMap();
    return map[workspaceId] === true;
}

/**
 * Set the opt-in flag for a workspace. Persisted via Storage.
 *
 * @param {string} workspaceId
 * @param {boolean} optedIn
 * @returns {void}
 */
export function setOptedIn(workspaceId, optedIn) {
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) return;
    const map = _readOptInMap();
    if (optedIn) {
        map[workspaceId] = true;
    } else {
        delete map[workspaceId];
    }
    _writeOptInMap(map);
}

/* -------------------------------------------------------------------------- */
/* Public API — lifecycle                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Activate the file layer for the given workspace. Snapshots the current
 * `State.settings` for every safelisted key into `_originalGlobals` so a
 * later `disable()` (or project switch) can restore them. Idempotent for
 * the same workspace; throws if called against a different workspace
 * without `disable()` first (mirrors memory's invariant).
 *
 * Does NOT load from git — separate explicit `loadFromGit()` call.
 *
 * @param {string} workspaceId
 * @returns {Promise<void>}
 */
export async function enable(workspaceId) {
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
        throw new Error('workspace-settings.enable: workspaceId must be a non-empty string');
    }
    if (_enabled) {
        if (_activeWorkspaceId !== workspaceId) {
            throw new Error(
                `workspace-settings.enable: already active for "${_activeWorkspaceId}"; ` +
                `disable() before switching to "${workspaceId}"`,
            );
        }
        return;
    }

    _activeWorkspaceId = workspaceId;
    _enabled = true;

    _originalGlobals = new Map();
    for (const key of SAFELIST) {
        _originalGlobals.set(key, _cloneValue(State.settings[key]));
    }

    if (!_reapplyVisualSettings) {
        try {
            const mod = await import('../../utils/apply-visual-settings.js');
            _reapplyVisualSettings = mod.applyVisualSettings;
        } catch (err) {
            console.warn('[workspace-settings] applyVisualSettings import failed:', err);
        }
    }
}

/**
 * Deactivate the layer. Restores every snapshotted global value to
 * `State.settings`, clears pending content + diagnostics + applied
 * overrides, and re-applies visual settings so the UI reflects the
 * pre-merge state.
 *
 * Safe to call when not enabled (no-op).
 *
 * @returns {void}
 */
export function disable() {
    if (!_enabled) return;

    for (const [key, val] of _originalGlobals.entries()) {
        State.settings[key] = _cloneValue(val);
    }

    _originalGlobals = new Map();
    _appliedOverrides = {};
    _pendingFiles = new Map();
    _diagnostics = { warnings: [] };
    _activeWorkspaceId = null;
    _enabled = false;

    if (_reapplyVisualSettings) {
        try { _reapplyVisualSettings(); } catch (err) {
            console.warn('[workspace-settings] disable applyVisualSettings failed:', err);
        }
    }
}

/**
 * Read `.aieditor/settings.json` from the active workspace's git
 * provider, strip unsafe keys, merge into `State.settings`, and
 * re-apply visual settings.
 *
 * Missing file is a no-op success — workspaces without overrides are
 * the common case. JSON parse failure surfaces as a diagnostic; the
 * State.settings stays at its snapshot (i.e. the user's global values).
 *
 * @param {{
 *   owner: string,
 *   repo: string,
 *   branch?: string,
 *   gitClient?: { getFile: Function },
 * }} opts
 * @returns {Promise<{ applied: number, rejected: number, warnings: number }>}
 */
export async function loadFromGit(opts) {
    if (!opts || typeof opts.owner !== 'string' || typeof opts.repo !== 'string') {
        throw new Error('workspace-settings.loadFromGit: opts.owner and opts.repo are required');
    }
    if (!_enabled || !_activeWorkspaceId) {
        throw new Error('workspace-settings.loadFromGit: enable(workspaceId) must be called first');
    }

    const branch = opts.branch || 'main';
    const git = opts.gitClient || _gitClient || (await _getDefaultGitClient());

    let fileContent = '';
    try {
        const file = await git.getFile(opts.owner, opts.repo, FILE_PATH, branch);
        fileContent = file && typeof file.content === 'string' ? file.content : '';
    } catch {
        // Treat any read failure as "file absent" (real 404s from all four
        // providers look this way; transient errors retry on next mount).
        return { applied: 0, rejected: 0, warnings: 0 };
    }

    if (!fileContent) {
        return { applied: 0, rejected: 0, warnings: 0 };
    }

    const { overrides, warnings } = parse(fileContent, { sourcePath: FILE_PATH });
    for (const w of warnings) _diagnostics.warnings.push(w);

    let applied = 0;
    for (const [key, val] of Object.entries(overrides)) {
        if (!isSafelisted(key)) continue;
        State.settings[key] = _cloneValue(val);
        _appliedOverrides[key] = _cloneValue(val);
        applied++;
    }

    if (applied > 0 && _reapplyVisualSettings) {
        try { _reapplyVisualSettings(); } catch (err) {
            console.warn('[workspace-settings] loadFromGit applyVisualSettings failed:', err);
        }
    }

    return { applied, rejected: warnings.filter((w) => w.type === 'unsafe_key_stripped').length, warnings: warnings.length };
}

/* -------------------------------------------------------------------------- */
/* Public API — write path                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Record changed safelisted keys to the pending file. Called from
 * `collectAndSave()` after `State.settings` is updated. For each
 * safelisted key:
 *
 *   - If current `State.settings[key]` differs from the snapshotted
 *     original global, it's an override → upsert into
 *     `_appliedOverrides`.
 *   - If current `State.settings[key]` matches the original global,
 *     drop any existing override for that key (the user reverted to
 *     the global default; no need to keep it in the file).
 *
 * Non-safelisted keys are silently ignored. Empty override map drops
 * the pending file entry — an empty `.aieditor/settings.json` would be
 * noise.
 *
 * `setKeys` lists every key the caller scanned (typically the entire
 * SAFELIST). Keys not in `setKeys` retain whatever override they had.
 *
 * @param {Iterable<string>} setKeys
 * @returns {void}
 */
export function recordChanges(setKeys) {
    if (!_enabled) return;

    const keys = Array.isArray(setKeys) ? setKeys : Array.from(setKeys || []);
    let changed = false;
    for (const key of keys) {
        if (!isSafelisted(key)) continue;
        const val = _cloneValue(State.settings[key]);
        const original = _originalGlobals.get(key);

        if (_deepEqual(val, original)) {
            // No-op vs. global. If we previously had an override for
            // this key, drop it (user reverted via the regular
            // settings UI).
            if (key in _appliedOverrides) {
                delete _appliedOverrides[key];
                changed = true;
            }
        } else if (!_deepEqual(_appliedOverrides[key], val)) {
            _appliedOverrides[key] = val;
            changed = true;
        }
    }

    if (!changed) return;
    _regeneratePendingFile();
    EventBus.emit('workspaceSettings:changed', {
        overrides: { ..._appliedOverrides },
    });
}

/**
 * Reset a single key back to its original global value. Removes it from
 * `_appliedOverrides`, restores `State.settings[key]` from the snapshot,
 * regenerates the pending file (which may delete the entry if no
 * overrides remain), and re-applies visual settings.
 *
 * @param {string} key
 * @returns {void}
 */
export function resetToGlobal(key) {
    if (!_enabled) return;
    if (!isSafelisted(key)) return;
    if (!(key in _appliedOverrides)) return;

    delete _appliedOverrides[key];
    if (_originalGlobals.has(key)) {
        State.settings[key] = _cloneValue(_originalGlobals.get(key));
    }
    _regeneratePendingFile();

    if (_reapplyVisualSettings) {
        try { _reapplyVisualSettings(); } catch { /* ignore */ }
    }
    EventBus.emit('workspaceSettings:changed', {
        overrides: { ..._appliedOverrides },
    });
}

function _regeneratePendingFile() {
    if (Object.keys(_appliedOverrides).length === 0) {
        _pendingFiles.delete(FILE_PATH);
        return;
    }
    _pendingFiles.set(FILE_PATH, serialize(_appliedOverrides));
}

/* -------------------------------------------------------------------------- */
/* Public API — read accessors                                                */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} path
 * @returns {string|null}
 */
export function getPendingContent(path) {
    if (!_pendingFiles.has(path)) return null;
    return _pendingFiles.get(path);
}

/** @returns {string[]} */
export function listPendingPaths() {
    return Array.from(_pendingFiles.keys()).sort();
}

/**
 * Drop entries from the pending-content map without touching the
 * applied overrides on `State.settings`. Two callers:
 *   - The commit modal's auto-clear hook after `batchSaveFiles()` lands.
 *   - The "Discard" button on protected branches.
 *
 * @param {string[]} [paths]
 * @returns {string[]} paths actually dropped.
 */
export function discardPendingWrites(paths) {
    if (!_enabled) return [];
    const targets = Array.isArray(paths) ? paths : Array.from(_pendingFiles.keys());
    const dropped = [];
    for (const p of targets) {
        if (_pendingFiles.delete(p)) dropped.push(p);
    }
    if (dropped.length > 0) {
        EventBus.emit('workspaceSettings:changed', {
            overrides: { ..._appliedOverrides },
        });
    }
    return dropped;
}

/** @returns {{ warnings: Array<Object> }} */
export function getDiagnostics() {
    return { warnings: _diagnostics.warnings.slice() };
}

export function clearDiagnostics() {
    _diagnostics = { warnings: [] };
}

/** @returns {boolean} */
export function isEnabled() {
    return _enabled;
}

/** @returns {string|null} */
export function getActiveWorkspaceId() {
    return _activeWorkspaceId;
}

/**
 * Snapshot of the currently-applied overrides. Used by the Settings tab
 * to render the override list, and by the inline-decoration pass.
 *
 * @returns {Record<string, unknown>}
 */
export function getAppliedOverrides() {
    return { ..._appliedOverrides };
}

/**
 * The original (pre-merge) global value for a safelisted key, or
 * undefined if not snapshotted.
 *
 * @param {string} key
 * @returns {unknown}
 */
export function getOriginalGlobal(key) {
    if (!_originalGlobals.has(key)) return undefined;
    return _cloneValue(_originalGlobals.get(key));
}

/**
 * Snapshot of all original-global values, keyed by safelisted key.
 * Used by `exportSettings()` to dump the un-merged view.
 *
 * @returns {Record<string, unknown>}
 */
export function getOriginalGlobals() {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of _originalGlobals.entries()) out[k] = _cloneValue(v);
    return out;
}

/* -------------------------------------------------------------------------- */
/* Boot integration                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Wire the file layer into the app's project lifecycle. Registers
 * subscribers for `project:loaded` (auto-enable for opted-in workspaces
 * + load from Git) and `project:cleared` (disable + restore globals).
 *
 * Called once at boot from `js/app.js`. Listeners short-circuit when the
 * workspace isn't opted in, so the layer stays inert by default.
 *
 * @returns {void}
 */
export function installFileLayer() {
    EventBus.on('project:loaded', async (e) => {
        const { connectionId, owner, repo } = e || {};
        if (!connectionId || !owner || !repo) return;
        const wsId = `${connectionId}/${owner}/${repo}`;
        if (!isOptedIn(wsId)) return;
        try {
            if (_enabled && _activeWorkspaceId !== wsId) disable();
            await enable(wsId);
            await loadFromGit({ owner, repo, branch: State.currentBranch || 'main' });
        } catch (err) {
            console.error('[workspace-settings] project:loaded handler failed:', err);
        }
    });

    EventBus.on('project:cleared', () => {
        if (_enabled) disable();
    });
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function _cloneValue(v) {
    if (v === null || v === undefined) return v;
    if (typeof v !== 'object') return v;
    try { return JSON.parse(JSON.stringify(v)); } catch { return v; }
}

function _deepEqual(a, b) {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return false;
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch { return false; }
}

async function _getDefaultGitClient() {
    if (_gitClient) return _gitClient;
    const mod = await import('../../git.js');
    _gitClient = mod.Git;
    return _gitClient;
}

/* -------------------------------------------------------------------------- */
/* Test seams                                                                 */
/* -------------------------------------------------------------------------- */

/** @internal */
export function _setGitClientForTests(client) {
    _gitClient = client;
}

/** @internal */
export function _setReapplyVisualSettingsForTests(fn) {
    _reapplyVisualSettings = fn;
}

/** @internal */
export function _resetForTests() {
    disable();
    _gitClient = null;
    _reapplyVisualSettings = null;
}
