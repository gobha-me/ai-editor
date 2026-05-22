// @ts-check
/**
 * Sub-agent-approval card — Preact component (2.49.0 slice 2).
 *
 * Renders the security-load-bearing **capability summary** per
 * DESIGN-sub-agents.md §"Approval-card capability summary": profile,
 * admitted tools, per-call narrow, cost ceiling, run timeout,
 * recursion, memory, **write-access ✗/✓ with warning class when ✓**.
 * The user sees exactly what the sub-agent *can do* — not just what
 * the parent *asked it to do* — before approving. The warning class
 * fires when any admitted tool is in the write-classification set
 * (DESIGN §Risks: "user does not notice profile override on capability
 * summary" — High-severity trust failure).
 *
 * Three states (mirrors `ScriptApprovalCard.js` shape):
 *   - **review**  — Approve / Reject / Cancel buttons. The user reads
 *                   the task + capability summary.
 *   - **running** — Approve clicked → sub-agent loop drives via
 *                   `runSubAgent` (sibling runner module). Spinner +
 *                   Stop button. Stop terminates the loop and resolves
 *                   with cancellation envelope.
 *   - **done**    — Loop posted its result. The parent unmounts on
 *                   `subagent_approval:resolved`; this branch is only
 *                   visible for the brief tick between resolve() and
 *                   unmount.
 *
 * @since 2.49.0
 * @module chat/subagent-approval-card/SubAgentApprovalCard
 */

import { getPreact } from '../../utils/preact-mount.js';
import {
    resolveSubAgentApproval,
    cancelSubAgentApproval,
} from '../state.js';
import { runSubAgent } from '../subagent-runner.js';

const { html, useState, useRef } = await getPreact();

/** Tools whose mere admission flips Write access to ✓ on the summary. */
const WRITE_TOOL_NAMES = new Set([
    'edit_file', 'commit_files', 'write_file', 'replace_lines',
    'insert_lines', 'delete_lines',
]);

/** Tools admission of which fires the "memory writes" ✓ row. */
const MEMORY_WRITE_TOOL_NAMES = new Set([
    'memory_remember', 'memory_forget', 'memory_update',
]);

function _formatTokens(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '?';
    return n.toLocaleString();
}

function _formatDollars(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '?';
    return `$${n.toFixed(2)}`;
}

function _formatMs(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '?';
    if (n >= 60000) return `${Math.round(n / 60000)} min`;
    return `${Math.round(n / 1000)} s`;
}

/**
 * @param {{ initial: {
 *   transcriptId: string,
 *   task: string,
 *   contextHint?: string,
 *   profileName: string,
 *   capabilitySummary?: {
 *     profile?: string,
 *     profileRegistered?: boolean,
 *     admittedTools?: string[],
 *     perCallNarrow?: string[] | null,
 *     ceilings?: { max_tokens?: number, max_dollars?: number, run_timeout_ms?: number, recursion_depth?: number },
 *     memoryWriteTools?: string[],
 *     writeTools?: string[],
 *     childModel?: { id: string, source: string },
 *   },
 *   resolve: Function,
 * } }} props
 */
