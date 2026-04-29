/**
 * Tests for EditTracker — stale line detection and edit tracking.
 * EditTracker has ZERO imports, making it perfectly testable under node:test
 * with no shim. The .js sibling (tests/test-edit-tracker.js) covers the
 * browser suite.
 *
 * Tests run sequentially in declaration order under node:test, so the
 * EditTracker.clearAll() calls between groups preserve the original suite
 * semantics (each group starts from a known empty state).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditTracker } from '../js/tools/edit-tracker.js';

// ============================================
// Core operations
// ============================================

EditTracker.clearAll();

test('recordRead stores file entry', () => {
    // recordRead(path, startLine, endLine, totalLines)
    EditTracker.recordRead('app.js', 1, 100, 100);
    assert.ok(EditTracker.lastReads.has('app.js'));
});

test('recordRead stores totalLines', () => {
    assert.equal(EditTracker.lastReads.get('app.js').totalLines, 100);
});

test('recordEdit stores edit', () => {
    // recordEdit(path, operation, startLine, endLine, lineDelta)
    EditTracker.recordEdit('app.js', 'replace_lines', 10, 15, -3);
    assert.equal(EditTracker.edits.get('app.js')?.length, 1);
});

test('Lines before edit are not stale', () => {
    const beforeResult = EditTracker.checkStale('app.js', 1, 5);
    assert.equal(beforeResult.stale, false);
});

test('Lines after edit region are stale (shifted)', () => {
    const afterResult = EditTracker.checkStale('app.js', 20, 25);
    assert.equal(afterResult.stale, true);
    assert.ok(afterResult.reason.includes('edit'));
    assert.equal(afterResult.suggestedAdjustment, -3);
});

// ============================================
// Clear and reset
// ============================================

test('clearAll() empties lastReads and edits', () => {
    EditTracker.clearAll();
    assert.equal(EditTracker.lastReads.size, 0);
    assert.equal(EditTracker.edits.size, 0);
});

test('Stale after clearAll (no read recorded)', () => {
    const noReadResult = EditTracker.checkStale('app.js', 10, 20);
    assert.equal(noReadResult.stale, true);
    assert.ok(noReadResult.reason.includes('No recent read'));
});

// ============================================
// Multiple edits
// ============================================

test('Same-size edit (delta=0) does not cause stale below', () => {
    EditTracker.clearAll();
    EditTracker.recordRead('main.py', 1, 50, 50);
    EditTracker.recordEdit('main.py', 'replace_lines', 5, 10, 0);
    const sameSize = EditTracker.checkStale('main.py', 15, 20);
    assert.equal(sameSize.stale, false);
});

test('Multiple edits tracked', () => {
    EditTracker.recordEdit('main.py', 'replace_lines', 20, 25, -4);
    assert.equal(EditTracker.edits.get('main.py')?.length, 2);
});

test('Lines after multiple edits are stale', () => {
    const belowBoth = EditTracker.checkStale('main.py', 30, 35);
    assert.equal(belowBoth.stale, true);
});

// ============================================
// Cross-file isolation
// ============================================

test('Unrelated file is stale (no read, not edit-related)', () => {
    EditTracker.clearAll();
    EditTracker.recordRead('a.js', 1, 100, 100);
    EditTracker.recordEdit('a.js', 'replace_lines', 10, 20, -5);
    const bResult = EditTracker.checkStale('b.js', 10, 20);
    assert.equal(bResult.stale, true);
    assert.ok(bResult.reason.includes('No recent read'));
});

test('clearFile removes file edits and reads', () => {
    EditTracker.clearFile('a.js');
    assert.equal(EditTracker.edits.has('a.js'), false);
    assert.equal(EditTracker.lastReads.has('a.js'), false);
});

// ============================================
// Out-of-range detection
// ============================================

test('Edit beyond read range is stale', () => {
    EditTracker.clearAll();
    EditTracker.recordRead('range.js', 1, 50, 50);
    const outOfRange = EditTracker.checkStale('range.js', 60, 70);
    assert.equal(outOfRange.stale, true);
    assert.ok(outOfRange.reason.includes('last read was'));
});

// ============================================
// Debug info
// ============================================

test('getDebugInfo reports file, edit count, lastRead, and recent edits', () => {
    EditTracker.clearAll();
    EditTracker.recordRead('debug.js', 1, 100, 100);
    EditTracker.recordEdit('debug.js', 'insert_lines', 50, 50, 5);

    const info = EditTracker.getDebugInfo('debug.js');
    assert.equal(info.path, 'debug.js');
    assert.equal(info.editCount, 1);
    assert.notEqual(info.lastRead, null);
    assert.equal(info.recentEdits.length, 1);
    assert.equal(info.recentEdits[0].delta, 5);
});
