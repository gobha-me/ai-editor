/**
 * Manager ledger-wiring tests (1.15.0 / Task Ledger Phase 1).
 *
 * The full RetrievalManager (`js/intelligence/retrieval/manager.js`) imports
 * browser-bound modules and is not node-importable, so this test focuses on
 * the node-importable rollup helper. The contract under test:
 *
 *   `find_relevant_files`'s file rollup MUST suppress chunks whose ids
 *   carry the reserved `ledger_marker:` namespace, otherwise the synthetic
 *   marker `source_uri="ledger://<turn>"` would surface as a bogus file
 *   path in the LLM-tool result.
 *
 * Pure node test on `manager-helpers.js#rollupToFiles`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rollupToFiles } from '../js/intelligence/retrieval/manager-helpers.js';

function makeRealChunk(id, sourceUri, score = 0.7) {
    return {
        id,
        collection: 'workspace_code',
        content: 'real content',
        tokens: 100,
        metadata: {
            source_uri: sourceUri,
            content_type: 'code',
            created_at: 0,
            updated_at: 0,
            content_hash: 'abc',
            structural: null,
            custom: {},
        },
        provenance: {
            source_uri: sourceUri,
            byte_range: null,
            line_range: null,
            retrieved_by: 'semantic',
            score,
            score_kind: 'cosine',
        },
        embedding: null,
    };
}

function makeMarkerChunk(originalId, turnId, priorTurnId) {
    return {
        id: `ledger_marker:${originalId}:${turnId}`,
        collection: 'workspace_code',
        content: `[Already admitted: ${originalId} — see turn ${priorTurnId}; ~123 tokens]`,
        tokens: 20,
        metadata: {
            source_uri: `ledger://${priorTurnId}`,
            content_type: 'code',
            created_at: 0,
            updated_at: 0,
            content_hash: 'abc',
            structural: null,
            custom: { suppressed_chunk_id: originalId, prior_turn_id: priorTurnId },
        },
        provenance: {
            source_uri: `ledger://${priorTurnId}`,
            byte_range: null,
            line_range: null,
            retrieved_by: 'ledger_marker',
            score: 0,
            score_kind: 'structural_expanded',
        },
        embedding: null,
    };
}

function buildResult(chunks) {
    /** @type {{ [k: string]: any }} */
    const chunksById = {};
    for (const c of chunks) chunksById[c.id] = c;
    return {
        blocks: [{
            kind: 'retrieved',
            content: '',
            tokens: 0,
            chunks: chunks.map(c => c.id),
        }],
        used_tokens: 0,
        chunks_by_id: chunksById,
        diagnostics: {},
    };
}

test('rollupToFiles excludes ledger_marker chunks; only real paths surface', () => {
    const real = makeRealChunk('chunk_a', 'src/auth/middleware.ts', 0.9);
    const marker = makeMarkerChunk('chunk_b', 'turn_5', 'turn_3');
    const result = buildResult([real, marker]);
    const files = rollupToFiles(result, 5);
    assert.equal(files.length, 1, 'only one path returned (marker filtered)');
    assert.equal(files[0].path, 'src/auth/middleware.ts');
    // Belt-and-braces: no entry with the ledger:// scheme.
    for (const f of files) {
        assert.ok(!f.path.startsWith('ledger://'), `unexpected ledger path: ${f.path}`);
    }
});

test('rollupToFiles preserves real chunks when only markers accompany them', () => {
    const real = makeRealChunk('chunk_a', 'src/util.js', 0.5);
    const marker1 = makeMarkerChunk('chunk_b', 'turn_5', 'turn_3');
    const marker2 = makeMarkerChunk('chunk_c', 'turn_5', 'turn_2');
    const result = buildResult([marker1, real, marker2]);
    const files = rollupToFiles(result, 5);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'src/util.js');
});

test('rollupToFiles negative regression: without filter, marker would surface', () => {
    // Sanity check — the filter is what prevents marker pollution. If
    // rollupToFiles is ever rewritten without the filter, this test fails:
    // we'd see two paths and one of them would be `ledger://...`.
    const real = makeRealChunk('chunk_a', 'src/auth.ts');
    const marker = makeMarkerChunk('chunk_b', 'turn_x', 'turn_y');
    const files = rollupToFiles(buildResult([real, marker]), 5);
    assert.ok(
        !files.some(f => f.path.startsWith('ledger://')),
        'ledger_marker chunks must NOT surface as file paths in find_relevant_files results',
    );
});

test('rollupToFiles returns empty when only markers are present', () => {
    const m1 = makeMarkerChunk('a', 'turn_5', 'turn_3');
    const m2 = makeMarkerChunk('b', 'turn_5', 'turn_2');
    const files = rollupToFiles(buildResult([m1, m2]), 5);
    assert.deepEqual(files, []);
});
