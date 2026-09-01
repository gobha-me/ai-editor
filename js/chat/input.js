/**
 * Input Handling
 * Manages user input, keyboard events, image paste/drop, and message sending
 */

import { State, EventBus } from '../core.js';
import { LLM } from '../llm.js';
import { escapeAttr } from '../utils/html.js';
import { cancelToolLoop } from './state.js';
import { addMessage } from './messages.js';
import {
    getPendingImages,
    addPendingImage,
    removePendingImage,
    clearPendingImages,
    getPendingUserResponse,
    enqueueUserMessage
} from './state.js';
import {
    showChip,
    hideChip,
    setChipQuery,
    navigateChip,
    selectChipActive,
    isChipVisible,
} from './memory-chip.js';
import { findActiveTrigger, applyCitation } from './memory-chip/match.js';

/** Max image size in bytes (5 MB) */
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

/** Max text file size in bytes (1 MB) */
const MAX_TEXT_SIZE = 1 * 1024 * 1024;

/** Accepted image MIME types */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Accepted text MIME types — covers common code and doc formats */
const TEXT_TYPES = new Set([
    'text/plain', 'text/markdown', 'text/csv', 'text/html', 'text/css',
    'text/xml', 'text/yaml', 'text/x-python', 'text/x-c', 'text/x-c++',
    'text/x-java', 'text/x-rust', 'text/x-go', 'text/x-perl',
    'application/json', 'application/xml', 'application/yaml',
    'application/x-yaml', 'application/javascript', 'application/typescript'
]);

/** File extensions recognized as text when MIME detection is unreliable */
const TEXT_EXTENSIONS = new Set([
    'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'toml',
    'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
    'py', 'rb', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'java', 'kt', 'swift',
    'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
    'sql', 'graphql', 'proto', 'lua', 'pl', 'pm', 'r', 'R',
    'ini', 'cfg', 'conf', 'env', 'gitignore', 'dockerignore',
    'Dockerfile', 'Makefile', 'cmake', 'log', 'diff', 'patch'
]);

/** @returns {boolean} True if the file looks like a text file */
function _isTextFile(file) {
    if (TEXT_TYPES.has(file.type)) return true;
    const ext = (file.name || '').split('.').pop()?.toLowerCase() || '';
    return TEXT_EXTENSIONS.has(ext);
}

/** @returns {boolean} True if the file is an accepted image */
function _isImageFile(file) {
    return IMAGE_TYPES.has(file.type);
}

/**
 * Setup input event handlers
 */
