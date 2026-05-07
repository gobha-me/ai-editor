// @ts-check
/**
 * Chat plan-approval card — mount lifecycle around the
 * `PlanApprovalCard` Preact component (github#25, 1.10.0).
 *
 * Mirrors the ask-user-card shape exactly: subscribes to
 * `EventBus('plan_approval:pending')` to mount, and
 * `plan_approval:resolved` to unmount. The tool handler in
 * `js/tools/plan-tools.js` stores its resolve fn via
 * `setPendingPlanApproval`, which fires the pending event; the
 * Preact component calls `resolvePlanApproval(envelope)` from a
 * button click, which fires the resolved event. Single-slot —
 * Phase 1 assumes one pending plan at a time.
 *
 * Decision §9 (`docs/ROADMAP.md`): Preact + htm allowed for new
 * state-heavy surfaces from 1.3.0. Joins ask-user-card,
 * scratchpad-panel, queued-input-panel, memory chip.
 *
 * @since 1.10.0 (github#25)
 * @module chat/plan-approval-card
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
        console.warn('[plan-approval-card] ignoring nested plan_approval:pending — already mounted');
        return;
    }
    const chatContainer = getChatContainer();
    if (!chatContainer) {
        console.warn('[plan-approval-card] no chat container yet; cannot mount');
        return;
    }

    _mounting = true;
    const slot = document.createElement('div');
    slot.className = 'chat-message plan-approval-slot';
    slot.dataset.pending = '1';
    chatContainer.appendChild(slot);
    _slot = slot;

    try {
        const { PlanApprovalCard } = await import('./plan-approval-card/PlanApprovalCard.js');
        _cleanup = await mountPreact(slot, PlanApprovalCard, { initial: pending });
        try { chatContainer.scrollTop = chatContainer.scrollHeight; } catch { /* best-effort */ }
    } catch (err) {
        console.error('[plan-approval-card] mount failed:', err);
        if (slot && slot.isConnected) {
            slot.innerHTML = '<div class="plan-approval-card plan-approval-card--error">Failed to render plan approval card. See console for details.</div>';
        }
    } finally {
        _mounting = false;
    }
}

function _onResolved() {
    if (!_slot) return;
    if (_cleanup) {
        try { _cleanup(); } catch (err) {
            console.error('[plan-approval-card] unmount failed:', err);
        }
        _cleanup = null;
    }
    try { _slot.remove(); } catch { /* best-effort */ }
    _slot = null;
}

/**
 * Wire EventBus subscriptions for plan-approval card lifecycle.
 * Idempotent — called once at chat init from `js/chat/index.js`.
 */
export function initPlanApprovalCard() {
    if (_initialized) return;
    _initialized = true;
    EventBus.on('plan_approval:pending', _onPending);
    EventBus.on('plan_approval:resolved', _onResolved);
}

/**
 * Test seam — true while a card is mounted.
 * @returns {boolean}
 */
export function _isMounted() {
    return _slot !== null;
}
