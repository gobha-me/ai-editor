// @ts-check
/**
 * PR Review surface — Preact + htm root.
 *
 * Read-only middle-pane takeover for inspecting a pull request:
 * Conversation / Files / Commits / Checks tabs with side-by-side diff
 * and inline comment threads anchored to lines.
 *
 * Slice 1 is read-only — no comment posting, no review submission,
 * no AI summary. Those land in 2.13.0 (dock + submission) and 2.14.0
 * (AI summary). The bottom-of-conversation banner tells the user
 * where to find submission in the meantime.
 *
 * Mirrors the lifecycle pattern in
 * [`js/chat/scratchpad-panel/ScratchpadPanel.js`]: async `getPreact()`
 * at module top, `useLayoutEffect` for EventBus subscriptions
 * (`useEffect` queues until next render in the vendor-bundle env and
 * misses any emit fired before the second render).
 *
 * @since 2.12.0 (Touch 3 PR Review surface — slice 1)
 * @module pr-review/PrReviewSurface
 */

import { State, EventBus } from '../core.js';
import { Git } from '../git.js';
import { renderMarkdown } from '../secondary-pane.js';
import { getPreact } from '../utils/preact-mount.js';
import { parsePatch, pairSideBySide, truncateRows, countChanges } from './diff-parse.js';
import { PrReviewDock } from './PrReviewDock.js';
import { PrCommentComposer } from './PrCommentComposer.js';
import { getCiStatusMeta } from '../ui/icons.js';
import { nextPollDelay, shouldPoll } from './poll-cadence.js';
import {
    addDraft,
    getResolvedLocal,
    isFileViewed,
    toggleViewed,
} from './review-state.js';

const { html, useState, useLayoutEffect, useMemo } = await getPreact();

const FILE_STATUS_MARK = {
    added: { mark: 'A', cls: 'pr__filemark--add', label: 'Added' },
    removed: { mark: 'D', cls: 'pr__filemark--del', label: 'Deleted' },
    modified: { mark: 'M', cls: 'pr__filemark--mod', label: 'Modified' },
    renamed: { mark: 'R', cls: 'pr__filemark--ren', label: 'Renamed' },
    copied: { mark: 'C', cls: 'pr__filemark--ren', label: 'Copied' }
};

const STATE_BADGE = {
    open: { text: 'Open', cls: 'pr__state-badge--open' },
    closed: { text: 'Closed', cls: 'pr__state-badge--closed' },
    merged: { text: 'Merged', cls: 'pr__state-badge--merged' }
};

/**
 * Group comments by file path for the file-tree thread-count badge.
 * @param {Array<Object>} comments
 * @returns {Map<string, number>}
 */
function _commentCountsByPath(comments) {
    const counts = new Map();
    for (const c of comments) {
        if (!c.path) continue;
        counts.set(c.path, (counts.get(c.path) || 0) + 1);
    }
    return counts;
}

/**
 * Group comments by `(path, line, side)` so the diff renderer can
 * render thread rows anchored to the right cell.
 *
 * @param {Array<Object>} comments
 * @returns {Map<string, Array<Object>>}  key = `${path}::${side}::${line}`
 */
function _commentsByAnchor(comments) {
    const map = new Map();
    for (const c of comments) {
        if (!c.path || !c.line) continue;
        const side = c.side === 'LEFT' ? 'LEFT' : 'RIGHT';
        const key = `${c.path}::${side}::${c.line}`;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(c);
    }
    return map;
}

/**
 * Root surface. Owns its own data fetch; the mount module just
 * supplies `{ owner, repo, prNumber, onClose }`.
 *
 * @param {{owner:string, repo:string, prNumber:number, onClose:Function}} props
 */
