/**
 * Chat State Management
 * Centralized state for chat module
 */

import { EventBus, Storage } from '../core.js';

// DOM references
let chatContainer = null;
let inputElement = null;

// Edit state — `{ code, raw, path?, originalContent? }`.
// `code` is the proposed file contents; `raw` is the model's full reply
// (often empty when the model returns only a fenced code block).
// `path` and `originalContent` (1.7.1.x github#38) are snapshotted at
// `setPendingEdit` time so the approval-card renderer can show path +
// unified diff against the file the user is looking at, even if the
// user edits the buffer before approving.
let pendingEdit = null;

// ask_user (github#33 Phase 1) — pending question state. Holds the
// resolve fn the tool handler is awaiting; the AskUserCard component
// (or a cancel path) calls resolveUserResponse / cancelUserResponse to
// settle the Promise so the chat loop's tool result is whatever the
// user submits. Single-slot in 1.9.0; nesting would require a queue.
let pendingUserResponse = null;  // { question, type, options, allow_custom, resolve }

// Image attachments pending send
let pendingImages = [];  // Images [{ dataUrl, name, size, type: 'image' }]let pendingFiles = [];  // Text/binary [{ text, name, size, type: 'text' }]
let pendingFiles = [];  // Text/binary [{ text, name, size, type: 'text' }]

// Plan Mode (github#25) — global flag that restricts the LLM to read-only
// tools, instructs it to produce a structured plan, and surfaces an
// approval card before any mutating action. Persisted via Storage so a
// refresh keeps the mode the user last saw. Toggled from the chip in the
// chat input area, the auto-engage-on-issue-start setting in profiles-tab,
// or implicitly cleared when an approval card resolves with status:
// 'approved'. See pendingPlanApproval below for the gate that pauses the
// tool loop.
//
// Hydrated by `hydratePlanMode()` from `app.js` after `Storage.init()` —
// the module-load timing predates Storage's IDB-backed cache, so reading
// here would miss the Storage-prefixed key. The boot call also migrates
// the pre-2.40.0 unprefixed `chat.planMode` legacy key onto Storage.
let planMode = false;

// Plan-approval pending state — single-slot, mirrors pendingUserResponse.
// Set by submit_plan_for_approval tool handler; resolved by the
// PlanApprovalCard component. Held separately from pendingUserResponse so
// the two cards can mount independently and so handlers.js can inspect
// the resolution envelope (approved → setPlanMode(false)) without
// guessing which card resolved.
let pendingPlanApproval = null;  // { plan, resolve }

// Approved-plan slot — gitea#424 (2.52.0). Captured at
// `resolvePlanApproval` when the user clicks Approve, exposed to the
// model during execution via the `read_approved_plan` tool so the
// executor can reference the approved plan instead of regenerating
// deliverable content from its own working memory. Module-scope only —
// not persisted across page refresh; cleared on new chat / conversation
// switch alongside `State.scratchpad`. Rejected / cancelled approvals
// do NOT write here (the slot's contract is "the plan the user said yes
// to," not "the most recent plan submitted").
let approvedPlan = null;  // { plan: string, approvedAt: number } | null

// Script-approval pending state — single-slot, mirrors pendingPlanApproval.
// 1.16.0: LLM-authored automation Phase 1 (DESIGN-llm-authored-automation.md).
// Set by submit_script_for_approval tool handler; resolved by the
// ScriptApprovalCard component (after the Worker run completes, on Reject,
// or on Cancel). Held separately because the resolution envelope shape is
// different (approved → carries stdout/stderr/runtime_ms/truncated; cancel
// can carry partial_stdout / partial_stderr).
let pendingScriptApproval = null;  // { source, description, expected_output, resolve }

// Sub-agent approval pending state — single-slot, mirrors pendingScriptApproval.
// 2.49.0.0 — slice 1 of github#24 Phase 1 (DESIGN-sub-agents.md §"Gap 6").
// Set by the `delegate_task` tool handler (slice 2); resolved by the
// SubAgentApprovalCard component (slice 2) after the sub-agent loop
// completes, on Reject, or on Cancel. Held separately because the
// resolution envelope shape is distinct (approved → carries status /
// summary / artifacts / cost / transcript_id; cancel can carry
// `partial: true`).
//
// Slice 1 lands the slot + helpers; no caller writes to it yet. The
// `cancelToolLoop` path below already invokes `cancelSubAgentApproval`
// so a future stop-button press during slice 2's first dogfood will not
// leak the awaited Promise.
let pendingSubAgentApproval = null;  // { transcriptId, task, contextHint, profileName, modelOverride, capabilitySummary, resolve }  (2.89.0 gitea#505 — modelOverride field)

