// @ts-check
/**
 * Memory file layer — transparent `.aieditor/memory/*.md` projection of the
 * workspace-scope structured store. The "killer integration" of the Memory
 * track per ROADMAP §1.3.0 "Why now": memory committed with the repo
 * round-trips through Git so opening the same project on a second machine
 * surfaces the same memories.
 *
 * Phase split:
 *   - **PR #3 (this)**: serializer + parser + loader + mutation listener
 *     + initial flush on enable. Pending content is held in an in-memory
 *     `Map<path, content>` map. No `Git.updateFile()` calls — the editor
 *     has no working-tree concept, so writing immediately would force a
 *     commit per mutation. Instead, consumers (PR #7 commit-modal) read
 *     pending content via `getPendingContent()` and include it in the
 *     batch at commit time.
 *   - **PR #7**: commit-modal "Memory updates" section reads
 *     `listPendingPaths()` + `getPendingContent()` and feeds them through
 *     `batchSaveFiles()` alongside the user's selected dirty tabs.
 *     Auto-staging on non-protected branches uses Touch 1 Flow 3A's
 *     parallel "Memory updates" section presentation.
 *
 * **Consistency model:** pending content is *eventually consistent* with
 * the store. The mutation handler is async (reads back from IDB to
 * regenerate the affected category file), so a caller that does
 * `await store.create(...)` then immediately reads `getPendingContent()`
 * will see stale content for one IDB roundtrip. In practice the latency
 * is sub-millisecond and consumers (commit modal, `@memory` chip) read
 * pending content well after the mutation that triggered it. Tests
 * exercise this naturally because `createMemoryFakeIDB()` resolves on
 * the next microtask — the handler completes before the test continues.
 *
 * Decisions consumed (memory file `project_design_engagement.md`):
 *   - §1: `user` + `workspace` only — file layer projects ONLY workspace.
 *     User-scope events are filtered out in the mutation listener.
 *   - §4: deterministic key-sorted YAML-frontmatter blocks per record.
 *     Conflict resolution by latest `updated_at`, surface duplicates as
 *     diagnostics warnings.
 *
 * Format (per record):
 * ```
 * ---
 * actor: "user:jeff"
 * category: "preferences"
 * created_at: 1714464000000
 * created_by: "user:jeff"
 * expires_at: null
 * id: "7c8b2a4d-91f0-4c2e-bd34-5f6a8e9d0123"
 * key: "preferred_test_runner"
 * md_path: ".aieditor/memory/preferences.md"
 * owner_id_or_workspace_id: "gitea:xcaliber/ai-editor"
 * scope: "workspace"
 * source: "user_explicit"
 * superseded_by: null
 * updated_at: 1714464000000
 * ---
 * "node:test"
 * ```
 *
 * Frontmatter keys are alphabetically sorted (byte-determinism). Strings
 * are double-quoted with JSON escape rules. Numbers are bare. Null is
 * bare `null`. The body is JSON-encoded so any string/object/array value
 * round-trips unambiguously. `embedding` and `embedding_model_id` are NOT
 * serialized — embeddings are derivable on load (PR #4 will populate via
 * the embeddings client) and crowding the file with float arrays defeats
 * the human-readability goal.
 *
 * @module intelligence/memory/file-layer
 */

import { EventBus, State } from '../../core.js';
import { MEMORY_EVENTS, MEMORY_CATEGORIES } from './contracts.js';
import { validateRecord, canonicalizeKey } from './validation.js';
import * as store from './store.js';
import { isMemoryRepoModeEnabled } from '../../utils/memory-repo-mode-flag.js';

const FILE_LAYER_ROOT = '.aieditor/memory';

/** Fields persisted to the YAML frontmatter (everything except `value`, `embedding`, `embedding_model_id`). */
const PERSISTED_FIELDS = Object.freeze([
    'actor',
    'category',
    'created_at',
    'created_by',
    'expires_at',
    'id',
    'key',
    'md_path',
    'owner_id_or_workspace_id',
    'scope',
    'source',
    'superseded_by',
    'updated_at',
]);

