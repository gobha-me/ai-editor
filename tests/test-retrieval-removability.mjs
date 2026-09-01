/**
 * Removability check for 1.15.0 / Task Ledger Phase 1.
 *
 * Markers replacing re-pasted chunks are the intended user-visible effect.
 * Under the removability protocol, every "User-visible:
 * Yes" slice gets an explicit regression test that pins the visible
 * change against the pre-slice behavior.
 *
 * This file is that pin. Two arms over the same fixture:
 *
 *   - **Arm 1 (pre-1.15.0 simulation).** Caller passes `task_ledger: null`,
 *     replicating the production wiring as it existed before this slice.
 *     Two back-to-back compose() calls with the same query produce
 *     identical content (chunk text, not a marker), and `diagnostics`
 *     reports `ledger_consulted: false` / `ledger_suppressions: 0`.
 *
 *   - **Arm 2 (post-1.15.0).** Caller passes a live ledger. The first
 *     compose() seeds the admissions array; the second compose() emits a
 *     marker for the re-touched chunk and `diagnostics` reports
 *     `ledger_consulted: true` / `ledger_suppressions: 1`.
 *
 * The arms diff *only* on the marker. Any future change that breaks
 * Arm 1 (e.g. ledger consultation accidentally engaged when ledger is
 * null) or Arm 2 (consultation regression) trips this test. The
 * "removability" claim is that arm 1's behavior is achievable by
 * removing the slice — i.e. nulling the production ledger wiring
 * (`js/intelligence/retrieval/manager.js#findRelevantFiles`) reverts
 * to arm 1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compose } from '../js/intelligence/retrieval/composer.js';
import { createTaskLedger } from '../js/profiles/task-ledger.js';

let nextId = 0;
const cid = () => `chunk_${(nextId++).toString(16).padStart(8, '0')}`;

function makeChunk(content, overrides = {}) {
    const id = overrides.id || cid();
    return {
        id,
        collection: 'docs',
        content,
        tokens: overrides.tokens ?? Math.max(1, Math.ceil(content.length / 4)),
        metadata: {
            source_uri: `docs/${id}.md`,
            content_type: 'prose',
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
            content_hash: 'deadbeef',
            structural: null,
            custom: {},
        },
        provenance: {
            source_uri: `docs/${id}.md`,
            byte_range: [0, content.length],
            line_range: null,
            retrieved_by: 'semantic',
            score: 0.7,
            score_kind: 'cosine',
        },
        embedding: null,
    };
}

function fakeStrategy(name, chunks) {
    return {
        name,
        applies_to: () => ({ score: 1, reason: 'applicability=1' }),
        retrieve: async (_req, quota) => chunks.slice(0, quota),
    };
}

function buildReq(taskLedger, turnId = 'turn_1') {
    return {
        task: '',
        query: 'authentication middleware',
        collections: ['docs'],
        budget: { total_tokens: 8000, system_reserve: 800, output_reserve: 800, history_reserve: 1000 },
        history: null,
        filters: null,
        strategy_hints: null,
        priority_pins: null,
        task_ledger: taskLedger,
        turn_id: turnId,
    };
}

const noPinsGetter = async () => null;

test('removability arm 1: task_ledger=null → both calls return chunk content, no marker, ledger_consulted=false', async () => {
    const chunk = makeChunk('the auth middleware checks the bearer token', {
        tokens: 50,
        id: 'chunk_authmw_arm1',
    });
    const strategies = [fakeStrategy('semantic', [chunk])];
    const deps = { strategies, getChunkByID: noPinsGetter };

    // Two sequential compose() calls — identical query, ledger=null both times.
    const r1 = await compose(buildReq(null, 'turn_1'), deps);
    const r2 = await compose(buildReq(null, 'turn_2'), deps);

    // Both calls return the chunk verbatim — no marker substitution.
    assert.ok(r1.chunks_by_id[chunk.id], 'arm 1 / call 1 keeps the original chunk');
    assert.ok(r2.chunks_by_id[chunk.id], 'arm 1 / call 2 keeps the original chunk');
    // No marker chunk should appear.
    for (const id of Object.keys(r1.chunks_by_id)) {
        assert.ok(!id.startsWith('ledger_marker:'), 'arm 1 / call 1 must not emit a marker');
    }
    for (const id of Object.keys(r2.chunks_by_id)) {
        assert.ok(!id.startsWith('ledger_marker:'), 'arm 1 / call 2 must not emit a marker');
    }
    // Diagnostics consistently report no consultation.
    assert.equal(r1.diagnostics.ledger_consulted, false);
    assert.equal(r1.diagnostics.ledger_suppressions, 0);
    assert.equal(r2.diagnostics.ledger_consulted, false);
    assert.equal(r2.diagnostics.ledger_suppressions, 0);
});

test('removability arm 2: live ledger → call 2 emits marker + ledger_suppressions=1', async () => {
    const chunk = makeChunk('the auth middleware checks the bearer token', {
        tokens: 50,
        id: 'chunk_authmw_arm2',
    });
    const strategies = [fakeStrategy('semantic', [chunk])];
    const deps = { strategies, getChunkByID: noPinsGetter };

    const ledger = createTaskLedger({ taskId: 'conv_x', surface: 'coder.v1' });

    const r1 = await compose(buildReq(ledger, 'turn_1'), deps);
    const r2 = await compose(buildReq(ledger, 'turn_2'), deps, { now: Date.now() });

    // Call 1: cold candidate → admitted, no suppression.
    assert.equal(r1.diagnostics.ledger_consulted, true);
    assert.equal(r1.diagnostics.ledger_suppressions, 0);
    assert.ok(r1.chunks_by_id[chunk.id]);
    assert.equal(ledger.admissions.length, 1);

    // Call 2: prior admission exists with identical query → suppressed.
    assert.equal(r2.diagnostics.ledger_consulted, true);
    assert.equal(r2.diagnostics.ledger_suppressions, 1);
    // Original chunk no longer in chunks_by_id; a marker is.
    const ids = Object.keys(r2.chunks_by_id);
    const markerId = ids.find(id => id.startsWith('ledger_marker:'));
    assert.ok(markerId, `expected a marker chunk in arm 2 / call 2, got ${ids.join(',')}`);
    const marker = r2.chunks_by_id[markerId];
    // The marker references the original chunk's id and prior turn_id, and
    // its content includes the "; ~{tokens} tokens" suffix per DESIGN line 216.
    assert.match(marker.content, new RegExp(`Already admitted: ${chunk.id} — see turn turn_1; ~50 tokens`));
    assert.equal(marker.tokens, 20);
    assert.equal(marker.provenance.retrieved_by, 'ledger_marker');
    // Exclusion record was written.
    assert.equal(ledger.exclusions.length, 1);
    assert.equal(ledger.exclusions[0].chunk_id, chunk.id);
    assert.equal(ledger.exclusions[0].reason, 'already_admitted_low_novelty');
});

test('removability diff: arm 1 vs arm 2 differ only on marker emission, not on diagnostics shape', async () => {
    const chunk = makeChunk('shared content', { tokens: 40, id: 'chunk_diff' });
    const strategies = [fakeStrategy('semantic', [chunk])];
    const deps = { strategies, getChunkByID: noPinsGetter };

    const ledger = createTaskLedger({ taskId: 'conv_y', surface: 'coder.v1' });

    const arm1Call1 = await compose(buildReq(null, 'turn_a'), deps);
    const arm1Call2 = await compose(buildReq(null, 'turn_b'), deps);
    const arm2Call1 = await compose(buildReq(ledger, 'turn_a'), deps);
    const arm2Call2 = await compose(buildReq(ledger, 'turn_b'), deps);

    // Diagnostics surface the same keys in both arms.
    const keys = (d) => Object.keys(d).sort();
    assert.deepEqual(keys(arm1Call1.diagnostics), keys(arm2Call1.diagnostics));
    assert.deepEqual(keys(arm1Call2.diagnostics), keys(arm2Call2.diagnostics));

    // Arm 1 / call 2 returns the chunk; arm 2 / call 2 returns a marker.
    // This is the ONLY structural diff — the visible feature of the slice.
    assert.ok(arm1Call2.chunks_by_id[chunk.id], 'arm 1 / call 2 still has chunk');
    assert.ok(!arm2Call2.chunks_by_id[chunk.id], 'arm 2 / call 2 dropped chunk in favor of marker');
    const arm2MarkerId = Object.keys(arm2Call2.chunks_by_id).find(id => id.startsWith('ledger_marker:'));
    assert.ok(arm2MarkerId);
});
