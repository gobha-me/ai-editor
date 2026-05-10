// @ts-check
/**
 * Merge Conflict Resolver — Preact + htm root.
 *
 * Three-pane (Theirs / Resolved / Ours) per-hunk surface for reconciling
 * a PR/MR whose provider reports `mergeable: false`. v1 covers Take
 * theirs / Take ours per hunk + push resolved content to the head
 * branch. Take both, AI resolve, and the conflict minimap are slice-2
 * follow-ups.
 *
 * v1 trade-off: 2-way diff between base and head (no merge-base leg).
 * The resolution is committed to the head branch so the provider's next
 * mergeability check passes; the actual merge runs through the existing
 * PR Review surface's Merge button.
 *
 * Mirrors the lifecycle pattern in
 * [`js/pr-review/PrReviewSurface.js`]: async `getPreact()` at module
 * top, `useLayoutEffect` for EventBus subscriptions (the vendor-bundle
 * env queues `useEffect` until the next render — layout effects flush
 * synchronously so subscriptions are live the instant mountPreact
 * resolves).
 *
 * @since 2.18.0 (Touch 3 Merge Conflict Resolver — slice 1)
 * @module merge-conflict/MergeConflictSurface
 */

import { EventBus } from '../core.js';
import { Git } from '../git.js';
import { getPreact } from '../utils/preact-mount.js';
import { extractHunks } from './hunks.js';
import { applyResolutions } from './resolve.js';

const { html, useState, useLayoutEffect, useMemo } = await getPreact();

/**
 * Root component. Owns its own data fetch via `Git.getMergeConflicts`.
 * The mount module supplies `{ owner, repo, prNumber, onClose }`.
 *
 * @param {{owner:string, repo:string, prNumber:number, onClose:Function}} props
 */
