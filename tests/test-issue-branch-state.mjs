/**
 * Unit tests for computeIssueBranchState (1.13.0, Touch 3 extraction B).
 * Pure function — no DOM, no State reads. The shim is still imported because
 * issue-detail.js's transitive imports (core.js / git.js) touch browser globals
 * at module-eval time.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeIssueBranchState, issueBranchName } from '../js/issue-detail.js';

// ============================================
// issueBranchName slug rules
// ============================================

test('issueBranchName: lowercases + slugifies + caps at 50 chars', () => {
    const name = issueBranchName(42, 'Fix the BUG in widget!!!');
    assert.equal(name, 'issue/42-fix-the-bug-in-widget');
});

test('issueBranchName: handles unicode + repeated dashes', () => {
    const name = issueBranchName(7, '— hello — world —');
    assert.equal(name, 'issue/7-hello-world');
});

test('issueBranchName: very long titles are truncated cleanly', () => {
    const long = 'a'.repeat(80);
    const name = issueBranchName(99, long);
    // "issue/99-" + 50 chars = 59 total; ensure no trailing dash
    assert.match(name, /^issue\/99-a{50}$/);
});

test('issueBranchName: empty title still yields a valid prefix', () => {
    const name = issueBranchName(1, '');
    assert.equal(name, 'issue/1-');
});

// ============================================
// computeIssueBranchState — three states
// ============================================

const issue = { number: 12, title: 'Add pause to Snake' };

test('isOnBranch=true when currentBranch matches the issue branch', () => {
    const state = computeIssueBranchState(issue, {
        branches: [{ name: 'issue/12-add-pause-to-snake' }],
        currentBranch: 'issue/12-add-pause-to-snake',
        defaultBranch: 'main',
    });
    assert.equal(state.isOnBranch, true);
    assert.ok(state.existingBranch);
    assert.equal(state.branchName, 'issue/12-add-pause-to-snake');
    assert.equal(state.defaultBranch, 'main');
});

test('existingBranch present, isOnBranch=false → "switch" state', () => {
    const state = computeIssueBranchState(issue, {
        branches: [{ name: 'issue/12-add-pause-to-snake' }, { name: 'main' }],
        currentBranch: 'main',
        defaultBranch: 'main',
    });
    assert.equal(state.isOnBranch, false);
    assert.ok(state.existingBranch);
});

test('no existing branch → "create" state', () => {
    const state = computeIssueBranchState(issue, {
        branches: [{ name: 'main' }],
        currentBranch: 'main',
        defaultBranch: 'main',
    });
    assert.equal(state.isOnBranch, false);
    assert.equal(state.existingBranch, undefined);
});

// ============================================
// Edge cases — defensive against missing context
// ============================================

test('missing branches list defaults to empty + create state', () => {
    const state = computeIssueBranchState(issue, { currentBranch: 'main' });
    assert.equal(state.existingBranch, undefined);
    assert.equal(state.isOnBranch, false);
});

test('missing currentBranch never matches', () => {
    const state = computeIssueBranchState(issue, {
        branches: [{ name: 'issue/12-add-pause-to-snake' }],
    });
    assert.equal(state.isOnBranch, false);
});

test('missing defaultBranch falls back to "main"', () => {
    const state = computeIssueBranchState(issue, { branches: [], currentBranch: 'main' });
    assert.equal(state.defaultBranch, 'main');
});

test('explicit defaultBranch is respected', () => {
    const state = computeIssueBranchState(issue, {
        branches: [],
        currentBranch: 'master',
        defaultBranch: 'master',
    });
    assert.equal(state.defaultBranch, 'master');
});

test('issue with no title still yields a branchName', () => {
    const state = computeIssueBranchState({ number: 5 }, { branches: [], currentBranch: 'main' });
    assert.equal(state.branchName, 'issue/5-');
});
