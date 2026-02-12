/**
 * Diff Utilities
 * Simple line-by-line diff computation and display formatting.
 * Extracted from editor.js in 0.9.13 — no external dependencies.
 */

// ============================================
// DIFF COMPUTATION
// ============================================

export function computeSimpleDiff(original, updated) {
    const originalLines = original.split('\n');
    const updatedLines = updated.split('\n');
    const diff = [];

    const maxLen = Math.max(originalLines.length, updatedLines.length);
    
    for (let i = 0; i < maxLen; i++) {
        const origLine = originalLines[i];
        const updLine = updatedLines[i];
        
        if (origLine === undefined) {
            diff.push({ type: 'add', line: i + 1, content: updLine });
        } else if (updLine === undefined) {
            diff.push({ type: 'remove', line: i + 1, content: origLine });
        } else if (origLine !== updLine) {
            diff.push({ type: 'change', line: i + 1, original: origLine, updated: updLine });
        }
    }

    return diff;
}

// ============================================
// DIFF DISPLAY FORMATTING
// ============================================

export function formatDiffForDisplay(diff) {
    return diff.map(d => {
        switch (d.type) {
            case 'add':
                return `+ L${d.line}: ${d.content}`;
            case 'remove':
                return `- L${d.line}: ${d.content}`;
            case 'change':
                return `~ L${d.line}:\n  - ${d.original}\n  + ${d.updated}`;
            default:
                return '';
        }
    }).join('\n');
}