export function MergeConflictSurface({ owner, repo, prNumber, onClose }) {
    const [data, setData] = useState({
        loading: true,
        error: null,
        baseRef: '',
        headRef: '',
        files: /** @type {Array<{path:string, base:string, head:string, headSha:string|null, status:string|null, hunks: any[]}>} */ ([]),
    });
    const [activeIdx, setActiveIdx] = useState(0);
    /** @type {[Object<string, Object<number, 'theirs'|'ours'>>, Function]} */
    const [resolutions, setResolutions] = useState({});
    const [pushing, setPushing] = useState(false);
    const [pushError, setPushError] = useState(/** @type {string|null} */ (null));

    useLayoutEffect(() => {
        let cancelled = false;
        async function load() {
            try {
                const res = await Git.getMergeConflicts(owner, repo, prNumber);
                if (cancelled) return;
                if (!res || !res.supported) {
                    setData(d => ({
                        ...d,
                        loading: false,
                        error: 'Merge conflict resolution is not supported for this provider.',
                    }));
                    return;
                }
                const filesWithHunks = (res.files || [])
                    .map(f => ({
                        path: f.path,
                        base: f.base || '',
                        head: f.head || '',
                        headSha: f.headSha || null,
                        status: f.status || null,
                        hunks: extractHunks(f.base || '', f.head || ''),
                    }))
                    .filter(f => f.hunks.length > 0);
                setData({
                    loading: false,
                    error: null,
                    baseRef: res.baseRef || '',
                    headRef: res.headRef || '',
                    files: filesWithHunks,
                });
                setActiveIdx(0);
                setResolutions({});
                EventBus.emit('mergeConflict:opened', { prNumber, fileCount: filesWithHunks.length });
            } catch (e) {
                if (cancelled) return;
                console.error('[merge-conflict] load failed:', e);
                setData(d => ({ ...d, loading: false, error: e?.message || String(e) }));
            }
        }
        load();
        return () => { cancelled = true; };
    }, [owner, repo, prNumber]);

    // Derived counts.
    const summary = useMemo(() => {
        let total = 0;
        let resolved = 0;
        for (const f of data.files) {
            for (const h of f.hunks) {
                total++;
                if (resolutions[f.path]?.[h.id]) resolved++;
            }
        }
        return { total, resolved };
    }, [data.files, resolutions]);

    const allResolved = summary.total > 0 && summary.resolved === summary.total;
    const activeFile = data.files[activeIdx] || null;

    function pickHunk(filePath, hunkId, choice) {
        setResolutions(prev => ({
            ...prev,
            [filePath]: { ...(prev[filePath] || {}), [hunkId]: choice },
        }));
    }

    async function handlePush() {
        if (!allResolved || pushing) return;
        setPushing(true);
        setPushError(null);
        try {
            const filesPayload = data.files.map(f => ({
                path: f.path,
                content: applyResolutions(f.base, f.head, resolutions[f.path] || {}),
                sha: f.headSha || undefined,
            }));
            const message = `Resolve merge conflicts for #${prNumber} into ${data.headRef}\n\n${filesPayload.map(f => `- ${f.path}`).join('\n')}`;
            await Git.batchCommitFilesOnBranch(owner, repo, data.headRef, filesPayload, message);
            EventBus.emit('mergeConflict:resolved', {
                prNumber,
                files: filesPayload.map(f => f.path),
                headRef: data.headRef,
            });
            EventBus.emit('prs:refresh');
            onClose();
        } catch (e) {
            console.error('[merge-conflict] push failed:', e);
            setPushError(e?.message || String(e));
        } finally {
            setPushing(false);
        }
    }

    function handleAbort() {
        EventBus.emit('mergeConflict:aborted', { prNumber });
        onClose();
    }

    if (data.loading) {
        return html`
            <div class="mc">
                <${TopBar}
                    baseRef=${data.baseRef}
                    headRef=${data.headRef}
                    summary=${summary}
                    pushing=${false}
                    onAbort=${handleAbort}
                    onPush=${handlePush}
                    pushDisabled=${true}
                    pushLabel="Loading…" />
                <div class="mc__loading">Loading merge conflicts for PR #${prNumber}…</div>
            </div>
        `;
    }
    if (data.error) {
        return html`
            <div class="mc">
                <${TopBar}
                    baseRef=${data.baseRef}
                    headRef=${data.headRef}
                    summary=${summary}
                    pushing=${false}
                    onAbort=${handleAbort}
                    onPush=${handlePush}
                    pushDisabled=${true}
                    pushLabel="Push & close" />
                <div class="mc__error">Failed to load merge conflicts: ${data.error}</div>
            </div>
        `;
    }
    if (data.files.length === 0) {
        return html`
            <div class="mc">
                <${TopBar}
                    baseRef=${data.baseRef}
                    headRef=${data.headRef}
                    summary=${summary}
                    pushing=${false}
                    onAbort=${handleAbort}
                    onPush=${handlePush}
                    pushDisabled=${true}
                    pushLabel="Push & close" />
                <div class="mc__empty">
                    No conflicting files detected. The PR may already be mergeable; refresh the PR Review surface to confirm.
                </div>
            </div>
        `;
    }

    const pushLabel = pushing
        ? '⏳ Pushing…'
        : `Push resolved to ${data.headRef || 'head'}`;

    return html`
        <div class="mc">
            <${TopBar}
                baseRef=${data.baseRef}
                headRef=${data.headRef}
                summary=${summary}
                pushing=${pushing}
                onAbort=${handleAbort}
                onPush=${handlePush}
                pushDisabled=${!allResolved || pushing}
                pushLabel=${pushLabel} />
            ${pushError && html`<div class="mc__error">Push failed: ${pushError}</div>`}
            <div class="mc__body">
                <${FilePane}
                    files=${data.files}
                    resolutions=${resolutions}
                    activeIdx=${activeIdx}
                    onSelect=${setActiveIdx} />
                <div class="mc__main">
                    ${activeFile && activeFile.hunks.map((h, i) => html`
                        <${HunkRow}
                            key=${activeFile.path + ':' + h.id}
                            hunk=${h}
                            idx=${i}
                            choice=${resolutions[activeFile.path]?.[h.id] || null}
                            onPick=${(c) => pickHunk(activeFile.path, h.id, c)} />
                    `)}
                </div>
            </div>
        </div>
    `;
}

// ============================================
// Top bar
// ============================================

function TopBar({ baseRef, headRef, summary, pushing, onAbort, onPush, pushDisabled, pushLabel }) {
    const pct = summary.total === 0 ? 0 : Math.round((summary.resolved / summary.total) * 100);
    return html`
        <div class="mc__topbar">
            <span class="mc__title-block">
                <span class="mc__warn-glyph" aria-hidden="true">⚠</span>
                <span class="mc__title">Resolve conflicts</span>
                ${baseRef && headRef && html`
                    <span class="mc__sub">merging <code>${baseRef}</code> into <code>${headRef}</code></span>
                `}
            </span>
            <div class="mc__topbar-meta">
                <span class="mc__progress">
                    <span class="mc__progress-bar"><span style=${`width: ${pct}%`}></span></span>
                    <span>${summary.resolved} of ${summary.total} resolved</span>
                </span>
                <button type="button" class="mc__btn" onClick=${onAbort} disabled=${pushing}>
                    Abort
                </button>
                <button type="button" class="mc__btn mc__btn--primary" onClick=${onPush} disabled=${pushDisabled}>
                    ${pushLabel}
                </button>
            </div>
        </div>
    `;
}

// ============================================
// File pane (left)
// ============================================

