// @ts-check
/**
 * PR Review — sticky bottom dock.
 *
 * Owns Submit (with line-anchored draft queue + optional summary) and
 * Merge (extracted to PrMergeControls). Renders disabled with an
 * inline note when the active provider doesn't support review
 * submission (GitLab → 2.13.1).
 *
 * Submit lifecycle:
 *   - Reads queued drafts from review-state for the active PR
 *   - On Submit: Git.submitPullRequestReview({event, body, comments: drafts})
 *   - Success: clearDrafts(), emit `prs:refresh` (surface reloads),
 *              transient "Review submitted ✓" banner
 *   - Failure: drafts preserved, error chip + showToast
 *
 * Drafts list updates push through the EventBus channel
 * `pr-review:drafts-changed` (emitted by per-line `+` and per-thread
 * Reply paths). useLayoutEffect for the subscription so the listener
 * registers before the second render — matches PrReviewSurface.js
 * pattern (slice-1 line 108-180).
 *
 * @since 2.13.0 (Touch 3 PR Review surface — slice 2)
 * @module pr-review/PrReviewDock
 */

import { State, EventBus } from '../core.js';
import { Git, loadFile } from '../git.js';
import { LLM } from '../llm/api.js';
import { applyEdit } from '../editor/instance.js';
import { getPreact } from '../utils/preact-mount.js';
import { getDrafts, clearDrafts, removeDraft } from './review-state.js';
import { PrMergeControls } from './PrMergeControls.js';
import { concatJobLogs, tailTruncate } from './diagnose-logs.js';
import { buildDiagnoseFixMessages } from './diagnose-prompt.js';
import { parsePatchResponse } from './diagnose-parse.js';
import { getPending, setPending, clearPending } from './diagnose-state.js';
import { VERSION } from '../version.js';

const { html, useState, useLayoutEffect, useEffect } = await getPreact();

const SUBMITTED_TOAST_MS = 2000;

/**
 * @param {{
 *   prNumber: number,
 *   pr: any,
 *   ci?: {state?:string, statuses?:Array}|null,
 *   capabilities: {reviewSubmission?:boolean, threadResolve?:boolean, viewedFiles?:boolean, merge?:boolean, rerunCi?:boolean},
 *   threadsTotal: number,
 *   threadsResolvedLocal: number,
 *   onCiPollReset?: () => void
 * }} props
 */