/* -------------------------------------------------------------------------- */
/* Module state                                                               */
/* -------------------------------------------------------------------------- */

/** @type {Map<string, string>} path → serialized markdown */
let _pendingFiles = new Map();

/** @type {{ warnings: Array<Object> }} */
let _diagnostics = { warnings: [] };

/** Active workspace id (`${connectionId}/${owner}/${repo}`) or null. */
let _activeWorkspaceId = null;

/** Whether the layer is currently subscribed and active. */
let _enabled = false;

/** @type {Array<() => void>} EventBus unsubscribers. */
let _unsubscribers = [];

/** Injected git client (defaults to real `Git`); test seam. */
let _gitClient = null;

/* -------------------------------------------------------------------------- */
/* Public API — pure serialization                                            */
/* -------------------------------------------------------------------------- */

/**
 * Path for a category file. Unknown categories return null (caller should
 * treat as a programming error — only `MEMORY_CATEGORIES` values reach
 * this helper).
 *
 * @param {string} category
 * @returns {string|null}
 */
export function categoryPath(category) {
    if (!MEMORY_CATEGORIES.includes(category)) return null;
    return `${FILE_LAYER_ROOT}/${category}.md`;
}

/** Path for the master index file. */
export function indexPath() {
    return `${FILE_LAYER_ROOT}/index.md`;
}

/**
 * Serialize a list of records to a category file's markdown content.
 * Records sorted by `key` (canonical) for byte-determinism. Empty list
 * returns empty string.
 *
 * @param {Array<Object>} records
 * @returns {string}
 */
export function serialize(records) {
    if (!Array.isArray(records) || records.length === 0) return '';
    const sorted = [...records].sort((a, b) => {
        const ka = canonicalizeKey(a.key);
        const kb = canonicalizeKey(b.key);
        if (ka < kb) return -1;
        if (ka > kb) return 1;
        // Tie-break by id for determinism if same key sneaks through.
        return String(a.id).localeCompare(String(b.id));
    });
    return sorted.map(_serializeRecord).join('\n');
}

/**
 * Serialize the master index file. Lists each category file with its
 * record count. Categories with zero records are omitted.
 *
 * @param {Object} counts  Map of category → record count.
 * @returns {string}
 */
export function serializeIndex(counts) {
    const lines = [
        '# AI Editor — workspace memory index',
        '',
        'Per-category files in this directory hold workspace-scope memory records,',
        'one YAML-frontmatter block per record. The structured store in IndexedDB',
        'is the canonical layer; these files are a transparent projection that',
        'rounds-trip through Git so memories follow the repo across machines.',
        '',
        '## Files',
        '',
    ];
    let any = false;
    for (const cat of MEMORY_CATEGORIES) {
        const n = counts && typeof counts[cat] === 'number' ? counts[cat] : 0;
        if (n === 0) continue;
        any = true;
        lines.push(`- \`${cat}.md\` — ${n} record${n === 1 ? '' : 's'}`);
    }
    if (!any) {
        lines.push('_No memory records in this workspace yet._');
    }
    lines.push('');
    return lines.join('\n');
}

/**
 * Parse a category file's markdown content into records + warnings.
 * Resolves duplicate-key conflicts by keeping the latest `updated_at`;
 * each conflict surfaces as a `warnings` entry. Malformed blocks are
 * skipped with a warning; well-formed blocks in the same file still
 * parse.
 *
 * @param {string} content
 * @param {{ sourcePath?: string }} [opts]  `sourcePath` populates warning context.
 * @returns {{ records: Array<Object>, warnings: Array<Object> }}
 */
