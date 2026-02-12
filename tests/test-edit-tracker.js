/**
 * Tests for EditTracker — stale line detection and edit tracking.
 * EditTracker has ZERO imports, making it perfectly testable.
 */
import { EditTracker } from '../js/tools/edit-tracker.js';

const { T } = window;

T.suite('EditTracker — Core Operations');

// Reset before each logical group
EditTracker.clearAll();

// Record a read (path, startLine, endLine, totalLines)
EditTracker.recordRead('app.js', 1, 100, 100);
T.assert(EditTracker.lastReads.has('app.js'), 'recordRead stores file entry');
T.eq(EditTracker.lastReads.get('app.js').totalLines, 100, 'recordRead stores totalLines');

// Record an edit (path, operation, startLine, endLine, lineDelta)
EditTracker.recordEdit('app.js', 'replace_lines', 10, 15, -3);
T.eq(EditTracker.edits.get('app.js')?.length, 1, 'recordEdit stores edit');

// checkStale — lines before edit are NOT stale (edit didn't shift them)
const beforeResult = EditTracker.checkStale('app.js', 1, 5);
T.eq(beforeResult.stale, false, 'Lines before edit are not stale');

// Lines after edit region ARE stale (line numbers shifted by lineDelta)
const afterResult = EditTracker.checkStale('app.js', 20, 25);
T.eq(afterResult.stale, true, 'Lines after edit region are stale (shifted)');
T.assert(afterResult.reason.includes('edit'), 'Stale result includes reason');
T.eq(afterResult.suggestedAdjustment, -3, 'Suggests drift adjustment of -3');

T.suite('EditTracker — Clear and Reset');

EditTracker.clearAll();
T.eq(EditTracker.lastReads.size, 0, 'clearAll() empties lastReads');
T.eq(EditTracker.edits.size, 0, 'clearAll() empties edits');

// After clearAll, checkStale returns stale=true because no read exists
const noReadResult = EditTracker.checkStale('app.js', 10, 20);
T.eq(noReadResult.stale, true, 'Stale after clearAll (no read recorded)');
T.assert(noReadResult.reason.includes('No recent read'), 'Reason: no recent read');

T.suite('EditTracker — Multiple Edits');

EditTracker.clearAll();
EditTracker.recordRead('main.py', 1, 50, 50);

// Edit lines 5-10, no net change (delta=0)
EditTracker.recordEdit('main.py', 'replace_lines', 5, 10, 0);
const sameSize = EditTracker.checkStale('main.py', 15, 20);
T.eq(sameSize.stale, false, 'Same-size edit (delta=0) does not cause stale below');

// Another edit at 20-25, removes 4 lines (delta=-4)
EditTracker.recordEdit('main.py', 'replace_lines', 20, 25, -4);
T.eq(EditTracker.edits.get('main.py')?.length, 2, 'Multiple edits tracked');

// Lines well below both edits are stale
const belowBoth = EditTracker.checkStale('main.py', 30, 35);
T.eq(belowBoth.stale, true, 'Lines after multiple edits are stale');

T.suite('EditTracker — Cross-File Isolation');

EditTracker.clearAll();
EditTracker.recordRead('a.js', 1, 100, 100);
EditTracker.recordEdit('a.js', 'replace_lines', 10, 20, -5);

// Different file: no read means stale for "no read" reason, not edit-related
const bResult = EditTracker.checkStale('b.js', 10, 20);
T.eq(bResult.stale, true, 'Unrelated file is stale (no read, not edit-related)');
T.assert(bResult.reason.includes('No recent read'), 'Reason is "no read" not edit conflict');

// clearFile only affects one file
EditTracker.clearFile('a.js');
T.eq(EditTracker.edits.has('a.js'), false, 'clearFile removes file edits');
T.eq(EditTracker.lastReads.has('a.js'), false, 'clearFile removes file reads');

T.suite('EditTracker — Out-of-Range Detection');

EditTracker.clearAll();
EditTracker.recordRead('range.js', 1, 50, 50);

// Try to edit beyond read range
const outOfRange = EditTracker.checkStale('range.js', 60, 70);
T.eq(outOfRange.stale, true, 'Edit beyond read range is stale');
T.assert(outOfRange.reason.includes('last read was'), 'Reason mentions read range');

T.suite('EditTracker — Debug Info');

EditTracker.clearAll();
EditTracker.recordRead('debug.js', 1, 100, 100);
EditTracker.recordEdit('debug.js', 'insert_lines', 50, 50, 5);

const info = EditTracker.getDebugInfo('debug.js');
T.eq(info.path, 'debug.js', 'Debug info includes path');
T.eq(info.editCount, 1, 'Debug info includes edit count');
T.assert(info.lastRead !== null, 'Debug info includes lastRead');
T.eq(info.recentEdits.length, 1, 'Debug info includes recent edits');
T.eq(info.recentEdits[0].delta, 5, 'Debug edit shows correct delta');