function FilePane({ files, resolutions, activeIdx, onSelect }) {
    return html`
        <div class="mc__filepane" role="navigation" aria-label="Conflicting files">
            <div class="mc__filepane-head">Conflicting files</div>
            ${files.map((f, i) => {
                const total = f.hunks.length;
                const resolvedCount = Object.keys(resolutions[f.path] || {}).length;
                const status = resolvedCount === 0
                    ? 'pending'
                    : resolvedCount < total
                        ? 'active'
                        : 'done';
                const cls = `mc__file-row mc__file-row--${status}` + (i === activeIdx ? ' mc__file-row--current' : '');
                return html`
                    <button type="button"
                        class=${cls}
                        onClick=${() => onSelect(i)}
                        aria-current=${i === activeIdx ? 'true' : 'false'}>
                        <span class=${`mc__file-pip mc__file-pip--${status}`}></span>
                        <span class="mc__file-path">${f.path}</span>
                        <span class="mc__file-stat">${resolvedCount}/${total}</span>
                    </button>
                `;
            })}
        </div>
    `;
}

// ============================================
// Hunk row (three-pane)
// ============================================

function HunkRow({ hunk, idx, choice, onPick }) {
    const stateClass = choice
        ? `mc__hunk--resolved-${choice}`
        : 'mc__hunk--unresolved';
    return html`
        <div class=${`mc__hunk ${stateClass}`}>
            <div class="mc__hunk-head">
                <span class="mc__hunk-num">Conflict ${idx + 1}</span>
                <span class="mc__hunk-line">L${hunk.lineNo}</span>
                ${choice
                    ? html`<span class="mc__hunk-state mc__hunk-state--resolved">Resolved (took ${choice})</span>`
                    : html`<span class="mc__hunk-state mc__hunk-state--unresolved">Unresolved</span>`}
                <div class="mc__hunk-actions">
                    <button type="button"
                        class=${'mc__act mc__act--theirs' + (choice === 'theirs' ? ' mc__act--picked' : '')}
                        onClick=${() => onPick('theirs')}>
                        ← Take theirs
                    </button>
                    <button type="button"
                        class=${'mc__act mc__act--ours' + (choice === 'ours' ? ' mc__act--picked' : '')}
                        onClick=${() => onPick('ours')}>
                        Take ours →
                    </button>
                </div>
            </div>
            <div class="mc__three">
                <${CodePane}
                    side="theirs"
                    label="Incoming"
                    lineNo=${hunk.lineNo}
                    lines=${hunk.theirs} />
                <${ResolvedPane}
                    lineNo=${hunk.lineNo}
                    lines=${choice === 'theirs' ? hunk.theirs : choice === 'ours' ? hunk.ours : null} />
                <${CodePane}
                    side="ours"
                    label="Current"
                    lineNo=${hunk.lineNo}
                    lines=${hunk.ours} />
            </div>
        </div>
    `;
}

function CodePane({ side, label, lineNo, lines }) {
    const arrow = side === 'theirs' ? '◀' : '▶';
    return html`
        <div class=${`mc__pane mc__pane--${side}`}>
            <div class=${`mc__pane-head mc__pane-head--${side}`}>
                <span class="mc__pane-head-l">
                    <span class=${`mc__side-mark mc__side-mark--${side}`} aria-hidden="true">${arrow}</span>
                    <strong>${label}</strong>
                </span>
                <span class="mc__pane-head-r">${lines.length} line${lines.length === 1 ? '' : 's'}</span>
            </div>
            <pre class="mc__code">
                ${lines.length === 0
                    ? html`<div class="mc__code-empty">(empty)</div>`
                    : lines.map((l, i) => html`
                        <div class=${`mc__code-row mc__code-row--${side}`} key=${i}>
                            <span class="mc__code-num">${lineNo + i}</span>
                            <span class="mc__code-line">${l}</span>
                        </div>
                    `)}
            </pre>
        </div>
    `;
}

function ResolvedPane({ lineNo, lines }) {
    return html`
        <div class="mc__pane mc__pane--resolved">
            <div class="mc__pane-head mc__pane-head--resolved">
                <span class="mc__pane-head-l">
                    <span class="mc__side-mark mc__side-mark--res" aria-hidden="true">●</span>
                    <strong>Resolved</strong>
                </span>
                <span class="mc__pane-head-r">${lines == null ? '—' : `${lines.length} line${lines.length === 1 ? '' : 's'}`}</span>
            </div>
            ${lines == null
                ? html`
                    <div class="mc__resolved-empty">
                        <span>Pick a side above.</span>
                    </div>
                `
                : html`
                    <pre class="mc__code mc__code--resolved">
                        ${lines.length === 0
                            ? html`<div class="mc__code-empty">(empty)</div>`
                            : lines.map((l, i) => html`
                                <div class="mc__code-row mc__code-row--resolved" key=${i}>
                                    <span class="mc__code-num">${lineNo + i}</span>
                                    <span class="mc__code-line">${l}</span>
                                </div>
                            `)}
                    </pre>
                `}
        </div>
    `;
}
