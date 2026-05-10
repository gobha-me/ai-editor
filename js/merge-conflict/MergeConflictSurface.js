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
 *   - 2.19.0 (slice 2): Take both action, ResolvedPane both branch,
 *     scroll-anchored hunk ids feeding the new Minimap component.
 *   - 2.21.0 (slice 3): per-hunk AI resolve action + inline approval
 *     card. Mirrors the v2.14.0 PR Review Diagnose & fix lifecycle.
 * @module merge-conflict/MergeConflictSurface
 */

import { EventBus } from '../core.js';
import { Git } from '../git.js';
import { LLM } from '../llm/api.js';
import { getPreact } from '../utils/preact-mount.js';
import { extractHunks, splitLines } from './hunks.js';
import { applyResolutions } from './resolve.js';
import { Minimap } from './Minimap.js';
import { buildAiResolveMessages } from './ai-resolve-prompt.js';
import { parseAiResolveResponse } from './ai-resolve-parse.js';

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
    /** @type {[Object<string, Object<number, import('./resolve.js').ResolutionChoice>>, Function]} */
    const [resolutions, setResolutions] = useState({});
    const [pushing, setPushing] = useState(false);
    const [pushError, setPushError] = useState(/** @type {string|null} */ (null));

    /**
     * Per-hunk AI proposal state. Keyed `${path}:${hunkId}`.
     * `token` is a race-marker — when the user picks a string side
     * mid-flight, `pickHunk` clears the entry; the resolved Promise
     * checks the token at write time and drops the result if it's
     * stale or missing.
     *
     * @type {[Object<string, {status:'running'|'proposed'|'error', token:number, content?:string[], rationale?:string, error?:string}>, Function]}
     */
    const [pendingAi, setPendingAi] = useState({});

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
        // Clear any in-flight or proposed AI state for this hunk — the
        // string pick wins and the AI Promise (if running) will see a
        // missing/changed token at write time and drop its result.
        const key = filePath + ':' + hunkId;
        setPendingAi(prev => {
            if (!prev[key]) return prev;
            const next = { ...prev };
            delete next[key];
            return next;
        });
    }

    /**
     * Slice 5 lines of unchanged context from the base file around a
     * hunk. Clipped at file edges; the prompt builder substitutes
     * explicit edge markers when an array is empty.
     *
     * @param {{path:string, base:string, hunks:Array<{id:number, lineNo:number, theirs:string[]}>}} file
     * @param {{id:number, lineNo:number, theirs:string[]}} hunk
     * @returns {{contextBefore:string[], contextAfter:string[]}}
     */
    function getHunkContext(file, hunk) {
        const baseLines = splitLines(file.base || '');
        const start0 = Math.max(0, hunk.lineNo - 1);
        const end0 = Math.min(baseLines.length, start0 + (hunk.theirs?.length || 0));
        const beforeStart = Math.max(0, start0 - 5);
        const afterEnd = Math.min(baseLines.length, end0 + 5);
        return {
            contextBefore: baseLines.slice(beforeStart, start0),
            contextAfter: baseLines.slice(end0, afterEnd),
        };
    }

    async function handleAiResolve(filePath, hunk) {
        const key = filePath + ':' + hunk.id;
        const token = Date.now() + Math.random();
        setPendingAi(prev => ({ ...prev, [key]: { status: 'running', token } }));
        EventBus.emit('mergeConflict:aiResolve:start', { prNumber, path: filePath, hunkId: hunk.id });

        const file = data.files.find(f => f.path === filePath);
        if (!file) {
            setPendingAi(prev => {
                if (prev[key]?.token !== token) return prev;
                return { ...prev, [key]: { status: 'error', token, error: 'File not found in surface state.' } };
            });
            return;
        }
        const { contextBefore, contextAfter } = getHunkContext(file, hunk);
        const messages = buildAiResolveMessages({
            filePath,
            theirs: hunk.theirs || [],
            ours: hunk.ours || [],
            contextBefore,
            contextAfter,
        });

        try {
            const result = await LLM.chat(messages, { stream: false, temperature: 0.2 });
            const parsed = parseAiResolveResponse(result?.content || '');
            // Race-token check: a `pickHunk` mid-flight (or another AI
            // resolve on the same hunk) clears or replaces the entry.
            // Drop our result silently in either case.
            setPendingAi(prev => {
                if (prev[key]?.token !== token) return prev;
                if (!parsed.ok) {
                    EventBus.emit('mergeConflict:aiResolve:error', { prNumber, path: filePath, hunkId: hunk.id, error: parsed.error });
                    return { ...prev, [key]: { status: 'error', token, error: parsed.error } };
                }
                EventBus.emit('mergeConflict:aiResolve:success', { prNumber, path: filePath, hunkId: hunk.id });
                return { ...prev, [key]: { status: 'proposed', token, content: parsed.resolvedLines, rationale: parsed.rationale } };
            });
        } catch (e) {
            const msg = e?.message || String(e);
            setPendingAi(prev => {
                if (prev[key]?.token !== token) return prev;
                EventBus.emit('mergeConflict:aiResolve:error', { prNumber, path: filePath, hunkId: hunk.id, error: msg });
                return { ...prev, [key]: { status: 'error', token, error: msg } };
            });
        }
    }

    function handleAiApprove(filePath, hunk) {
        const key = filePath + ':' + hunk.id;
        const entry = pendingAi[key];
        if (!entry || entry.status !== 'proposed' || !Array.isArray(entry.content)) return;
        // Normalize: collapse no-op AI output into the existing string
        // choice so the CSS / minimap state matches user intent.
        const content = entry.content;
        const eqArray = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
        let normalized;
        if (eqArray(content, hunk.theirs || [])) normalized = 'theirs';
        else if (eqArray(content, hunk.ours || [])) normalized = 'ours';
        else if (eqArray(content, [...(hunk.theirs || []), ...(hunk.ours || [])])) normalized = 'both';
        else normalized = { choice: 'ai', content };
        // Re-use pickHunk for the write — but pickHunk also clears the
        // AI entry, which is what we want.
        pickHunk(filePath, hunk.id, normalized);
    }

    function handleAiReject(filePath, hunkId) {
        const key = filePath + ':' + hunkId;
        setPendingAi(prev => {
            if (!prev[key]) return prev;
            const next = { ...prev };
            delete next[key];
            return next;
        });
    }

    /**
     * Scroll a hunk into view inside the main hunk list. Called from the
     * Minimap when the user clicks a band. Lookup by id is stable across
     * renders because each `mc__hunk` carries `id="mc-hunk-${h.id}"`.
     */
    function jumpToHunk(hunkId) {
        const el = document.getElementById('mc-hunk-' + hunkId);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
                    ${activeFile && activeFile.hunks.map((h, i) => {
                        const key = activeFile.path + ':' + h.id;
                        return html`
                            <${HunkRow}
                                key=${key}
                                hunk=${h}
                                idx=${i}
                                choice=${resolutions[activeFile.path]?.[h.id] || null}
                                aiState=${pendingAi[key] || null}
                                onPick=${(c) => pickHunk(activeFile.path, h.id, c)}
                                onAiResolve=${() => handleAiResolve(activeFile.path, h)}
                                onAiApprove=${() => handleAiApprove(activeFile.path, h)}
                                onAiReject=${() => handleAiReject(activeFile.path, h.id)} />
                        `;
                    })}
                </div>
                <${Minimap}
                    hunks=${activeFile?.hunks || []}
                    fileResolutions=${activeFile ? resolutions[activeFile.path] : null}
                    onJump=${jumpToHunk} />
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

function HunkRow({ hunk, idx, choice, aiState, onPick, onAiResolve, onAiApprove, onAiReject }) {
    const isAiChoice = typeof choice === 'object' && choice !== null && choice.choice === 'ai';
    const choiceKey = isAiChoice ? 'ai' : (typeof choice === 'string' ? choice : null);
    const aiRunning = aiState?.status === 'running';
    const aiProposed = aiState?.status === 'proposed';
    const aiError = aiState?.status === 'error';

    let stateClass;
    if (choiceKey) stateClass = `mc__hunk--resolved-${choiceKey}`;
    else if (aiRunning) stateClass = 'mc__hunk--unresolved mc__hunk--pending-ai';
    else stateClass = 'mc__hunk--unresolved';

    const resolvedLines = choice === 'theirs'
        ? hunk.theirs
        : choice === 'ours'
            ? hunk.ours
            : choice === 'both'
                ? [...hunk.theirs, ...hunk.ours]
                : isAiChoice
                    ? choice.content
                    : null;

    return html`
        <div class=${`mc__hunk ${stateClass}`} id=${'mc-hunk-' + hunk.id}>
            <div class="mc__hunk-head">
                <span class="mc__hunk-num">Conflict ${idx + 1}</span>
                <span class="mc__hunk-line">L${hunk.lineNo}</span>
                ${choiceKey
                    ? html`<span class="mc__hunk-state mc__hunk-state--resolved">Resolved (took ${choiceKey})</span>`
                    : html`<span class="mc__hunk-state mc__hunk-state--unresolved">Unresolved</span>`}
                <div class="mc__hunk-actions">
                    <button type="button"
                        class=${'mc__act mc__act--theirs' + (choiceKey === 'theirs' ? ' mc__act--picked' : '')}
                        onClick=${() => onPick('theirs')}>
                        ← Take theirs
                    </button>
                    <button type="button"
                        class=${'mc__act mc__act--both' + (choiceKey === 'both' ? ' mc__act--picked' : '')}
                        onClick=${() => onPick('both')}>
                        ↕ Take both
                    </button>
                    <button type="button"
                        class=${'mc__act mc__act--ours' + (choiceKey === 'ours' ? ' mc__act--picked' : '')}
                        onClick=${() => onPick('ours')}>
                        Take ours →
                    </button>
                    <button type="button"
                        class=${'mc__act mc__act--ai' + (choiceKey === 'ai' ? ' mc__act--picked' : '')}
                        onClick=${onAiResolve}
                        disabled=${aiRunning}
                        title="Ask the LLM to propose a resolution for this hunk">
                        ${aiRunning ? '⏳ Resolving…' : '🤖 AI resolve'}
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
                    lines=${resolvedLines} />
                <${CodePane}
                    side="ours"
                    label="Current"
                    lineNo=${hunk.lineNo}
                    lines=${hunk.ours} />
            </div>
            ${aiProposed && html`
                <div class="mc__ai-card chat-message tool-call tool-success edit-proposal">
                    <details class="tool-call-details" open>
                        <summary class="tool-call-summary">
                            <span class="tool-call-icon">🤖</span>
                            <span class="tool-call-name">AI resolve proposal</span>
                            <span class="tool-call-args-summary">Conflict ${idx + 1}</span>
                        </summary>
                        <div class="tool-call-body">
                            ${aiState.rationale && html`
                                <div class="tool-call-section">
                                    <div class="tool-call-section-label">Rationale</div>
                                    <div class="mc__ai-rationale">${aiState.rationale}</div>
                                </div>
                            `}
                            <div class="tool-call-section">
                                <div class="tool-call-section-label">Proposed resolved lines</div>
                                <pre class="tool-call-json">${(aiState.content || []).join('\n')}</pre>
                            </div>
                        </div>
                    </details>
                    <div class="mc__ai-actions">
                        <button type="button" class="mc__btn mc__btn--primary" onClick=${onAiApprove}>
                            Approve
                        </button>
                        <button type="button" class="mc__btn" onClick=${onAiReject}>
                            Reject
                        </button>
                    </div>
                </div>
            `}
            ${aiError && html`
                <div class="mc__ai-error" role="alert">
                    AI resolve failed: ${aiState.error}
                    <button type="button" class="mc__btn mc__btn--ghost" onClick=${() => onAiReject()}>
                        Dismiss
                    </button>
                </div>
            `}
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