// Control flags
let _cancelToolLoop = false;  // Module-level cancel flag for stop button

/**
 * Initialize chat DOM references
 */
export function initChatState(containerEl, inputEl) {
    chatContainer = containerEl;
    inputElement = inputEl;
}

/**
 * Get chat container element
 */
export function getChatContainer() {
    return chatContainer;
}

/**
 * Get input element
 */
export function getInputElement() {
    return inputElement;
}

/**
 * Get pending edit
 */
export function getPendingEdit() {
    return pendingEdit;
}

/**
 * Set pending edit
 */
export function setPendingEdit(edit) {
    pendingEdit = edit;
}

/**
 * Clear pending edit
 */
export function clearPendingEdit() {
    pendingEdit = null;
}

// ============================================
// ASK_USER PENDING RESPONSE (github#33 Phase 1)
// ============================================

/**
 * Get the currently pending ask_user request, if any.
 * Returns the object passed to setPendingUserResponse — the AskUserCard
 * reads `question`, `type`, `options`, `allow_custom` from it.
 *
 * @returns {{question: string, type: string, options?: Array, allow_custom?: boolean, resolve: Function} | null}
 */
export function getPendingUserResponse() {
    return pendingUserResponse;
}

/**
 * Set the pending ask_user state. Called by the tool handler immediately
 * before it returns the Promise that `resolve` will eventually settle.
 * Emits `ask_user:pending` so the card mounts itself.
 *
 * @param {{question: string, type: string, options?: Array, allow_custom?: boolean, resolve: Function}} pending
 */
export function setPendingUserResponse(pending) {
    pendingUserResponse = pending;
    try { EventBus.emit('ask_user:pending', pending); } catch { /* best-effort */ }
}

/**
 * Resolve the pending ask_user Promise with the user's answer. Called by
 * the AskUserCard's submit button. The shape of `answer` is the
 * card-side payload (selected value(s) and/or custom text); the chat
 * loop turns it into a tool_result verbatim.
 *
 * No-op when nothing is pending.
 *
 * @param {Object} answer
 * @returns {boolean} True if a Promise was resolved.
 */
export function resolveUserResponse(answer) {
    if (!pendingUserResponse) return false;
    const { resolve } = pendingUserResponse;
    pendingUserResponse = null;
    try { EventBus.emit('ask_user:resolved', { cancelled: false }); } catch { /* best-effort */ }
    try { resolve({ status: 'answered', answer }); } catch (err) {
        console.error('[ask_user] resolve threw:', err);
    }
    return true;
}

/**
 * Cancel the pending ask_user Promise. Called by the tool-loop cancel
 * path (Stop button) so the awaited handler doesn't leak. The handler
 * receives a cancellation envelope; the loop discards it as part of
 * the cancel bookkeeping.
 *
 * @returns {boolean} True if a Promise was cancelled.
 */
export function cancelUserResponse() {
    if (!pendingUserResponse) return false;
    const { resolve } = pendingUserResponse;
    pendingUserResponse = null;
    try { EventBus.emit('ask_user:resolved', { cancelled: true }); } catch { /* best-effort */ }
    try {
        resolve({ status: 'cancelled', cancelled: true, error: 'User cancelled the question.' });
    } catch (err) {
        console.error('[ask_user] cancel resolve threw:', err);
    }
    return true;
}

/**
 * Check if tool loop is cancelled
 */
export function isToolLoopCancelled() {
    return _cancelToolLoop;
}

/**
 * Cancel tool loop. Also releases any pending ask_user Promise so the
 * tool handler doesn't leak — without this, cancelling mid-question
 * would leave the awaited Promise unsettled forever. Same goes for
 * pending plan approval (github#25), script approval (1.16.0), and
 * sub-agent approval (2.49.0.0 — slice 1 of github#24 Phase 1).
 */
