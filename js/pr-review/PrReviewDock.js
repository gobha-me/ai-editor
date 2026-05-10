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
import { Git } from '../git.js';
import { getPreact } from '../utils/preact-mount.js';
import { getDrafts, clearDrafts, removeDraft } from './review-state.js';
import { PrMergeControls } from './PrMergeControls.js';

const { html, useState, useLayoutEffect, useEffect } = await getPreact();

const SUBMITTED_TOAST_MS = 2000;

/**
 * @param {{
 *   prNumber: number,
 *   pr: any,
 *   capabilities: {reviewSubmission?:boolean, threadResolve?:boolean, viewedFiles?:boolean, merge?:boolean},
 *   threadsTotal: number,
 *   threadsResolvedLocal: number
 * }} props
 */
export function PrReviewDock({ prNumber, pr, capabilities, threadsTotal, threadsResolvedLocal }) {
    const [drafts, setDrafts] = useState(() => getDrafts(prNumber));
    const [event, setEvent] = useState(/** @type {'COMMENT'|'APPROVE'|'REQUEST_CHANGES'} */ ('COMMENT'));
    const [summary, setSummary] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState(/** @type {string|null} */ (null));
    const [submittedFlash, setSubmittedFlash] = useState(false);

    // Re-pull drafts on the cross-component change event AND when the
    // active PR number changes (e.g. user opened a different PR without
    // closing the surface first).
    useLayoutEffect(() => {
        setDrafts(getDrafts(prNumber));
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
    const prClosed = pr?.state !== 'open' || pr?.merged;

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
                    ${supportsMerge && html`
                        <${PrMergeControls}
                            prNumber=${prNumber}
                            pr=${pr}
                            onError=${(msg) => setError(msg)} />
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