export function PrReviewDock({ prNumber, pr, ci, capabilities, threadsTotal, threadsResolvedLocal, onCiPollReset }) {
    const [drafts, setDrafts] = useState(() => getDrafts(prNumber));
    const [event, setEvent] = useState(/** @type {'COMMENT'|'APPROVE'|'REQUEST_CHANGES'} */ ('COMMENT'));
    const [summary, setSummary] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState(/** @type {string|null} */ (null));
    const [submittedFlash, setSubmittedFlash] = useState(false);
    const [rerunBusy, setRerunBusy] = useState(false);
    const [rerunError, setRerunError] = useState(/** @type {string|null} */ (null));
    const [diagBusy, setDiagBusy] = useState(false);
    const [diagError, setDiagError] = useState(/** @type {string|null} */ (null));
    const [diagPending, setDiagPending] = useState(() => getPending(prNumber));

    // Re-pull drafts on the cross-component change event AND when the
    // active PR number changes (e.g. user opened a different PR without
    // closing the surface first). Same hook also re-pulls the diagnose
    // pending state for the new PR (per-PR isolation in diagnose-state).
    useLayoutEffect(() => {
        setDrafts(getDrafts(prNumber));
        setDiagPending(getPending(prNumber));
        setDiagError(null);
        setDiagBusy(false);
        const off = EventBus.on('pr-review:drafts-changed', (payload) => {
            if (!payload || payload.prNumber === prNumber) {
                setDrafts(getDrafts(prNumber));
            }
        });
        return off;
    }, [prNumber]);

    // Auto-clear the "Review submitted ✓" flash.
    useEffect(() => {
        if (!submittedFlash) return;
        const t = setTimeout(() => setSubmittedFlash(false), SUBMITTED_TOAST_MS);
        return () => clearTimeout(t);
    }, [submittedFlash]);

    const draftCount = drafts.length;
    const supportsReview = capabilities?.reviewSubmission === true;
    const supportsMerge = capabilities?.merge === true && pr?.state === 'open' && !pr?.merged;
    const supportsRerun = capabilities?.rerunCi === true && ci?.state === 'failure'
        && pr?.state === 'open' && !pr?.merged && !!pr?.headSha;
    // No new capability flag — `listWorkflowJobs` + `getJobLog` ship on
    // all three providers (verified github.js:1131/1151, gitea.js:1096/1129,
    // gitlab.js:1096/1116). Gate matches the Re-run pattern except for
    // the `capabilities?.rerunCi` check.
    const supportsDiagnose = ci?.state === 'failure'
        && pr?.state === 'open' && !pr?.merged && !!pr?.headSha;
    const prClosed = pr?.state !== 'open' || pr?.merged;

    // gitea#523 — when a provider advertises `reviewSubmission` but not
    // `merge` on an open PR, the merge controls used to silently vanish
    // (visible since 2.13.0; rediscovered at 2.95.0). The conjunctive
    // gate below narrows to *exactly* the anomalous case: providers that
    // legitimately don't support merge (gitlab today) also don't claim
    // reviewSubmission, so they won't trip it. Used both for the visible
    // dock notice + the one-shot console.warn below.
    const mergeGateAnomaly = !prClosed
        && capabilities?.reviewSubmission === true
        && capabilities?.merge !== true;

    useEffect(() => {
        if (!mergeGateAnomaly) return;
        console.warn(
            '[pr-review] Merge controls suppressed despite reviewSubmission capability — capabilities.merge !== true on an open PR (gitea#523).',
            {
                connectionId: State.currentProject?.connectionId,
                projectOwner: State.currentProject?.owner,
                projectRepo: State.currentProject?.repo,
                capabilitiesMerge: capabilities?.merge,
                capabilityKeys: Object.keys(capabilities || {}),
                prState: pr?.state,
                prMerged: pr?.merged,
                version: VERSION,
            }
        );
    }, [mergeGateAnomaly]);

    async function handleSubmit() {
        if (submitting) return;
        if (!supportsReview) return;
        const trimmedSummary = summary.trim();
        if (draftCount === 0 && !trimmedSummary && event === 'COMMENT') {
            setError('Add a comment or queue a line-anchored draft before submitting.');
            return;
        }
        setError(null);
        setSubmitting(true);
        try {
            if (!State.currentProject) throw new Error('No project loaded');
            const { owner, repo } = State.currentProject;
            const payload = {
                event,
                body: trimmedSummary || undefined,
                comments: drafts.map(d => ({
                    path: d.path,
                    line: d.line,
                    side: d.side,
                    body: d.body,
                })),
            };
            await Git.submitPullRequestReview(owner, repo, prNumber, payload);

            clearDrafts(prNumber);
            EventBus.emit('pr-review:drafts-changed', { prNumber });
            setSummary('');
            setEvent('COMMENT');
            setSubmittedFlash(true);
            // Load-on-click pattern — refetch comments + state from the
            // server. The surface subscribes to `prs:refresh` (slice-1
            // line 175) so the new review appears without a manual
            // refresh button.
            EventBus.emit('prs:refresh');
        } catch (e) {
            const msg = e?.message || String(e);
            setError(msg);
            // Escalate to a toast in case the user has scrolled away
            // from the dock when the failure surfaces.
            try {
                if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
                    window.showToast(`Submit failed: ${msg}`, 'error');
                }
            } catch { /* non-fatal */ }
        } finally {
            setSubmitting(false);
        }
    }

    function handleRemoveDraft(draftId) {
        removeDraft(prNumber, draftId);
        EventBus.emit('pr-review:drafts-changed', { prNumber });
    }

    async function handleRerunCi() {
        if (rerunBusy) return;
        setRerunBusy(true);
        setRerunError(null);
        try {
            if (!State.currentProject) throw new Error('No project loaded');
            const { owner, repo } = State.currentProject;
            // No `head_sha` filter on the listWorkflowRuns endpoint — fetch the
            // recent page (per-provider limit ~20) and pick the latest run for
            // the PR's head commit. Both providers return runs sorted desc.
            const runs = await Git.listWorkflowRuns(owner, repo);
            const matching = (runs || []).find(r => r.headSha === pr.headSha);
            if (!matching) {
                throw new Error('No workflow run found for this PR head commit.');
            }
            await Git.rerunWorkflowJobs(owner, repo, matching.id);
            if (typeof onCiPollReset === 'function') onCiPollReset();
        } catch (e) {
            setRerunError(e?.message || String(e));
        } finally {
            setRerunBusy(false);
        }
    }

    async function handleDiagnoseFix() {
        if (diagBusy) return;
        setDiagBusy(true);
        setDiagError(null);
        try {
            if (!State.currentProject) throw new Error('No project loaded');
            const { owner, repo } = State.currentProject;

            const runs = await Git.listWorkflowRuns(owner, repo);
            const matching = (runs || []).find(r => r.headSha === pr.headSha);
            if (!matching) throw new Error('No workflow run found for this PR head commit.');

            const jobs = await Git.listWorkflowJobs(owner, repo, matching.id);
            const failed = (jobs || []).filter(j => j && j.conclusion === 'failure');
            if (failed.length === 0) throw new Error('No failed jobs in the latest workflow run.');

            const jobLogs = await Promise.all(failed.map(async (j) => ({
                id: j.id,
                name: j.name,
                log: await Git.getJobLog(owner, repo, j.id),
            })));

            const concat = concatJobLogs(jobLogs);
            const truncated = tailTruncate(concat);

            // Heuristic: pick the first repo file path that appears in the
            // truncated logs. Sort by length desc so longer paths win over
            // their prefixes (e.g. `src/x/main.js` over `main.js`).
            const filePaths = (State.fileTree || [])
                .filter(f => f && f.type === 'file' && typeof f.path === 'string')
                .map(f => f.path);
            const ranked = [...filePaths].sort((a, b) => b.length - a.length);
            const targetPath = ranked.find(p => truncated.text.includes(p)) || null;

            let fileContent = null;
            if (targetPath) {
                try {
                    const fileResult = await Git.getFile(owner, repo, targetPath, pr.head);
                    fileContent = typeof fileResult === 'string'
                        ? fileResult
                        : (fileResult?.content ?? null);
                } catch { /* swallow; let model proceed without the file */ }
            }

            const messages = buildDiagnoseFixMessages({
                logs: truncated.text,
                fileContent,
                filePath: targetPath,
                projectTree: filePaths.join('\n'),
                prTitle: pr?.title || '',
                logTotalBytes: truncated.totalBytes,
                logTruncatedAtCap: truncated.truncatedAtCap,
            });

            const result = await LLM.chat(messages, { stream: false, temperature: 0.2 });
            const parsed = parsePatchResponse(result?.content || '');
            if (!parsed.ok) throw new Error(`Model response invalid: ${parsed.error}`);

            // Best-effort baseline for the diff. If the model picked a
            // different path than the heuristic guessed, refetch.
            let originalContent = parsed.path === targetPath ? fileContent : null;
            if (originalContent == null) {
                try {
                    const r = await Git.getFile(owner, repo, parsed.path, pr.head);
                    originalContent = typeof r === 'string' ? r : (r?.content ?? null);
                } catch { originalContent = null; }
            }

            const payload = {
                path: parsed.path,
                newContent: parsed.newContent,
                originalContent,
                rationale: parsed.rationale,
                jobNames: failed.map(j => j.name).filter(Boolean),
                createdAt: Date.now(),
            };
            setPending(prNumber, payload);
            setDiagPending(payload);
        } catch (e) {
            setDiagError(e?.message || String(e));
        } finally {
            setDiagBusy(false);
        }
    }

    async function handleDiagnoseApprove() {
        if (!diagPending) return;
        try {
            await loadFile(diagPending.path);
            applyEdit(diagPending.newContent);
            clearPending(prNumber);
            setDiagPending(null);
            setDiagError(null);
            if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
                window.showToast('Patch applied to editor — review and save.', 'success');
            }
        } catch (e) {
            setDiagError(e?.message || String(e));
        }
    }

    function handleDiagnoseReject() {
        clearPending(prNumber);
        setDiagPending(null);
        setDiagError(null);
    }

    return html`
        <div class="pr-dock" role="region" aria-label="Pull request review actions">
            ${draftCount > 0 && html`
                <div class="pr-dock__drafts" aria-label="Pending draft comments">
                    <div class="pr-dock__drafts-h">
                        <strong>${draftCount}</strong> pending ${draftCount === 1 ? 'draft' : 'drafts'}
                        ${threadsTotal > 0 && html`
                            <span class="pr-dock__threads"> · ${threadsResolvedLocal}/${threadsTotal} threads addressed</span>
                        `}
                    </div>
                    <ul class="pr-dock__drafts-list" role="list">
                        ${drafts.map(d => html`
                            <li class="pr-dock__draft" key=${d.id}>
                                <code class="pr-dock__draft-loc">${d.path}:${d.line} (${d.side})</code>
                                <span class="pr-dock__draft-body">${_truncate(d.body, 80)}</span>
                                <button
                                    type="button"
                                    class="pr__btn pr__btn--ghost pr__btn--xs"
                                    onClick=${() => handleRemoveDraft(d.id)}
                                    aria-label=${'Remove draft on ' + d.path + ':' + d.line}>
                                    ✕
                                </button>
                            </li>
                        `)}
                    </ul>
                </div>
            `}

            ${!supportsReview && !prClosed && html`
                <div class="pr-dock__notice" role="note">
                    Review submission lands for this provider in 2.13.1. Merge controls remain available below.
                </div>
            `}

            ${supportsRerun && html`
                <div class="pr-dock__rerun" role="region" aria-label="CI failure recovery">
                    <span class="pr-dock__rerun-msg">
                        ❌ CI failed on this commit.
                    </span>
                    <button
                        type="button"
                        class="pr__btn pr__btn--ghost"
                        onClick=${handleRerunCi}
                        disabled=${rerunBusy}
                        title="Re-run only the failed jobs of the latest workflow run for this PR's head commit">
                        ${rerunBusy ? '⏳ Re-running…' : '↻ Re-run failed jobs'}
                    </button>
                    ${rerunError && html`<span class="pr-dock__rerun-error" role="alert">${rerunError}</span>`}
                </div>
            `}

            ${supportsDiagnose && html`
                <div class="pr-dock__diagnose" role="region" aria-label="CI failure diagnosis">
                    ${!diagPending && html`
                        <button
                            type="button"
                            class="pr__btn pr__btn--ghost"
                            onClick=${handleDiagnoseFix}
                            disabled=${diagBusy}
                            title="Pull failed-job logs and ask the model to propose a single-file fix">
                            ${diagBusy ? '⏳ Diagnosing…' : '🔧 Diagnose & fix'}
                        </button>
                    `}
                    ${diagError && html`<span class="pr-dock__diagnose-error" role="alert">${diagError}</span>`}
                    ${diagPending && html`
                        <div class="pr-dock__diagnose-card chat-message tool-call tool-success edit-proposal">
                            <details class="tool-call-details" open>
                                <summary class="tool-call-summary">
                                    <span class="tool-call-icon">🔧</span>
                                    <span class="tool-call-name">Diagnose & fix</span>
                                    <span class="tool-call-args-summary">${diagPending.path}</span>
                                </summary>
                                <div class="tool-call-body">
                                    ${diagPending.rationale && html`
                                        <div class="tool-call-section">
                                            <div class="tool-call-section-label">Rationale</div>
                                            <div class="pr-dock__diagnose-rationale">${diagPending.rationale}</div>
                                        </div>
                                    `}
                                    <div class="tool-call-section">
                                        <div class="tool-call-section-label">Proposed file contents</div>
                                        <pre class="tool-call-json">${diagPending.newContent}</pre>
                                    </div>
                                </div>
                            </details>
                            <div class="pr-dock__diagnose-actions">
                                <button
                                    type="button"
                                    class="pr__btn pr__btn--primary"
                                    onClick=${handleDiagnoseApprove}>
                                    Apply to editor
                                </button>
                                <button
                                    type="button"
                                    class="pr__btn pr__btn--ghost"
                                    onClick=${handleDiagnoseReject}>
                                    Reject
                                </button>
                            </div>
                        </div>
                    `}
                </div>
            `}

            ${prClosed
                ? html`<div class="pr-dock__closed">PR ${pr?.merged ? 'merged' : 'closed'} — no further actions.</div>`
                : html`
                    ${supportsReview && html`
                        <div class="pr-dock__submit">
                            <div class="pr-dock__radio" role="radiogroup" aria-label="Review type">
                                ${[
                                    { v: 'COMMENT', l: 'Comment' },
                                    { v: 'REQUEST_CHANGES', l: 'Request changes' },
                                    { v: 'APPROVE', l: 'Approve' },
                                ].map(opt => html`
                                    <label class=${'pr-dock__radio-opt ' + (event === opt.v ? 'pr-dock__radio-opt--active' : '')} key=${opt.v}>
                                        <input
                                            type="radio"
                                            name="pr-dock-event"
                                            value=${opt.v}
                                            checked=${event === opt.v}
                                            onChange=${() => setEvent(opt.v)}
                                            disabled=${submitting} />
                                        ${opt.l}
                                    </label>
                                `)}
                            </div>
                            <textarea
                                class="pr-dock__summary"
                                placeholder="Optional review summary…"
                                value=${summary}
                                onInput=${(e) => setSummary(e.target.value)}
                                disabled=${submitting}
                                rows=${2}
                                aria-label="Review summary"
                            ></textarea>
                            ${error && html`<div class="pr-dock__error" role="alert">${error}</div>`}
                            ${submittedFlash && html`<div class="pr-dock__flash" role="status">Review submitted ✓</div>`}
                            <div class="pr-dock__actions">
                                <button
                                    type="button"
                                    class="pr__btn pr__btn--primary"
                                    onClick=${handleSubmit}
                                    disabled=${submitting || !supportsReview}>
                                    ${submitting ? '⏳ Submitting…' : `Submit review${draftCount > 0 ? ` (${draftCount})` : ''}`}
                                </button>
                            </div>
                        </div>
                    `}
                    ${supportsMerge
                        ? html`
                            <${PrMergeControls}
                                prNumber=${prNumber}
                                pr=${pr}
                                capabilities=${capabilities}
                                onError=${(msg) => setError(msg)} />
                        `
                        : mergeGateAnomaly && html`
                            <div class="pr-dock__notice pr-dock__merge-fallback" role="alert">
                                ⚠️ Merge controls suppressed — capabilities.merge = ${String(capabilities?.merge)} on this provider for an open PR. See browser console for diagnostic payload (gitea#523).
                            </div>
                        `}
                `}
        </div>
    `;
}

function _truncate(s, n) {
    if (typeof s !== 'string') return '';
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + '…';
}
