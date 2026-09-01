/**
 * AI Editor - Enhanced Diff Viewer
 * Implements side-by-side and unified diff views with syntax highlighting
 */

import { State, EventBus } from './core.js';
import { escapeHtml } from './utils/html.js';

// ============================================
// DIFF VIEW STATE
// ============================================

let currentViewMode = 'unified'; // 'unified' | 'side-by-side'
let currentChangeIndex = 0; // FIX: Start at 0, not -1
let changePositions = [];

// ============================================
// CORE DIFF ALGORITHM (Myers Diff)
// ============================================

/**
 * Compute diff using Myers algorithm (industry standard)
 * Returns hunks of changes with context lines
 */
export function computeDiff(originalLines, modifiedLines, contextLines = 3) {
    const changes = myersDiff(originalLines, modifiedLines);
    const hunks = groupIntoHunks(changes, originalLines, modifiedLines, contextLines);
    return { changes, hunks };
}

/**
 * Myers diff algorithm - same used by Git
 */
function myersDiff(a, b) {
    const n = a.length;
    const m = b.length;
    const max = n + m;
    const v = {};
    const trace = [];

    // CRITICAL: Seed the frontier — standard Myers requires V[1]=0
    v[1] = 0;

    for (let d = 0; d <= max; d++) {
        trace.push({...v});
        
        for (let k = -d; k <= d; k += 2) {
            let x;
            if (k === -d || (k !== d && v[k - 1] < v[k + 1])) {
                x = v[k + 1];
            } else {
                x = v[k - 1] + 1;
            }
            
            let y = x - k;
            
            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }
            
            v[k] = x;
            
            if (x >= n && y >= m) {
                return backtrackChanges(trace, a, b, d);
            }
        }
    }
    
    return backtrackChanges(trace, a, b, max);
}

function backtrackChanges(trace, a, b, d) {
    const changes = [];
    let x = a.length;
    let y = b.length;
    
    for (let i = d; i >= 0; i--) {
        const v = trace[i];
        const k = x - y;
        
        let prevK;
        if (k === -i || (k !== i && v[k - 1] < v[k + 1])) {
            prevK = k + 1;
        } else {
            prevK = k - 1;
        }
        
        const prevX = v[prevK];
        const prevY = prevX - prevK;
        
        while (x > prevX && y > prevY) {
            changes.unshift({ type: 'equal', oldLine: x - 1, newLine: y - 1 });
            x--;
            y--;
        }
        
        if (i > 0) {
            if (x === prevX) {
                changes.unshift({ type: 'insert', newLine: y - 1 });
                y--;
            } else {
                changes.unshift({ type: 'delete', oldLine: x - 1 });
                x--;
            }
        }
    }
    
    return changes;
}

/**
 * Group changes into hunks with context lines
 */
function groupIntoHunks(changes, originalLines, modifiedLines, contextLines) {
    if (changes.length === 0) return [];
    
    // Find indices of all non-equal changes
    const changeIndices = [];
    changes.forEach((c, i) => { if (c.type !== 'equal') changeIndices.push(i); });
    if (changeIndices.length === 0) return [];
    
    // Group change indices into hunk ranges (merge when gap <= 2*contextLines)
    const groups = [];
    let groupStart = changeIndices[0];
    let groupEnd = changeIndices[0];
    
    for (let i = 1; i < changeIndices.length; i++) {
        if (changeIndices[i] - groupEnd <= contextLines * 2 + 1) {
            groupEnd = changeIndices[i]; // merge into current group
        } else {
            groups.push([groupStart, groupEnd]);
            groupStart = changeIndices[i];
            groupEnd = changeIndices[i];
        }
    }
    groups.push([groupStart, groupEnd]);
    
    // Build hunks from groups with context
    return groups.map(([gStart, gEnd]) => {
        const from = Math.max(0, gStart - contextLines);
        const to = Math.min(changes.length - 1, gEnd + contextLines);
        const hunkChanges = changes.slice(from, to + 1);
        
        // Compute start positions — find the first valid line number in the range
        let oldStart = 1, newStart = 1;
        let foundOld = false, foundNew = false;
        for (let i = from; i <= to; i++) {
            if (!foundOld && changes[i].oldLine !== undefined && changes[i].oldLine >= 0) {
                oldStart = changes[i].oldLine + 1;
                foundOld = true;
            }
            if (!foundNew && changes[i].newLine !== undefined && changes[i].newLine >= 0) {
                newStart = changes[i].newLine + 1;
                foundNew = true;
            }
            if (foundOld && foundNew) break;
        }
        
        return { oldStart, newStart, changes: hunkChanges };
    });
}

// ============================================
// DIFF STATISTICS
// ============================================