export function setupInputHandlers(inputElement, handleUserInputFn) {
    if (!inputElement || !handleUserInputFn) {
        console.error('[setupInputHandlers] Missing required parameters');
        return;
    }

    // @memory chip — dispatch keystrokes to the picker controller before
    // the chat-send handler runs. When the picker is open, ↑/↓ navigate,
    // Enter inserts the citation, and Escape closes; all four consume
    // the event AND call stopImmediatePropagation so the send-on-Enter
    // listener below doesn't fire after `selectChipActive()` closes the
    // chip (`isChipVisible()` would already read false in that listener).
    inputElement.addEventListener('keydown', (e) => {
        if (!isChipVisible()) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            e.stopImmediatePropagation();
            navigateChip('down');
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopImmediatePropagation();
            navigateChip('up');
        } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            e.stopImmediatePropagation();
            selectChipActive();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopImmediatePropagation();
            hideChip();
        }
    });

    // Enter to send
    inputElement.addEventListener('keydown', (e) => {
        if (isChipVisible()) return;  // chip handler above owns this stroke
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const inputValue = inputElement.value.trim();
            const images = getPendingImages().slice();
            if (!inputValue && images.length === 0) {
                inputElement.value = '';
                return;
            }
            // ask_user is up — the AskUserCard owns input. Don't queue
            // (the user is already responding via the card UI).
            // Don't send either; the existing card-submit path handles it.
            if (getPendingUserResponse()) {
                return;  // leave inputValue alone so user sees what they typed
            }
            inputElement.value = '';
            if (State.isGenerating) {
                // github#33 Phase 2 — queue for delivery between rounds.
                const result = enqueueUserMessage({ text: inputValue, images });
                clearPendingImages();
                renderImagePreview();
                if (result.droppedOldest) {
                    addMessage('system', '⚠️ Queued message limit reached (5) — oldest queued message dropped.');
                }
                return;
            }
            handleUserInputFn(inputValue);
        }
    });

    // @memory trigger detection — fires on every textarea content change
    // (typing, paste-text, programmatic value updates). Opens the chip
    // when the cursor is inside an active `@memory[...filter]` substring
    // and closes it when the cursor leaves.
    const handleTriggerChange = () => {
        const text = inputElement.value || '';
        const cursor = (typeof inputElement.selectionStart === 'number')
            ? inputElement.selectionStart
            : text.length;
        const trigger = findActiveTrigger(text, cursor);
        if (trigger) {
            if (!isChipVisible()) {
                showChip({
                    onSelect: (record) => {
                        const t2 = findActiveTrigger(inputElement.value || '',
                            (typeof inputElement.selectionStart === 'number')
                                ? inputElement.selectionStart
                                : (inputElement.value || '').length);
                        const result = applyCitation(inputElement.value || '', t2 || trigger, record.key);
                        inputElement.value = result.text;
                        try { inputElement.setSelectionRange(result.cursor, result.cursor); } catch { /* swallow */ }
                        inputElement.focus();
                    },
                });
            }
            setChipQuery(trigger.query);
        } else if (isChipVisible()) {
            hideChip();
        }
    };
    inputElement.addEventListener('input', handleTriggerChange);
    inputElement.addEventListener('keyup', (e) => {
        // Selection-only changes (arrow keys without modifying text) come
        // through keyup, not input. Only re-run when the cursor could
        // have moved.
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' ||
            e.key === 'Home' || e.key === 'End') {
            handleTriggerChange();
        }
    });
    inputElement.addEventListener('click', handleTriggerChange);
    inputElement.addEventListener('blur', () => {
        // Don't close on the focus-jump that happens during paste; close
        // only if focus actually leaves the textarea AND the chip slot.
        // The chip popover is visual-only (no focusable elements), so a
        // genuine blur means the user clicked elsewhere.
        setTimeout(() => {
            if (document.activeElement !== inputElement) hideChip();
        }, 100);
    });

    // Paste — intercept images from clipboard
    inputElement.addEventListener('paste', (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;

        for (const item of items) {
            if (IMAGE_TYPES.has(item.type)) {
                e.preventDefault();
                const file = item.getAsFile();
                if (file) _processFile(file);
                return;  // Only handle first image
            }
        }
        // If no image, let default text paste happen
    });

    // Drag & drop images and text files onto input
    inputElement.addEventListener('dragover', (e) => {
        if (_hasDragFile(e)) {
            e.preventDefault();
            inputElement.classList.add('drag-over');
        }
    });
    inputElement.addEventListener('dragleave', () => {
        inputElement.classList.remove('drag-over');
    });
    inputElement.addEventListener('drop', (e) => {
        inputElement.classList.remove('drag-over');
        const file = e.dataTransfer?.files?.[0];
        // .zip files are handled by the window-wide drop listener (Touch 3
        // zip-flow, 2.20.0) — explicitly skip them here so the import modal
        // wins over chat-input attachment.
        if (file && typeof file.name === 'string' && file.name.toLowerCase().endsWith('.zip')) {
            return;
        }
        if (file && (_isImageFile(file) || _isTextFile(file))) {
            e.preventDefault();
            _processFile(file);
        }
    });

    // Wire the attach button (📎)
    const attachBtn = document.getElementById('btnAttachImage');
    if (attachBtn) {
        attachBtn.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            // Accept images and common text/code file types
            input.accept = 'image/png,image/jpeg,image/gif,image/webp,.txt,.md,.csv,.json,.yaml,.yml,.xml,.html,.css,.js,.ts,.py,.go,.rs,.c,.h,.cpp,.java,.sh,.sql,.toml,.ini,.log,.diff,.patch';
            input.onchange = (e) => {
                const file = e.target.files?.[0];
                if (file) _processFile(file);
            };
            input.click();
        });
    }
}

/**
 * Process any accepted file (image or text) and add to pending attachments.
 * Images → dataUrl (base64).  Text files → plain text content.
 * Warns (but does not block) if attaching an image and the current model
 * lacks vision capability.
 * @param {File} file
 */
