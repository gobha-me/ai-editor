// @ts-check
/**
 * Tests for the pure payload mappers exported from
 * `js/git-providers/{gitea,github}.js` — the LEFT/RIGHT side mapping
 * and the event-enum mapping that the submitPullRequestReview path
 * relies on.
 *
 * @since 2.13.0 (Touch 3 PR Review surface — slice 2)
 */

import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    _mapDraftToGiteaReviewComment,
    _mapEventEnum,
} from '../js/git-providers/gitea.js';

import {
    _mapDraftToGitHubReviewComment,
    _mapEventEnumGitHub,
} from '../js/git-providers/github.js';

// ============================================
// Gitea — side mapping
// ============================================

test('Gitea: side LEFT → old_position', () => {
    const out = _mapDraftToGiteaReviewComment({
        path: 'src/app.js',
        line: 42,
        side: 'LEFT',
        body: 'remove this',
    });
    assert.equal(out.path, 'src/app.js');
    assert.equal(out.body, 'remove this');
    assert.equal(out.old_position, 42);
    assert.equal(out.new_position, undefined);
});

test('Gitea: side RIGHT → new_position', () => {
    const out = _mapDraftToGiteaReviewComment({
        path: 'src/app.js',
        line: 100,
        side: 'RIGHT',
        body: 'looks good',
    });
    assert.equal(out.new_position, 100);
    assert.equal(out.old_position, undefined);
});

// ============================================
// Gitea — event enum mapping
// ============================================

test('Gitea: APPROVE → APPROVED, others passthrough', () => {
    assert.equal(_mapEventEnum('APPROVE'), 'APPROVED');
    assert.equal(_mapEventEnum('COMMENT'), 'COMMENT');
    assert.equal(_mapEventEnum('REQUEST_CHANGES'), 'REQUEST_CHANGES');
    assert.equal(_mapEventEnum(''), 'COMMENT');
    assert.equal(_mapEventEnum(undefined), 'COMMENT');
});

// ============================================
// GitHub — passthrough mapping
// ============================================

test('GitHub: draft is mapped 1:1 (path/line/side/body)', () => {
    const out = _mapDraftToGitHubReviewComment({
        path: 'a.ts',
        line: 7,
        side: 'RIGHT',
        body: 'nit',
    });
    assert.deepEqual(out, { path: 'a.ts', line: 7, side: 'RIGHT', body: 'nit' });
});

test('GitHub: event enum passthrough', () => {
    assert.equal(_mapEventEnumGitHub('APPROVE'), 'APPROVE');
    assert.equal(_mapEventEnumGitHub('COMMENT'), 'COMMENT');
    assert.equal(_mapEventEnumGitHub('REQUEST_CHANGES'), 'REQUEST_CHANGES');
    assert.equal(_mapEventEnumGitHub(undefined), 'COMMENT');
});
