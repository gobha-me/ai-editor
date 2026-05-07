/**
 * Chat State Management
 * Centralized state for chat module
 */

import { EventBus } from '../core.js';

// DOM references
let chatContainer = null;
let inputElement = null;

// Edit state
let pendingEdit = null;  // { code, explanation } waiting for user approval

// ask_user (github#33 Phase 1) — pending question state. Holds the
// resolve fn the tool handler is awaiting; the AskUserCard component
// (or a cancel path) calls resolveUserResponse / cancelUserResponse to
// settle the Promise so the chat loop's tool result is whatever the
// user submits. Single-slot in 1.9.0; nesting would require a queue.
let pendingUserResponse = null;  // { question, type, options, allow_custom, resolve }

// Image attachments pending send
let pendingImages = [];  // Images [{ dataUrl, name, size, type: 'image' }]let pendingFiles = [];  // Text/binary [{ text, name, size, type: 'text' }]
let pendingFiles = [];  // Text/binary [{ text, name, size, type: 'text' }]

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
 * would leave the awaited Promise unsettled forever.
 */
export function cancelToolLoop() {
    _cancelToolLoop = true;
    if (pendingUserResponse) {
        cancelUserResponse();
    }
}

/**
 * Reset tool loop cancel flag
 */
export function resetToolLoopCancel() {
    _cancelToolLoop = false;
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