export function cancelToolLoop() {
    _cancelToolLoop = true;
    if (pendingUserResponse) {
        cancelUserResponse();
    }
    if (pendingPlanApproval) {
        cancelPlanApproval();
    }
    if (pendingScriptApproval) {
        cancelScriptApproval();
    }
    if (pendingSubAgentApproval) {
        cancelSubAgentApproval();
    }
}

// ============================================
// PLAN MODE (github#25)
// ============================================

/**
 * Read the persisted plan-mode value into the module-scope flag. Called
 * from `app.js` boot after `Storage.init()` completes. Also migrates the
 * pre-2.40.0 unprefixed `chat.planMode` legacy localStorage key, which
 * stored `'1'`/`'0'` strings — the new Storage layout holds a real
 * boolean under the prefixed `ai-editor-chat.planMode` key.
 */
export function hydratePlanMode() {
    Storage.migrateLegacyKey('chat.planMode', 'chat.planMode', { transform: (s) => s === '1' });
    planMode = Storage.get('chat.planMode', false) === true;
}

/**
 * @returns {boolean}
 */
export function getPlanMode() {
    return planMode;
}

/**
 * Toggle plan mode. Persists via Storage and emits
 * `plan-mode:changed` so the chip + banner re-render. The chat loop
 * reads this fresh per round in handlers.js, and the system prompt
 * builder reads it inside buildSystemPrompt() — both paths see the new
 * value on the next message boundary, never mid-round.
 *
 * @param {boolean} value
 */
export function setPlanMode(value) {
    const next = !!value;
    if (next === planMode) return;
    planMode = next;
    Storage.set('chat.planMode', planMode);
    try { EventBus.emit('plan-mode:changed', planMode); } catch { /* best-effort */ }
}

/**
 * @returns {{ plan: string, resolve: Function } | null}
 */
export function getPendingPlanApproval() {
    return pendingPlanApproval;
}

/**
 * Set the pending plan-approval state. Called by submit_plan_for_approval
 * tool handler immediately before it returns the Promise that `resolve`
 * will eventually settle. Emits `plan_approval:pending` so the card mounts.
 *
 * @param {{ plan: string, resolve: Function }} pending
 */
export function setPendingPlanApproval(pending) {
    pendingPlanApproval = pending;
    try { EventBus.emit('plan_approval:pending', pending); } catch { /* best-effort */ }
}

/**
 * Resolve the pending plan-approval Promise with the user's verdict.
 * Called by the PlanApprovalCard's Approve / Reject buttons. The
 * envelope shape ({ status: 'approved' | 'rejected', feedback?: string })
 * becomes the tool_result the chat loop forwards to the LLM. handlers.js
 * separately watches for { status: 'approved' } to call setPlanMode(false)
 * before the next round.
 *
 * @param {{ status: 'approved' | 'rejected', feedback?: string }} envelope
 * @returns {boolean} True if a Promise was resolved.
 */
export function resolvePlanApproval(envelope) {
    if (!pendingPlanApproval) return false;
    const { plan, resolve } = pendingPlanApproval;
    // gitea#424 — capture the approved plan body before clearing the
    // pending slot so the executor can read it back via `read_approved_plan`.
    // Only writes on status='approved'; rejected/cancelled leave the prior
    // slot untouched (a re-plan iteration shouldn't erase a previously
    // approved plan from earlier in the conversation).
    if (envelope && envelope.status === 'approved' && typeof plan === 'string' && plan.length > 0) {
        approvedPlan = { plan, approvedAt: Date.now() };
    }
    pendingPlanApproval = null;
    try { EventBus.emit('plan_approval:resolved', { cancelled: false, ...envelope }); } catch { /* best-effort */ }
    try { resolve(envelope); } catch (err) {
        console.error('[plan_approval] resolve threw:', err);
    }
    return true;
}

/**
 * Cancel the pending plan-approval Promise. Called from the Stop-button
 * cancel path (cancelToolLoop) so the awaited handler doesn't leak.
 *
 * @returns {boolean} True if a Promise was cancelled.
 */
export function cancelPlanApproval() {
    if (!pendingPlanApproval) return false;
    const { resolve } = pendingPlanApproval;
    pendingPlanApproval = null;
    try { EventBus.emit('plan_approval:resolved', { cancelled: true }); } catch { /* best-effort */ }
    try {
        resolve({ status: 'cancelled', cancelled: true, error: 'User cancelled the plan approval.' });
    } catch (err) {
        console.error('[plan_approval] cancel resolve threw:', err);
    }
    return true;
}

