// @ts-check
/**
 * Settings → Memory tab — Preact components.
 *
 * The first Preact + htm consumer in AI Editor (Decision §9). Subsequent
 * Memory PRs add the chat consent card (PR #6), commit-modal section
 * (PR #7), and inline `@memory` chip (PR #8).
 *
 * Memory management layout:
 *   - Toolbar: ◆ Memory · count · file-mode toggle · Audit · Export
 *   - Repo-mode banner (when file mode is active)
 *   - Filters: search input + scope chips (all/user/workspace)
 *   - Split pane: list (left) + detail (right)
 *
 * Differs from the mock per 2026-04-30 kickoff decisions:
 *   - No `persona` scope (Decision §1).
 *   - No `confidence` field anywhere (Decision §2 — `source` enum drives
 *     the "may be stale" affordance).
 *
 * Live updates: subscribes to `MEMORY_EVENTS.{CREATED,UPDATED,DELETED}`
 * so a memory written via the `memory_remember` LLM tool appears in the
 * list without a manual refresh. Effect cleanup unsubscribes on unmount.
 *
 * @since 1.3.0 (Memory PR #5)
 * @module settings/memory-tab/MemoryTab
 */

import { State, EventBus } from '../../core.js';
import { getPreact } from '../../utils/preact-mount.js';
import {
    list,
    update,
    softDelete,
    audit,
    isEnabled as fileLayerIsEnabled,
    listPendingPaths,
    getActiveWorkspaceId,
    enable as fileLayerEnable,
    disable as fileLayerDisable,
    getOrCreateUserOwnerId,
    MEMORY_EVENTS,
    MEMORY_SCOPES,
} from '../../intelligence/memory/index.js';

// Resolve the Preact + htm module once at file load. Memory-tab.js loads
// this file via dynamic import so a bundle failure doesn't break the
// settings-manager import graph.
const { html, useState, useEffect, useMemo } = await getPreact();

const ACTOR_USER = 'user:settings-tab';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Active workspace id in the file-layer's `${connectionId}/${owner}/${repo}`
 * format. Returns null when no project is loaded.
 */
function _currentWorkspaceId() {
    const p = State && State.currentProject;
    if (!p || !p.connectionId || !p.owner || !p.repo) return null;
    return `${p.connectionId}/${p.owner}/${p.repo}`;
}

// User-scope owner id resolves through `getOrCreateUserOwnerId()` in the
// memory subsystem so the tab and `memory_remember` LLM tool see the same
// bucket. The id is a lazy UUID persisted at `Storage('memoryUserId')`.

/**
 * Format an epoch-ms timestamp as a relative phrase ("3 minutes ago",
 * "2 days ago"). Coarse — UI doesn't need second-level precision.
 */
function _relativeTime(ts) {
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return '';
    const delta = Date.now() - ts;
    if (delta < 60_000) return 'just now';
    if (delta < 3_600_000) {
        const m = Math.floor(delta / 60_000);
        return `${m} minute${m === 1 ? '' : 's'} ago`;
    }
    if (delta < 86_400_000) {
        const h = Math.floor(delta / 3_600_000);
        return `${h} hour${h === 1 ? '' : 's'} ago`;
    }
    const d = Math.floor(delta / 86_400_000);
    return `${d} day${d === 1 ? '' : 's'} ago`;
}

/**
 * Render a memory record's `value` as a string for the list row. Strings
 * pass through; objects/arrays JSON-stringify.
 */
