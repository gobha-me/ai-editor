/**
 * AI Editor - Edit Tracker
 * Tracks file reads and edits to detect stale line numbers
 */

/**
 * EditTracker prevents LLMs from using stale line numbers after edits.
 * 
 * Problem: After replace_lines(10-15), all lines below shift. If the LLM
 * then calls replace_lines(20-25) using line numbers from BEFORE the first
 * edit, it will target the wrong lines.
 * 
 * Solution: Track all reads and edits. Reject edits that use line numbers
 * from before the last edit that affected those lines.
 */
const EditTracker = {
    // Track the most recent read operation per file
    lastReads: new Map(),  // path -> { startLine, endLine, timestamp, totalLines, seq }
    
    // Track all edit operations (ring buffer per file)
    edits: new Map(),      // path -> Array<{ operation, startLine, endLine, lineDelta, timestamp, seq }>
    
    // Monotonic sequence counter — ensures logical ordering even when
    // Date.now() returns the same value for rapid consecutive operations
    _seq: 0,
    
    // Configuration
    MAX_EDITS_PER_FILE: 50,           // Keep last 50 edits per file
    STALE_READ_THRESHOLD_MS: 300000,  // Reads older than 5 minutes (300s) considered stale
                                      // Increased from 30s to accommodate LLM analysis workflows
                                      // that involve multiple tool calls, searches, and planning
    
    /**
     * Record a file read operation.
     * Call this from read_file, read_lines, read_current_file, open_file.
     * (read_file added to call sites at 2.79.0 / gitea#485.)
     */
    recordRead(path, startLine = 1, endLine = null, totalLines = null) {
        if (!path) return;
        
        this.lastReads.set(path, {
            startLine,
            endLine: endLine || totalLines,  // null means "whole file"
            totalLines,
            timestamp: Date.now(),
            seq: ++this._seq
        });
        
        console.log(`[EditTracker] Recorded read: ${path} lines ${startLine}-${endLine || 'end'}`);
    },
    
    /**
     * Record an edit operation.
     * Call this from replace_lines, insert_lines, delete_lines AFTER successful edit.
     */
    recordEdit(path, operation, startLine, endLine, lineDelta) {
        if (!path) return;
        
        let pathEdits = this.edits.get(path);
        if (!pathEdits) {
            pathEdits = [];
            this.edits.set(path, pathEdits);
        }
        
        pathEdits.push({
            operation,
            startLine,
            endLine,
            lineDelta,
            timestamp: Date.now(),
            seq: ++this._seq
        });
        
        // Keep only recent edits (ring buffer)
        if (pathEdits.length > this.MAX_EDITS_PER_FILE) {
            pathEdits.shift();
        }
        
        console.log(`[EditTracker] Recorded ${operation}: ${path} lines ${startLine}-${endLine}, delta=${lineDelta}`);
    },
    
    /**
     * Check if an edit operation uses stale line numbers.
     * Returns { stale: false } if safe, or { stale: true, reason, suggestedLine } if stale.
     */
    checkStale(path, targetStartLine, targetEndLine = null) {
        if (!path) {
            return { stale: true, reason: 'No file path provided' };
        }
        
        const lastRead = this.lastReads.get(path);
        const pathEdits = this.edits.get(path) || [];
        
        // RULE 1: Must have read the file recently
        if (!lastRead) {
            return { 
                stale: true, 
                reason: 'No recent read_lines or read_current_file for this file. You MUST read the file first to see current line numbers.'
            };
        }
        
        // RULE 2: Read must be recent (not ancient)
        const timeSinceRead = Date.now() - lastRead.timestamp;
        if (timeSinceRead > this.STALE_READ_THRESHOLD_MS) {
            return { 
                stale: true, 
                reason: `Last read was ${Math.floor(timeSinceRead / 1000)}s ago. File may have changed. Read it again to see current line numbers.`
            };
        }
        
        // RULE 3: An edit since the last read invalidates the target range if either
        //   (a) the edit's range OVERLAPS the target — the lines at the target now
        //       contain new content (model's read saw the OLD content), or
        //   (b) the edit was entirely ABOVE the target with non-zero delta — line
        //       numbers below shifted, so the target's content is at different
        //       line numbers than the model recorded.
        // Pre-1.8.3 only checked (b) with strict `<`, missing (a) entirely. The
        // gap let sequential overlapping edits silently mutate lines whose content
        // had already been replaced — surfaced by the html-games dogfood report.
        const tEnd = targetEndLine != null ? targetEndLine : targetStartLine;
        const editsAfterRead = pathEdits.filter(e => {
            if (e.seq <= lastRead.seq) return false;
            // Post-edit length of the affected region: original span + delta.
            // Min-clamped to 0 because a delete can leave nothing behind.
            const editPostLen = Math.max(0, (e.endLine - e.startLine + 1) + (e.lineDelta || 0));
            const editPostEnd = e.startLine + Math.max(0, editPostLen - 1);
            // (a) overlap: max-of-starts <= min-of-ends
            const overlap = Math.max(e.startLine, targetStartLine) <= Math.min(editPostEnd, tEnd);
            if (overlap) return true;
            // (b) above-target shift
            if (e.lineDelta !== 0 && e.startLine < targetStartLine) return true;
            return false;
        });

        if (editsAfterRead.length > 0) {
            // Split for messaging: overlapping edits demand a re-read; above-only
            // edits can be papered over with a drift suggestion.
            const overlapping = editsAfterRead.filter(e => {
                const editPostLen = Math.max(0, (e.endLine - e.startLine + 1) + (e.lineDelta || 0));
                const editPostEnd = e.startLine + Math.max(0, editPostLen - 1);
                return Math.max(e.startLine, targetStartLine) <= Math.min(editPostEnd, tEnd);
            });
            const aboveOnly = editsAfterRead.filter(e => !overlapping.includes(e));

            const editDescriptions = editsAfterRead.map(e =>
                `${e.operation} at lines ${e.startLine}-${e.endLine} (${e.lineDelta >= 0 ? '+' : ''}${e.lineDelta})`
            ).join(', ');

            // Drift only meaningful when no overlap — overlap means content
            // changed, no line-number adjustment can recover the old content.
            const totalDrift = aboveOnly.reduce((sum, e) => sum + (e.lineDelta || 0), 0);
            const overlapMsg = overlapping.length > 0
                ? `${overlapping.length} edit(s) modified content within or overlapping target lines ${targetStartLine}-${tEnd}: ${editDescriptions}. The lines at this range no longer match what your read returned. You MUST call read_lines on the target region before editing.`
                : `${editsAfterRead.length} edit(s) changed line numbers since your last read: ${editDescriptions}. Total line drift: ${totalDrift >= 0 ? '+' : ''}${totalDrift}. You MUST call read_lines on the target region before editing.`;

            return {
                stale: true,
                reason: overlapMsg,
                suggestedAdjustment: totalDrift,
                suggestedStartLine: overlapping.length === 0 ? targetStartLine + totalDrift : null,
                suggestedEndLine: overlapping.length === 0 && targetEndLine ? targetEndLine + totalDrift : null
            };
        }
        
        // RULE 4: Target must be within the range that was read
        // (Only check if we have endLine - null means "whole file" read)
        if (lastRead.endLine !== null && targetStartLine > lastRead.endLine) {
            return {
                stale: true,
                reason: `Your last read was lines ${lastRead.startLine}-${lastRead.endLine}, but you're trying to edit line ${targetStartLine}. ` +
                       `Read the target region first to see what's there.`
            };
        }
        
        return { stale: false };
    },
    
    /**
     * Clear all tracking for a file.
     * Call when opening a new file or closing a file.
     */
    clearFile(path) {
        if (!path) return;
        this.lastReads.delete(path);
        this.edits.delete(path);
        console.log(`[EditTracker] Cleared tracking for ${path}`);
    },
    
    /**
     * Clear all tracking.
     * Call when switching projects or resetting state.
     */
    clearAll() {
        this.lastReads.clear();
        this.edits.clear();
        this._seq = 0;
        console.log('[EditTracker] Cleared all tracking');
    },
    
    /**
     * Get debug info for a file.
     */
    getDebugInfo(path) {
        const lastRead = this.lastReads.get(path);
        const pathEdits = this.edits.get(path) || [];
        
        return {
            path,
            lastRead: lastRead ? {
                lines: `${lastRead.startLine}-${lastRead.endLine || 'end'}`,
                ageMs: Date.now() - lastRead.timestamp,
                totalLines: lastRead.totalLines
            } : null,
            editCount: pathEdits.length,
            recentEdits: pathEdits.slice(-5).map(e => ({
                operation: e.operation,
                lines: `${e.startLine}-${e.endLine}`,
                delta: e.lineDelta,
                ageMs: Date.now() - e.timestamp
            }))
        };
    }
};

export { EditTracker };
