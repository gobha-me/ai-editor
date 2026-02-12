/**
 * Input Handling
 * Manages user input, keyboard events, image paste/drop, and message sending
 */

import { State, EventBus } from '../core.js';
import { LLM } from '../llm.js';
import { cancelToolLoop } from './state.js';
import { addMessage } from './messages.js';
import {
    getPendingImages,
    addPendingImage,
    removePendingImage,
    clearPendingImages
} from './state.js';

/** Max image size in bytes (5 MB) */
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

/** Accepted MIME types */
const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Setup input event handlers
 */
export function setupInputHandlers(inputElement, handleUserInputFn) {
    if (!inputElement || !handleUserInputFn) {
        console.error('[setupInputHandlers] Missing required parameters');
        return;
    }

    // Enter to send
    inputElement.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const inputValue = inputElement.value.trim();
            inputElement.value = '';
            if ((inputValue || getPendingImages().length > 0) && !State.isGenerating) {
                handleUserInputFn(inputValue);
            }
        }
    });

    // Paste — intercept images from clipboard
    inputElement.addEventListener('paste', (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;

        for (const item of items) {
            if (ACCEPTED_TYPES.has(item.type)) {
                e.preventDefault();
                const file = item.getAsFile();
                if (file) _processImageFile(file);
                return;  // Only handle first image
            }
        }
        // If no image, let default text paste happen
    });

    // Drag & drop images onto input
    inputElement.addEventListener('dragover', (e) => {
        if (_hasDragImage(e)) {
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
        if (file && ACCEPTED_TYPES.has(file.type)) {
            e.preventDefault();
            _processImageFile(file);
        }
    });

    // Wire the attach button (📎)
    const attachBtn = document.getElementById('btnAttachImage');
    if (attachBtn) {
        attachBtn.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/png,image/jpeg,image/gif,image/webp';
            input.onchange = (e) => {
                const file = e.target.files?.[0];
                if (file) _processImageFile(file);
            };
            input.click();
        });
    }
}

/**
 * Process an image file into a data URL and add to pending.
 * @param {File} file
 */
function _processImageFile(file) {
    if (!ACCEPTED_TYPES.has(file.type)) {
        window.showToast?.('Unsupported image type', 'warning');
        return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
        window.showToast?.('Image too large (5 MB max)', 'warning');
        return;
    }

    const reader = new FileReader();
    reader.onload = () => {
        addPendingImage({
            dataUrl: reader.result,
            name: file.name || 'pasted-image',
            size: file.size
        });
        renderImagePreview();
    };
    reader.readAsDataURL(file);
}

/**
 * Check if a drag event contains an image.
 */
function _hasDragImage(e) {
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
    strip.innerHTML = images.map((img, i) => `
        <div class="image-preview-thumb" title="${img.name} (${_fmtSize(img.size)})">
            <img src="${img.dataUrl}" alt="Attached image ${i + 1}">
            <button class="image-preview-remove" onclick="window.Chat.removeImage(${i})" 
                    title="Remove" aria-label="Remove image">✕</button>
        </div>
    `).join('');
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
        addMessage('assistant', content + '\n\n*(generation stopped)*');
    }
}