export function parse(content, opts) {
    const sourcePath = opts && opts.sourcePath ? opts.sourcePath : null;
    /** @type {Array<Object>} */
    const records = [];
    /** @type {Array<Object>} */
    const warnings = [];

    if (typeof content !== 'string' || content.trim().length === 0) {
        return { records, warnings };
    }

    const trimmed = content.replace(/\r\n/g, '\n').trim();
    const lines = trimmed.split('\n');
    const dashLines = [];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i] === '---') dashLines.push(i);
    }

    if (dashLines.length === 0) {
        warnings.push({ type: 'no_records', message: 'no `---` delimiters found', sourcePath });
        return { records, warnings };
    }
    if (dashLines.length % 2 !== 0) {
        warnings.push({
            type: 'unpaired_delimiter',
            message: `expected even count of \`---\` lines; got ${dashLines.length}`,
            sourcePath,
        });
        // Truncate to the last pair we can use.
        dashLines.length = dashLines.length - 1;
    }

    for (let i = 0; i < dashLines.length; i += 2) {
        const yamlStart = dashLines[i] + 1;
        const yamlEnd = dashLines[i + 1] - 1;
        const bodyStart = dashLines[i + 1] + 1;
        const bodyEnd = (i + 2 < dashLines.length ? dashLines[i + 2] : lines.length) - 1;

        if (yamlStart > yamlEnd) {
            warnings.push({ type: 'empty_frontmatter', blockIndex: i / 2, sourcePath });
            continue;
        }

        const yamlText = lines.slice(yamlStart, yamlEnd + 1).join('\n');
        let bodyEndTrimmed = bodyEnd;
        while (bodyEndTrimmed >= bodyStart && lines[bodyEndTrimmed] === '') bodyEndTrimmed--;
        const bodyText = bodyEndTrimmed >= bodyStart ? lines.slice(bodyStart, bodyEndTrimmed + 1).join('\n') : '';

        let fields;
        try {
            fields = _parseYaml(yamlText);
        } catch (err) {
            warnings.push({
                type: 'malformed_frontmatter',
                blockIndex: i / 2,
                message: err && err.message ? err.message : String(err),
                sourcePath,
            });
            continue;
        }

        let value;
        try {
            value = _parseBody(bodyText);
        } catch (err) {
            warnings.push({
                type: 'malformed_body',
                blockIndex: i / 2,
                message: err && err.message ? err.message : String(err),
                sourcePath,
            });
            continue;
        }

        const rec = {
            ...fields,
            value,
            // Embedding-related fields are not in the file layer; downstream
            // queues an embed via PR #4's hooks.
            embedding: null,
            embedding_model_id: typeof fields.embedding_model_id === 'string' ? fields.embedding_model_id : '',
        };

        const validation = validateRecord(rec);
        if (!validation.ok) {
            warnings.push({
                type: 'validation_failed',
                blockIndex: i / 2,
                recordId: rec.id || null,
                errors: validation.errors,
                sourcePath,
            });
            continue;
        }

        records.push(rec);
    }

    // Conflict resolution: dedupe by canonical key, latest updated_at wins.
    /** @type {Map<string, Object>} */
    const byKey = new Map();
    for (const rec of records) {
        const ck = canonicalizeKey(rec.key);
        const prior = byKey.get(ck);
        if (!prior) {
            byKey.set(ck, rec);
            continue;
        }
        const winner = rec.updated_at >= prior.updated_at ? rec : prior;
        const loser = winner === rec ? prior : rec;
        byKey.set(ck, winner);
        warnings.push({
            type: 'duplicate_key',
            key: ck,
            kept: winner.id,
            dropped: loser.id,
            sourcePath,
        });
    }

    return { records: Array.from(byKey.values()), warnings };
}

/* -------------------------------------------------------------------------- */
/* Public API — lifecycle                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Activate the file layer for a specific workspace. Registers EventBus
 * subscribers for memory mutations, performs an initial flush of all
 * existing workspace-scope records to the pending content map. Idempotent:
 * re-enabling against an already-active layer is a no-op (asserts the
 * workspace id matches; throws if it differs — caller should `disable()`
 * first when switching workspaces).
 *
 * Loading from Git (reading existing `.aieditor/memory/*.md` files into
 * IDB) is a separate explicit call: see `loadFromGit()`. Splitting the
 * two lets the loader run on workspace mount before the user's first
 * mutation, and lets tests exercise each side in isolation.
 *
 * @param {string} workspaceId  Typically `${connectionId}/${owner}/${repo}`.
 * @returns {Promise<void>}
 */
