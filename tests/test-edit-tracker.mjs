/**
 * Tests for EditTracker — stale line detection and edit tracking.
 * EditTracker has ZERO imports, making it perfectly testable.
 */
import { EditTracker } from '../js/tools/edit-tracker.js';

const { T } = window;

T.suite('EditTracker — Core Operations');

// Reset before each logical group
EditTracker.clear();

// Record a read
EditTracker.recordRead('app.js', 100);
T.eq(EditTracker.lastReads.get('app.js'), 100, 'recordRead stores line count');

// Record an edit
EditTracker.recordEdit('app.js', { startLine: 10, endLine: 15, newLineCount: 3 });
T.eq(EditTracker.edits.get('app.js')?.length, 1, 'recordEdit stores edit');

// Stale detection — edit targeting lines BEFORE the recorded edit should be OK
// because the edit was at 10-15, and a new edit at 1-5 is before it
T.eq(EditTracker.isStale('app.js', 1, 5), false, 'Lines before edit are not stale');

// But lines at the edit boundary or after may be stale
// because line numbers shifted after the 10-15 → 3-line replacement
T.eq(EditTracker.isStale('app.js', 20, 25), true, 'Lines after edit region are stale (shifted)');

T.suite('EditTracker — Clear and Reset');

EditTracker.clear();
T.eq(EditTracker.lastReads.size, 0, 'clear() empties lastReads');
T.eq(EditTracker.edits.size, 0, 'clear() empties edits');

// After clear, nothing is stale
T.eq(EditTracker.isStale('app.js', 10, 20), false, 'Nothing stale after clear');

T.suite('EditTracker — Multiple Edits');

EditTracker.clear();
EditTracker.recordRead('main.py', 50);

// Edit lines 5-10 (replace with same count = no shift)
EditTracker.recordEdit('main.py', { startLine: 5, endLine: 10, newLineCount: 6 });
T.eq(EditTracker.isStale('main.py', 5, 10), false, 'Same-size replacement is not stale at edit site');

// Another edit at 20-25 (shifts content below)
EditTracker.recordEdit('main.py', { startLine: 20, endLine: 25, newLineCount: 2 });
T.eq(EditTracker.edits.get('main.py')?.length, 2, 'Multiple edits tracked');

// Lines well beyond the edits are stale
T.eq(EditTracker.isStale('main.py', 30, 35), true, 'Lines after multiple edits are stale');

T.suite('EditTracker — Cross-File Isolation');

EditTracker.clear();
EditTracker.recordRead('a.js', 100);
EditTracker.recordEdit('a.js', { startLine: 10, endLine: 20, newLineCount: 5 });

// Different file should not be affected
T.eq(EditTracker.isStale('b.js', 10, 20), false, 'Unrelated file is not stale');

// clearFile only affects one file
EditTracker.clearFile('a.js');
T.eq(EditTracker.edits.has('a.js'), false, 'clearFile removes file edits');
T.eq(EditTracker.lastReads.has('a.js'), false, 'clearFile removes file reads');
