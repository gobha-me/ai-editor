// @ts-check
/**
 * Sub-agent transcript panel — Preact slide-over component (2.49.0
 * slice 2 of github#24 Phase 1).
 *
 * Renders the sub-agent's full transcript: task, capability summary,
 * round-by-round messages (system / user / assistant / tool result),
 * tool-call timeline, final cost. Read-only — the parent agent has
 * already received the structured summary; this view is for the human
 * reviewer.
 *
 * Subscribes to `subagent:transcript_updated` events emitted by the
 * runner so a panel opened mid-run reflects new rounds as they arrive.
 *
 * @since 2.49.0
 * @module chat/subagent-transcript-panel/SubAgentTranscriptPanel
 */

import { State, EventBus } from '../../core.js';
import { getPreact } from '../../utils/preact-mount.js';

const { html, useState, useEffect } = await getPreact();

function _formatRelTime(ts) {
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return '';
    const diff = Date.now() - ts;
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ago`;
}

function _formatDuration(start, end) {
    if (typeof start !== 'number' || typeof end !== 'number') return '';
    const ms = end - start;
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

function _stringifyContent(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map(c => (typeof c === 'string' ? c : (c?.text || JSON.stringify(c))))
            .join('\n');
    }
    try { return JSON.stringify(content, null, 2); } catch { return String(content); }
}

function _classifyMessage(msg) {
    if (msg?.role === 'system') return 'system';
    if (msg?.role === 'user') return 'user';
    if (msg?.role === 'assistant') return 'assistant';
    if (msg?.role === 'tool') return 'tool';
    return 'unknown';
}

/**
 * @param {{transcriptId: string, onClose: () => void}} props
 */
export function SubAgentTranscriptPanel({ transcriptId, onClose }) {
    const [, forceRerender] = useState(0);

    useEffect(() => {
        // Re-render on transcript updates emitted by the runner.
        const handler = (ev) => {
            if (ev && ev.transcriptId === transcriptId) {
                forceRerender(n => n + 1);
            }
        };
        EventBus.on('subagent:transcript_updated', handler);
        EventBus.on('subagent:finished', handler);
        return () => {
            try {
                EventBus.off?.('subagent:transcript_updated', handler);
                EventBus.off?.('subagent:finished', handler);
            } catch { /* best-effort */ }
        };
    }, [transcriptId]);

    const transcript = State.subagents?.transcripts?.[transcriptId];
    if (!transcript) {
        return html`
            <div class="subagent-transcript-panel">
                <div class="subagent-transcript-panel__backdrop" onClick=${onClose}></div>
                <div class="subagent-transcript-panel__sheet">
                    <div class="subagent-transcript-panel__header">
                        <h2>Sub-agent transcript</h2>
                        <button type="button" class="subagent-transcript-panel__close" onClick=${onClose}>✕</button>
                    </div>
                    <div class="subagent-transcript-panel__body">
                        <p class="subagent-transcript-panel__empty">
                            Transcript <code>${transcriptId}</code> not found. It may have been cleared on conversation switch.
                        </p>
                    </div>
                </div>
            </div>
        `;
    }

    const messages = Array.isArray(transcript.messages) ? transcript.messages : [];
    const toolActions = Array.isArray(transcript.toolActions) ? transcript.toolActions : [];
    const cost = transcript.cost || { tokens: 0, dollars: 0, rounds: 0 };
    const status = transcript.status || 'unknown';
    const ceilings = transcript.ceilings || {};

    return html`
        <div class="subagent-transcript-panel">
            <div class="subagent-transcript-panel__backdrop" onClick=${onClose}></div>
            <div class="subagent-transcript-panel__sheet">
                <div class="subagent-transcript-panel__header">
                    <h2>
                        Sub-agent transcript
                        <span class="subagent-transcript-panel__status subagent-transcript-panel__status--${status}">${status}</span>
                    </h2>
                    <button type="button" class="subagent-transcript-panel__close" onClick=${onClose}>✕</button>
                </div>

                <div class="subagent-transcript-panel__body">
                    <section class="subagent-transcript-panel__meta">
                        <div><strong>Profile:</strong> <code>${transcript.profileName || 'subagent.v1'}</code></div>
                        <div><strong>Started:</strong> ${_formatRelTime(transcript.startedAt)}</div>
                        ${transcript.finishedAt ? html`<div><strong>Duration:</strong> ${_formatDuration(transcript.startedAt, transcript.finishedAt)}</div>` : null}
                        <div><strong>Cost:</strong> ${cost.tokens.toLocaleString()} tokens · $${cost.dollars.toFixed(4)} · ${cost.rounds} round${cost.rounds === 1 ? '' : 's'}</div>
                        ${ceilings.max_tokens ? html`<div class="subagent-transcript-panel__ceilings"><strong>Ceilings:</strong> ${ceilings.max_tokens.toLocaleString()} tokens / $${ceilings.max_dollars?.toFixed?.(2) ?? '?'} / ${Math.round((ceilings.run_timeout_ms || 0) / 1000)}s</div>` : null}
                    </section>

                    <section class="subagent-transcript-panel__task">
                        <h3>Task</h3>
                        <pre class="subagent-transcript-panel__task-body">${transcript.task || '(no task recorded)'}</pre>
                        ${transcript.contextHint ? html`
                            <h4>Context hint</h4>
                            <pre class="subagent-transcript-panel__context-hint">${transcript.contextHint}</pre>
                        ` : null}
                    </section>

                    ${toolActions.length > 0 ? html`
                        <section class="subagent-transcript-panel__tools">
                            <h3>Tool calls (${toolActions.length})</h3>
                            <ol class="subagent-transcript-panel__tool-list">
                                ${toolActions.map((a, i) => html`
                                    <li key=${i} class=${a.error ? 'subagent-transcript-panel__tool-call--error' : 'subagent-transcript-panel__tool-call'}>
                                        ${a.error ? '❌' : '✅'} <code>${a.toolName}</code>
                                        ${a.args ? html`<small>${JSON.stringify(a.args).slice(0, 100)}</small>` : null}
                                    </li>
                                `)}
                            </ol>
                        </section>
                    ` : null}

                    <section class="subagent-transcript-panel__messages">
                        <h3>Messages (${messages.length})</h3>
                        <ol class="subagent-transcript-panel__message-list">
                            ${messages.map((msg, i) => {
                                const kind = _classifyMessage(msg);
                                const content = _stringifyContent(msg?.content);
                                return html`
                                    <li key=${i} class="subagent-transcript-panel__message subagent-transcript-panel__message--${kind}">
                                        <span class="subagent-transcript-panel__role">${kind}</span>
                                        <pre class="subagent-transcript-panel__content">${content || '(empty)'}</pre>
                                    </li>
                                `;
                            })}
                        </ol>
                    </section>
                </div>
            </div>
        </div>
    `;
}