export async function enable(workspaceId) {
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
        throw new Error('file-layer.enable: workspaceId must be a non-empty string');
    }
    if (_enabled) {
        if (_activeWorkspaceId !== workspaceId) {
            throw new Error(
                `file-layer.enable: already active for workspace "${_activeWorkspaceId}"; ` +
                `disable() before switching to "${workspaceId}"`,
            );
        }
        return;
    }

    _activeWorkspaceId = workspaceId;
    _enabled = true;

    _unsubscribers.push(
        EventBus.on(MEMORY_EVENTS.CREATED, (e) => _onMutation(e && e.record)),
        EventBus.on(MEMORY_EVENTS.UPDATED, (e) => _onMutation(e && e.after)),
        EventBus.on(MEMORY_EVENTS.DELETED, (e) => _onMutation(e && e.before)),
    );

    await _flushAll();
}

/**
 * Deactivate the file layer. Unsubscribes from EventBus, clears pending
 * content and diagnostics. Safe to call when not enabled (no-op).
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
 * Read existing `.aieditor/memory/*.md` files from the active workspace's
 * Git provider, parse them, and seed the structured store with any
 * records not already present (by `id`). Run on workspace mount before
 * the user's first mutation. Warnings (malformed blocks, duplicate keys)
 * accumulate into `getDiagnostics()`.
 *
 * @param {{
 *   owner: string,
 *   repo: string,
 *   branch?: string,
 *   actor?: string,
 *   gitClient?: { getFile: Function },
 * }} opts
 * @returns {Promise<{ seeded: number, skipped: number, warnings: number }>}
 */
export async function loadFromGit(opts) {
    if (!opts || typeof opts.owner !== 'string' || typeof opts.repo !== 'string') {
        throw new Error('file-layer.loadFromGit: opts.owner and opts.repo are required');
    }
    if (!_enabled || !_activeWorkspaceId) {
        throw new Error('file-layer.loadFromGit: enable(workspaceId) must be called first');
    }

    const branch = opts.branch || 'main';
    const actor = opts.actor || 'system:file-layer';
    const git = opts.gitClient || _gitClient || (await _getDefaultGitClient());

    let seeded = 0;
    let skipped = 0;
    let warningCount = 0;

    for (const category of MEMORY_CATEGORIES) {
        const path = categoryPath(category);
        if (!path) continue;

        let fileContent;
        try {
            const file = await git.getFile(opts.owner, opts.repo, path, branch);
            fileContent = file && typeof file.content === 'string' ? file.content : '';
        } catch (err) {
            // Treat any read failure as "file absent." Real 404s look this way
            // across providers; transient errors will retry on next mount.
            continue;
        }

        if (!fileContent) continue;

        const { records, warnings } = parse(fileContent, { sourcePath: path });
        for (const w of warnings) {
            _diagnostics.warnings.push(w);
            warningCount++;
        }

        for (const rec of records) {
            const existing = await store.getById(rec.id);
            if (existing) {
                skipped++;
                continue;
            }
            // Re-route through `store.create()` so the audit log captures the
            // load. The store generates a fresh id; we want to preserve the
            // file's id. Workaround: write directly via the IDB layer is too
            // invasive — instead we accept a fresh id (audit chain restarts
            // for this record on the new machine). PR #4's `memory_remember`
            // tool will adopt the same path.
            try {
                await store.create({
                    scope: rec.scope,
                    owner_id_or_workspace_id: rec.owner_id_or_workspace_id,
                    key: rec.key,
                    value: rec.value,
                    category: rec.category,
                    source: rec.source,
                    created_by: rec.created_by,
                    actor,
                    embedding: null,
                    embedding_model_id: rec.embedding_model_id,
                    expires_at: rec.expires_at,
                    md_path: rec.md_path,
                }, { reason: `file-layer.loadFromGit ${path}` });
                seeded++;
            } catch (err) {
                _diagnostics.warnings.push({
                    type: 'seed_failed',
                    sourcePath: path,
                    recordId: rec.id,
                    message: err && err.message ? err.message : String(err),
                });
                warningCount++;
            }
        }
    }

    return { seeded, skipped, warnings: warningCount };
}

