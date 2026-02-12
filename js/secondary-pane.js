// ============================================
// PREVIEW, DIFF & BLAME PANE
// ============================================

import { State, EventBus } from './core.js';
import { Git } from './git.js';
import { renderUnifiedView, renderSideBySideView, getViewMode, initDiffKeyboardShortcuts, initScrollSync, cleanupScrollSync } from './diff-viewer.js';
import { escapeHtml, escapeAttr } from './utils/html.js';

let secondaryPaneMode = null; // 'preview' | 'diff' | 'blame' | null
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
    const btnBlame = document.getElementById('btnToggleBlame');
    const btnLineNumbers = document.getElementById('btnToggleLineNumbers');
    if (!btnPreview || !btnDiff || !btnLineNumbers) return;
    
    const hasFile = !!(State.activeTabIndex >= 0 && State.openTabs[State.activeTabIndex]);
    btnPreview.disabled = !isPreviewable(path);
    btnDiff.disabled = !hasFile;
    if (btnBlame) btnBlame.disabled = !hasFile;
    
    btnPreview.classList.toggle('active', secondaryPaneMode === 'preview');
    btnDiff.classList.toggle('active', secondaryPaneMode === 'diff');
    if (btnBlame) btnBlame.classList.toggle('active', secondaryPaneMode === 'blame');
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

export function toggleBlamePane() {
    if (secondaryPaneMode === 'blame') { closeSecondaryPane(); return; }
    secondaryPaneMode = 'blame';
    document.getElementById('secondaryPane').style.display = 'flex';
    document.getElementById('secondaryPaneTitle').textContent = '🔍 Blame';
    document.getElementById('resizeHandlePreview').style.display = 'none';

    // Blame overlays the editor like diff
    const split = document.getElementById('editorSplit');
    split.classList.remove('split-active');
    split.classList.remove('secondary-fullscreen');
    split.classList.add('diff-overlay');
    isFullscreen = false;
    _updateFullscreenButton();

    renderBlame();
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

// ============================================
// BLAME RENDERING
// ============================================

// Color palette for blame commit alternation
const BLAME_COLORS = [
    'var(--blame-bg-1, rgba(59, 130, 246, 0.08))',
    'var(--blame-bg-2, rgba(16, 185, 129, 0.08))',
    'var(--blame-bg-3, rgba(245, 158, 11, 0.08))',
    'var(--blame-bg-4, rgba(139, 92, 246, 0.08))',
    'var(--blame-bg-5, rgba(236, 72, 153, 0.08))',
    'var(--blame-bg-6, rgba(20, 184, 166, 0.08))',
];

async function renderBlame() {
    const pane = document.getElementById('secondaryPaneContent');
    const tab = State.openTabs[State.activeTabIndex];
    if (!tab) { pane.innerHTML = '<div class="diff-empty">No file open</div>'; return; }

    const path = tab.path;
    const { owner, repo } = State.currentProject || {};
    const branch = State.currentBranch || 'main';

    if (!owner || !repo) {
        pane.innerHTML = '<div class="diff-empty">No project loaded</div>';
        return;
    }

    pane.innerHTML = '<div class="blame-loading">⏳ Loading blame data…</div>';

    try {
        const blameData = await Git.getBlame(owner, repo, path, branch);
        _renderBlameView(pane, blameData, path);
    } catch (err) {
        if (err.code === 'BLAME_UNSUPPORTED' || err.message?.includes('not support')) {
            // Fall back to file commit history
            await _renderFileHistory(pane, owner, repo, path, branch);
        } else {
            pane.innerHTML = `<div class="diff-empty">⚠️ Blame failed: ${escapeHtml(err.message)}</div>`;
        }
    }
}

function _renderBlameView(pane, blameData, path) {
    const ranges = blameData?.ranges || [];
    if (ranges.length === 0) {
        pane.innerHTML = '<div class="diff-empty">No blame data available</div>';
        return;
    }

    // Assign colors to commits for alternating backgrounds
    const commitColors = new Map();
    let colorIdx = 0;

    let html = '<div class="blame-view"><table class="blame-table">';
    let lineNum = 1;

    for (const range of ranges) {
        const sha = range.commit.sha;
        if (!commitColors.has(sha)) {
            commitColors.set(sha, BLAME_COLORS[colorIdx % BLAME_COLORS.length]);
            colorIdx++;
        }
        const bg = commitColors.get(sha);
        const isFirst = true; // Show gutter info on first line of range

        for (let i = 0; i < range.lines.length; i++) {
            const line = range.lines[i];
            const gutterContent = i === 0
                ? `<span class="blame-sha" title="${escapeAttr(range.commit.message)}">${escapeHtml(range.commit.shortSha)}</span>
                   <span class="blame-author">${escapeHtml(_shortAuthor(range.commit.author))}</span>
                   <span class="blame-date">${escapeHtml(_shortDate(range.commit.date))}</span>`
                : '';

            html += `<tr style="background:${bg}">
                <td class="blame-ln">${lineNum}</td>
                <td class="blame-gutter">${gutterContent}</td>
                <td class="blame-code"><pre>${escapeHtml(line)}</pre></td>
            </tr>`;
            lineNum++;
        }
    }

    html += '</table></div>';

    const titleBar = `<div class="blame-header">
        <span class="blame-path">🔍 ${escapeHtml(path)}</span>
        <span class="blame-stats">${lineNum - 1} lines · ${commitColors.size} commits</span>
    </div>`;

    pane.innerHTML = titleBar + html;
}

async function _renderFileHistory(pane, owner, repo, path, branch) {
    pane.innerHTML = '<div class="blame-loading">⏳ Loading file history…</div>';

    try {
        const commits = await Git.getFileCommits(owner, repo, path, branch);

        if (!commits || commits.length === 0) {
            pane.innerHTML = '<div class="diff-empty">No commit history found for this file</div>';
            return;
        }

        let html = `<div class="blame-header">
            <span class="blame-path">📜 ${escapeHtml(path)} — File History</span>
            <span class="blame-stats">${commits.length} commits</span>
        </div>`;

        html += '<div class="file-history"><table class="history-table">';
        html += '<thead><tr><th>Commit</th><th>Author</th><th>Date</th><th>Message</th></tr></thead><tbody>';

        for (const c of commits) {
            html += `<tr>
                <td class="history-sha"><code>${escapeHtml(c.shortSha)}</code></td>
                <td class="history-author">${escapeHtml(c.author)}</td>
                <td class="history-date">${escapeHtml(_shortDate(c.date))}</td>
                <td class="history-msg">${escapeHtml(c.message)}</td>
            </tr>`;
        }

        html += '</tbody></table></div>';
        pane.innerHTML = html;
    } catch (err) {
        pane.innerHTML = `<div class="diff-empty">⚠️ File history failed: ${escapeHtml(err.message)}</div>`;
    }
}

function _shortAuthor(name) {
    if (!name) return '';
    // "Jeff Smith" → "Jeff S."
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 10);
    return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

function _shortDate(dateStr) {
    if (!dateStr) return '';
    try {
        const d = new Date(dateStr);
        const now = new Date();
        const diffMs = now - d;
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays === 0) return 'today';
        if (diffDays === 1) return 'yesterday';
        if (diffDays < 30) return `${diffDays}d ago`;
        if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    } catch {
        return dateStr.slice(0, 10);
    }
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
        } else if (secondaryPaneMode === 'blame') {
            renderBlame();
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
