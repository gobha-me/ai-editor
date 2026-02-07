/**
 * AI Editor - Enhanced Diff Viewer
 * Implements side-by-side and unified diff views with syntax highlighting
 */

import { State, EventBus } from './core.js';

// ============================================
// DIFF VIEW STATE
// ============================================

let currentViewMode = 'unified'; // 'unified' | 'side-by-side'
let currentChangeIndex = -1;
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
    
    const hunks = [];
    let currentHunk = null;
    
    changes.forEach((change, index) => {
        const isChange = change.type !== 'equal';
        
        if (isChange) {
            if (!currentHunk) {
                // Start new hunk
                const startIndex = Math.max(0, index - contextLines);
                currentHunk = {
                    oldStart: changes[startIndex].oldLine !== undefined ? changes[startIndex].oldLine + 1 : 1,
                    newStart: changes[startIndex].newLine !== undefined ? changes[startIndex].newLine + 1 : 1,
                    changes: changes.slice(startIndex, index + 1)
                };
            } else {
                currentHunk.changes.push(change);
            }
        } else if (currentHunk) {
            // Add context after change
            currentHunk.changes.push(change);
            
            // Check if we should close this hunk
            const nextChangeIndex = changes.findIndex((c, i) => i > index && c.type !== 'equal');
            if (nextChangeIndex === -1 || nextChangeIndex - index > contextLines * 2) {
                // Close hunk
                hunks.push(currentHunk);
                currentHunk = null;
            }
        }
    });
    
    if (currentHunk) {
        hunks.push(currentHunk);
    }
    
    return hunks;
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
    
    return `
        <div class="diff-hunk-header" data-hunk="${hunkIndex}">
            <span class="diff-hunk-info">@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@</span>
        </div>
    `;
}

function renderHunkContent(hunk, originalLines, modifiedLines, mode) {
    let html = '';
    
    hunk.changes.forEach((change, index) => {
        const lineNum = hunk.changes.indexOf(change);
        
        if (change.type === 'equal') {
            const line = originalLines[change.oldLine];
            html += `
                <div class="diff-line diff-equal">
                    <span class="diff-ln">${change.oldLine + 1}</span>
                    <span class="diff-ln">${change.newLine + 1}</span>
                    <span class="diff-text"> ${escapeHtml(line)}</span>
                </div>
            `;
        } else if (change.type === 'delete') {
            const line = originalLines[change.oldLine];
            changePositions.push({ index: changePositions.length, element: null });
            html += `
                <div class="diff-line diff-removed" data-change-index="${changePositions.length - 1}">
                    <span class="diff-ln">${change.oldLine + 1}</span>
                    <span class="diff-ln"></span>
                    <span class="diff-text">-${escapeHtml(line)}</span>
                </div>
            `;
        } else if (change.type === 'insert') {
            const line = modifiedLines[change.newLine];
            changePositions.push({ index: changePositions.length, element: null });
            html += `
                <div class="diff-line diff-added" data-change-index="${changePositions.length - 1}">
                    <span class="diff-ln"></span>
                    <span class="diff-ln">${change.newLine + 1}</span>
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
    let lineIndex = 0;
    
    changes.forEach(change => {
        if (change.type === 'equal') {
            const lineNum = side === 'left' ? change.oldLine : change.newLine;
            const line = lines[lineNum];
            html += `
                <div class="diff-line diff-equal">
                    <span class="diff-ln">${lineNum + 1}</span>
                    <span class="diff-text"> ${escapeHtml(line)}</span>
                </div>
            `;
        } else if (change.type === 'delete' && side === 'left') {
            const line = lines[change.oldLine];
            html += `
                <div class="diff-line diff-removed">
                    <span class="diff-ln">${change.oldLine + 1}</span>
                    <span class="diff-text">-${escapeHtml(line)}</span>
                </div>
            `;
        } else if (change.type === 'insert' && side === 'right') {
            const line = lines[change.newLine];
            html += `
                <div class="diff-line diff-added">
                    <span class="diff-ln">${change.newLine + 1}</span>
                    <span class="diff-text">+${escapeHtml(line)}</span>
                </div>
            `;
        } else if (change.type === 'delete' && side === 'right') {
            // Empty line on right side for deleted line
            html += '<div class="diff-line diff-empty"></div>';
        } else if (change.type === 'insert' && side === 'left') {
            // Empty line on left side for added line
            html += '<div class="diff-line diff-empty"></div>';
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
                        onclick="window.DiffViewer.setViewMode('unified')" 
                        title="Unified View">
                    Unified
                </button>
                <button class="diff-btn ${currentViewMode === 'side-by-side' ? 'active' : ''}" 
                        onclick="window.DiffViewer.setViewMode('side-by-side')" 
                        title="Side-by-Side View">
                    Side-by-Side
                </button>
                <button class="diff-btn" 
                        onclick="window.DiffViewer.previousChange()" 
                        title="Previous Change (Alt+↑)">
                    ↑
                </button>
                <button class="diff-btn" 
                        onclick="window.DiffViewer.nextChange()" 
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
    
    currentChangeIndex = (currentChangeIndex + 1) % changePositions.length;
    highlightChange(currentChangeIndex);
}

export function previousChange() {
    if (changePositions.length === 0) return;
    
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
    currentChangeIndex = -1;
    
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
// UTILITIES
// ============================================

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================
// KEYBOARD SHORTCUTS
// ============================================

export function initDiffKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Only handle shortcuts when diff pane is active
        const diffPane = document.getElementById('secondaryPane');
        if (!diffPane || diffPane.style.display === 'none') return;
        
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
// SCROLL SYNCHRONIZATION (for side-by-side)
// ============================================

export function initScrollSync() {
    const leftPane = document.querySelector('.diff-pane-left');
    const rightPane = document.querySelector('.diff-pane-right');
    
    if (!leftPane || !rightPane) return;
    
    let syncingLeft = false;
    let syncingRight = false;
    
    leftPane.addEventListener('scroll', () => {
        if (syncingLeft) return;
        syncingRight = true;
        rightPane.scrollTop = leftPane.scrollTop;
        setTimeout(() => syncingRight = false, 10);
    });
    
    rightPane.addEventListener('scroll', () => {
        if (syncingRight) return;
        syncingLeft = true;
        leftPane.scrollTop = rightPane.scrollTop;
        setTimeout(() => syncingLeft = false, 10);
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
    getViewMode
};

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