/**
 * Read the approved-plan slot. Backs the `read_approved_plan` tool
 * (gitea#424, 2.52.0). Returns null when no plan has been approved in
 * the current conversation.
 *
 * @returns {{ plan: string, approvedAt: number } | null}
 */
export function getApprovedPlan() {
    return approvedPlan;
}

/**
 * Replace the approved-plan slot. Primary writer is `resolvePlanApproval`
 * on `status='approved'`; exposed here for tests + future seam consumers
 * that want to seed the slot without round-tripping through the approval
 * card.
 *
 * @param {{ plan: string, approvedAt: number } | null} value
 */
export function setApprovedPlan(value) {
    approvedPlan = value;
}

/**
 * Clear the approved-plan slot. Called on conversation switch / new chat
 * by `js/chat/conversations.js` alongside the scratchpad reset, so a
 * fresh conversation starts without a stale plan from the prior thread.
 */
export function clearApprovedPlan() {
    approvedPlan = null;
}

/**
 * Reset tool loop cancel flag
 */
export function resetToolLoopCancel() {
    _cancelToolLoop = false;
}

// ============================================
// SCRIPT-APPROVAL (1.16.0 — DESIGN-llm-authored-automation.md)
// ============================================

/**
 * @returns {{ source: string, description: string, expected_output: string, resolve: Function } | null}
 */
export function getPendingScriptApproval() {
    return pendingScriptApproval;
}

/**
 * Set the pending script-approval state. Called by the
 * `submit_script_for_approval` tool handler immediately before it returns
 * the Promise that `resolve` will eventually settle. Emits
 * `script_approval:pending` so the card mounts.
 *
 * Single-slot: nesting is impossible because the chat loop is paused on
 * the awaited Promise. If a second pending fires anyway it indicates a
 * bug in the chat loop; the existing `console.warn` from the card layer
 * is the visible signal.
 *
 * @param {{ source: string, description: string, expected_output: string, resolve: Function }} pending
 */
export function setPendingScriptApproval(pending) {
    pendingScriptApproval = pending;
    try { EventBus.emit('script_approval:pending', pending); } catch { /* best-effort */ }
}

/**
 * Resolve the pending script-approval Promise with the user's verdict +
 * (when approved) the Worker's captured output. The envelope shape:
 *   - { status: 'approved', stdout, stderr, runtime_ms, truncated }
 *   - { status: 'rejected', feedback }
 *   - { status: 'cancelled', cancelled: true, partial_stdout?, partial_stderr? }
 *
 * The chat loop forwards this verbatim as the tool_result; the model
 * uses stdout/stderr/runtime_ms/truncated to decide its next move
 * (re-author tighter? aggregate? give up?).
 *
 * @param {Object} envelope
 * @returns {boolean} True if a Promise was resolved.
 */
export function resolveScriptApproval(envelope) {
    if (!pendingScriptApproval) return false;
    const { resolve } = pendingScriptApproval;
    pendingScriptApproval = null;
    try { EventBus.emit('script_approval:resolved', { cancelled: false, ...envelope }); } catch { /* best-effort */ }
    try { resolve(envelope); } catch (err) {
        console.error('[script_approval] resolve threw:', err);
    }
    return true;
}

/**
 * Cancel the pending script-approval Promise. Called from the Stop-button
 * cancel path (cancelToolLoop) so the awaited handler doesn't leak. If
 * the Worker was already running, the card layer terminates it before
 * calling this function and passes any captured partial output.
 *
 * @param {{ partial_stdout?: string, partial_stderr?: string }} [extras]
 * @returns {boolean} True if a Promise was cancelled.
 */
export function cancelScriptApproval(extras) {
    if (!pendingScriptApproval) return false;
    const { resolve } = pendingScriptApproval;
    pendingScriptApproval = null;
    const partial = (extras && typeof extras === 'object') ? extras : {};
    try { EventBus.emit('script_approval:resolved', { cancelled: true }); } catch { /* best-effort */ }
    try {
        resolve({
            status: 'cancelled',
            cancelled: true,
            error: 'User cancelled the script approval.',
            partial_stdout: typeof partial.partial_stdout === 'string' ? partial.partial_stdout : '',
            partial_stderr: typeof partial.partial_stderr === 'string' ? partial.partial_stderr : '',
        });
    } catch (err) {
        console.error('[script_approval] cancel resolve threw:', err);
    }
    return true;
}