export function SubAgentApprovalCard({ initial }) {
    const [phase, setPhase] = useState('review');  // 'review' | 'running' | 'done'
    const [feedback, setFeedback] = useState('');
    const [progress, setProgress] = useState({ rounds: 0, tokens: 0, dollars: 0 });
    const _runHandleRef = useRef(/** @type {{cancel: () => void} | null} */ (null));

    if (!initial || typeof initial.task !== 'string' || !initial.task) {
        return html`<div class="subagent-approval-card subagent-approval-card--error">Sub-agent approval card has no task content.</div>`;
    }

    const cap = initial.capabilitySummary || {};
    const profile = cap.profile || initial.profileName || 'subagent.v1';
    const profileRegistered = cap.profileRegistered !== false;
    const admittedTools = Array.isArray(cap.admittedTools) ? cap.admittedTools : [];
    const perCallNarrow = Array.isArray(cap.perCallNarrow) ? cap.perCallNarrow : null;
    const ceilings = cap.ceilings || {};
    const memoryWriteTools = Array.isArray(cap.memoryWriteTools)
        ? cap.memoryWriteTools
        : admittedTools.filter(t => MEMORY_WRITE_TOOL_NAMES.has(t));
    const writeTools = Array.isArray(cap.writeTools)
        ? cap.writeTools
        : admittedTools.filter(t => WRITE_TOOL_NAMES.has(t));
    const hasWrite = writeTools.length > 0;
    const hasMemoryWrite = memoryWriteTools.length > 0;

    // 2.89.0 (gitea#505) — resolved-child-model display. "primary" source
    // shows "(primary model — <id>)" so the user notices when the cheap-
    // tier fallback fired; any other source shows just the id (the source
    // is implicit — non-primary means the cost-positive path is active).
    const childModel = (cap.childModel && typeof cap.childModel === 'object')
        ? cap.childModel
        : { id: '', source: 'primary' };
    const childModelLabel = childModel.source === 'primary'
        ? `(primary model — ${childModel.id || '(unset)'})`
        : (childModel.id || '(unset)');

    const onApprove = () => {
        if (phase !== 'review') return;
        setPhase('running');
        const handle = runSubAgent(initial, {
            onProgress: (snapshot) => {
                // snapshot: { rounds, tokens, dollars, status }
                setProgress({
                    rounds: typeof snapshot?.rounds === 'number' ? snapshot.rounds : 0,
                    tokens: typeof snapshot?.tokens === 'number' ? snapshot.tokens : 0,
                    dollars: typeof snapshot?.dollars === 'number' ? snapshot.dollars : 0,
                });
            },
            onComplete: (envelope) => {
                _runHandleRef.current = null;
                setPhase('done');
                resolveSubAgentApproval(envelope);
            },
        });
        _runHandleRef.current = handle || null;
    };

    const onReject = () => {
        if (phase !== 'review') return;
        setPhase('done');
        resolveSubAgentApproval({
            status: 'rejected',
            feedback: (feedback || '').trim()
                || 'No feedback provided. Re-scope the delegation or handle inline.',
            transcript_id: initial.transcriptId || '',
        });
    };

    const onStop = () => {
        if (phase !== 'running') return;
        setPhase('done');
        try { _runHandleRef.current?.cancel(); } catch { /* best-effort */ }
        _runHandleRef.current = null;
        cancelSubAgentApproval({
            transcript_id: initial.transcriptId || '',
        });
    };

    const toolList = admittedTools.length > 0
        ? admittedTools.join(', ')
        : '(none — sub-agent has no tools)';
    const narrowLabel = perCallNarrow && perCallNarrow.length > 0
        ? perCallNarrow.join(', ')
        : '(none — full profile admission)';

    return html`
        <div class=${'subagent-approval-card subagent-approval-card--' + phase + (hasWrite ? ' subagent-approval-card--write-warning' : '')}>
            <div class="subagent-approval-card__header">
                <span class="subagent-approval-card__icon" aria-hidden="true">🤝</span>
                <span class="subagent-approval-card__title">Delegate task to sub-agent</span>
                <span class="subagent-approval-card__profile-pill" title="Profile bounding the sub-agent's tool reach.">${profile}</span>
            </div>

            <div class="subagent-approval-card__section">
                <div class="subagent-approval-card__section-label">Task</div>
                <pre class="subagent-approval-card__task">${initial.task}</pre>
            </div>

            ${initial.contextHint ? html`
                <div class="subagent-approval-card__section">
                    <div class="subagent-approval-card__section-label">Context hint (parent-supplied)</div>
                    <pre class="subagent-approval-card__context-hint">${initial.contextHint}</pre>
                </div>
            ` : null}

            <div class="subagent-approval-card__section subagent-approval-card__capability">
                <div class="subagent-approval-card__section-label">Capability summary (what the sub-agent can do)</div>
                <table class="subagent-approval-card__cap-table">
                    <tr>
                        <th>Profile</th>
                        <td>${profile} ${profileRegistered ? html`<span class="subagent-approval-card__ok">(✓ registered)</span>` : html`<span class="subagent-approval-card__warn">(✗ unknown — falls back)</span>`}</td>
                    </tr>
                    <tr>
                        <th>Model</th>
                        <td><code>${childModelLabel}</code></td>
                    </tr>
                    <tr>
                        <th>Admitted tools</th>
                        <td><code>${toolList}</code></td>
                    </tr>
                    <tr>
                        <th>Per-call narrow</th>
                        <td><code>${narrowLabel}</code></td>
                    </tr>
                    <tr>
                        <th>Cost ceiling</th>
                        <td>${_formatTokens(ceilings.max_tokens)} tokens / ${_formatDollars(ceilings.max_dollars)}</td>
                    </tr>
                    <tr>
                        <th>Run timeout</th>
                        <td>${_formatMs(ceilings.run_timeout_ms)}</td>
                    </tr>
                    <tr>
                        <th>Recursion</th>
                        <td>${(ceilings.recursion_depth || 0) > 0 ? `enabled (depth ${ceilings.recursion_depth})` : 'disabled'}</td>
                    </tr>
                    <tr>
                        <th>Memory writes</th>
                        <td>${hasMemoryWrite
                            ? html`<span class="subagent-approval-card__warn">✓ admitted: <code>${memoryWriteTools.join(', ')}</code></span>`
                            : html`<span class="subagent-approval-card__ok">✗ no memory tool admissions</span>`}</td>
                    </tr>
                    <tr class=${hasWrite ? 'subagent-approval-card__cap-row--warn' : ''}>
                        <th>Write access</th>
                        <td>${hasWrite
                            ? html`<span class="subagent-approval-card__warn">✓ admitted: <code>${writeTools.join(', ')}</code> — sub-agent can mutate the workspace</span>`
                            : html`<span class="subagent-approval-card__ok">✗ no write tools admitted (read-only)</span>`}</td>
                    </tr>
                </table>
            </div>

            ${phase === 'review' ? html`
                <label class="subagent-approval-card__feedback-label">
                    <span class="subagent-approval-card__feedback-hint">Optional feedback (used when rejecting):</span>
                    <textarea
                        class="subagent-approval-card__feedback"
                        rows="2"
                        placeholder="Why is this delegation wrong? (Parent re-scopes with this feedback.)"
                        value=${feedback}
                        onInput=${(e) => setFeedback(e.currentTarget.value)}></textarea>
                </label>
                <div class="subagent-approval-card__actions">
                    <button
                        type="button"
                        class="subagent-approval-card__approve"
                        onClick=${onApprove}>
                        ▶ Approve & run sub-agent
                    </button>
                    <button
                        type="button"
                        class="subagent-approval-card__reject"
                        onClick=${onReject}>
                        ↺ Reject — re-scope
                    </button>
                    <span class="subagent-approval-card__hint">
                        Sub-agent runs against ${profile} with the admitted tools above. Cost charged under <code>delegate_task</code>.
                    </span>
                </div>
            ` : null}

            ${phase === 'running' ? html`
                <div class="subagent-approval-card__running">
                    <span class="subagent-approval-card__spinner" aria-hidden="true">⏳</span>
                    <span class="subagent-approval-card__running-label">
                        Sub-agent running… round ${progress.rounds} · ${_formatTokens(progress.tokens)} tokens · ${_formatDollars(progress.dollars)}
                    </span>
                    <button
                        type="button"
                        class="subagent-approval-card__stop"
                        onClick=${onStop}>
                        ⏹ Stop
                    </button>
                </div>
            ` : null}

            ${phase === 'done' ? html`
                <div class="subagent-approval-card__done">Done — closing…</div>
            ` : null}
        </div>
    `;
}
