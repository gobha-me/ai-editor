// ============================================
// PREVIEW & DIFF PANE
// ============================================

import { State, EventBus } from './core.js';
import { renderUnifiedView, renderSideBySideView, getViewMode, initDiffKeyboardShortcuts, initScrollSync, cleanupScrollSync } from './diff-viewer.js';
import { escapeHtml, escapeAttr } from './utils/html.js';

let secondaryPaneMode = null; // 'preview' | 'diff' | null
let diffViewerInitialized = false;
let isFullscreen = false;

export function isPreviewable(path) {
    if (!path) return false;
    const ext = path.split('.').pop().toLowerCase();
    return ['html', 'htm', 'md', 'markdown', 'svg'].includes(ext);
}

export function updateToolbarButtons() {
    const path = State.currentFile?.path || '';
    
    const btnPreview = document.getElementById('btnTogglePreview');
    const btnDiff = document.getElementById('btnToggleDiff');
    const btnLineNumbers = document.getElementById('btnToggleLineNumbers');
    if (!btnPreview || !btnDiff || !btnLineNumbers) return;
    
    btnPreview.disabled = !isPreviewable(path);
    btnDiff.disabled = !(State.activeTabIndex >= 0 && State.openTabs[State.activeTabIndex]);
    
    btnPreview.classList.toggle('active', secondaryPaneMode === 'preview');
    btnDiff.classList.toggle('active', secondaryPaneMode === 'diff');
    btnLineNumbers.classList.toggle('active', State.settings.showLineNumbers !== false);
}

export function togglePreviewPane() {
    if (secondaryPaneMode === 'preview') { closeSecondaryPane(); return; }
    secondaryPaneMode = 'preview';
    document.getElementById('secondaryPane').style.display = 'flex';
    document.getElementById('secondaryPaneTitle').textContent = '👁 Preview';
    document.getElementById('resizeHandlePreview').style.display = '';
    const split = document.getElementById('editorSplit');
    split.classList.remove('diff-overlay');  // clean up if switching from diff
    split.classList.remove('secondary-fullscreen');
    split.classList.add('split-active');
    isFullscreen = false;
    _updateFullscreenButton();
    renderPreview();
    updateToolbarButtons();
}

export function toggleDiffPane() {
    if (secondaryPaneMode === 'diff') { closeSecondaryPane(); return; }
    secondaryPaneMode = 'diff';
    document.getElementById('secondaryPane').style.display = 'flex';
    document.getElementById('secondaryPaneTitle').textContent = '± Diff';
    document.getElementById('resizeHandlePreview').style.display = 'none';
    
    // Diff overlays the editor (full width, editor hidden)
    const split = document.getElementById('editorSplit');
    split.classList.remove('split-active');
    split.classList.remove('secondary-fullscreen');
    split.classList.add('diff-overlay');
    isFullscreen = false;
    _updateFullscreenButton();
    
    // Initialize diff keyboard shortcuts once
    if (!diffViewerInitialized) {
        initDiffKeyboardShortcuts();
        diffViewerInitialized = true;
    }
    
    renderDiff();
    updateToolbarButtons();
}

export function closeSecondaryPane() {
    // Cleanup scroll sync listeners
    cleanupScrollSync();
    
    secondaryPaneMode = null;
    isFullscreen = false;
    document.getElementById('secondaryPane').style.display = 'none';
    document.getElementById('resizeHandlePreview').style.display = 'none';
    document.getElementById('secondaryPaneContent').innerHTML = '';
    const split = document.getElementById('editorSplit');
    split.classList.remove('split-active');
    split.classList.remove('diff-overlay');
    split.classList.remove('secondary-fullscreen');
    updateToolbarButtons();
}

function renderPreview() {
    const pane = document.getElementById('secondaryPaneContent');
    const path = State.currentFile?.path || '';
    const content = State.editorContent || '';
    const ext = path.split('.').pop().toLowerCase();

    if (ext === 'html' || ext === 'htm') {
        pane.innerHTML = `<iframe class="preview-iframe" sandbox="allow-scripts allow-same-origin" srcdoc="${escapeAttr(content)}"></iframe>`;
    } else if (ext === 'md' || ext === 'markdown') {
        pane.innerHTML = `<div class="preview-markdown">${renderMarkdown(content)}</div>`;
    } else if (ext === 'svg') {
        // SVG can contain <script> tags and event handlers — sanitize or sandbox
        if (typeof DOMPurify !== 'undefined') {
            const cleanSvg = DOMPurify.sanitize(content, { USE_PROFILES: { svg: true, svgFilters: true } });
            pane.innerHTML = `<div class="preview-svg">${cleanSvg}</div>`;
        } else {
            // Fallback: render in sandboxed iframe (no script execution)
            pane.innerHTML = `<iframe class="preview-iframe" sandbox="" srcdoc="${escapeAttr(content)}"></iframe>`;
        }
    } else {
        pane.innerHTML = `<div class="preview-unsupported">Preview not available for .${escapeHtml(ext)} files</div>`;
    }
}

