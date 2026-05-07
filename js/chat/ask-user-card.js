// @ts-check
/**
 * Chat ask_user card — mount lifecycle around the `AskUserCard` Preact
 * component (github#33 Phase 1, 1.9.0).
 *
 * Self-subscribes to `EventBus('ask_user:pending')`: when the tool
 * handler stores its resolve fn via `setPendingUserResponse` and the
 * event fires, this module appends a slot to `getChatContainer()` and
 * mounts a Preact tree into it. On `EventBus('ask_user:resolved')` the
 * slot is unmounted (Preact cleanup) and removed from the DOM.
 *
 * Design notes:
 *   - The card mounts during the tool handler's awaited Promise — the
 *     chat loop is blocked on `executeToolCall`, so addToolCallMessage
 *     hasn't run yet for this tool. The card therefore renders ABOVE
 *     the tool-call detail (the detail appears once the user answers
 *     and the loop resumes). UX-wise this is fine: the card is the
 *     active prompt; the tool-call detail is post-hoc audit info.
 *   - Single-slot — Phase 1 assumes one pending ask_user at a time.
 *     Concurrent calls would require a queue; not in scope for 1.9.0.
 *
 * Decision §9 (`docs/ROADMAP.md`): Preact + htm allowed for new
 * state-heavy surfaces from 1.3.0. Joins Memory tab, consent card,
 * scratchpad panel.
 *
 * @since 1.9.0 (github#33 Phase 1)
 * @module chat/ask-user-card
 */

import { EventBus } from '../core.js';
import { mountPreact } from '../utils/preact-mount.js';
import { getChatContainer } from './state.js';

/** @type {HTMLElement | null} The currently-mounted slot, if any. */
let _slot = null;
/** @type {(() => void) | null} Preact cleanup fn for the active mount. */
let _cleanup = null;
/** @type {boolean} Concurrency guard for the async mount. */
let _mounting = false;
/** @type {boolean} Whether init has already wired EventBus subscriptions. */
let _initialized = false;

async function _onPending(pending) {
    if (_slot || _mounting) {
        // Phase 1: nesting not supported. Ignoring is preferable to
        // silently overwriting — the prior question's resolve fn is
        // still live in state.js.
        console.warn('[ask-user-card] ignoring nested ask_user:pending — already mounted');
        return;
    }
    const chatContainer = getChatContainer();
    if (!chatContainer) {
        console.warn('[ask-user-card] no chat container yet; cannot mount');
        return;
    }

    _mounting = true;
    const slot = document.createElement('div');
    slot.className = 'chat-message ask-user-slot';
    slot.dataset.pending = '1';
    chatContainer.appendChild(slot);
    _slot = slot;

    try {
        const { AskUserCard } = await import('./ask-user-card/AskUserCard.js');
        _cleanup = await mountPreact(slot, AskUserCard, { initial: pending });
        try { chatContainer.scrollTop = chatContainer.scrollHeight; } catch { /* best-effort */ }
    } catch (err) {
        console.error('[ask-user-card] mount failed:', err);
        if (slot && slot.isConnected) {
            slot.innerHTML = '<div class="ask-user-card ask-user-card--error">Failed to render question card. See console for details.</div>';
        }
    } finally {
        _mounting = false;
    }
}

function _onResolved() {
    if (!_slot) return;
    if (_cleanup) {
        try { _cleanup(); } catch (err) {
            console.error('[ask-user-card] unmount failed:', err);
        }
        _cleanup = null;
    }
    try { _slot.remove(); } catch { /* best-effort */ }
    _slot = null;
}

/**
 * Wire EventBus subscriptions for ask_user card lifecycle. Idempotent —
 * called once at chat init from `js/chat/index.js`.
 */
export function initAskUserCard() {
    if (_initialized) return;
    _initialized = true;
    EventBus.on('ask_user:pending', _onPending);
    EventBus.on('ask_user:resolved', _onResolved);
}

/**
 * Test seam — true while a card is mounted.
 * @returns {boolean}
 */
export function _isMounted() {
    return _slot !== null;
}