export function computeDiffStats(changes) {
    const stats = {
        additions: 0,
        deletions: 0,
        modifications: 0
    };
    
    let prevWasDelete = false;
    
    changes.forEach(change => {
        if (change.type === 'insert') {
            if (prevWasDelete) {
                stats.modifications++;
                prevWasDelete = false;
            } else {
                stats.additions++;
            }
        } else if (change.type === 'delete') {
            prevWasDelete = true;
            stats.deletions++;
        } else {
            prevWasDelete = false;
        }
    });
    
    return stats;
}

// ============================================
// UNIFIED VIEW RENDERER
// ============================================

export function renderUnifiedView(originalLines, modifiedLines) {
    const { changes, hunks } = computeDiff(originalLines, modifiedLines, 3);
    const stats = computeDiffStats(changes);
    
    changePositions = [];
    currentChangeIndex = 0; // FIX: Reset to 0 when rendering
    let html = renderDiffHeader(stats, originalLines.length, modifiedLines.length);
    
    hunks.forEach((hunk, hunkIndex) => {
        html += renderHunkHeader(hunk, hunkIndex);
        html += renderHunkContent(hunk, originalLines, modifiedLines, 'unified');
    });
    
    return html;
}

function renderHunkHeader(hunk, hunkIndex) {
    const oldCount = hunk.changes.filter(c => c.oldLine !== undefined).length;
    const newCount = hunk.changes.filter(c => c.newLine !== undefined).length;
    
    // Safety: ensure start positions are positive
    const oldStart = Math.max(1, hunk.oldStart);
    const newStart = Math.max(1, hunk.newStart);
    
    return `
        <div class="diff-hunk-header" data-hunk="${hunkIndex}">
            <span class="diff-hunk-info">@@ old:${oldStart},${oldCount}  new:${newStart},${newCount} @@</span>
        </div>
    `;
}

function renderHunkContent(hunk, originalLines, modifiedLines, mode) {
    let html = '';
    
    hunk.changes.forEach((change) => {
        if (change.type === 'equal') {
            const oldLn = change.oldLine >= 0 ? change.oldLine + 1 : '';
            const newLn = change.newLine >= 0 ? change.newLine + 1 : '';
            const line = originalLines[change.oldLine] ?? '';
            html += `
                <div class="diff-line diff-equal" data-old-line="${oldLn}" data-new-line="${newLn}">
                    <span class="diff-ln">${oldLn}</span>
                    <span class="diff-ln">${newLn}</span>
                    <span class="diff-text"> ${escapeHtml(line)}</span>
                </div>
            `;
        } else if (change.type === 'delete') {
            const oldLn = change.oldLine >= 0 ? change.oldLine + 1 : '';
            const line = originalLines[change.oldLine] ?? '';
            changePositions.push({ index: changePositions.length, oldLine: oldLn || null, newLine: null });
            html += `
                <div class="diff-line diff-removed" data-change-index="${changePositions.length - 1}" data-old-line="${oldLn}">
                    <span class="diff-ln">${oldLn}</span>
                    <span class="diff-ln"></span>
                    <span class="diff-text">-${escapeHtml(line)}</span>
                </div>
            `;
        } else if (change.type === 'insert') {
            const newLn = change.newLine >= 0 ? change.newLine + 1 : '';
            const line = modifiedLines[change.newLine] ?? '';
            changePositions.push({ index: changePositions.length, oldLine: null, newLine: newLn || null });
            html += `
                <div class="diff-line diff-added" data-change-index="${changePositions.length - 1}" data-new-line="${newLn}">
                    <span class="diff-ln"></span>
                    <span class="diff-ln">${newLn}</span>
                    <span class="diff-text">+${escapeHtml(line)}</span>
                </div>
            `;
        }
    });
    
    return html;
}

// ============================================
// SIDE-BY-SIDE VIEW RENDERER
// ============================================

export function renderSideBySideView(originalLines, modifiedLines) {
    const { changes } = computeDiff(originalLines, modifiedLines, 3);
    const stats = computeDiffStats(changes);
    
    changePositions = [];
    currentChangeIndex = 0; // FIX: Reset to 0 when rendering
    let html = renderDiffHeader(stats, originalLines.length, modifiedLines.length);
    
    html += '<div class="diff-side-by-side-container">';
    html += '<div class="diff-pane diff-pane-left">';
    html += renderSideBySidePane(changes, originalLines, 'left');
    html += '</div>';
    html += '<div class="diff-pane diff-pane-right">';
    html += renderSideBySidePane(changes, modifiedLines, 'right');
    html += '</div>';
    html += '</div>';
    
    return html;
}

