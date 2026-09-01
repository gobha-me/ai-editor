// @ts-check
/**
 * Chat sub-agent-approval card — mount lifecycle around the
 * `SubAgentApprovalCard` Preact component. See docs/DESIGN-sub-agents.md.
 *
 * Mirrors `plan-approval-card.js`/`script-approval-card.js`. Differs
 * from script-approval in that the side-effect after Approve runs
 * *in-process* (the sub-agent's `runToolLoop` invocation in the
 * component) rather than in a sandboxed Worker — sub-agents drive the
 * same `LLM.chat` transport as the parent and need access to
 * `ToolRegistry.executeWithProfile`, both of which live on the main
 * thread. The card owns the in-flight `SubAgentContext` reference so
 * a Stop-button press can release the awaited Promise cleanly; the
 * lifecycle wrapper just owns the slot lookup and Preact cleanup.
 *
 * Decision §9: Preact + htm allowed for new state-heavy surfaces.
 *
 * @since 2.49.0
 * @module chat/subagent-approval-card
 */

import { EventBus } from '../core.js';
import { mountPreact } from '../utils/preact-mount.js';
import { getChatContainer } from './state.js';

/** @type {HTMLElement | null} */
let _slot = null;
/** @type {(() => void) | null} */
let _cleanup = null;
/** @type {boolean} */
let _mounting = false;
/** @type {boolean} */
let _initialized = false;

async function _onPending(pending) {
    if (_slot || _mounting) {
        console.warn('[subagent-approval-card] ignoring nested subagent_approval:pending — already mounted');
        return;
    }
    const chatContainer = getChatContainer();
    if (!chatContainer) {
        console.warn('[subagent-approval-card] no chat container yet; cannot mount');
        return;
    }

    _mounting = true;
    const slot = document.createElement('div');
    slot.className = 'chat-message subagent-approval-slot';
    slot.dataset.pending = '1';
    chatContainer.appendChild(slot);
    _slot = slot;

    try {
        const { SubAgentApprovalCard } = await import('./subagent-approval-card/SubAgentApprovalCard.js');
        _cleanup = await mountPreact(slot, SubAgentApprovalCard, { initial: pending });
        try { chatContainer.scrollTop = chatContainer.scrollHeight; } catch { /* best-effort */ }
    } catch (err) {
        console.error('[subagent-approval-card] mount failed:', err);
        if (slot && slot.isConnected) {
            slot.innerHTML = '<div class="subagent-approval-card subagent-approval-card--error">Failed to render sub-agent approval card. See console for details.</div>';
        }
    } finally {
        _mounting = false;
    }
}

function _onResolved() {
    if (!_slot) return;
    if (_cleanup) {
        try { _cleanup(); } catch (err) {
            console.error('[subagent-approval-card] unmount failed:', err);
        }
        _cleanup = null;
    }
    try { _slot.remove(); } catch { /* best-effort */ }
    _slot = null;
}

/**
 * Wire EventBus subscriptions for sub-agent-approval card lifecycle.
 * Idempotent — called once at chat init from `js/chat/index.js`.
 */
export function initSubAgentApprovalCard() {
    if (_initialized) return;
    _initialized = true;
    EventBus.on('subagent_approval:pending', _onPending);
    EventBus.on('subagent_approval:resolved', _onResolved);
}

/**
 * Test seam — true while a card is mounted.
 * @returns {boolean}
 */
export function _isMounted() {
    return _slot !== null;
}