export function PrReviewSurface({ owner, repo, prNumber, onClose }) {
    const [data, setData] = useState({
        pr: null,
        files: [],
        comments: [],
        commits: [],
        ci: { state: 'unknown', statuses: [] },
        loading: true,
        error: null
    });
    const [tab, setTab] = useState('files');
    const [activePath, setActivePath] = useState(null);
    const [diffMode, setDiffMode] = useState(/** @type {'split'|'unified'} */ ('split'));
    const [filter, setFilter] = useState('');

    useLayoutEffect(() => {
        let cancelled = false;
        async function load() {
            setData(d => ({ ...d, loading: true, error: null }));
            try {
                const pr = await Git.getPullRequest(owner, repo, prNumber);
                if (cancelled) return;
                // Render header immediately
                setData(d => ({ ...d, pr, loading: false }));

                // `compareRefs(base, head)` is the source of truth for the
                // PR-scoped commits. On GitHub it ALSO carries a per-file
                // patch array (which backfills patches missing from
                // /pulls/{n}/files); on Gitea its `files` is always `[]`
                // (the Compare schema has no `files` field — see the
                // `compareRefs` docstring in [`gitea.js`](../git-providers/gitea.js)).
                // The compare round-trip stays unconditional because the
                // GitHub backfill is the cheap path; Gitea cascades through
                // the /pulls/{n}.diff fallback below.
                const [files, comments, ci, compare] = await Promise.all([
                    Git.getPullRequestFiles(owner, repo, prNumber).catch(() => []),
                    Git.getPullRequestComments(owner, repo, prNumber).catch(() => []),
                    Git.getCommitStatus(owner, repo, pr.head).catch(() => ({ state: 'unknown', statuses: [] })),
                    Git.compareRefs(owner, repo, pr.base, pr.head).catch(() => ({ commits: [], files: [] }))
                ]);
                if (cancelled) return;

                // Backfill missing patches from compare.files keyed on filename.
                const patchByPath = new Map();
                for (const f of (compare.files || [])) {
                    if (f.filename && f.patch) patchByPath.set(f.filename, f.patch);
                }
                let filesWithPatches = files.map(f =>
                    f.patch ? f : { ...f, patch: patchByPath.get(f.filename) || null }
                );
                const commits = compare.commits || [];

                setData(d => ({ ...d, files: filesWithPatches, comments, ci, commits }));
                if (filesWithPatches.length > 0) {
                    setActivePath(p => p || filesWithPatches[0].filename);
                }

                // Third fallback: Gitea returns null per-file `patch` for
                // many real-world PRs on BOTH /files and /compare. Fetch
                // the raw .diff endpoint (always works) and backfill any
                // file still missing a patch. Only triggered when needed
                // — the round-trip has real cost on large PRs.
                const stillMissing = filesWithPatches.some(f => !f.patch);
                if (stillMissing) {
                    try {
                        const rawDiffMap = await Git.getPullRequestDiff(owner, repo, prNumber);
                        if (cancelled) return;
                        if (rawDiffMap && rawDiffMap.size > 0) {
                            filesWithPatches = filesWithPatches.map(f =>
                                f.patch ? f : { ...f, patch: rawDiffMap.get(f.filename) || null }
                            );
                            setData(d => ({ ...d, files: filesWithPatches }));
                        }
                    } catch (e) {
                        // Non-fatal — surface still works without patches,
                        // empty-diff message tells the user which file lacks one.
                        console.warn('[pr-review] raw .diff fallback failed:', e.message);
                    }
                }
            } catch (e) {
                if (cancelled) return;
                setData(d => ({ ...d, loading: false, error: e.message || String(e) }));
            }
        }
        load();
        const off = EventBus.on('prs:refresh', load);
        return () => {
            cancelled = true;
            off();
        };
    }, [owner, repo, prNumber]);

    const commentCounts = useMemo(() => _commentCountsByPath(data.comments), [data.comments]);
    const commentsByAnchor = useMemo(() => _commentsByAnchor(data.comments), [data.comments]);

    // Slice 2 — capabilities are read once per render from the active
    // provider; the dock decides what to enable based on these flags.
    // Falls back to empty `{}` when no project is loaded so the UI
    // degrades to "everything disabled" instead of throwing.
    const capabilities = useMemo(() => {
        try { return Git.capabilities || {}; } catch { return {}; }
    }, [data.pr]);

    // Force-re-render seam for cross-component review-state updates
    // (e.g. user clicks `+` on a diff line → addDraft → dock count
    // updates AND the row's already-drafted indicator updates here).
    const [stateBump, setStateBump] = useState(0);
    useLayoutEffect(() => {
        const off = EventBus.on('pr-review:drafts-changed', () => setStateBump(n => n + 1));
        return off;
    }, []);

    const threadsResolvedLocal = useMemo(
        () => getResolvedLocal(prNumber).size,
        [prNumber, stateBump]
    );

    // Per-surface CI polling. 10s for the first 2 minutes, 30s after,
    // via recursive setTimeout so each next-tick is computed against
    // wall-clock elapsed time (not the previous tick's start). Cleanup
    // on unmount cancels the pending timeout — must be airtight so we
    // don't poll for a closed dock.
    //
    // Re-run resets the cadence: it sets ci.state back to `pending`,
    // the dep changes, the effect re-runs with a fresh `startTime`.
    //
    // The poll updates only `data.ci` — never emits `prs:refresh`,
    // which would kick a full reload + the rail PR panel refetch. That
    // is the load-bearing scope discipline for this slice.
    useLayoutEffect(() => {
        if (!shouldPoll(data.pr, data.ci)) return;
        let cancelled = false;
        let timeoutId = null;
        const startTime = Date.now();

        const schedule = () => {
            if (cancelled) return;
            const delay = nextPollDelay(Date.now() - startTime);
            timeoutId = setTimeout(tick, delay);
        };

        async function tick() {
            if (cancelled) return;
            try {
                const ci = await Git.getCommitStatus(owner, repo, data.pr.head);
                if (cancelled) return;
                setData(d => ({ ...d, ci }));
                if (ci?.state === 'pending') schedule();
            } catch (err) {
                if (cancelled) return;
                console.warn('[pr-review] CI poll failed:', err.message);
                schedule();
            }
        }

        schedule();
        return () => {
            cancelled = true;
            if (timeoutId) clearTimeout(timeoutId);
        };
    }, [data.ci?.state, data.pr?.state, data.pr?.merged, data.pr?.head, owner, repo]);

    /**
     * Reset CI back to `pending` so the polling effect re-fires.
     * Called by the dock's Re-run handler on success.
     */
    const handleCiPollReset = () => {
        setData(d => ({
            ...d,
            ci: { ...(d.ci || {}), state: 'pending' }
        }));
    };

    if (data.loading && !data.pr) {
        return html`
            <div class="pr-review">
                <${PrTopBar} pr=${null} onClose=${onClose} loading=${true} />
                <div class="pr-review__loading">Loading PR #${prNumber}…</div>
            </div>
        `;
    }
    if (data.error) {
        return html`
            <div class="pr-review">
                <${PrTopBar} pr=${null} onClose=${onClose} loading=${false} />
                <div class="pr-review__error">Failed to load PR #${prNumber}: ${data.error}</div>
            </div>
        `;
    }

    const headSha = data.pr?.headSha || '';
    const threadsTotal = commentsByAnchor.size;

    return html`
        <div class="pr-review">
            <${PrTopBar} pr=${data.pr} ci=${data.ci} onClose=${onClose} loading=${false} />
            <${PrTabs}
                active=${tab}
                onSelect=${setTab}
                counts=${{
                    conversation: data.comments.filter(c => !c.path).length,
                    files: data.files.length,
                    commits: data.commits.length,
                    checks: (data.ci.statuses && data.ci.statuses.length) || 0
                }}
            />
            <div class="pr-review__body">
                ${tab === 'files' && html`
                    <${PrFilesView}
                        files=${data.files}
                        commentCounts=${commentCounts}
                        commentsByAnchor=${commentsByAnchor}
                        activePath=${activePath}
                        onSelectPath=${setActivePath}
                        diffMode=${diffMode}
                        onDiffModeChange=${setDiffMode}
                        filter=${filter}
                        onFilterChange=${setFilter}
                        prNumber=${prNumber}
                        headSha=${headSha}
                        capabilities=${capabilities}
                        viewedBump=${stateBump}
                    />
                `}
                ${tab === 'conversation' && html`
                    <${PrConversationView} pr=${data.pr} comments=${data.comments} />
                `}
                ${tab === 'commits' && html`
                    <${PrCommitsView} commits=${data.commits} />
                `}
                ${tab === 'checks' && html`
                    <${PrChecksView} ci=${data.ci} />
                `}
            </div>
            <${PrReviewDock}
                prNumber=${prNumber}
                pr=${data.pr}
                ci=${data.ci}
                capabilities=${capabilities}
                threadsTotal=${threadsTotal}
                threadsResolvedLocal=${threadsResolvedLocal}
                onCiPollReset=${handleCiPollReset}
            />
        </div>
    `;
}