function renderSideBySidePane(changes, lines, side) {
    let html = '';
    
    changes.forEach(change => {
        if (change.type === 'equal') {
            const lineNum = side === 'left' ? change.oldLine : change.newLine;
            const displayNum = (lineNum !== undefined && lineNum >= 0) ? lineNum + 1 : '';
            const line = lines[lineNum] ?? '';
            html += `
                <div class="diff-line diff-equal" data-${side === 'left' ? 'old' : 'new'}-line="${displayNum}">
                    <span class="diff-ln">${displayNum}</span>
                    <span class="diff-text"> ${escapeHtml(line)}</span>
                </div>
            `;
        } else if (change.type === 'delete' && side === 'left') {
            const displayNum = (change.oldLine !== undefined && change.oldLine >= 0) ? change.oldLine + 1 : '';
            const line = lines[change.oldLine] ?? '';
            html += `
                <div class="diff-line diff-removed" data-old-line="${displayNum}">
                    <span class="diff-ln">${displayNum}</span>
                    <span class="diff-text">-${escapeHtml(line)}</span>
                </div>
            `;
        } else if (change.type === 'insert' && side === 'right') {
            const displayNum = (change.newLine !== undefined && change.newLine >= 0) ? change.newLine + 1 : '';
            const line = lines[change.newLine] ?? '';
            html += `
                <div class="diff-line diff-added" data-new-line="${displayNum}">
                    <span class="diff-ln">${displayNum}</span>
                    <span class="diff-text">+${escapeHtml(line)}</span>
                </div>
            `;
        } else if (change.type === 'delete' && side === 'right') {
            // Empty line on right side for deleted line
            html += '<div class="diff-line diff-empty"><span class="diff-ln"></span><span class="diff-text"></span></div>';
        } else if (change.type === 'insert' && side === 'left') {
            // Empty line on left side for added line
            html += '<div class="diff-line diff-empty"><span class="diff-ln"></span><span class="diff-text"></span></div>';
        }
    });
    
    return html;
}

// ============================================
// DIFF HEADER
// ============================================

function renderDiffHeader(stats, originalLineCount, modifiedLineCount) {
    return `
        <div class="diff-header">
            <div class="diff-stats">
                <span class="diff-stat-additions">+${stats.additions}</span>
                <span class="diff-stat-deletions">-${stats.deletions}</span>
                <span class="diff-stat-info">${originalLineCount} → ${modifiedLineCount} lines</span>
            </div>
            <div class="diff-controls">
                <button class="diff-btn ${currentViewMode === 'unified' ? 'active' : ''}"
                        data-action="setViewMode" data-mode="unified"
                        title="Unified View">
                    Unified
                </button>
                <button class="diff-btn ${currentViewMode === 'side-by-side' ? 'active' : ''}"
                        data-action="setViewMode" data-mode="side-by-side"
                        title="Side-by-Side View">
                    Side-by-Side
                </button>
                <button class="diff-btn"
                        data-action="previousChange"
                        title="Previous Change (Alt+↑)">
                    ↑
                </button>
                <button class="diff-btn"
                        data-action="nextChange"
                        title="Next Change (Alt+↓)">
                    ↓
                </button>
            </div>
        </div>
    `;
}

// ============================================
// NAVIGATION
// ============================================

export function nextChange() {
    if (changePositions.length === 0) return;
    
    // FIX: Proper wrapping from 0
    currentChangeIndex = (currentChangeIndex + 1) % changePositions.length;
    highlightChange(currentChangeIndex);
}

export function previousChange() {
    if (changePositions.length === 0) return;
    
    // FIX: Proper wrapping from 0
    currentChangeIndex = currentChangeIndex <= 0 
        ? changePositions.length - 1 
        : currentChangeIndex - 1;
    highlightChange(currentChangeIndex);
}

