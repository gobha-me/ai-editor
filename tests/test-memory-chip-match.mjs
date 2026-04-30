/**
 * Tests for js/chat/memory-chip/match.js — pure helpers driving the
 * `@memory` picker. No DOM, no IDB, no Preact: trigger detection,
 * filtering, citation formatting, citation insertion.
 *
 * The wire format committed in PR #8 is `[memory:<key>]` markdown.
 * These tests pin both the format and the cursor placement after
 * insertion so a future render-path change can't quietly diverge.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    findActiveTrigger,
    filterMemories,
    formatCitation,
    applyCitation,
} from '../js/chat/memory-chip/match.js';

/* -------------------------------------------------------------------------- */
/* findActiveTrigger                                                          */
/* -------------------------------------------------------------------------- */

test('findActiveTrigger — returns null on empty / non-string input', () => {
    assert.equal(findActiveTrigger('', 0), null);
    assert.equal(findActiveTrigger(null, 0), null);
    assert.equal(findActiveTrigger(undefined, 0), null);
    assert.equal(findActiveTrigger('hello', 5), null);
});

test('findActiveTrigger — opens picker when @memory is at start of text', () => {
    const t = findActiveTrigger('@memory', 7);
    assert.ok(t);
    assert.equal(t.start, 0);
    assert.equal(t.end, 7);
    assert.equal(t.query, '');
});

test('findActiveTrigger — opens picker when @memory follows whitespace', () => {
    const t = findActiveTrigger('hi @memory', 10);
    assert.ok(t);
    assert.equal(t.start, 3);
    assert.equal(t.end, 10);
    assert.equal(t.query, '');
});

test('findActiveTrigger — captures the filter substring after a single space', () => {
    const t = findActiveTrigger('@memory pref', 12);
    assert.ok(t);
    assert.equal(t.start, 0);
    assert.equal(t.end, 12);
    assert.equal(t.query, 'pref');
});

test('findActiveTrigger — does NOT open when text ends in `memory` without @', () => {
    assert.equal(findActiveTrigger('I have a good memory', 20), null);
});

test('findActiveTrigger — does NOT open when @memory is preceded by a non-space character', () => {
    // Embedded inside another token, like `email-@memory` — should not trigger.
    assert.equal(findActiveTrigger('foo@memory', 10), null);
});

test('findActiveTrigger — closes once a second whitespace appears after the trigger', () => {
    // After the user types past the filter into the next word, the picker shuts.
    assert.equal(findActiveTrigger('@memory pref ', 13), null);
    assert.equal(findActiveTrigger('@memory pref next', 17), null);
});

test('findActiveTrigger — only inspects text up to the cursor', () => {
    // Cursor sits before the @memory, so no trigger is open.
    assert.equal(findActiveTrigger('hello @memory pref', 5), null);
});

test('findActiveTrigger — picks the most recent @memory when several exist', () => {
    const t = findActiveTrigger('see @memory foo and now @memory ba', 34);
    assert.ok(t);
    assert.equal(t.query, 'ba');
    assert.equal(t.start, 24);
});

test('findActiveTrigger — clamps cursor to text length', () => {
    const t = findActiveTrigger('@memory', 999);
    assert.ok(t);
    assert.equal(t.end, 7);
});

test('findActiveTrigger — picks up multi-character keys without rejection', () => {
    // The filter substring may include `:`, `-`, `.`, etc. — only whitespace closes it.
    const t = findActiveTrigger('@memory api-key.foo', 19);
    assert.ok(t);
    assert.equal(t.query, 'api-key.foo');
});

/* -------------------------------------------------------------------------- */
/* filterMemories                                                             */
/* -------------------------------------------------------------------------- */

const SAMPLE = [
    { id: '1', scope: 'user', key: 'preferred_editor', value: 'vim',           updated_at: 1000 },
    { id: '2', scope: 'user', key: 'preferred_theme',  value: 'oneDark',       updated_at: 2000 },
    { id: '3', scope: 'workspace', key: 'project_owner', value: 'Jeff',        updated_at: 3000 },
    { id: '4', scope: 'user', key: 'venice_api_key',   value: 'sk-***',        updated_at: 1500 },
    { id: '5', scope: 'user', key: 'last_project',     value: { name: 'memo' },updated_at: 2500 },
];

