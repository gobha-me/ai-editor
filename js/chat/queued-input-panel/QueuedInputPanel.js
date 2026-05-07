// @ts-check
/**
 * Queued user input panel — Preact component.
 *
 * Visible only when `getUserMessageQueueLength() > 0`. Shows the count,
 * each queued message preview, and a × button per message that calls
 * `removeQueuedUserMessage(index)`. FIFO order matches the issue's
 * "delivered in order" spec.
 *
 * Hidden when empty so it stays out of the way during normal use.
 *
 * @since 1.9.1 (github#33 Phase 2)
 * @module chat/queued-input-panel/QueuedInputPanel
 */

import { EventBus } from '../../core.js';
import { getPreact } from '../../utils/preact-mount.js';
import {
    peekUserMessageQueue,
    removeQueuedUserMessage
} from '../state.js';

const { html, useState, useLayoutEffect } = await getPreact();

const PREVIEW_MAX = 80;

function _truncate(text) {
    if (!text) return '(no text — attachments only)';
    return text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) + '…' : text;
}

/**
 * Root queued-input panel component. Reads `peekUserMessageQueue()` each
 * render; subscribes to `chat:queueChanged` to know when to re-render.
 */
export function QueuedInputPanel() {
    const [, setVersion] = useState(0);

    useLayoutEffect(() => {
        const bump = () => setVersion((v) => v + 1);
        const off = EventBus.on('chat:queueChanged', bump);
        return () => { off(); };
    }, []);

    const queue = peekUserMessageQueue();
    if (queue.length === 0) return null;

    const onRemove = (index) => {
        removeQueuedUserMessage(index);
    };

    return html`
        <div class="queued-input-panel" role="status" aria-live="polite">
            <div class="queued-input-panel__header">
                <span class="queued-input-panel__icon" aria-hidden="true">💬</span>
                <span class="queued-input-panel__label">${queue.length} ${queue.length === 1 ? 'message' : 'messages'} queued — will deliver after current turn</span>
            </div>
            <ul class="queued-input-panel__list">
                ${queue.map((msg, i) => html`
                    <li class="queued-input-panel__item" key=${i}>
                        <span class="queued-input-panel__text" title=${msg.text || ''}>${_truncate(msg.text)}</span>
                        ${msg.images && msg.images.length > 0
                            ? html`<span class="queued-input-panel__attach" aria-label=${`${msg.images.length} attachment(s)`}>📎${msg.images.length}</span>`
                            : null}
                        <button type="button"
                            class="queued-input-panel__remove"
                            aria-label="Remove queued message"
                            title="Remove from queue"
                            onClick=${() => onRemove(i)}>×</button>
                    </li>
                `)}
            </ul>
        </div>
    `;
}