// ============================================
// Top bar
// ============================================

function PrTopBar({ pr, ci, onClose, loading }) {
    const stateKey = pr ? (pr.merged ? 'merged' : pr.state) : 'open';
    const state = STATE_BADGE[stateKey] || STATE_BADGE.open;
    const ciMeta = getCiStatusMeta(ci && ci.state);
    const ciInfo = { label: `${ciMeta.emoji} ${ciMeta.text}`, cls: ciMeta.cls };
    return html`
        <div class="pr-review__topbar">
            <button type="button" class="pr__btn pr__btn--ghost pr__back" onClick=${onClose} title="Back to editor (Esc)" aria-label="Back to editor">
                <span aria-hidden="true">←</span><span class="pr__back-label">Back</span>
            </button>
            ${loading
                ? html`<span class="pr__title pr__title--loading">Loading…</span>`
                : html`
                    <span class=${'pr__state-badge ' + state.cls}>${state.text}</span>
                    <span class="pr__title">
                        <span class="pr__num">#${pr.number}</span>
                        <span class="pr__title-text">${pr.title}</span>
                    </span>
                    <span class="pr__branches" title=${pr.head + ' → ' + pr.base}>
                        <code>${pr.head}</code>
                        <span class="pr__branch-arrow" aria-hidden="true">→</span>
                        <code>${pr.base}</code>
                    </span>
                    ${ci && html`<span class=${'pr__ci-badge ' + ciInfo.cls} title=${'CI: ' + ci.state}>${ciInfo.label}</span>`}
                    ${pr.url && html`
                        <a class="pr__btn pr__btn--ghost pr__ext" href=${pr.url} target="_blank" rel="noopener" title="Open in browser">
                            <span aria-hidden="true">↗</span>
                        </a>
                    `}
                `}
        </div>
    `;
}