test('filterMemories — empty array on bad input', () => {
    assert.deepEqual(filterMemories(null, ''), []);
    assert.deepEqual(filterMemories(undefined, 'x'), []);
});

test('filterMemories — empty query returns most-recent first up to limit', () => {
    const out = filterMemories(SAMPLE, '', 3);
    assert.equal(out.length, 3);
    assert.equal(out[0].id, '3');  // 3000
    assert.equal(out[1].id, '5');  // 2500
    assert.equal(out[2].id, '2');  // 2000
});

test('filterMemories — startsWith match ranks above contains match', () => {
    const out = filterMemories(SAMPLE, 'pref', 8);
    assert.equal(out.length, 2);
    // Both keys start with `pref` (score 100) — tiebreak by updated_at desc
    assert.equal(out[0].id, '2');
    assert.equal(out[1].id, '1');
});

test('filterMemories — substring on key still matches', () => {
    const out = filterMemories(SAMPLE, 'editor', 8);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, '1');
});

test('filterMemories — value-based match ranks below key matches', () => {
    // `vim` only appears in record 1's value
    const out = filterMemories(SAMPLE, 'vim', 8);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, '1');
});

test('filterMemories — case-insensitive', () => {
    const out = filterMemories(SAMPLE, 'PREF', 8);
    assert.equal(out.length, 2);
    assert.ok(out.every((m) => m.key.includes('pref')));
});

test('filterMemories — caps results at the requested limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
        id: String(i),
        scope: 'user',
        key: `pref_${i}`,
        value: i,
        updated_at: i,
    }));
    const out = filterMemories(many, 'pref', 5);
    assert.equal(out.length, 5);
});

test('filterMemories — drops null/undefined entries', () => {
    const out = filterMemories([null, undefined, ...SAMPLE], 'pref', 8);
    assert.equal(out.length, 2);
});

/* -------------------------------------------------------------------------- */
/* formatCitation + applyCitation                                             */
/* -------------------------------------------------------------------------- */

test('formatCitation — wraps key in [memory:KEY]', () => {
    assert.equal(formatCitation('preferred_editor'), '[memory:preferred_editor]');
});

test('formatCitation — empty key returns empty string', () => {
    assert.equal(formatCitation(''), '');
    assert.equal(formatCitation(null), '');
});

test('applyCitation — replaces the trigger range with the citation + space', () => {
    const text = 'Hi @memory pref!';
    const trigger = { start: 3, end: 15, query: 'pref' };
    // Note: trigger.end is the position right after the user-typed `pref` substring.
    const result = applyCitation(text, trigger, 'preferred_editor');
    assert.equal(result.text, 'Hi [memory:preferred_editor] !');
    // Cursor lands right after the inserted space.
    assert.equal(result.cursor, 'Hi [memory:preferred_editor] '.length);
});

test('applyCitation — works at start of text', () => {
    const text = '@memory';
    const trigger = { start: 0, end: 7, query: '' };
    const result = applyCitation(text, trigger, 'foo');
    assert.equal(result.text, '[memory:foo] ');
    assert.equal(result.cursor, '[memory:foo] '.length);
});

test('applyCitation — preserves text after the trigger', () => {
    const text = 'pre @memory pr suffix';
    const trigger = { start: 4, end: 14, query: 'pr' };
    const result = applyCitation(text, trigger, 'profile');
    assert.equal(result.text, 'pre [memory:profile]  suffix');
});

test('applyCitation — null trigger leaves text untouched, cursor at end', () => {
    const text = 'no trigger here';
    const result = applyCitation(text, null, 'x');
    assert.equal(result.text, text);
    assert.equal(result.cursor, text.length);
});

test('applyCitation — empty key collapses to no insertion', () => {
    const text = '@memory';
    const trigger = { start: 0, end: 7, query: '' };
    const result = applyCitation(text, trigger, '');
    assert.equal(result.text, text);
    assert.equal(result.cursor, 7);
});
