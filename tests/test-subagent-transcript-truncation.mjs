/**
 * Tests for the 12K-per-turn truncation applied to sub-agent
 * transcripts on persistence. The mitigation is a hard cap on
 * retained tool_result content). Slice 2 of github#24 Phase 1 (2.49.0).
 *
 * Pins:
 *   - A `tool_result` turn larger than 12K chars truncates to ≤12K +
 *     truncation marker on persistence.
 *   - Turns ≤12K pass through unchanged.
 *   - Non-tool turns (system/user/assistant) pass through unchanged
 *     regardless of size — the truncation is a tool_result-specific
 *     bound.
 *   - The live State.subagents.transcripts slot is NOT mutated by the
 *     serializer (the transcript panel reads from the live slot;
 *     truncation only applies to the persisted payload).
 *
 * Runs under `node --test`. Imports the persistence helper exported
 * for tests from `js/chat/conversations.js`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    _serializeSubAgentTranscripts,
    _truncateTranscriptForPersistence,
    SUBAGENT_TRANSCRIPT_TURN_LIMIT,
} from '../js/chat/conversations.js';

const LIMIT = SUBAGENT_TRANSCRIPT_TURN_LIMIT;
const huge = 'x'.repeat(LIMIT + 5000);
const small = 'x'.repeat(LIMIT - 100);

test('_truncateTranscriptForPersistence: tool turn >12K is truncated + marker', () => {
    const transcript = {
        id: 't-1',
        messages: [
            { role: 'system', content: 'sub-agent sys' },
            { role: 'user', content: 'find foo' },
            { role: 'assistant', content: 'calling read_file' },
            { role: 'tool', tool_call_id: 'tc-1', content: huge },
        ],
    };
    const out = _truncateTranscriptForPersistence(transcript);
    const toolMsg = out.messages[3];
    assert.ok(toolMsg.content.length <= LIMIT + 200, // 200 = marker headroom
        `tool content should be ≤${LIMIT} + marker (got ${toolMsg.content.length})`);
    assert.ok(toolMsg.content.includes('truncated for persistence'),
        'truncation marker present');
});

test('_truncateTranscriptForPersistence: tool turn ≤12K passes through unchanged', () => {
    const transcript = {
        id: 't-2',
        messages: [
            { role: 'tool', tool_call_id: 'tc-1', content: small },
        ],
    };
    const out = _truncateTranscriptForPersistence(transcript);
    assert.equal(out.messages[0].content, small, 'unchanged content');
    assert.equal(out.messages[0].content.length, small.length);
});

test('_truncateTranscriptForPersistence: non-tool turns pass through regardless of size', () => {
    // A huge assistant message (e.g. an extra-verbose summary) should
    // not be truncated — the bound is tool_result-specific. The
    // assistant's final answer is the load-bearing payload the parent
    // reads; truncating it would silently corrupt the summary.
    const transcript = {
        id: 't-3',
        messages: [
            { role: 'system', content: huge },
            { role: 'user', content: huge },
            { role: 'assistant', content: huge },
        ],
    };
    const out = _truncateTranscriptForPersistence(transcript);
    assert.equal(out.messages[0].content, huge, 'system unchanged');
    assert.equal(out.messages[1].content, huge, 'user unchanged');
    assert.equal(out.messages[2].content, huge, 'assistant unchanged');
});

test('_serializeSubAgentTranscripts: serializes the full transcripts map', () => {
    const live = {
        't-a': {
            id: 't-a',
            messages: [
                { role: 'tool', content: huge },
            ],
            cost: { tokens: 100, dollars: 0.01, rounds: 1 },
        },
        't-b': {
            id: 't-b',
            messages: [
                { role: 'tool', content: small },
            ],
        },
    };
    const out = _serializeSubAgentTranscripts(live);
    assert.deepEqual(Object.keys(out).sort(), ['t-a', 't-b']);
    assert.ok(out['t-a'].messages[0].content.length <= LIMIT + 200);
    assert.equal(out['t-b'].messages[0].content, small, 't-b unchanged');
});

test('_serializeSubAgentTranscripts: live slot is NOT mutated', () => {
    // The transcript panel reads from the live State.subagents.transcripts
    // slot; if persistence truncated in place, the panel would lose
    // content. Truncation must produce a copy.
    const live = {
        't-c': {
            id: 't-c',
            messages: [
                { role: 'tool', content: huge },
            ],
        },
    };
    const liveContentBefore = live['t-c'].messages[0].content;
    _serializeSubAgentTranscripts(live);
    assert.equal(live['t-c'].messages[0].content, liveContentBefore,
        'live slot must be unchanged');
    assert.equal(live['t-c'].messages[0].content.length, huge.length);
});

test('_serializeSubAgentTranscripts: empty / null input → empty object', () => {
    assert.deepEqual(_serializeSubAgentTranscripts({}), {});
    assert.deepEqual(_serializeSubAgentTranscripts(null), {});
    assert.deepEqual(_serializeSubAgentTranscripts(undefined), {});
});

test('_truncateTranscriptForPersistence: null/undefined inputs are safe', () => {
    assert.equal(_truncateTranscriptForPersistence(null), null);
    assert.equal(_truncateTranscriptForPersistence(undefined), undefined);
});
