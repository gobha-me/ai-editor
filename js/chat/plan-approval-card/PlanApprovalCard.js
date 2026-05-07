// @ts-check
/**
 * Plan-approval card — Preact component (github#25, 1.10.0).
 *
 * Renders the LLM's submitted plan (markdown) and an Approve / Reject
 * pair with an optional feedback textarea for rejection. Submitting
 * settles the plan-approval Promise via `resolvePlanApproval` in
 * `state.js`; the lifecycle wrapper (`plan-approval-card.js`) listens
 * for the `plan_approval:resolved` event and unmounts.
 *
 * Approve and Reject have very different downstream semantics:
 *   - Approve → handlers.js sees `{ status: 'approved' }` in the tool
 *     result and calls `setPlanMode(false)` before the next round, so
 *     the LLM regains the full tool catalog and starts implementation.
 *   - Reject → `{ status: 'rejected', feedback }` flows back unchanged;
 *     plan mode stays on; the LLM iterates with the user's feedback.
 *
 * UX rules:
 *   - Plan markdown rendered via global `marked.parse` (same as chat
 *     messages). Falls back to a `<pre>` block if marked is unavailable.
 *   - Reject button enabled at all times; the feedback field is optional
 *     but encouraged.
 *   - After click, both buttons disable to prevent double-submit.
 *
 * @since 1.10.0 (github#25)
 * @module chat/plan-approval-card/PlanApprovalCard
 */

import { getPreact } from '../../utils/preact-mount.js';
import { resolvePlanApproval } from '../state.js';

const { html, useState } = await getPreact();

function _renderPlanMarkdown(plan) {
    try {
        if (typeof window !== 'undefined' && window.marked && typeof window.marked.parse === 'function') {
            return { __html: window.marked.parse(plan, { breaks: true, gfm: true }) };
        }
    } catch { /* fall through to pre */ }
    return null;
}

/**
 * @param {{initial: {plan: string}}} props
 */
export function PlanApprovalCard({ initial }) {
    const [submitted, setSubmitted] = useState(false);
    const [feedback, setFeedback] = useState('');

    if (!initial || !initial.plan) {
        return html`<div class="plan-approval-card plan-approval-card--error">Plan-approval card has no plan content.</div>`;
    }

    const onApprove = () => {
        if (submitted) return;
        setSubmitted(true);
        resolvePlanApproval({ status: 'approved' });
    };

    const onReject = () => {
        if (submitted) return;
        setSubmitted(true);
        resolvePlanApproval({
            status: 'rejected',
            feedback: (feedback || '').trim() || 'No feedback provided. Re-plan with more attention to the user\'s constraints.',
        });
    };

    const rendered = _renderPlanMarkdown(initial.plan);
    const planBlock = rendered
        ? html`<div class="plan-approval-card__plan" dangerouslySetInnerHTML=${rendered}></div>`
        : html`<pre class="plan-approval-card__plan plan-approval-card__plan--pre">${initial.plan}</pre>`;

    return html`
        <div class=${'plan-approval-card' + (submitted ? ' plan-approval-card--submitted' : '')}>
            <div class="plan-approval-card__header">
                <span class="plan-approval-card__icon" aria-hidden="true">📋</span>
                <span class="plan-approval-card__title">Plan ready for review</span>
            </div>
            ${planBlock}
            <label class="plan-approval-card__feedback-label">
                <span class="plan-approval-card__feedback-hint">Optional feedback (used when rejecting):</span>
                <textarea
                    class="plan-approval-card__feedback"
                    rows="2"
                    placeholder="What's wrong with the plan? The LLM will re-plan with this in mind."
                    value=${feedback}
                    disabled=${submitted}
                    onInput=${(e) => setFeedback(e.currentTarget.value)}></textarea>
            </label>
            <div class="plan-approval-card__actions">
                <button
                    type="button"
                    class="plan-approval-card__approve"
                    disabled=${submitted}
                    onClick=${onApprove}>
                    ${submitted ? 'Sent ✓' : '✅ Approve & execute'}
                </button>
                <button
                    type="button"
                    class="plan-approval-card__reject"
                    disabled=${submitted}
                    onClick=${onReject}>
                    ${submitted ? '' : '↺ Reject — re-plan'}
                </button>
                <span class="plan-approval-card__hint">
                    Approving lifts Plan Mode; rejecting keeps it on so the LLM can iterate.
                </span>
            </div>
        </div>
    `;
}