// ============================================
// Tabs
// ============================================

function PrTabs({ active, onSelect, counts }) {
    const tabs = [
        { id: 'conversation', label: 'Conversation', count: counts.conversation },
        { id: 'files', label: 'Files', count: counts.files },
        { id: 'commits', label: 'Commits', count: counts.commits },
        { id: 'checks', label: 'Checks', count: counts.checks }
    ];
    return html`
        <div class="pr-review__tabs" role="tablist" aria-label="Pull request sections">
            ${tabs.map(t => html`
                <button
                    type="button"
                    role="tab"
                    aria-selected=${active === t.id}
                    class=${'pr__tab ' + (active === t.id ? 'pr__tab--active' : '')}
                    onClick=${() => onSelect(t.id)}
                    key=${t.id}>
                    <span class="pr__tab-label">${t.label}</span>
                    ${t.count > 0 && html`<span class="pr__tab-count">${t.count}</span>`}
                </button>
            `)}
        </div>
    `;
}

// ============================================
// Files view (file tree + diff pane)
// ============================================

function PrFilesView({ files, commentCounts, commentsByAnchor, activePath, onSelectPath, diffMode, onDiffModeChange, filter, onFilterChange, prNumber, headSha, capabilities, viewedBump }) {
    const filtered = useMemo(() => {
        const q = filter.trim().toLowerCase();
        if (!q) return files;
        return files.filter(f =>
            f.filename.toLowerCase().includes(q) ||
            (f.previousFilename && f.previousFilename.toLowerCase().includes(q))
        );
    }, [files, filter]);

    const active = files.find(f => f.filename === activePath) || null;

    if (files.length === 0) {
        return html`<div class="pr-review__empty">No changed files.</div>`;
    }

    return html`
        <div class="pr__files">
            <aside class="pr__filetree" aria-label="Changed files">
                <div class="pr__filetree-h">
                    <input
                        type="search"
                        class="pr__filter"
                        placeholder=${`Filter ${files.length} files…`}
                        value=${filter}
                        onInput=${(e) => onFilterChange(e.target.value)}
                        aria-label="Filter files" />
                </div>
                <ul class="pr__filelist" role="list">
                    ${filtered.map(f => {
                        const status = FILE_STATUS_MARK[f.status] || FILE_STATUS_MARK.modified;
                        const threadCount = commentCounts.get(f.filename) || 0;
                        const isActive = f.filename === activePath;
                        const viewed = isFileViewed(prNumber, f.filename);
                        const cls = 'pr__filerow'
                            + (isActive ? ' pr__filerow--active' : '')
                            + (viewed ? ' pr__filerow--viewed' : '');
                        return html`
                            <li class=${cls} key=${f.filename}>
                                <button type="button" class="pr__filebtn" onClick=${() => onSelectPath(f.filename)} title=${f.filename} aria-current=${isActive}>
                                    <span class=${'pr__filemark ' + status.cls} aria-label=${status.label}>${status.mark}</span>
                                    <span class="pr__filepath">${f.filename}</span>
                                    ${threadCount > 0 && html`
                                        <span class="pr__threadcount" title=${threadCount + ' comments'}>${'💬 ' + threadCount}</span>
                                    `}
                                    <span class="pr__filestats">
                                        <span class="pr__add">+${f.additions || 0}</span>
                                        <span class="pr__del">−${f.deletions || 0}</span>
                                    </span>
                                </button>
                                <label class="pr__filerow-viewed" title=${viewed ? 'Mark unviewed' : 'Mark viewed'} onClick=${(e) => e.stopPropagation()}>
                                    <input
                                        type="checkbox"
                                        checked=${viewed}
                                        onChange=${() => {
                                            toggleViewed(prNumber, f.filename);
                                            EventBus.emit('pr-review:drafts-changed', { prNumber });
                                        }}
                                        aria-label=${'Mark ' + f.filename + (viewed ? ' unviewed' : ' viewed')} />
                                    <span class="pr__filerow-viewed-label">Viewed</span>
                                </label>
                            </li>
                        `;
                    })}
                </ul>
            </aside>
            <section class="pr__diffpane" aria-label="Diff for selected file">
                ${active
                    ? html`<${PrFileDiff}
                            file=${active}
                            mode=${diffMode}
                            onModeChange=${onDiffModeChange}
                            commentsByAnchor=${commentsByAnchor}
                            prNumber=${prNumber}
                            headSha=${headSha}
                            capabilities=${capabilities} />`
                    : html`<div class="pr-review__empty">Select a file to view its diff.</div>`}
            </section>
        </div>
    `;
}

