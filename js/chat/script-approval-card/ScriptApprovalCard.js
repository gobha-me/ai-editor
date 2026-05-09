// @ts-check
/**
 * Script-approval card — Preact component (1.16.0).
 *
 * Renders three sections:
 *   - description (markdown via global `marked.parse`)
 *   - source (a `<pre><code>` block — explicit fallback when CodeMirror
 *     unavailable; the source visibility is the security-load-bearing view)
 *   - expected_output (markdown)
 *
 * Three states:
 *   - **review**  — Approve / Reject / Cancel buttons. The user reads the
 *                   source. No worker spawned yet.
 *   - **running** — Approve clicked → spawned worker via `ensureWorker`
 *                   prop, posting `{type: 'run_script', ...}`. The card
 *                   shows a spinner + Stop button. Stop terminates the
 *                   worker and resolves with cancellation envelope.
 *   - **done**    — Worker posted `scriptComplete`. We don't render
 *                   "done" — the card is unmounted by the parent on
 *                   `script_approval:resolved`. This branch is reached
 *                   only for the brief moment between resolve() and the
 *                   parent's unmount tick.
 *
 * Per DESIGN-llm-authored-automation.md §"Cancel-while-running": user
 * Stop while the script is running terminates the Worker and resolves
 * with `{status: 'cancelled', cancelled: true, partial_stdout, partial_stderr}`.
 *
 * @since 1.16.0
 * @module chat/script-approval-card/ScriptApprovalCard
 */

import { getPreact } from '../../utils/preact-mount.js';
import {
    resolveScriptApproval,
    cancelScriptApproval,
} from '../state.js';
import { resolveScriptAutomationConfig } from '../../profiles/resolve.js';

const { html, useState, useEffect, useRef } = await getPreact();

function _renderMarkdown(text) {
    try {
        if (typeof window !== 'undefined' && window.marked && typeof window.marked.parse === 'function') {
            return { __html: window.marked.parse(String(text || ''), { breaks: true, gfm: true }) };
        }
    } catch { /* fall through to plain */ }
    return null;
}

function _resolvedConfig() {
    try {
        const State = (typeof window !== 'undefined' && window.AIEditor?.State) || null;
        const Profiles = (typeof window !== 'undefined' && window.AIEditor?.Profiles) || null;
        // 2.0.0 — slice 3: read profile-keyed via the picker. Mirror the
        // tools-tab.js flip; falling back to chat.v1 if the helper isn't
        // window-exposed (defensive, since this runs from a Worker boundary).
        const profileName = (State?.settings?.profile && Profiles?.has?.(State.settings.profile))
            ? State.settings.profile
            : 'chat.v1';
        const cfg = resolveScriptAutomationConfig(profileName);
        const overlay = State?.settings?.scriptAutomation || {};
        const timeout_ms = Number.isInteger(overlay.timeout_ms) && overlay.timeout_ms > 0
            ? overlay.timeout_ms
            : cfg.timeout_ms;
        const max_output_bytes = Number.isInteger(overlay.max_output_bytes) && overlay.max_output_bytes > 0
            ? overlay.max_output_bytes
            : cfg.max_output_bytes;
        return { timeout_ms, max_output_bytes };
    } catch {
        return { timeout_ms: 30000, max_output_bytes: 262144 };
    }
}

/**
 * @param {{
 *   initial: { source: string, description: string, expected_output: string },
 *   ensureWorker?: () => Worker,
 *   captureOutput?: (stdout: string, stderr: string) => void
 * }} props
 */