/* -------------------------------------------------------------------------- */
/* Public API — pending content                                               */
/* -------------------------------------------------------------------------- */

/**
 * Get the current pending content for a path, or null if no content is
 * pending for that path. Consumers (PR #7 commit modal) read this to
 * include memory files in the next commit.
 *
 * @param {string} path
 * @returns {string|null}
 */
export function getPendingContent(path) {
    if (!_pendingFiles.has(path)) return null;
    return _pendingFiles.get(path);
}

/**
 * List every path with pending content. Sorted lexicographically for
 * deterministic UI rendering.
 *
 * @returns {string[]}
 */
export function listPendingPaths() {
    return Array.from(_pendingFiles.keys()).sort();
}

/**
 * Snapshot of accumulated diagnostics (warnings from parse/load). The
 * Settings → Memory tab (PR #5) renders these as a notification list.
 * Returns a defensive copy.
 *
 * @returns {{ warnings: Array<Object> }}
 */
export function getDiagnostics() {
    return { warnings: _diagnostics.warnings.slice() };
}

/**
 * Clear accumulated diagnostics. Settings → Memory tab dismiss action
 * calls this after the user has reviewed the warnings.
 */
export function clearDiagnostics() {
    _diagnostics = { warnings: [] };
}

/**
 * Whether the layer is currently active.
 * @returns {boolean}
 */
export function isEnabled() {
    return _enabled;
}

/**
 * Active workspace id, or null when disabled.
 * @returns {string|null}
 */
export function getActiveWorkspaceId() {
    return _activeWorkspaceId;
}

/* -------------------------------------------------------------------------- */
/* Boot integration                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Wire the file layer into the app's project lifecycle. Called once at
 * boot from `js/app.js`. When `?memoryRepoMode=on` is set in the URL,
 * subscribes to `project:loaded` (enable + initial flush + load from Git)
 * and `project:cleared` (disable).
 *
 * Safe to call when the URL flag is off — registers no listeners and
 * the file layer stays inert until PR #5's Settings toggle activates it.
 *
 * @returns {void}
 */
export function installFileLayer() {
    if (!isMemoryRepoModeEnabled()) return;

    EventBus.on('project:loaded', async ({ connectionId, owner, repo }) => {
        try {
            const wsId = `${connectionId}/${owner}/${repo}`;
            if (_enabled && _activeWorkspaceId !== wsId) disable();
            await enable(wsId);
            await loadFromGit({ owner, repo, branch: State.currentBranch });
        } catch (err) {
            console.error('[memory file-layer] project:loaded handler failed:', err);
        }
    });

    EventBus.on('project:cleared', () => {
        if (_enabled) disable();
    });
}

/* -------------------------------------------------------------------------- */
/* Internals — event handling                                                 */
/* -------------------------------------------------------------------------- */

async function _onMutation(record) {
    if (!record || record.scope !== 'workspace') return;
    if (!_enabled) return;
    if (record.owner_id_or_workspace_id !== _activeWorkspaceId) return;

    try {
        await _regenerateCategory(record.category);
    } catch (err) {
        _diagnostics.warnings.push({
            type: 'regenerate_failed',
            category: record.category,
            message: err && err.message ? err.message : String(err),
        });
    }
}

async function _regenerateCategory(category) {
    if (!MEMORY_CATEGORIES.includes(category)) return;
    const records = await store.list({
        scope: 'workspace',
        owner_id_or_workspace_id: _activeWorkspaceId,
        category,
    });
    const path = categoryPath(category);
    if (!path) return;
    if (records.length === 0) {
        _pendingFiles.delete(path);
    } else {
        _pendingFiles.set(path, serialize(records));
    }
    _regenerateIndex();
}

