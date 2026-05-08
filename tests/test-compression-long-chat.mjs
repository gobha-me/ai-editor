/**
 * Long-chat regression for the 1.17.0 profile-keyed compression
 * resolver. Per ROADMAP §"2.X path" (1.17.0 row): *"Needs long-chat
 * regression test before tagging."*
 *
 * Drives `Compactor.compress` over a synthetic 30-turn history under
 * both resolved configs (coder.v1 and chat.v1) and asserts the
 * `preserve_recent` window from the resolved profile actually shapes
 * eviction:
 *
 *   - chat.v1 → `preserve_recent: 4`  (Rule 5 only)
 *   - coder.v1 → `preserve_recent: 24` (Rules 1, 2, 5)
 *
 * The two corner cases the chat-side reconciliation (24 → 4) must
 * survive:
 *   1. A subsumable read pair *inside* the trailing window must be
 *      kept under coder.v1 (preserve_recent invariant beats Rule 1).
 *   2. A subsumable read pair *outside* the trailing window can be
 *      evicted under coder.v1 (Rule 1 fires).
 *
 * Pure: no DOM, no Storage, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveCompressionConfig } from '../js/profiles/index.js';
import { compress } from '../js/intelligence/compression/index.js';

let _seq = 0;
function resetSeq() { _seq = 0; }

function mkTurn(role, content, metadata, tokens) {
    const id = `T${_seq++}`;
    const t = tokens != null ? tokens : Math.max(1, Math.ceil((content || '').length / 3.5));
    return {
        id,
        role,
        content: content || '',
        tokens: t,
        timestamp: _seq,
        metadata: metadata || {},
    };
}
function mkUser(text)  { return mkTurn('user', text, {}, 50); }
function mkAsst(text)  { return mkTurn('assistant', text, {}, 50); }
function mkRead(path, range) {
    return mkTurn('tool_result', `read ${path}`, {
        tool_name: 'read_lines',
        file_ops: [{ path, op: 'read', range, content_hash: null }],
    }, 100);
}

/**
 * Build a 30-turn alternating history (user → asst → user → ...) with
 * a subsumable read pair planted at the requested indices. Per Rule 1
 * (Subsumption), an *earlier* narrower read is dropped when a *later*
 * read has a range that contains it — so plant the narrower read at
 * the earlier index and the wider read at the later index.
 *
 * @param {number} subsumedIdx  0-based index of the narrower (earlier) read
 * @param {number} subsumerIdx  0-based index of the wider (later) read; > subsumedIdx
 */
function buildHistoryWithSubsumablePair(subsumedIdx, subsumerIdx) {
    resetSeq();
    /** @type {any[]} */
    const history = [];
    for (let i = 0; i < 30; i++) {
        if (i === subsumedIdx) {
            history.push(mkRead('foo.js', [10, 50]));
        } else if (i === subsumerIdx) {
            history.push(mkRead('foo.js', [1, 100]));
        } else {
            history.push(i % 2 === 0 ? mkUser(`u${i}`) : mkAsst(`a${i}`));
        }
    }
    return history;
}

test('chat.v1 resolved config carries preserve_recent: 4', () => {
    const cfg = resolveCompressionConfig('chat.v1');
    assert.equal(cfg.preserve_recent, 4);
    assert.equal(cfg.profileName, 'chat.v1');
});

test('coder.v1 resolved config carries preserve_recent: 24', () => {
    const cfg = resolveCompressionConfig('coder.v1');
    assert.equal(cfg.preserve_recent, 24);
    assert.equal(cfg.profileName, 'coder.v1');
});

test('chat.v1 over 30-turn history: trailing 4 turns are preserved verbatim', async () => {
    const cfg = resolveCompressionConfig('chat.v1');
    resetSeq();
    const history = [];
    for (let i = 0; i < 30; i++) {
        history.push(i % 2 === 0 ? mkUser(`u${i}`) : mkAsst(`a${i}`));
    }
    const trailingIds = history.slice(-cfg.preserve_recent).map(t => t.id);

    const result = await compress({
        history,
        rules: cfg.rules,
        preserve_recent: cfg.preserve_recent,
        summarizer: null,
        budget_tokens: Number.POSITIVE_INFINITY,
    });

    assert.deepEqual(result.diagnostics.rule_errors, []);
    const survivingIds = result.history.map(t => t.id);
    for (const id of trailingIds) {
        assert.ok(survivingIds.includes(id), `trailing turn ${id} must be in surviving history`);
    }
    // The last 4 of surviving must equal the last 4 of input, in order.
    assert.deepEqual(survivingIds.slice(-cfg.preserve_recent), trailingIds);
});

test('coder.v1: subsumed read OUTSIDE the trailing-24 window IS evicted (Rule 1 fires)', async () => {
    const cfg = resolveCompressionConfig('coder.v1');
    // preserveStart = 30 - 24 = 6 → indices 0..5 are eviction-eligible.
    const subsumedIdx = 1;
    const subsumerIdx = 3;
    const history = buildHistoryWithSubsumablePair(subsumedIdx, subsumerIdx);
    const subsumedId = history[subsumedIdx].id;

    const result = await compress({
        history,
        rules: cfg.rules,
        preserve_recent: cfg.preserve_recent,
        summarizer: null,
        budget_tokens: Number.POSITIVE_INFINITY,
    });

    assert.deepEqual(result.diagnostics.rule_errors, []);
    const survivingIds = result.history.map(t => t.id);
    assert.ok(!survivingIds.includes(subsumedId), 'subsumed read outside protected window should be evicted');
});

test('coder.v1: subsumed read INSIDE the trailing-24 window is KEPT (preserve_recent beats Rule 1)', async () => {
    const cfg = resolveCompressionConfig('coder.v1');
    // preserveStart = 6 → planting both reads at indices 25 and 27 puts
    // them inside the protected window.
    const subsumedIdx = 25;
    const subsumerIdx = 27;
    const history = buildHistoryWithSubsumablePair(subsumedIdx, subsumerIdx);
    const subsumedId = history[subsumedIdx].id;

    const result = await compress({
        history,
        rules: cfg.rules,
        preserve_recent: cfg.preserve_recent,
        summarizer: null,
        budget_tokens: Number.POSITIVE_INFINITY,
    });

    assert.deepEqual(result.diagnostics.rule_errors, []);
    const survivingIds = result.history.map(t => t.id);
    assert.ok(survivingIds.includes(subsumedId), 'subsumed read inside protected window must be kept');
});

test('chat.v1 over 30-turn history with no budget pressure: Rule 5 does not fire (no eviction)', async () => {
    // Rule 5 (Summarization) needs budget pressure to evict. With
    // budget_tokens: Infinity (matching js/chat/compactor-integration.js)
    // chat surfaces are effectively a pass-through today. The
    // preserve_recent: 4 reconciliation matters when the future
    // tighter Rule 5 integration (ROADMAP §1.2.4) ships — this test
    // pins today's behavior so that future change is visible.
    const cfg = resolveCompressionConfig('chat.v1');
    resetSeq();
    const history = [];
    for (let i = 0; i < 30; i++) {
        history.push(i % 2 === 0 ? mkUser(`u${i}`) : mkAsst(`a${i}`));
    }

    const result = await compress({
        history,
        rules: cfg.rules,
        preserve_recent: cfg.preserve_recent,
        summarizer: null,
        budget_tokens: Number.POSITIVE_INFINITY,
    });

    assert.equal(result.history.length, 30);
    assert.deepEqual(result.diagnostics.evicted_ids, []);
    assert.deepEqual(result.diagnostics.rule_errors, []);
});