export function ScriptApprovalCard({ initial, ensureWorker, captureOutput }) {
    const [phase, setPhase] = useState('review');  // 'review' | 'running' | 'done'
    const [feedback, setFeedback] = useState('');
    const [progress, setProgress] = useState({ stdoutBytes: 0, stderrBytes: 0 });
    const _runIdRef = useRef(0);
    const _outputRef = useRef({ stdout: '', stderr: '' });

    if (!initial || typeof initial.source !== 'string' || !initial.source) {
        return html`<div class="script-approval-card script-approval-card--error">Script-approval card has no source content.</div>`;
    }

    const onApprove = () => {
        if (phase !== 'review') return;
        if (typeof ensureWorker !== 'function') {
            // Fallback: no worker available (test environment, browser
            // refused Workers). Resolve with an explicit error envelope
            // so the model isn't left waiting.
            resolveScriptApproval({
                status: 'approved',
                stdout: '',
                stderr: 'Worker unavailable in this environment.',
                runtime_ms: 0,
                truncated: true,
            });
            return;
        }
        setPhase('running');
        const worker = ensureWorker();
        const { timeout_ms, max_output_bytes } = _resolvedConfig();
        const id = ++_runIdRef.current;

        const onMessage = (e) => {
            const msg = e.data || {};
            // Filter on our run id so a stale listener from a previous
            // mount can't resolve our promise.
            if (msg.id !== id && msg.type !== 'git_call') return;
            if (msg.type === 'scriptComplete') {
                _outputRef.current.stdout = msg.stdout || '';
                _outputRef.current.stderr = msg.stderr || '';
                if (typeof captureOutput === 'function') {
                    try { captureOutput(msg.stdout || '', msg.stderr || ''); } catch { /* */ }
                }
                worker.removeEventListener('message', onMessage);
                resolveScriptApproval({
                    status: 'approved',
                    stdout: msg.stdout || '',
                    stderr: msg.stderr || '',
                    runtime_ms: typeof msg.runtime_ms === 'number' ? msg.runtime_ms : 0,
                    truncated: !!msg.truncated,
                });
                setPhase('done');
            } else if (msg.type === 'error') {
                worker.removeEventListener('message', onMessage);
                resolveScriptApproval({
                    status: 'approved',
                    stdout: '',
                    stderr: `Worker error: ${msg.error || 'unknown'}`,
                    runtime_ms: 0,
                    truncated: true,
                });
                setPhase('done');
            }
        };
        worker.addEventListener('message', onMessage);
        worker.postMessage({
            type: 'run_script',
            id,
            source: initial.source,
            timeout_ms,
            max_output_bytes,
        });
    };

    const onReject = () => {
        if (phase !== 'review') return;
        setPhase('done');
        resolveScriptApproval({
            status: 'rejected',
            feedback: (feedback || '').trim() || 'No feedback provided. Re-author the script with tighter scope or a different approach.',
        });
    };

    const onStop = () => {
        if (phase !== 'running') return;
        setPhase('done');
        // Worker termination + partial-output capture is owned by the
        // lifecycle wrapper (script-approval-card.js) on the cancelled
        // path. We surface partial output we've already accumulated via
        // the captureOutput prop.
        cancelScriptApproval({
            partial_stdout: _outputRef.current.stdout,
            partial_stderr: _outputRef.current.stderr,
        });
    };

    const descRendered = _renderMarkdown(initial.description);
    const expectedRendered = _renderMarkdown(initial.expected_output);
    const descBlock = descRendered
        ? html`<div class="script-approval-card__description" dangerouslySetInnerHTML=${descRendered}></div>`
        : html`<pre class="script-approval-card__description script-approval-card__description--pre">${initial.description}</pre>`;
    const expectedBlock = expectedRendered
        ? html`<div class="script-approval-card__expected" dangerouslySetInnerHTML=${expectedRendered}></div>`
        : html`<pre class="script-approval-card__expected script-approval-card__expected--pre">${initial.expected_output}</pre>`;

    return html`
        <div class=${'script-approval-card script-approval-card--' + phase}>
            <div class="script-approval-card__header">
                <span class="script-approval-card__icon" aria-hidden="true">📜</span>
                <span class="script-approval-card__title">Script ready for review</span>
                <span class="script-approval-card__tier" title="Tier 0: read-only fs walk; no network; no DOM.">Tier 0</span>
            </div>

            <div class="script-approval-card__section">
                <div class="script-approval-card__section-label">What it does (LLM-authored description)</div>
                ${descBlock}
            </div>

            <div class="script-approval-card__section">
                <div class="script-approval-card__section-label">Source (review carefully)</div>
                <pre class="script-approval-card__source"><code>${initial.source}</code></pre>
            </div>

            <div class="script-approval-card__section">
                <div class="script-approval-card__section-label">Expected output (LLM's contract)</div>
                ${expectedBlock}
            </div>

            ${phase === 'review' ? html`
                <label class="script-approval-card__feedback-label">
                    <span class="script-approval-card__feedback-hint">Optional feedback (used when rejecting):</span>
                    <textarea
                        class="script-approval-card__feedback"
                        rows="2"
                        placeholder="What's wrong with this script? The LLM will re-author with this in mind."
                        value=${feedback}
                        onInput=${(e) => setFeedback(e.currentTarget.value)}></textarea>
                </label>
                <div class="script-approval-card__actions">
                    <button
                        type="button"
                        class="script-approval-card__approve"
                        onClick=${onApprove}>
                        ▶ Approve & run (sandboxed)
                    </button>
                    <button
                        type="button"
                        class="script-approval-card__reject"
                        onClick=${onReject}>
                        ↺ Reject — re-author
                    </button>
                    <span class="script-approval-card__hint">
                        Worker has no <code>fetch</code>, no DOM, no <code>process</code>; only <code>Git.getFile</code> / <code>Git.getFileTree</code>.
                    </span>
                </div>
            ` : null}

            ${phase === 'running' ? html`
                <div class="script-approval-card__running">
                    <span class="script-approval-card__spinner" aria-hidden="true">⏳</span>
                    <span class="script-approval-card__running-label">Running in sandboxed worker…</span>
                    <button
                        type="button"
                        class="script-approval-card__stop"
                        onClick=${onStop}>
                        ⏹ Stop
                    </button>
                </div>
            ` : null}

            ${phase === 'done' ? html`
                <div class="script-approval-card__done">Done — closing…</div>
            ` : null}
        </div>
    `;
}