function _regenerateIndex() {
    /** @type {Object<string, number>} */
    const counts = {};
    for (const cat of MEMORY_CATEGORIES) {
        const path = categoryPath(cat);
        if (!path) continue;
        const content = _pendingFiles.get(path);
        if (!content) continue;
        // Cheap count: number of `---` lines / 2.
        let dashes = 0;
        for (let i = 0; i < content.length; i++) {
            if (content[i] === '-' && content[i + 1] === '-' && content[i + 2] === '-' &&
                (i === 0 || content[i - 1] === '\n') &&
                (i + 3 === content.length || content[i + 3] === '\n')) {
                dashes++;
                i += 2;
            }
        }
        counts[cat] = Math.floor(dashes / 2);
    }

    const anyContent = Object.values(counts).some((n) => n > 0);
    const idx = indexPath();
    if (!anyContent) {
        _pendingFiles.delete(idx);
        return;
    }
    _pendingFiles.set(idx, serializeIndex(counts));
}

async function _flushAll() {
    for (const cat of MEMORY_CATEGORIES) {
        await _regenerateCategory(cat);
    }
}

/* -------------------------------------------------------------------------- */
/* Internals — YAML serialization                                             */
/* -------------------------------------------------------------------------- */

function _serializeRecord(rec) {
    const lines = ['---'];
    for (const field of PERSISTED_FIELDS) {
        const v = rec[field];
        lines.push(`${field}: ${_formatScalar(v)}`);
    }
    lines.push('---');
    lines.push(_formatBody(rec.value));
    lines.push('');
    return lines.join('\n');
}

function _formatScalar(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v === 'boolean') return String(v);
    // String — JSON-encode for unambiguous round-trip.
    return JSON.stringify(String(v));
}

function _formatBody(value) {
    // JSON-encode every value type for unambiguous parsing. Strings come
    // out as `"..."`; objects/arrays as their JSON form; numbers/booleans
    // as bare; null as `null`.
    return JSON.stringify(value === undefined ? null : value);
}

function _parseYaml(text) {
    /** @type {Object<string, any>} */
    const out = {};
    const lines = text.split('\n');
    for (const raw of lines) {
        const line = raw.trim();
        if (line.length === 0) continue;
        const colon = line.indexOf(':');
        if (colon === -1) {
            throw new Error(`malformed yaml line (no colon): ${raw}`);
        }
        const key = line.slice(0, colon).trim();
        const valText = line.slice(colon + 1).trim();
        out[key] = _parseScalar(valText);
    }
    return out;
}

function _parseScalar(text) {
    if (text === 'null' || text === '~') return null;
    if (text === 'true') return true;
    if (text === 'false') return false;
    // String — must be JSON-encoded.
    if (text.startsWith('"')) {
        try {
            return JSON.parse(text);
        } catch (err) {
            throw new Error(`malformed quoted string: ${text}`);
        }
    }
    // Number.
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text)) {
        return Number(text);
    }
    // Bare token — accept as string for forward compat (e.g. enum-like values).
    return text;
}

function _parseBody(text) {
    if (text.length === 0) return null;
    return JSON.parse(text);
}

/* -------------------------------------------------------------------------- */
/* Default Git client (lazy import to break a cycle with js/git.js)           */
/* -------------------------------------------------------------------------- */

async function _getDefaultGitClient() {
    if (_gitClient) return _gitClient;
    const mod = await import('../../git.js');
    _gitClient = mod.Git;
    return _gitClient;
}

/* -------------------------------------------------------------------------- */
/* Test seams                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Test seam: inject a fake git client. Production code should never call
 * this. Used by `tests/test-memory-file-layer.mjs`.
 */
export function _setGitClientForTests(client) {
    _gitClient = client;
}

/**
 * Test seam: full reset of file-layer state. Used in `beforeEach` of
 * the file-layer test suite to isolate tests.
 */
export function _resetForTests() {
    disable();
    _gitClient = null;
}
