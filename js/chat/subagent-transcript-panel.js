// @ts-check
/**
 * Sub-agent transcript panel — slide-over wrapper around the
 * `SubAgentTranscriptPanel` Preact component (2.49.0 slice 2 of
 * github#24 Phase 1).
 *
 * Mirrors `scratchpad-panel.js`'s mount lifecycle but is *triggered*
 * (not always-mounted): subscribes to `subagent:open_transcript` to
 * mount, internal close button (or `subagent:close_transcript` event)
 * to unmount. Holds a single slot — opening a second transcript while
 * one is mounted unmounts the first.
 *
 * Reads `State.subagents.transcripts[transcriptId]` directly (no
 * subscription); the live runner writes through as the loop runs, so
 * a panel mounted *during* a sub-agent run sees updates by re-reading
 * on each `subagent:transcript_updated` event the runner emits.
 *
 * @since 2.49.0
 * @module chat/subagent-transcript-panel
 */

import { EventBus } from '../core.js';
import { mountPreact } from '../utils/preact-mount.js';

/** @type {HTMLElement | null} */
let _slot = null;
/** @type {(() => void) | null} */
let _cleanup = null;
/** @type {boolean} */
let _mounting = false;
/** @type {boolean} */
let _initialized = false;
/** @type {string | null} The currently-displayed transcript id. */
let _currentTranscriptId = null;

async function _onOpen({ transcriptId }) {
    if (!transcriptId) return;
    // Switching transcripts: unmount current first.
    if (_slot && _currentTranscriptId !== transcriptId) {
        _onClose();
    }
    if (_slot || _mounting) return;

    _mounting = true;
    const slot = document.createElement('div');
    slot.className = 'subagent-transcript-panel-slot';
    document.body.appendChild(slot);
    _slot = slot;
    _currentTranscriptId = transcriptId;

    try {
        const { SubAgentTranscriptPanel } = await import('./subagent-transcript-panel/SubAgentTranscriptPanel.js');
        _cleanup = await mountPreact(slot, SubAgentTranscriptPanel, {
            transcriptId,
            onClose: () => {
                try { EventBus.emit('subagent:close_transcript', { transcriptId }); } catch { /* */ }
            },
        });
    } catch (err) {
        console.error('[subagent-transcript-panel] mount failed:', err);
        if (slot && slot.isConnected) {
            slot.innerHTML = '<div class="subagent-transcript-panel subagent-transcript-panel--error">Failed to render transcript panel. See console for details.</div>';
        }
    } finally {
        _mounting = false;
    }
}

function _onClose() {
    if (!_slot) return;
    if (_cleanup) {
        try { _cleanup(); } catch (err) {
            console.error('[subagent-transcript-panel] unmount failed:', err);
        }
        _cleanup = null;
    }
    try { _slot.remove(); } catch { /* best-effort */ }
    _slot = null;
    _currentTranscriptId = null;
}

/**
 * Wire EventBus subscriptions. Idempotent — called once at chat init.
 */
export function initSubAgentTranscriptPanel() {
    if (_initialized) return;
    _initialized = true;
    EventBus.on('subagent:open_transcript', _onOpen);
    EventBus.on('subagent:close_transcript', _onClose);
}

/**
 * Test seam — true while a panel is mounted.
 * @returns {boolean}
 */
export function _isMounted() {
    return _slot !== null;
}
