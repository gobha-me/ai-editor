/**
 * AI Editor - Panel Resize Manager
 * Drag handles for sidebar and chat panel resizing
 */

import { Storage } from './core.js';

const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 500;
const CHAT_MIN = 250;
const CHAT_MAX = 700;
const PREVIEW_MIN_PCT = 20;  // Minimum preview width as % of split
const PREVIEW_MAX_PCT = 75;  // Maximum preview width as % of split

/**
 * Initialize drag-to-resize for sidebar and chat panel.
 * Persists widths to localStorage.
 */
export function initPanelResize() {
    const sidebar = document.getElementById('sidebar');
    const chatPanel = document.getElementById('chatPanel');
    const sidebarHandle = document.getElementById('resizeHandleSidebar');
    const chatHandle = document.getElementById('resizeHandleChat');

    if (!sidebarHandle || !chatHandle) return;

    // Restore saved widths
    const savedSidebarWidth = Storage.get('sidebarWidth');
    const savedChatWidth = Storage.get('chatWidth');
    if (savedSidebarWidth && sidebar) {
        sidebar.style.width = savedSidebarWidth + 'px';
    }
    if (savedChatWidth && chatPanel) {
        chatPanel.style.width = savedChatWidth + 'px';
    }

    // Restore hidden state
    if (Storage.get('sidebarHidden')) {
        sidebar.classList.add('hidden');
        sidebarHandle.style.display = 'none';
    }
    if (Storage.get('chatHidden')) {
        chatPanel.classList.add('hidden');
        chatHandle.style.display = 'none';
    }

    // --- Sidebar resize ---
    setupDragHandle(sidebarHandle, {
        onDrag(e) {
            const rect = sidebar.getBoundingClientRect();
            const newWidth = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, e.clientX - rect.left));
            sidebar.style.width = newWidth + 'px';
        },
        onEnd() {
            const width = sidebar.getBoundingClientRect().width;
            Storage.set('sidebarWidth', Math.round(width));
        }
    });

    // --- Chat resize ---
    setupDragHandle(chatHandle, {
        onDrag(e) {
            const rect = chatPanel.getBoundingClientRect();
            const newWidth = Math.min(CHAT_MAX, Math.max(CHAT_MIN, rect.right - e.clientX));
            chatPanel.style.width = newWidth + 'px';
        },
        onEnd() {
            const width = chatPanel.getBoundingClientRect().width;
            Storage.set('chatWidth', Math.round(width));
        }
    });

    // --- Preview/secondary pane resize ---
    const previewHandle = document.getElementById('resizeHandlePreview');
    const secondaryPane = document.getElementById('secondaryPane');
    const editorSplit = document.getElementById('editorSplit');
    
    if (previewHandle && secondaryPane && editorSplit) {
        setupDragHandle(previewHandle, {
            onDrag(e) {
                const splitRect = editorSplit.getBoundingClientRect();
                const splitWidth = splitRect.width;
                // Preview is on the right, so its width = splitRight - mouseX
                const newWidth = splitRect.right - e.clientX;
                const pct = (newWidth / splitWidth) * 100;
                const clampedPct = Math.min(PREVIEW_MAX_PCT, Math.max(PREVIEW_MIN_PCT, pct));
                secondaryPane.style.width = clampedPct + '%';
            },
            onEnd() {
                const splitWidth = editorSplit.getBoundingClientRect().width;
                const paneWidth = secondaryPane.getBoundingClientRect().width;
                const pct = Math.round((paneWidth / splitWidth) * 100);
                Storage.set('previewWidthPct', pct);
            }
        });

        // Restore saved preview width
        const savedPct = Storage.get('previewWidthPct');
        if (savedPct) {
            secondaryPane.style.width = savedPct + '%';
        }
    }
}

/**
 * Generic drag handle setup with body-level mouse capture.
 */
function setupDragHandle(handle, { onDrag, onEnd }) {
    let dragging = false;

    handle.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return; // left click only
        e.preventDefault();
        dragging = true;
        handle.classList.add('dragging');
        document.body.classList.add('resizing');

        function onMouseMove(e) {
            if (!dragging) return;
            // Capture coordinates now — event may be recycled before rAF fires
            const x = e.clientX;
            const y = e.clientY;
            requestAnimationFrame(() => onDrag({ clientX: x, clientY: y }));
        }

        function onMouseUp() {
            dragging = false;
            handle.classList.remove('dragging');
            document.body.classList.remove('resizing');
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            if (onEnd) onEnd();
        }

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}