// ============================================
// SUB-AGENT APPROVAL (2.49.0.0 — DESIGN-sub-agents.md)
// ============================================

/**
 * @returns {{ transcriptId: string, task: string, contextHint?: string, profileName: string, capabilitySummary?: object, resolve: Function } | null}
 */
export function getPendingSubAgentApproval() {
    return pendingSubAgentApproval;
}

/**
 * Set the pending sub-agent-approval state. Called by the `delegate_task`
 * tool handler (slice 2) immediately before it returns the Promise that
 * `resolve` will eventually settle. Emits `subagent_approval:pending` so
 * the card mounts.
 *
 * Single-slot: nesting is impossible because the chat loop is paused on
 * the awaited Promise. Phase 2 (parallel sub-agents per DESIGN §"Phasing")
 * lifts this; Phase 1 (slice 1 + slice 2) does not.
 *
 * @param {{ transcriptId: string, task: string, contextHint?: string, profileName: string, capabilitySummary?: object, resolve: Function }} pending
 */
export function setPendingSubAgentApproval(pending) {
    pendingSubAgentApproval = pending;
    try { EventBus.emit('subagent_approval:pending', pending); } catch { /* best-effort */ }
}

/**
 * Resolve the pending sub-agent-approval Promise with the user's verdict +
 * (when approved) the sub-agent's structured result envelope. The
 * envelope shape (DESIGN §Decision §6):
 *   - { status: 'completed' | 'partial', summary, artifacts, cost, transcript_id }
 *   - { status: 'rejected', feedback }
 *   - { status: 'cancelled', cancelled: true, partial: true, summary?, cost?, transcript_id }
 *   - { status: 'errored', error, cost?, transcript_id }
 *
 * The chat loop forwards this verbatim as the tool_result; the parent
 * agent reads `summary` as the load-bearing answer. `artifacts` is
 * informational; `cost` is informational (visible to the model so it
 * learns when delegation is paying off); `transcript_id` is intended
 * for the human reviewer.
 *
 * @param {Object} envelope
 * @returns {boolean} True if a Promise was resolved.
 */
export function resolveSubAgentApproval(envelope) {
    if (!pendingSubAgentApproval) return false;
    const { resolve } = pendingSubAgentApproval;
    pendingSubAgentApproval = null;
    try { EventBus.emit('subagent_approval:resolved', { cancelled: false, ...envelope }); } catch { /* best-effort */ }
    try { resolve(envelope); } catch (err) {
        console.error('[subagent_approval] resolve threw:', err);
    }
    return true;
}

/**
 * Cancel the pending sub-agent-approval Promise. Called from the
 * Stop-button cancel path (cancelToolLoop) so the awaited handler
 * doesn't leak. If the sub-agent loop was already running (post-Approve),
 * the card layer terminates it via the parent cancel signal before
 * calling this function and passes any captured partial result.
 *
 * @param {{ summary?: string, cost?: object, transcript_id?: string }} [extras]
 * @returns {boolean} True if a Promise was cancelled.
 */
export function cancelSubAgentApproval(extras) {
    if (!pendingSubAgentApproval) return false;
    const { resolve } = pendingSubAgentApproval;
    pendingSubAgentApproval = null;
    const partial = (extras && typeof extras === 'object') ? extras : {};
    try { EventBus.emit('subagent_approval:resolved', { cancelled: true }); } catch { /* best-effort */ }
    try {
        resolve({
            status: 'cancelled',
            cancelled: true,
            partial: true,
            error: 'User cancelled the sub-agent approval.',
            summary: typeof partial.summary === 'string' ? partial.summary : '',
            cost: (partial.cost && typeof partial.cost === 'object') ? partial.cost : null,
            transcript_id: typeof partial.transcript_id === 'string' ? partial.transcript_id : '',
        });
    } catch (err) {
        console.error('[subagent_approval] cancel resolve threw:', err);
    }
    return true;
}

// ============================================
// IMAGE ATTACHMENTS
// ============================================

/**
 * Get current pending images.
 * @returns {Array<{dataUrl: string, name: string, size: number}>}
 */