// ============================================
// File diff (a single file's hunks)
// ============================================

function PrFileDiff({ file, mode, onModeChange, commentsByAnchor, prNumber, headSha, capabilities }) {
    const parsed = useMemo(() => parsePatch(file.patch), [file.patch]);

    return html`
        <div class="pr__file">
            <div class="pr__file-h">
                <span class="pr__file-h-path">${file.filename}</span>
                ${file.previousFilename && html`
                    <span class="pr__file-h-prev" title=${'renamed from ' + file.previousFilename}>← ${file.previousFilename}</span>
                `}
                <span class="pr__file-h-spacer"></span>
                <div class="pr__file-h-modes" role="tablist" aria-label="Diff view mode">
                    <button type="button" class=${'pr__mode ' + (mode === 'split' ? 'pr__mode--active' : '')} onClick=${() => onModeChange('split')} aria-selected=${mode === 'split'}>Split</button>
                    <button type="button" class=${'pr__mode ' + (mode === 'unified' ? 'pr__mode--active' : '')} onClick=${() => onModeChange('unified')} aria-selected=${mode === 'unified'}>Unified</button>
                </div>
            </div>
            ${parsed.hunks.length === 0
                ? html`<div class="pr-review__empty">${file.patch ? 'Empty patch.' : 'No textual diff (binary or unchanged).'}</div>`
                : parsed.hunks.map((h, idx) => html`
                    <${PrHunk} hunk=${h} mode=${mode} path=${file.filename} commentsByAnchor=${commentsByAnchor} prNumber=${prNumber} headSha=${headSha} capabilities=${capabilities} key=${idx} />
                `)}
        </div>
    `;
}