function _processFile(file) {
    const isImage = _isImageFile(file);
    const isText  = _isTextFile(file);

    if (!isImage && !isText) {
        window.showToast?.('Unsupported file type. Images and text/code files are accepted.', 'warning');
        return;
    }

    if (isImage) {
        if (file.size > MAX_IMAGE_SIZE) {
            window.showToast?.('Image too large (5 MB max)', 'warning');
            return;
        }

        // Vision model gating — warn but allow
        const model = (State.models || []).find(m => m.id === State.settings.llmModel);
        if (model && !model.capabilities?.supportsVision) {
            window.showToast?.('⚠️ Current model does not support vision — image may be ignored by the LLM', 'warning');
        }

        const reader = new FileReader();
        reader.onload = () => {
            addPendingImage({
                dataUrl: reader.result,
                name: file.name || 'pasted-image',
                size: file.size,
                type: 'image'
            });
            renderImagePreview();
        };
        reader.readAsDataURL(file);

    } else {
        // Text file
        if (file.size > MAX_TEXT_SIZE) {
            window.showToast?.('Text file too large (1 MB max)', 'warning');
            return;
        }

        const reader = new FileReader();
        reader.onload = () => {
            addPendingImage({
                textContent: reader.result,
                name: file.name || 'attached-file',
                size: file.size,
                type: 'text'
            });
            renderImagePreview();
        };
        reader.readAsText(file);
    }
}

/**
 * Check if a drag event contains a file we might accept.
 */
function _hasDragFile(e) {
    const types = e.dataTransfer?.types || [];
    return types.includes('Files');
}

/**
 * Render the image preview strip above the input.
 */
export function renderImagePreview() {
    let strip = document.getElementById('imagePreviewStrip');
    const images = getPendingImages();

    if (images.length === 0) {
        if (strip) strip.style.display = 'none';
        return;
    }

    // Create strip container if needed — insert above the input wrapper
    if (!strip) {
        const inputArea = document.querySelector('.chat-input-area');
        const wrapper = document.querySelector('.chat-input-wrapper');
        if (!inputArea || !wrapper) return;
        strip = document.createElement('div');
        strip.id = 'imagePreviewStrip';
        strip.className = 'image-preview-strip';
        inputArea.insertBefore(strip, wrapper);
    }

    strip.style.display = '';
    strip.innerHTML = images.map((img, i) => {
        if (img.type === 'text') {
            // Text file — show filename badge instead of thumbnail
            return `
                <div class="image-preview-thumb text-file-badge" title="${escapeAttr(img.name)} (${_fmtSize(img.size)})">
                    <span class="text-file-icon">📄</span>
                    <span class="text-file-name">${escapeAttr(img.name)}</span>
                    <button class="image-preview-remove" data-action="removeImage" data-index="${i}"
                            title="Remove" aria-label="Remove file">✕</button>
                </div>
            `;
        }
        // Image — show thumbnail
        return `
            <div class="image-preview-thumb" title="${escapeAttr(img.name)} (${_fmtSize(img.size)})">
                <img src="${img.dataUrl}" alt="Attached image ${i + 1}">
                <button class="image-preview-remove" data-action="removeImage" data-index="${i}"
                        title="Remove" aria-label="Remove image">✕</button>
            </div>
        `;
    }).join('');
}

/**
 * Bind a delegated click handler for the image preview strip's remove
 * buttons. Phase 3a of the inline-handlers migration
 * (DESIGN-ui-event-dispatch.md). Scoped to
 * `#imagePreviewStrip` — `renderImagePreview()` rewrites the strip's
 * innerHTML on every attach/remove, so the document-level listener
 * survives container re-creation (and even initial element creation,
 * since the listener is on `document`, not the strip).
 */
let _wired = false;
export function mountChatInput({ onRemoveImage } = {}) {
    if (_wired) return;
    _wired = true;

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        if (!btn.closest('#imagePreviewStrip')) return;
        const action = btn.getAttribute('data-action');
        if (action === 'removeImage' && typeof onRemoveImage === 'function') {
            onRemoveImage(Number(btn.getAttribute('data-index')));
        }
    });
}

function _fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

/**
 * Remove a pending image and re-render.
 * Exposed on window.Chat for onclick handlers.
 */
export function removeImage(index) {
    removePendingImage(index);
    renderImagePreview();
}

/**
 * Stop generation
 */
export function stopGeneration() {
    cancelToolLoop();
    LLM.stop();
    State.isGenerating = false;
    EventBus.emit('llm:generating', false);
    
    const streamingEl = document.getElementById('streaming-message');
    if (streamingEl) {
        const content = streamingEl.querySelector('.message-content').textContent;
        streamingEl.remove();
        // gitea#425 — this path only fires from the explicit Stop button
        // (bound in app.js); name the reason rather than the symptom so
        // an exported transcript shows why the run ended.
        addMessage('assistant', content + '\n\n*Stopped by you.*');
    }
}
