/**
 * Tests for the `<PROJECT_CONVENTIONS>` block in the editor system prompt
 * (github#37 Phase 1, 1.6.13 — CLAUDE.md analogue).
 *
 * The system prompt builder reads `State.projectConventions` and, when it's
 * a non-empty string, wraps it in a `<PROJECT_CONVENTIONS>...</PROJECT_CONVENTIONS>`
 * block prefixed by the "📋 PROJECT CONVENTIONS" header.
 *
 * Asserts:
 *   - Absent (null / missing) → no block in the prompt; no `{{projectConventions}}`
 *     placeholder leak.
 *   - Present → block contains the verbatim content; the literal tag boundaries
 *     `<PROJECT_CONVENTIONS>` and `</PROJECT_CONVENTIONS>` are emitted.
 *   - Positioning → block sits AFTER the "🔒 UNTRUSTED CONTENT" rule and BEFORE
 *     the "Current context:" header (this is what gives the model the right
 *     mental model for trusted-vs-untrusted).
 *   - Empty string → treated like absent (no block).
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSystemPrompt } from '../js/prompts.js';
import { State } from '../js/core.js';

const SENTINEL = '# Project conventions\n- Bump js/version.js with feat/fix PRs.\n- Branch naming: issue/N-slug.\n';

function withConventions(value, fn) {
    const prev = State.projectConventions;
    try {
        State.projectConventions = value;
        return fn();
    } finally {
        State.projectConventions = prev;
    }
}

// ============================================
// Absent / null
// ============================================

test('no PROJECT_CONVENTIONS block when State.projectConventions is null', () => {
    withConventions(null, () => {
        const prompt = buildSystemPrompt();
        assert.ok(!prompt.includes('<PROJECT_CONVENTIONS>'), 'should not render opening tag when absent');
        assert.ok(!prompt.includes('</PROJECT_CONVENTIONS>'), 'should not render closing tag when absent');
        assert.ok(!prompt.includes('📋 PROJECT CONVENTIONS'), 'should not render header when absent');
        assert.ok(!prompt.includes('{{projectConventions}}'), 'placeholder must be substituted, not leaked');
    });
});

test('no PROJECT_CONVENTIONS block when State.projectConventions is empty string', () => {
    withConventions('', () => {
        const prompt = buildSystemPrompt();
        assert.ok(!prompt.includes('<PROJECT_CONVENTIONS>'));
        assert.ok(!prompt.includes('{{projectConventions}}'));
    });
});

// ============================================
// Present
// ============================================

test('PROJECT_CONVENTIONS block contains verbatim content when set', () => {
    withConventions(SENTINEL, () => {
        const prompt = buildSystemPrompt();
        assert.ok(prompt.includes('<PROJECT_CONVENTIONS>'), 'opening tag must appear');
        assert.ok(prompt.includes('</PROJECT_CONVENTIONS>'), 'closing tag must appear');
        assert.ok(prompt.includes('📋 PROJECT CONVENTIONS'), 'trusted-content header must appear');
        assert.ok(prompt.includes(SENTINEL), 'sentinel content must appear verbatim');
    });
});

test('PROJECT_CONVENTIONS block is NOT wrapped in <UNTRUSTED_*> markers', () => {
    // Trusted content earns command-following privileges. If a future change
    // accidentally routes CLAUDE.md through wrapUntrusted(), this catches it.
    withConventions(SENTINEL, () => {
        const prompt = buildSystemPrompt();
        const block = prompt.split('<PROJECT_CONVENTIONS>')[1].split('</PROJECT_CONVENTIONS>')[0];
        assert.ok(!block.includes('<UNTRUSTED_'), 'CLAUDE.md content must not be wrapped as untrusted');
    });
});

// ============================================
// Positioning
// ============================================

test('PROJECT_CONVENTIONS sits AFTER the untrusted-content rule and BEFORE Current context:', () => {
    withConventions(SENTINEL, () => {
        const prompt = buildSystemPrompt();
        const idxUntrusted = prompt.indexOf('🔒 UNTRUSTED CONTENT');
        const idxOpenTag = prompt.indexOf('<PROJECT_CONVENTIONS>');
        const idxCloseTag = prompt.indexOf('</PROJECT_CONVENTIONS>');
        const idxCurrentCtx = prompt.indexOf('Current context:');

        assert.ok(idxUntrusted >= 0, 'untrusted-content rule must be present');
        assert.ok(idxOpenTag >= 0, 'open tag must be present');
        assert.ok(idxCloseTag >= 0, 'close tag must be present');
        assert.ok(idxCurrentCtx >= 0, 'Current context: header must be present');

        assert.ok(idxUntrusted < idxOpenTag, 'untrusted-content rule must precede the conventions block');
        assert.ok(idxOpenTag < idxCloseTag, 'tags must be ordered');
        assert.ok(idxCloseTag < idxCurrentCtx, 'conventions block must precede Current context:');
    });
});