function PrHunk({ hunk, mode, path, commentsByAnchor, prNumber, headSha, capabilities }) {
    const { rows, truncated } = truncateRows(hunk.rows);
    return html`
        <div class="pr__hunk">
            <div class="pr__hunk-h" title=${hunk.header}>${hunk.header}</div>
            ${mode === 'split'
                ? html`<${PrHunkSplit} rows=${rows} path=${path} commentsByAnchor=${commentsByAnchor} prNumber=${prNumber} headSha=${headSha} capabilities=${capabilities} />`
                : html`<${PrHunkUnified} rows=${rows} path=${path} commentsByAnchor=${commentsByAnchor} prNumber=${prNumber} headSha=${headSha} capabilities=${capabilities} />`}
            ${truncated > 0 && html`
                <div class="pr__hunk-truncated">… ${truncated} more rows hidden (open in browser to view full diff)</div>
            `}
        </div>
    `;
}

function PrHunkUnified({ rows, path, commentsByAnchor, prNumber, headSha, capabilities }) {
    return html`
        <div class="pr__diff pr__diff--unified" role="table" aria-label="Unified diff">
            ${rows.map((r, i) => {
                const side = r.r != null ? 'RIGHT' : (r.l != null ? 'LEFT' : null);
                const lineNo = side === 'RIGHT' ? r.r : (side === 'LEFT' ? r.l : null);
                const lineKey = side && lineNo != null ? `${path}::${side}::${lineNo}` : null;
                const threads = lineKey ? commentsByAnchor.get(lineKey) : null;
                const canAddComment = side && lineNo != null && capabilities?.reviewSubmission;
                return html`
                    <div class=${'pr__row pr__row--' + r.kind} role="row" key=${i}>
                        <span class="pr__ln pr__ln--l" aria-hidden="true">${r.l ?? ''}</span>
                        <span class="pr__ln pr__ln--r" aria-hidden="true">${r.r ?? ''}</span>
                        <span class="pr__code">${_signFor(r.kind)}${r.code}</span>
                        ${canAddComment && html`
                            <${PrAddCommentButton} prNumber=${prNumber} path=${path} line=${lineNo} side=${side} headSha=${headSha} />
                        `}
                    </div>
                    ${threads && html`<${PrThreadRow} threads=${threads} prNumber=${prNumber} path=${path} side=${side} headSha=${headSha} capabilities=${capabilities} colspan=${3} />`}
                `;
            })}
        </div>
    `;
}