function _formatValue(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * Load every active record for the visible scopes. The store's `list()`
 * partitions by (scope, owner_id_or_workspace_id), so "all" requires two
 * calls and a merge. Workspace records are skipped when no project is
 * loaded — the partition key would be undefined.
 *
 * @returns {Promise<any[]>}
 */
async function _loadAllRecords() {
    const out = [];
    const userOwner = getOrCreateUserOwnerId();
    const userRecs = await list({ scope: 'user', owner_id_or_workspace_id: userOwner });
    out.push(...userRecs);
    const wsId = _currentWorkspaceId();
    if (wsId) {
        const wsRecs = await list({ scope: 'workspace', owner_id_or_workspace_id: wsId });
        out.push(...wsRecs);
    }
    out.sort((a, b) => b.updated_at - a.updated_at);
    return out;
}

/* -------------------------------------------------------------------------- */
/* Components                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Root Memory tab component. Owns the records list, selection, filter
 * state, and live-update subscriptions.
 */
export function MemoryTab() {
    const [records, setRecords] = useState(/** @type {any[]} */ ([]));
    const [selectedId, setSelectedId] = useState(/** @type {string|null} */ (null));
    const [filterText, setFilterText] = useState('');
    const [scopeChip, setScopeChip] = useState(/** @type {'all'|'user'|'workspace'} */ ('all'));
    const [fileModeOn, setFileModeOn] = useState(false);
    const [pendingPaths, setPendingPaths] = useState(/** @type {string[]} */ ([]));
    const [auditExpanded, setAuditExpanded] = useState(false);
    const [loadError, setLoadError] = useState(/** @type {string|null} */ (null));

    /** Re-read store + file-layer state. Called from initial load and on every event. */
    const refresh = () => {
        _loadAllRecords()
            .then((recs) => { setRecords(recs); setLoadError(null); })
            .catch((err) => {
                console.error('[memory-tab] list failed:', err);
                setLoadError(err && err.message ? err.message : String(err));
            });
        setFileModeOn(fileLayerIsEnabled());
        setPendingPaths(listPendingPaths());
    };

    // Initial load + EventBus subscriptions. Single effect so cleanup
    // unsubscribes from all three channels in one shot.
    useEffect(() => {
        refresh();
        const offC = EventBus.on(MEMORY_EVENTS.CREATED, refresh);
        const offU = EventBus.on(MEMORY_EVENTS.UPDATED, refresh);
        const offD = EventBus.on(MEMORY_EVENTS.DELETED, refresh);
        return () => { offC(); offU(); offD(); };
    }, []);

    // Filtered list — memo-ized so unrelated re-renders don't re-walk.
    const filtered = useMemo(() => {
        const q = filterText.trim().toLowerCase();
        return records.filter((r) => {
            if (scopeChip !== 'all' && r.scope !== scopeChip) return false;
            if (q) {
                const haystack = (String(r.key) + ' ' + _formatValue(r.value)).toLowerCase();
                if (!haystack.includes(q)) return false;
            }
            return true;
        });
    }, [records, filterText, scopeChip]);

    const selected = useMemo(
        () => (selectedId ? records.find((r) => r.id === selectedId) || null : null),
        [records, selectedId],
    );

    const onToggleFileMode = async () => {
        const wsId = _currentWorkspaceId();
        if (!wsId) {
            window.showToast?.('Open a project to enable repo-committed memory', 'info');
            return;
        }
        try {
            if (fileModeOn) {
                fileLayerDisable();
                window.showToast?.('Memory repo mode disabled', 'info');
            } else {
                await fileLayerEnable(wsId);
                window.showToast?.('Memory repo mode enabled — pending content lives in .aieditor/memory/', 'success');
            }
        } catch (err) {
            console.error('[memory-tab] file mode toggle failed:', err);
            window.showToast?.(`Failed to toggle file mode: ${err && err.message ? err.message : err}`, 'error');
        }
        setFileModeOn(fileLayerIsEnabled());
        setPendingPaths(listPendingPaths());
    };

    const onExport = () => {
        const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ai-editor-memory-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    return html`
        <div class="mem-tab">
            <${MemoryToolbar}
                count=${records.length}
                fileModeOn=${fileModeOn}
                workspaceAvailable=${_currentWorkspaceId() !== null}
                onToggleFileMode=${onToggleFileMode}
                auditExpanded=${auditExpanded}
                onToggleAudit=${() => setAuditExpanded((v) => !v)}
                onExport=${onExport}
            />
            ${fileModeOn ? html`<${MemoryRepoBanner} pendingPaths=${pendingPaths} />` : null}
            <${MemoryFilters}
                filterText=${filterText}
                onFilterChange=${setFilterText}
                scopeChip=${scopeChip}
                onScopeChange=${setScopeChip}
            />
            ${loadError ? html`<div class="mem-load-error">Failed to load memories: ${loadError}</div>` : null}
            <div class="mem-grid">
                <${MemoryList}
                    records=${filtered}
                    selectedId=${selectedId}
                    onSelect=${setSelectedId}
                />
                ${selected
                    ? html`<${MemoryDetail}
                        record=${selected}
                        auditExpanded=${auditExpanded}
                        onCleared=${() => setSelectedId(null)}
                    />`
                    : html`<div class="mem-detail mem-detail--empty">Select a memory to view or edit.</div>`}
            </div>
        </div>
    `;
}

/* -------------------------------------------------------------------------- */
/* Toolbar                                                                    */
/* -------------------------------------------------------------------------- */

function MemoryToolbar(props) {
    const { count, fileModeOn, workspaceAvailable, onToggleFileMode, auditExpanded, onToggleAudit, onExport } = props;
    return html`
        <div class="mem-toolbar">
            <div class="mem-toolbar__title">
                <span class="mem-glyph">◆</span> Memory
                <span class="mem-toolbar__count">${count} ${count === 1 ? 'entry' : 'entries'}</span>
            </div>
            <button type="button"
                class=${'mem-toggle ' + (fileModeOn ? 'mem-toggle--on' : '')}
                disabled=${!workspaceAvailable}
                title=${workspaceAvailable
                    ? 'Project memory committed to .aieditor/memory/*.md'
                    : 'Open a project to enable repo-committed memory'}
                onClick=${onToggleFileMode}>
                <span class="mem-toggle__switch"></span>
                <span>Commit to <code>.aieditor/memory/</code></span>
            </button>
            <button type="button" class="mem-toolbar__btn"
                aria-pressed=${auditExpanded}
                onClick=${onToggleAudit}>
                ${auditExpanded ? 'Hide audit' : 'Audit log'}
            </button>
            <button type="button" class="mem-toolbar__btn" onClick=${onExport}>Export</button>
        </div>
    `;
}

/* -------------------------------------------------------------------------- */
/* Repo-mode banner                                                           */
/* -------------------------------------------------------------------------- */

function MemoryRepoBanner({ pendingPaths }) {
    const wsId = getActiveWorkspaceId();
    return html`
        <div class="mem-repo-banner">
            <span class="mem-repo-banner__dot">●</span>
            <span>Memory committed with <code>${wsId || '—'}</code>.</span>
            ${pendingPaths.length > 0
                ? html`<span class="mem-repo-banner__paths">
                    Pending: ${pendingPaths.map((p, i) => html`${i > 0 ? ' · ' : ''}<code>${p}</code>`)}
                </span>`
                : html`<span class="mem-repo-banner__paths mem-repo-banner__paths--empty">No pending changes.</span>`}
        </div>
    `;
}

/* -------------------------------------------------------------------------- */
/* Filters                                                                    */
/* -------------------------------------------------------------------------- */

function MemoryFilters({ filterText, onFilterChange, scopeChip, onScopeChange }) {
    return html`
        <div class="mem-filters">
            <input type="text" class="mem-filters__search" placeholder="Search memories…"
                value=${filterText}
                onInput=${(e) => onFilterChange(e.currentTarget.value)} />
            <div class="mem-filters__chips" role="tablist" aria-label="Filter by scope">
                ${['all', ...MEMORY_SCOPES].map((s) => html`
                    <button type="button" key=${s}
                        role="tab"
                        aria-selected=${scopeChip === s}
                        class=${'mem-scope-chip ' + (scopeChip === s ? 'mem-scope-chip--active' : '')}
                        onClick=${() => onScopeChange(s)}>${s}</button>
                `)}
            </div>
        </div>
    `;
}

/* -------------------------------------------------------------------------- */
/* List + row                                                                 */
/* -------------------------------------------------------------------------- */

function MemoryList({ records, selectedId, onSelect }) {
    if (records.length === 0) {
        return html`
            <div class="mem-list mem-list--empty">
                <div>No memories match.</div>
                <div class="mem-list__hint">
                    Memories are created when the agent calls <code>memory_remember</code>
                    or via the chat consent card (Memory PR #6).
                </div>
            </div>
        `;
    }
    return html`
        <div class="mem-list" role="listbox" aria-label="Memory records">
            ${records.map((r) => html`
                <${MemoryRow}
                    key=${r.id}
                    record=${r}
                    selected=${r.id === selectedId}
                    onSelect=${() => onSelect(r.id)}
                />
            `)}
        </div>
    `;
}

function MemoryRow({ record, selected, onSelect }) {
    const sourceClass = `mem-source-tag mem-source-tag--${record.source.replace('_', '-')}`;
    return html`
        <div class=${'mem-row ' + (selected ? 'mem-row--selected' : '')}
            role="option"
            aria-selected=${selected}
            tabindex="0"
            onClick=${onSelect}
            onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}>
            <span class=${`mem-scope-badge mem-scope-badge--${record.scope}`}>${record.scope}</span>
            <div class="mem-row__body">
                <div class="mem-row__kv">
                    <span class="mem-row__key">${record.key}</span><span class="mem-row__colon">: </span>${_formatValue(record.value)}
                </div>
                <div class="mem-row__meta">
                    <span class=${sourceClass}>${record.source}</span>
                    <span class="mem-row__sep">·</span>
                    <span>updated ${_relativeTime(record.updated_at)}</span>
                </div>
            </div>
        </div>
    `;
}

/* -------------------------------------------------------------------------- */
/* Detail                                                                     */
/* -------------------------------------------------------------------------- */

function MemoryDetail({ record, auditExpanded, onCleared }) {
    const [draft, setDraft] = useState(_formatValue(record.value));
    const [auditEntries, setAuditEntries] = useState(/** @type {any[]} */ ([]));
    const [saving, setSaving] = useState(false);

    // Reset draft when the selected record changes.
    useEffect(() => {
        setDraft(_formatValue(record.value));
    }, [record.id, record.updated_at]);

    // Load audit entries for this record. Re-runs when expanded toggles.
    useEffect(() => {
        let cancelled = false;
        const limit = auditExpanded ? 50 : 5;
        audit.listForRecord(record.id)
            .then((entries) => {
                if (cancelled) return;
                // Most recent first; cap by limit.
                const sorted = entries.slice().sort((a, b) => b.seq - a.seq).slice(0, limit);
                setAuditEntries(sorted);
            })
            .catch((err) => {
                console.warn('[memory-tab] audit listForRecord failed:', err);
            });
        return () => { cancelled = true; };
    }, [record.id, record.updated_at, auditExpanded]);

    const onSave = async () => {
        if (saving) return;
        if (draft === _formatValue(record.value)) return;
        setSaving(true);
        try {
            await update(record.id, { value: draft }, {
                actor: ACTOR_USER,
                reason: 'edited via Settings → Memory tab',
            });
        } catch (err) {
            console.error('[memory-tab] save failed:', err);
            window.showToast?.(`Save failed: ${err && err.message ? err.message : err}`, 'error');
        } finally {
            setSaving(false);
        }
    };

    const onDelete = async () => {
        if (saving) return;
        if (!window.confirm(`Delete memory "${record.key}"? Audit trail is preserved.`)) return;
        setSaving(true);
        try {
            await softDelete(record.id, {
                actor: ACTOR_USER,
                reason: 'deleted via Settings → Memory tab',
            });
            onCleared();
        } catch (err) {
            console.error('[memory-tab] delete failed:', err);
            window.showToast?.(`Delete failed: ${err && err.message ? err.message : err}`, 'error');
        } finally {
            setSaving(false);
        }
    };

    const dirty = draft !== _formatValue(record.value);

    return html`
        <div class="mem-detail">
            <h5 class="mem-detail__title">Edit memory</h5>
            <div class="mem-field">
                <label class="mem-field__label">key</label>
                <input class="mem-field__input mem-field__input--readonly"
                    value=${record.key} readOnly
                    title="Key is identity-bearing — use supersede() to rename" />
            </div>
            <div class="mem-field">
                <label class="mem-field__label">value</label>
                <textarea class="mem-field__textarea" rows="4"
                    value=${draft}
                    onInput=${(e) => setDraft(e.currentTarget.value)}></textarea>
            </div>
            <div class="mem-detail__tags">
                <span class=${`mem-scope-badge mem-scope-badge--${record.scope}`}>${record.scope}</span>
                <span class=${`mem-source-tag mem-source-tag--${record.source.replace('_', '-')}`}>${record.source}</span>
                <span class="mem-detail__category">${record.category}</span>
            </div>
            <h5 class="mem-detail__title mem-detail__title--audit">
                Audit ${auditExpanded ? '(last 50)' : '(last 5)'}
            </h5>
            <div class="mem-audit-list">
                ${auditEntries.length === 0
                    ? html`<div class="mem-audit-entry mem-audit-entry--empty">No audit entries.</div>`
                    : auditEntries.map((e) => html`
                        <div class="mem-audit-entry" key=${e.seq}>
                            <span class="mem-audit-entry__when">${_relativeTime(e.ts)}</span>
                            <span class="mem-row__sep">·</span>
                            <span class="mem-audit-entry__action">${e.action}</span>
                            <span class="mem-row__sep">·</span>
                            <span class="mem-audit-entry__actor">${e.actor}</span>
                            ${e.reason ? html`<div class="mem-audit-entry__reason">${e.reason}</div>` : null}
                        </div>
                    `)}
            </div>
            <div class="mem-detail__actions">
                <button type="button"
                    class="mem-toolbar__btn mem-toolbar__btn--primary"
                    disabled=${!dirty || saving}
                    onClick=${onSave}>${saving ? 'Saving…' : 'Save'}</button>
                <button type="button"
                    class="mem-toolbar__btn mem-toolbar__btn--danger"
                    disabled=${saving}
                    onClick=${onDelete}>Delete</button>
            </div>
        </div>
    `;
}
