/**
 * Tests for getRefusalHint — the 1.8.2 next-action hint that rides on
 * the REFUSED envelope built in handlers.js.
 *
 * Origin: Grok-4-3 loop on get_ci_status against a no-PR branch
 * (HTML-Games dogfood, 2026-05-07). The pin on `create_pull_request`
 * inside the get_ci_status hint guards against silent regression of the
 * specific recovery path that fault demanded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getRefusalHint } from '../js/chat/refusal-hints.js';

test('get_ci_status hint names create_pull_request (regression pin)', () => {
    const hint = getRefusalHint('get_ci_status');
    assert.match(hint, /create_pull_request/);
    assert.match(hint, /precondition|fresh branch/i);
});

test('wait_for_ci hint reuses the missing-precondition framing', () => {
    const hint = getRefusalHint('wait_for_ci');
    assert.match(hint, /precondition|PR/i);
});

test('unknown tool falls back to the generic hint', () => {
    const hint = getRefusalHint('some_nonexistent_tool_xyz');
    assert.match(hint, /Re-read the prior result/);
    assert.match(hint, /precondition/);
});

test('hint is always a non-empty string (handlers.js concatenates it directly)', () => {
    for (const name of ['get_ci_status', 'wait_for_ci', '', undefined, 'unknown']) {
        const hint = getRefusalHint(name);
        assert.equal(typeof hint, 'string');
        assert.ok(hint.length > 0);
    }
});