function PrHunkSplit({ rows, path, commentsByAnchor, prNumber, headSha, capabilities }) {
    const paired = useMemo(() => pairSideBySide(rows), [rows]);
    return html`
        <div class="pr__diff pr__diff--split" role="table" aria-label="Side-by-side diff">
            ${paired.map((p, i) => {
                const leftKey = p.left && p.left.l != null ? `${path}::LEFT::${p.left.l}` : null;
                const rightKey = p.right && p.right.r != null ? `${path}::RIGHT::${p.right.r}` : null;
                const leftThreads = leftKey ? commentsByAnchor.get(leftKey) : null;
                const rightThreads = rightKey ? commentsByAnchor.get(rightKey) : null;
                const canAddLeft = p.left && p.left.l != null && capabilities?.reviewSubmission;
                const canAddRight = p.right && p.right.r != null && capabilities?.reviewSubmission;
                return html`
                    <div class="pr__row-split" role="row" key=${i}>
                        <span class=${'pr__cell-ln ' + (p.left ? 'pr__cell--' + p.left.kind : 'pr__cell--blank')}>${p.left ? p.left.l : ''}</span>
                        <span class=${'pr__cell-code ' + (p.left ? 'pr__cell--' + p.left.kind : 'pr__cell--blank')}>
                            ${p.left ? p.left.code : ''}
                            ${canAddLeft && html`
                                <${PrAddCommentButton} prNumber=${prNumber} path=${path} line=${p.left.l} side="LEFT" headSha=${headSha} />
                            `}
                        </span>
                        <span class=${'pr__cell-ln ' + (p.right ? 'pr__cell--' + p.right.kind : 'pr__cell--blank')}>${p.right ? p.right.r : ''}</span>
                        <span class=${'pr__cell-code ' + (p.right ? 'pr__cell--' + p.right.kind : 'pr__cell--blank')}>
                            ${p.right ? p.right.code : ''}
                            ${canAddRight && html`
                                <${PrAddCommentButton} prNumber=${prNumber} path=${path} line=${p.right.r} side="RIGHT" headSha=${headSha} />
                            `}
                        </span>
                    </div>
                    ${(leftThreads || rightThreads) && html`
                        <div class="pr__thread-split-row" role="row">
                            <div class="pr__thread-side">
                                ${leftThreads && html`<${PrThreadRow} threads=${leftThreads} prNumber=${prNumber} path=${path} side="LEFT" headSha=${headSha} capabilities=${capabilities} colspan=${1} />`}
                            </div>
                            <div class="pr__thread-side">
                                ${rightThreads && html`<${PrThreadRow} threads=${rightThreads} prNumber=${prNumber} path=${path} side="RIGHT" headSha=${headSha} capabilities=${capabilities} colspan=${1} />`}
                            </div>
                        </div>
                    `}
                `;
            })}
        </div>
    `;
}

/**
 * Per-line `+` button. Hover-revealed via CSS; click expands the
 * inline composer below the row. Saves draft into review-state and
 * fires the cross-component `pr-review:drafts-changed` event so the
 * dock count and any sibling subscribers re-render.
 */
function PrAddCommentButton({ prNumber, path, line, side, headSha }) {
    const [open, setOpen] = useState(false);
    if (!open) {
        return html`
            <button
                type="button"
                class="pr-row__add-btn"
                onClick=${(e) => { e.stopPropagation(); setOpen(true); }}
                aria-label=${'Add comment on ' + path + ' line ' + line + ' (' + side + ')'}
                title="Add comment on this line">
                +
            </button>
        `;
    }
    return html`
        <div class="pr-row__composer" onClick=${(e) => e.stopPropagation()}>
            <${PrCommentComposer}
                placeholder=${'Comment on ' + path + ':' + line}
                submitLabel="Add to review"
                onSave=${({ body }) => {
                    addDraft(prNumber, { path, line, side, body, commitSha: headSha });
                    EventBus.emit('pr-review:drafts-changed', { prNumber });
                    setOpen(false);
                }}
                onCancel=${() => setOpen(false)} />
        </div>
    `;
}

function _signFor(kind) {
    if (kind === 'add') return '+';
    if (kind === 'del') return '−';
    return ' ';
}

function PrThreadRow({ threads, prNumber, path, side, headSha, capabilities }) {
    const [replying, setReplying] = useState(false);
    const [replyBusy, setReplyBusy] = useState(false);
    const [replyError, setReplyError] = useState(/** @type {string|null} */ (null));
    const canReply = capabilities?.reviewSubmission && threads && threads.length > 0;

    async function handleReplySave({ body }) {
        if (replyBusy) return;
        setReplyBusy(true);
        setReplyError(null);
        try {
            if (!State.currentProject) throw new Error('No project loaded');
            const { owner, repo } = State.currentProject;
            await Git.createReviewComment(owner, repo, prNumber, {
                body,
                in_reply_to: threads[0].id,
                commitSha: headSha,
                path,
                line: threads[0].line,
                side,
            });
            setReplying(false);
            EventBus.emit('prs:refresh');
        } catch (e) {
            setReplyError(e?.message || String(e));
        } finally {
            setReplyBusy(false);
        }
    }

    return html`
        <div class="pr__threads" role="row">
            ${threads.map(c => html`
                <div class="pr__thread" key=${c.id}>
                    <div class="pr__thread-h">
                        <strong>${c.user || 'unknown'}</strong>
                        ${c.createdAt && html`<span class="pr__thread-when"> · ${_formatDate(c.createdAt)}</span>`}
                    </div>
                    <div class="pr__thread-body" dangerouslySetInnerHTML=${{ __html: renderMarkdown(c.body || '') }}></div>
                </div>
            `)}
            ${canReply && !replying && html`
                <div class="pr__thread-actions">
                    <button
                        type="button"
                        class="pr__btn pr__btn--ghost pr__btn--xs"
                        onClick=${() => setReplying(true)}>
                        ↩ Reply
                    </button>
                </div>
            `}
            ${replying && html`
                <div class="pr__thread-composer">
                    <${PrCommentComposer}
                        placeholder="Reply…"
                        submitLabel="Post reply"
                        busy=${replyBusy}
                        error=${replyError}
                        onSave=${handleReplySave}
                        onCancel=${() => { setReplying(false); setReplyError(null); }} />
                </div>
            `}
        </div>
    `;
}