function highlightChange(index) {
    // Remove previous highlights
    document.querySelectorAll('.diff-line.diff-current').forEach(el => {
        el.classList.remove('diff-current');
    });
    
    // Add new highlight
    const element = document.querySelector(`[data-change-index="${index}"]`);
    if (element) {
        element.classList.add('diff-current');
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

// ============================================
// VIEW MODE MANAGEMENT
// ============================================

export function setViewMode(mode) {
    if (mode === currentViewMode) return;
    
    currentViewMode = mode;
    currentChangeIndex = 0; // FIX: Reset to 0, not -1
    
    // Re-render diff with new mode
    EventBus.emit('diff:viewModeChanged', { mode });
    
    // Trigger re-render from secondary pane
    const event = new CustomEvent('diff:refresh');
    window.dispatchEvent(event);
}

export function getViewMode() {
    return currentViewMode;
}

// ============================================
// SCROLL SYNCHRONIZATION
// ============================================

/**
 * Initialize scroll sync between left/right diff panes (side-by-side mode).
 * Editor sync was removed in 0.9.16-1 since diffs now overlay the editor.
 */
export function initScrollSync() {
    const leftPane = document.querySelector('.diff-pane-left');
    const rightPane = document.querySelector('.diff-pane-right');
    
    if (leftPane && rightPane) {
        let scrollSource = null;
        
        const syncScroll = (source, target) => {
            if (scrollSource && scrollSource !== source) return;
            scrollSource = source;
            target.scrollTop = source.scrollTop;
            target.scrollLeft = source.scrollLeft;
            requestAnimationFrame(() => { scrollSource = null; });
        };
        
        leftPane.addEventListener('scroll', () => syncScroll(leftPane, rightPane), { passive: true });
        rightPane.addEventListener('scroll', () => syncScroll(rightPane, leftPane), { passive: true });
    }
}

/**
 * Cleanup (no-op since editor scroll sync was removed, kept for API compat).
 */
export function cleanupScrollSync() {
    // No-op — editor scroll sync removed in 0.9.16-1
}

// ============================================
// UTILITIES
// ============================================

// ============================================
// KEYBOARD SHORTCUTS
// ============================================

export function initDiffKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Only handle shortcuts when diff pane is active
        const diffPane = document.getElementById('secondaryPane');
        if (!diffPane || diffPane.style.display === 'none') return;

        // Don't capture keystrokes when user is typing in an input/textarea
        // or when a modal overlay is active (e.g. commit modal)
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
        if (document.querySelector('.modal-overlay.active')) return;
        
        // Alt+↓ - Next change
        if (e.altKey && e.key === 'ArrowDown') {
            e.preventDefault();
            nextChange();
        }
        // Alt+↑ - Previous change
        else if (e.altKey && e.key === 'ArrowUp') {
            e.preventDefault();
            previousChange();
        }
        // V - Toggle view mode
        else if (e.key === 'v' || e.key === 'V') {
            if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
                e.preventDefault();
                setViewMode(currentViewMode === 'unified' ? 'side-by-side' : 'unified');
            }
        }
    });
}

// ============================================
// EXPORTS FOR GLOBAL ACCESS
// ============================================

// Expose to window for button onclick handlers
window.DiffViewer = {
    setViewMode,
    nextChange,
    previousChange,
    getViewMode,
};

/**
 * Bind a delegated click handler for diff-viewer controls (view-mode toggle,
 * prev/next navigation). UI event-dispatch contract
 * (DESIGN-ui-event-dispatch.md). Scoped to `.diff-controls` —
 * the header re-renders on every unified/side-by-side toggle, so the single
 * document-level listener survives container re-creation.
 */
let _wired = false;
export function mountDiffViewer({ onSetViewMode, onPreviousChange, onNextChange } = {}) {
    if (_wired) return;
    _wired = true;

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        if (!btn.closest('.diff-controls')) return;
        const action = btn.getAttribute('data-action');
        if (action === 'setViewMode' && typeof onSetViewMode === 'function') {
            onSetViewMode(btn.getAttribute('data-mode'));
        } else if (action === 'previousChange' && typeof onPreviousChange === 'function') {
            onPreviousChange();
        } else if (action === 'nextChange' && typeof onNextChange === 'function') {
            onNextChange();
        }
    });
}

// ============================================
// CHARACTER-LEVEL DIFF (for modified lines)
// ============================================

/**
 * Compute character-level diff for a single line
 * Used to highlight exact changes within a modified line
 */
export function computeCharDiff(oldText, newText) {
    const changes = [];
    let i = 0, j = 0;
    
    while (i < oldText.length || j < newText.length) {
        if (oldText[i] === newText[j]) {
            changes.push({ type: 'equal', char: oldText[i] });
            i++;
            j++;
        } else {
            // Find next matching character
            let foundMatch = false;
            for (let k = 1; k <= 5; k++) {
                if (oldText[i + k] === newText[j]) {
                    // Deletion
                    for (let l = 0; l < k; l++) {
                        changes.push({ type: 'delete', char: oldText[i + l] });
                    }
                    i += k;
                    foundMatch = true;
                    break;
                } else if (oldText[i] === newText[j + k]) {
                    // Insertion
                    for (let l = 0; l < k; l++) {
                        changes.push({ type: 'insert', char: newText[j + l] });
                    }
                    j += k;
                    foundMatch = true;
                    break;
                }
            }
            
            if (!foundMatch) {
                if (i < oldText.length) {
                    changes.push({ type: 'delete', char: oldText[i] });
                    i++;
                }
                if (j < newText.length) {
                    changes.push({ type: 'insert', char: newText[j] });
                    j++;
                }
            }
        }
    }
    
    return changes;
}

export function renderCharDiff(charChanges) {
    let html = '';
    
    charChanges.forEach(change => {
        if (change.type === 'equal') {
            html += escapeHtml(change.char);
        } else if (change.type === 'delete') {
            html += `<span class="diff-char-removed">${escapeHtml(change.char)}</span>`;
        } else if (change.type === 'insert') {
            html += `<span class="diff-char-added">${escapeHtml(change.char)}</span>`;
        }
    });
    
    return html;
}
