// @ts-check
/**
 * Chat script-approval card — mount lifecycle around the
 * `ScriptApprovalCard` Preact component (1.16.0 — DESIGN-llm-authored-
 * automation.md §"First-Ship Scope").
 *
 * Mirrors `plan-approval-card.js` exactly for the mount/unmount
 * sequence. Differs in two ways:
 *   1. The card transitions through three states (review → running →
 *      done) instead of plan-mode's single review state — Approve
 *      doesn't immediately resolve; it spawns the Worker and waits.
 *   2. This file owns the Worker handle for tear-down hygiene. The
 *      component asks for the worker via the prop bag; this file spawns
 *      on first request, proxies `git_call` messages back to the
 *      main-thread `Git.*` API, and terminates the worker on either
 *      `script_approval:resolved` (normal completion) or `cancelToolLoop`
 *      (user hit Stop). Without this ownership the worker would outlive
 *      the card on a slow script.
 *
 * Decision §9: Preact + htm allowed for new state-heavy surfaces.
 * Joins ask-user-card, plan-approval-card, scratchpad-panel,
 * queued-input-panel.
 *
 * @since 1.16.0
 * @module chat/script-approval-card
 */

import { EventBus } from '../core.js';
import { mountPreact } from '../utils/preact-mount.js';
import { getChatContainer } from './state.js';
import { Git } from '../git.js';

/** @type {HTMLElement | null} */
let _slot = null;
/** @type {(() => void) | null} */
let _cleanup = null;
/** @type {boolean} */
let _mounting = false;
/** @type {boolean} */
let _initialized = false;
/** @type {Worker | null} */
let _worker = null;
/**
 * Captured stdout/stderr accumulator — forwarded to the cancel envelope
 * if the user hits Stop while the script is running, so the model sees
 * partial output instead of an empty cancel.
 * @type {{stdout: string, stderr: string}}
 */
let _runOutput = { stdout: '', stderr: '' };

/**
 * Spawn the worker on demand, attach its message handler, and return
 * the handle. The component calls this from its Approve path.
 *
 * @returns {Worker}
 */
function _ensureWorker() {
    if (_worker) return _worker;
    // Path is relative to this module; the browser resolves it via the
    // module URL. Worker constructor in modern browsers supports
    // `{ type: 'module' }` for ESM workers — the script-runner-worker
    // uses dynamic import for the runner helper.
    const url = new URL('../workers/script-runner-worker.js', import.meta.url);
    _worker = new Worker(url, { type: 'module' });

    _worker.addEventListener('message', async (e) => {
        const msg = e.data || {};
        if (msg.type === 'git_call') {
            // Worker is proxying a `Git.getFile` / `Git.getFileTree` call.
            // Resolve on the main thread (where State + provider live)
            // and post back the result. The worker awaits via call_id.
            const { call_id, fn, args } = msg;
            try {
                let value;
                if (fn === 'getFile') {
                    value = await Git.getFile(...(args || []));
                } else if (fn === 'readFile') {
                    // Convenience unwrap of getFile's envelope — the
                    // 99% case the model wants. Mirrors `read_file`
                    // tool semantics (returns just the string).
                    const file = await Git.getFile(...(args || []));
                    value = (file && typeof file === 'object' && typeof file.content === 'string')
                        ? file.content
                        : '';
                } else if (fn === 'getFileTree') {
                    value = await Git.getFileTree(...(args || []));
                } else {
                    throw new Error(`Unknown Git adapter fn: ${fn}`);
                }
                _worker?.postMessage({ type: 'git_call_result', call_id, ok: true, value });
            } catch (err) {
                _worker?.postMessage({
                    type: 'git_call_result',
                    call_id,
                    ok: false,
                    error: (err && err.message) ? err.message : String(err),
                });
            }
            return;
        }
        if (msg.type === 'scriptComplete' || msg.type === 'error') {
            // Cache for partial-output capture on cancel before the
            // component reads them off the resolve envelope.
            if (msg.type === 'scriptComplete') {
                _runOutput.stdout = msg.stdout || '';
                _runOutput.stderr = msg.stderr || '';
            }
            // Component owns the resolve via its message listener (see
            // ScriptApprovalCard.js); we just keep the buffers warm.
        }
    });
    return _worker;
}

function _terminateWorker() {
    if (!_worker) return;
    try { _worker.terminate(); } catch { /* best-effort */ }
    _worker = null;
    _runOutput = { stdout: '', stderr: '' };
}

/**
 * Test seam — exposes the partial output captured from the worker so
 * the cancel path can attach it to the cancel envelope. Returns a copy.
 */
export function _peekRunOutput() {
    return { stdout: _runOutput.stdout, stderr: _runOutput.stderr };
}

async function _onPending(pending) {
    if (_slot || _mounting) {
        console.warn('[script-approval-card] ignoring nested script_approval:pending — already mounted');
        return;
    }
    const chatContainer = getChatContainer();
    if (!chatContainer) {
        console.warn('[script-approval-card] no chat container yet; cannot mount');
        return;
    }

    _mounting = true;
    _runOutput = { stdout: '', stderr: '' };
    const slot = document.createElement('div');
    slot.className = 'chat-message script-approval-slot';
    slot.dataset.pending = '1';
    chatContainer.appendChild(slot);
    _slot = slot;

    try {
        const { ScriptApprovalCard } = await import('./script-approval-card/ScriptApprovalCard.js');
        _cleanup = await mountPreact(slot, ScriptApprovalCard, {
            initial: pending,
            ensureWorker: _ensureWorker,
            captureOutput: (stdout, stderr) => {
                _runOutput.stdout = stdout || '';
                _runOutput.stderr = stderr || '';
            },
        });
        try { chatContainer.scrollTop = chatContainer.scrollHeight; } catch { /* best-effort */ }
    } catch (err) {
        console.error('[script-approval-card] mount failed:', err);
        if (slot && slot.isConnected) {
            slot.innerHTML = '<div class="script-approval-card script-approval-card--error">Failed to render script approval card. See console for details.</div>';
        }
    } finally {
        _mounting = false;
    }
}

function _onResolved() {
    _terminateWorker();
    if (!_slot) return;
    if (_cleanup) {
        try { _cleanup(); } catch (err) {
            console.error('[script-approval-card] unmount failed:', err);
        }
        _cleanup = null;
    }
    try { _slot.remove(); } catch { /* best-effort */ }
    _slot = null;
}

/**
 * Wire EventBus subscriptions for script-approval card lifecycle.
 * Idempotent — called once at chat init from `js/chat/index.js`.
 */
export function initScriptApprovalCard() {
    if (_initialized) return;
    _initialized = true;
    EventBus.on('script_approval:pending', _onPending);
    EventBus.on('script_approval:resolved', _onResolved);
}

/**
 * Test seam — true while a card is mounted.
 * @returns {boolean}
 */
export function _isMounted() {
    return _slot !== null;
}