function _formatDate(iso) {
    try {
        return new Date(iso).toLocaleDateString();
    } catch {
        return '';
    }
}

// ============================================
// Conversation view
// ============================================

function PrConversationView({ pr, comments }) {
    const general = comments.filter(c => !c.path);
    return html`
        <div class="pr__conversation">
            ${pr && pr.body && html`
                <div class="pr__convo-body">
                    <div class="pr__convo-h">
                        <strong>${pr.user || 'unknown'}</strong>
                        ${pr.createdAt && html`<span class="pr__thread-when"> · ${_formatDate(pr.createdAt)}</span>`}
                    </div>
                    <div class="pr__convo-md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(pr.body) }}></div>
                </div>
            `}
            ${general.length === 0
                ? html`<div class="pr-review__empty pr__convo-empty">No discussion yet.</div>`
                : general.map(c => html`
                    <div class="pr__convo-comment" key=${c.id}>
                        <div class="pr__convo-h">
                            <strong>${c.user || 'unknown'}</strong>
                            ${c.createdAt && html`<span class="pr__thread-when"> · ${_formatDate(c.createdAt)}</span>`}
                        </div>
                        <div class="pr__convo-md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(c.body || '') }}></div>
                    </div>
                `)}
        </div>
    `;
}

// ============================================
// Commits view
// ============================================

function PrCommitsView({ commits }) {
    if (!commits || commits.length === 0) {
        return html`<div class="pr-review__empty">No commit history available.</div>`;
    }
    return html`
        <ul class="pr__commits" role="list">
            ${commits.map(c => html`
                <li class="pr__commit" key=${c.sha}>
                    <code class="pr__commit-sha">${c.shortSha || (c.sha || '').slice(0, 7)}</code>
                    <span class="pr__commit-msg">${c.subject || (c.message || '').split('\n')[0]}</span>
                    <span class="pr__commit-author">${c.author || 'unknown'}</span>
                    <span class="pr__commit-date">${_formatDate(c.date)}</span>
                </li>
            `)}
        </ul>
    `;
}

// ============================================
// Checks view
// ============================================

function PrChecksView({ ci }) {
    if (!ci || !ci.statuses || ci.statuses.length === 0) {
        return html`<div class="pr-review__empty">No CI checks reported.</div>`;
    }
    return html`
        <ul class="pr__checks" role="list">
            ${ci.statuses.map((s, i) => {
                const m = getCiStatusMeta(s.state);
                const label = `${m.emoji} ${m.text}`;
                return html`
                    <li class=${'pr__check pr__check--' + (s.state || 'unknown')} key=${i}>
                        <span class="pr__check-state">${label}</span>
                        <span class="pr__check-context">${s.context || s.name || 'check'}</span>
                        ${s.description && html`<span class="pr__check-desc">${s.description}</span>`}
                        ${s.target_url && html`<a href=${s.target_url} target="_blank" rel="noopener" class="pr__check-link">details ↗</a>`}
                    </li>
                `;
            })}
        </ul>
    `;
}