function renderDiff() {
    const pane = document.getElementById('secondaryPaneContent');
    const tab = State.openTabs[State.activeTabIndex];
    if (!tab) { pane.innerHTML = '<div class="diff-empty">No file open</div>'; return; }

    const original = tab.originalContent || '';
    const current = State.editorContent || '';
    if (original === current) { pane.innerHTML = '<div class="diff-empty">No changes detected</div>'; return; }

    const originalLines = original.split('\n');
    const currentLines = current.split('\n');
    
    // Use new diff viewer
    const viewMode = getViewMode();
    let diffHtml;
    
    if (viewMode === 'side-by-side') {
        diffHtml = renderSideBySideView(originalLines, currentLines);
    } else {
        diffHtml = renderUnifiedView(originalLines, currentLines);
    }
    
    pane.innerHTML = `<div class="diff-view diff-view-${viewMode}">${diffHtml}</div>`;
    
    // Initialize scroll sync (handles both side-by-side and editor sync)
    setTimeout(initScrollSync, 100);
}

// Listen for view mode changes
window.addEventListener('diff:refresh', renderDiff);

export function renderMarkdown(md) {
    // Use marked.js if available (loaded via CDN), fall back to basic regex
    if (typeof marked !== 'undefined') {
        try {
            const raw = marked.parse(md, { breaks: true, gfm: true });
            if (typeof DOMPurify !== 'undefined') {
                return DOMPurify.sanitize(raw);
            }
            return raw;
        } catch (e) {
            console.warn('Marked parse error in preview, falling back:', e);
        }
    }

    // Fallback: basic regex markdown
    let html = md
        .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => `<pre><code class="lang-${lang}">${escapeHtml(code.trim())}</code></pre>`)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/^######\s(.+)$/gm, '<h6>$1</h6>')
        .replace(/^#####\s(.+)$/gm, '<h5>$1</h5>')
        .replace(/^####\s(.+)$/gm, '<h4>$1</h4>')
        .replace(/^###\s(.+)$/gm, '<h3>$1</h3>')
        .replace(/^##\s(.+)$/gm, '<h2>$1</h2>')
        .replace(/^#\s(.+)$/gm, '<h1>$1</h1>')
        .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;">')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
        .replace(/^---+$/gm, '<hr>')
        .replace(/^>\s(.+)$/gm, '<blockquote>$1</blockquote>')
        .replace(/^[-*]\s(.+)$/gm, '<li>$1</li>')
        .replace(/^(?!<[hpuolibdcas]|<\/)(.+)$/gm, '<p>$1</p>');
    html = html.replace(/(<li>[\s\S]*?<\/li>)+/g, '<ul>$&</ul>');
    return html;
}

// Live-refresh secondary pane on edits
export function initSecondaryPaneAutoRefresh() {
    EventBus.on('editor:change', () => {
        if (secondaryPaneMode === 'preview') renderPreview();
        else if (secondaryPaneMode === 'diff') renderDiff();
    });
    
    // Refresh on tab switch
    EventBus.on('tab:switched', ({ tab }) => {
        if (secondaryPaneMode === 'preview') {
            if (isPreviewable(tab.path)) renderPreview();
            else closeSecondaryPane();
        } else if (secondaryPaneMode === 'diff') {
            renderDiff();
        }
        updateToolbarButtons();
    });
    
    // Refresh on file opened
    EventBus.on('file:opened', () => {
        updateToolbarButtons();
    });
    
    // Refresh diff after commit (originalContent now matches current)
    EventBus.on('git:fileUpdated', () => {
        if (secondaryPaneMode === 'diff') renderDiff();
    });
    EventBus.on('git:batchCommitted', () => {
        if (secondaryPaneMode === 'diff') renderDiff();
    });
    
    // Refresh diff after revert (content reset to original)
    EventBus.on('file:reverted', () => {
        if (secondaryPaneMode === 'diff') renderDiff();
    });
}

export function getSecondaryPaneMode() {
    return secondaryPaneMode;
}

/**
 * Toggle fullscreen mode on the secondary pane.
 * In fullscreen, the editor is hidden and the preview/diff fills the split.
 */
export function toggleSecondaryFullscreen() {
    if (!secondaryPaneMode) return;
    
    const split = document.getElementById('editorSplit');
    isFullscreen = !isFullscreen;
    
    if (isFullscreen) {
        split.classList.add('secondary-fullscreen');
        document.getElementById('resizeHandlePreview').style.display = 'none';
    } else {
        split.classList.remove('secondary-fullscreen');
        // Show resize handle again for preview mode (diff is always overlay)
        if (secondaryPaneMode === 'preview') {
            document.getElementById('resizeHandlePreview').style.display = '';
        }
    }
    
    _updateFullscreenButton();
}

function _updateFullscreenButton() {
    const btn = document.getElementById('btnSecondaryFullscreen');
    if (!btn) return;
    btn.textContent = isFullscreen ? '⛶' : '⛶';
    btn.title = isFullscreen ? 'Exit Fullscreen' : 'Toggle Fullscreen';
    btn.classList.toggle('active', isFullscreen);
}