export function getPendingImages() {
    return pendingImages;
}

/**
 * Add an image to the pending queue.
 * @param {{dataUrl: string, name: string, size: number}} image
 */
export function addPendingImage(image) {
    pendingImages.push(image);
}

/**
 * Remove a pending image by index.
 */
export function removePendingImage(index) {
    pendingImages.splice(index, 1);
}

/**
 * Clear all pending images (after send).
 */
export function clearPendingImages() {
    pendingImages = [];
}export function getPendingFiles() {
    return pendingFiles;
}

export function addPendingFile(file) {
    pendingFiles.push(file);
}

export function removePendingFile(index) {
    pendingFiles.splice(index, 1);
}

export function clearPendingFiles() {
    pendingFiles = [];
}

// ============================================
// QUEUED USER INPUT (github#33 Phase 2)
// ============================================

// Cap from issue spec — 1.9.1 ships 5; tunable later if dogfood demands.
const MAX_QUEUE = 5;

// Holds full user message payloads (text + images + files) sent while a
// chat run is in flight. Drained at the iteration boundary in
// handlers.js between rounds, so the model sees the messages as fresh
// user turns on its next call. NOT cleared by cancelToolLoop — the
// spec'd behavior is preservation across cancellation, so a Stop +
// new-prompt sequence drains them into the next run's first round.
let pendingMessageQueue = [];

/**
 * Enqueue a user message payload. The shape mirrors what
 * handleUserInputDirect builds today: text + an optional snapshot of
 * the pendingImages array (which actually carries both images and text
 * files via the `type: 'text'` discriminator). The live picker is
 * cleared by the caller so subsequent typing doesn't re-attach them.
 *
 * Caps at MAX_QUEUE = 5; oldest is dropped when full and the return
 * envelope advertises it so the caller can surface the toast.
 *
 * Emits `chat:queueChanged` with the new length.
 *
 * @param {{text: string, images?: Array}} msg
 * @returns {{queued: boolean, droppedOldest: boolean, length: number}}
 */
export function enqueueUserMessage(msg) {
    const entry = {
        text: msg.text || '',
        images: Array.isArray(msg.images) ? msg.images.slice() : [],
    };
    let droppedOldest = false;
    if (pendingMessageQueue.length >= MAX_QUEUE) {
        pendingMessageQueue.shift();
        droppedOldest = true;
    }
    pendingMessageQueue.push(entry);
    try { EventBus.emit('chat:queueChanged', pendingMessageQueue.length); } catch { /* best-effort */ }
    return { queued: true, droppedOldest, length: pendingMessageQueue.length };
}

/**
 * Read-only view of queued messages. Returns a shallow copy so the UI
 * can render previews without mutating the queue.
 *
 * @returns {Array<{text: string, images: Array}>}
 */
export function peekUserMessageQueue() {
    return pendingMessageQueue.slice();
}

/**
 * Drain the queue. Returns the messages in FIFO order and empties
 * internal storage. Emits `chat:queueChanged` with 0.
 *
 * @returns {Array<{text: string, images: Array}>}
 */
export function drainUserMessageQueue() {
    const drained = pendingMessageQueue;
    pendingMessageQueue = [];
    try { EventBus.emit('chat:queueChanged', 0); } catch { /* best-effort */ }
    return drained;
}

/**
 * Remove a single queued message by index (for the panel's × button).
 * No-op when out of range.
 *
 * @param {number} index
 * @returns {boolean} True if a message was removed.
 */
export function removeQueuedUserMessage(index) {
    if (index < 0 || index >= pendingMessageQueue.length) return false;
    pendingMessageQueue.splice(index, 1);
    try { EventBus.emit('chat:queueChanged', pendingMessageQueue.length); } catch { /* best-effort */ }
    return true;
}

/**
 * Explicit clear — distinct from drain because no caller takes the
 * messages. Reserved for future "Clear queue" UX; NOT wired into the
 * cancel path (preservation across cancellation is the spec).
 */
export function clearUserMessageQueue() {
    if (pendingMessageQueue.length === 0) return;
    pendingMessageQueue = [];
    try { EventBus.emit('chat:queueChanged', 0); } catch { /* best-effort */ }
}

/**
 * @returns {number}
 */
export function getUserMessageQueueLength() {
    return pendingMessageQueue.length;
}
