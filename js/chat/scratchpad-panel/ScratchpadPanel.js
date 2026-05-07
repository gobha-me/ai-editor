// @ts-check
/**
 * Chat scratchpad visibility panel — Preact component.
 *
 * Real-time view of `State.scratchpad` for the user. The scratchpad is
 * LLM-private storage (`scratchpad_write` / `scratchpad_read` /
 * `scratchpad_clear` tools in `js/tools/scratchpad-tools.js`) that
 * survives context compression — same survival mechanism as todos
 * (1.8.0). Without this panel users have no way to audit what the LLM
 * is "remembering."
 *
 * Read-only in 1.8.4 (github#34). Editing the scratchpad introduces
 * conflict-resolution complexity (LLM writes mid-edit) that the issue
 * itself flags as an open question — deferred to a follow-up.
 *
 * @since 1.8.4 (github#34)
 * @module chat/scratchpad-panel/ScratchpadPanel
 */

import { State, EventBus, Storage } from '../../core.js';
import { getPreact } from '../../utils/preact-mount.js';

// useLayoutEffect rather than useEffect so the EventBus subscription
// registers synchronously after the first DOM commit. Preact 10's
// useEffect queues until the next render in this codebase's
// vendor-bundle environment, which means a subscription set up with
// useEffect would miss any emit fired before the second render — we
// observed this in tests/index.html where mountPreact + emit produced
// `listenersAfterMount: 0`. Layout effects are flushed synchronously,
// so the subscription is live the instant mountPreact resolves.
const { html, useState, useLayoutEffect } = await getPreact();

const EXPANDED_KEY = 'scratchpadPanelExpanded';

/**
 * Snapshot the current scratchpad as `[key, content]` pairs sorted by key.
 * Sorting is purely cosmetic — keys are user/model-chosen and don't carry
 * implicit order; alphabetical avoids visual jitter when an LLM rewrites
 * an existing key.
 */
function _entries() {
    const pad = (State && State.scratchpad) || {};
    return Object.keys(pad).sort().map((k) => [k, pad[k]]);
}

/**
 * Root scratchpad panel component. Reads `State.scratchpad` directly each
 * render — `State` is the source of truth. Subscribes to three EventBus
 * channels to know when to re-render:
 *
 *   - `scratchpad:changed` — write/clear from the scratchpad tools (1.8.4
 *     emission added in `js/tools/scratchpad-tools.js`)
 *   - `conversation:loaded` — switch resets `State.scratchpad = {}`
 *     (`js/chat/conversations.js` line 263)
 *   - `conversation:created` — new chat resets `State.scratchpad = {}`
 *     (`js/chat/conversations.js` line 305)
 */
export function ScratchpadPanel() {
    const [, setVersion] = useState(0);
    const [expanded, setExpanded] = useState(() => Storage.get(EXPANDED_KEY, false) === true);

    // Single effect for the three EventBus subscriptions so cleanup
    // unsubscribes from all three in one shot.
    useLayoutEffect(() => {
        const bump = () => setVersion((v) => v + 1);
        const offChanged = EventBus.on('scratchpad:changed', bump);
        const offLoaded = EventBus.on('conversation:loaded', bump);
        const offCreated = EventBus.on('conversation:created', bump);
        return () => { offChanged(); offLoaded(); offCreated(); };
    }, []);

    const entries = _entries();
    const count = entries.length;

    const onToggle = () => {
        const next = !expanded;
        setExpanded(next);
        try { Storage.set(EXPANDED_KEY, next); } catch { /* best-effort */ }
    };

    return html`
        <div class=${'scratchpad-panel ' + (expanded ? 'scratchpad-panel--expanded' : 'scratchpad-panel--collapsed')}>
            <button type="button"
                class="scratchpad-panel__toggle"
                aria-expanded=${expanded}
                aria-controls="scratchpadPanelBody"
                onClick=${onToggle}
                title=${expanded ? 'Collapse Notes panel' : 'Expand Notes panel'}>
                <span class="scratchpad-panel__caret" aria-hidden="true">${expanded ? '▾' : '▸'}</span>
                <span class="scratchpad-panel__label">Notes</span>
                <span class="scratchpad-panel__count" aria-label=${`${count} ${count === 1 ? 'entry' : 'entries'}`}>${count}</span>
            </button>
            ${expanded
                ? html`
                    <div id="scratchpadPanelBody" class="scratchpad-panel__body">
                        ${count === 0
                            ? html`<div class="scratchpad-panel__empty">The LLM hasn't recorded any notes yet.</div>`
                            : entries.map(([k, v]) => html`
                                <details class="scratchpad-panel__entry" key=${k}>
                                    <summary class="scratchpad-panel__entry-key">${k}</summary>
                                    <pre class="scratchpad-panel__entry-content">${v}</pre>
                                </details>
                            `)}
                    </div>
                `
                : null}
        </div>
    `;
}
