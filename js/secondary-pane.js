// ============================================
// PREVIEW & DIFF PANE
// ============================================

import { State, EventBus } from './core.js';

let secondaryPaneMode = null; // 'preview' | 'diff' | null

export function isPreviewable(path) {
    if (!path) return false;
    const ext = path.split('.').pop().toLowerCase();
    return ['html', 'htm', 'md', 'markdown', 'svg'].includes(ext);
}

export function updateToolbarButtons() {
    const path = State.currentFile?.path || '';
    
    document.getElementById('btnTogglePreview').disabled = !isPreviewable(path);
    document.getElementById('btnToggleDiff').disabled = !(State.activeTabIndex >= 0 && State.openTabs[State.activeTabIndex]);
    
    document.getElementById('btnTogglePreview').classList.toggle('active', secondaryPaneMode === 'preview');
    document.getElementById('btnToggleDiff').classList.toggle('active', secondaryPaneMode === 'diff');
    document.getElementById('btnToggleLineNumbers').classList.toggle('active', State.settings.showLineNumbers !== false);
}

export function togglePreviewPane() {
    if (secondaryPaneMode === 'preview') { closeSecondaryPane(); return; }
    secondaryPaneMode = 'preview';
    document.getElementById('secondaryPane').style.display = 'flex';
    document.getElementById('secondaryPaneTitle').textContent = '👁 Preview';
    document.getElementById('editorSplit').classList.add('split-active');
    renderPreview();
    updateToolbarButtons();
}

export function toggleDiffPane() {
    if (secondaryPaneMode === 'diff') { closeSecondaryPane(); return; }
    secondaryPaneMode = 'diff';
    document.getElementById('secondaryPane').style.display = 'flex';
    document.getElementById('secondaryPaneTitle').textContent = '± Diff';
    document.getElementById('editorSplit').classList.add('split-active');
    renderDiff();
    updateToolbarButtons();
}

export function closeSecondaryPane() {
    secondaryPaneMode = null;
    document.getElementById('secondaryPane').style.display = 'none';
    document.getElementById('secondaryPaneContent').innerHTML = '';
    document.getElementById('editorSplit').classList.remove('split-active');
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
        pane.innerHTML = `<div class="preview-svg">${content}</div>`;
    } else {
        pane.innerHTML = `<div class="preview-unsupported">Preview not available for .${ext} files</div>`;
    }
}

function renderDiff() {
    const pane = document.getElementById('secondaryPaneContent');
    const tab = State.openTabs[State.activeTabIndex];
    if (!tab) { pane.innerHTML = '<div class="diff-empty">No file open</div>'; return; }

    const original = tab.originalContent || '';
    const current = State.editorContent || '';
    if (original === current) { pane.innerHTML = '<div class="diff-empty">No changes detected</div>'; return; }

    const diffHtml = buildDiffView(original.split('\n'), current.split('\n'));
    pane.innerHTML = `<div class="diff-view">${diffHtml}</div>`;
}

function buildDiffView(origLines, currLines) {
    const ops = computeLCS(origLines, currLines);
    let html = '', oi = 0, ci = 0;
    for (const op of ops) {
        if (op === 'equal') {
            html += `<div class="diff-line diff-equal"><span class="diff-ln">${oi+1}</span><span class="diff-ln">${ci+1}</span><span class="diff-text"> ${escapeHtml(origLines[oi])}</span></div>`;
            oi++; ci++;
        } else if (op === 'delete') {
            html += `<div class="diff-line diff-removed"><span class="diff-ln">${oi+1}</span><span class="diff-ln"></span><span class="diff-text">-${escapeHtml(origLines[oi])}</span></div>`;
            oi++;
        } else if (op === 'insert') {
            html += `<div class="diff-line diff-added"><span class="diff-ln"></span><span class="diff-ln">${ci+1}</span><span class="diff-text">+${escapeHtml(currLines[ci])}</span></div>`;
            ci++;
        }
    }
    return html;
}

function computeLCS(a, b) {
    const m = a.length, n = b.length;
    if (m + n > 10000) return computeSimpleOps(a, b);
    const dp = Array.from({length: m+1}, () => new Array(n+1).fill(0));
    for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
            dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]+1 : Math.max(dp[i-1][j], dp[i][j-1]);
    const ops = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && a[i-1] === b[j-1]) { ops.push('equal'); i--; j--; }
        else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) { ops.push('insert'); j--; }
        else { ops.push('delete'); i--; }
    }
    return ops.reverse();
}

function computeSimpleOps(a, b) {
    const ops = [];
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
        if (i >= a.length) ops.push('insert');
        else if (i >= b.length) ops.push('delete');
        else if (a[i] === b[i]) ops.push('equal');
        else { ops.push('delete'); ops.push('insert'); }
    }
    return ops;
}

function escapeAttr(text) {
    return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function renderMarkdown(md) {
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
}

export function getSecondaryPaneMode() {
    return secondaryPaneMode;
}
