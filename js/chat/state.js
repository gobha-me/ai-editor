/**
 * Chat State Management
 * Centralized state for chat module
 */

// DOM references
let chatContainer = null;
let inputElement = null;

// Edit state
let pendingEdit = null;  // { code, explanation } waiting for user approval

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

/**
 * Check if tool loop is cancelled
 */
export function isToolLoopCancelled() {
    return _cancelToolLoop;
}

/**
 * Cancel tool loop
 */
export function cancelToolLoop() {
    _cancelToolLoop = true;
}

/**
 * Reset tool loop cancel flag
 */
export function resetToolLoopCancel() {
    _cancelToolLoop = false;
}
