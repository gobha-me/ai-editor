/**
 * Parallel-execution ingest walker tests (1.5.0).
 *
 * Covers `js/intelligence/retrieval/walker.js` — the bounded-concurrency
 * harness layered over the 1.4.23 single-source `createIngestController`.
 * Each test() block focused on a single invariant, mirroring the
 * sibling test files (`test-retrieval-ingest-controller.mjs`,
 * `test-retrieval-store.mjs`, `test-retrieval-embedder.mjs`).
 *
 * Pure-data, no DOM / State / network — runs under `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createIngestWalker } from '../js/intelligence/retrieval/walker.js';

/* ---------------- Fixture builders ---------------- */

/**
 * Build a fake `IngestController` for the walker to drive. Each URI looked
 * up in `byUri` returns the configured `IngestResult` (or, if listed in
 * `throwFor`, throws). `delayFor` simulates async work so the concurrency
 * watermark observably tracks in-flight calls. The fake records call
 * order, in-flight counts, and a watermark (peak concurrent calls) so
 * concurrency-cap tests can assert directly.
 *
 * @param {Object} [options]
 * @param {Object<string, import('../js/intelligence/retrieval/contracts.js').IngestResult>} [options.byUri]
 * @param {Object<string, Error>} [options.throwFor]
 * @param {Object<string, number>} [options.delayFor]
 * @param {number} [options.defaultDelay]
 */
function makeFakeController({ byUri = {}, throwFor = {}, delayFor = {}, defaultDelay = 0 } = {}) {
    const calls = [];
    let inFlight = 0;
    let watermark = 0;
    let inFlightHistory = [];

    /**
     * @param {string} uri
     * @returns {import('../js/intelligence/retrieval/contracts.js').IngestResult}
     */
    function defaultResult(uri) {
        return {
            source_uri: uri,
            status: 'ingested',
            content_hash: 'h_' + uri,
            added: 1,
            removed: 0,
            embedded: 1,
            embed_failures: 0,
            error: null,
        };
    }

    const ingest = async (uri) => {
        calls.push(uri);
        inFlight += 1;
        if (inFlight > watermark) watermark = inFlight;
        inFlightHistory.push(inFlight);

        const delay = uri in delayFor ? delayFor[uri] : defaultDelay;
        if (delay > 0) {
            await new Promise((r) => setTimeout(r, delay));
        }

        try {
            if (uri in throwFor) {
                throw throwFor[uri];
            }
            return uri in byUri ? byUri[uri] : defaultResult(uri);
        } finally {
            inFlight -= 1;
        }
    };

    return {
        controller: { ingest, stats: () => ({ calls: calls.length }) },
        get calls() {
            return calls;
        },
        get watermark() {
            return watermark;
        },
        get inFlight() {
            return inFlight;
        },
        get inFlightHistory() {
            return inFlightHistory;
        },
    };
}

/**
 * Build an explicit `IngestResult` payload for fixture inputs.
 *
 * @param {string} uri
 * @param {Partial<import('../js/intelligence/retrieval/contracts.js').IngestResult>} overrides
 * @returns {import('../js/intelligence/retrieval/contracts.js').IngestResult}
 */
function ingestResult(uri, overrides = {}) {
    return {
        source_uri: uri,
        status: 'ingested',
        content_hash: 'h_' + uri,
        added: 1,
        removed: 0,
        embedded: 1,
        embed_failures: 0,
        error: null,
        ...overrides,
    };
}

/* ============================================================
 * Argument validation (5 cases)
 * ============================================================ */

test('createIngestWalker throws when options is missing or null', () => {
    assert.throws(() => createIngestWalker(), /options must be an object/);
    assert.throws(() => createIngestWalker(null), /options must be an object/);
    assert.throws(() => createIngestWalker(undefined), /options must be an object/);
});

test('createIngestWalker throws when controller is missing or invalid', () => {
    assert.throws(() => createIngestWalker({}), /controller must expose ingest/);
    assert.throws(
        () => createIngestWalker({ controller: {} }),
        /controller must expose ingest/,
    );
    assert.throws(
        () => createIngestWalker({ controller: { ingest: 'not a function' } }),
        /controller must expose ingest/,
    );
});

test('createIngestWalker throws when concurrency is invalid', () => {
    const { controller } = makeFakeController();
    assert.throws(
        () => createIngestWalker({ controller, concurrency: 0 }),
        /concurrency must be a positive integer/,
    );
    assert.throws(
        () => createIngestWalker({ controller, concurrency: -1 }),
        /concurrency must be a positive integer/,
    );
    assert.throws(
        () => createIngestWalker({ controller, concurrency: 1.5 }),
        /concurrency must be a positive integer/,
    );
    assert.throws(
        () => createIngestWalker({ controller, concurrency: NaN }),
        /concurrency must be a positive integer/,
    );
});

test('createIngestWalker throws when onProgress or now is non-function', () => {
    const { controller } = makeFakeController();
    assert.throws(
        () => createIngestWalker({ controller, onProgress: 'not a function' }),
        /onProgress must be a function/,
    );
    assert.throws(
        () => createIngestWalker({ controller, now: 42 }),
        /now must be a function/,
    );
});

test('createIngestWalker returns { walk, stats } both functions', () => {
    const { controller } = makeFakeController();
    const walker = createIngestWalker({ controller });
    assert.equal(typeof walker.walk, 'function');
    assert.equal(typeof walker.stats, 'function');
});

/* ============================================================
 * Empty / trivial inputs (3 cases)
 * ============================================================ */

test('walk([]) returns empty WalkResult', async () => {
    const { controller } = makeFakeController();
    const walker = createIngestWalker({ controller });
    const result = await walker.walk([]);
    assert.equal(result.total, 0);
    assert.deepEqual(result.results, []);
    assert.equal(result.aborted, false);
    assert.equal(result.ingested, 0);
    assert.equal(result.noop, 0);
    assert.equal(result.failed, 0);
    assert.equal(result.chunksAdded, 0);
    assert.equal(result.chunksRemoved, 0);
    assert.equal(result.embedFailures, 0);
    assert.ok(result.durationMs >= 0);
});

test('walk(empty AsyncIterable) returns empty WalkResult', async () => {
    const { controller } = makeFakeController();
    const walker = createIngestWalker({ controller });
    async function* empty() {
        // yields nothing
    }
    const result = await walker.walk(empty());
    assert.equal(result.total, 0);
    assert.deepEqual(result.results, []);
    assert.equal(result.aborted, false);
});

test('walk() rejects non-iterable input with TypeError', async () => {
    const { controller } = makeFakeController();
    const walker = createIngestWalker({ controller });
    await assert.rejects(walker.walk(/** @type {any} */ (null)), /TypeError/);
    await assert.rejects(walker.walk(/** @type {any} */ (123)), /Iterable or AsyncIterable/);
    await assert.rejects(walker.walk(/** @type {any} */ ({})), /Iterable or AsyncIterable/);
});

/* ============================================================
 * Iterable input shapes (3 cases)
 * ============================================================ */

test('walk(Array of 5 URIs) dispatches all 5', async () => {
    const fake = makeFakeController();
    const walker = createIngestWalker({ controller: fake.controller });
    const uris = ['a', 'b', 'c', 'd', 'e'];
    const result = await walker.walk(uris);
    assert.equal(result.total, 5);
    assert.equal(result.results.length, 5);
    assert.equal(fake.calls.length, 5);
    const seenUris = new Set(result.results.map((r) => r.source_uri));
    assert.deepEqual([...seenUris].sort(), [...uris].sort());
});

test('walk(AsyncIterable) yields and walks correctly', async () => {
    const fake = makeFakeController();
    const walker = createIngestWalker({ controller: fake.controller });
    async function* stream() {
        yield 'one';
        yield 'two';
        yield 'three';
    }
    const result = await walker.walk(stream());
    assert.equal(result.total, 3);
    assert.equal(result.results.length, 3);
    const seenUris = new Set(result.results.map((r) => r.source_uri));
    assert.deepEqual([...seenUris].sort(), ['one', 'three', 'two']);
});

test('walk(sync generator / Set) walks via the sync-iterable path', async () => {
    const fake = makeFakeController();
    const walker = createIngestWalker({ controller: fake.controller });
    const uris = new Set(['x', 'y', 'z']);
    const result = await walker.walk(uris);
    assert.equal(result.total, 3);

    // Also test a sync generator
    function* gen() {
        yield 'p';
        yield 'q';
    }
    const result2 = await walker.walk(gen());
    assert.equal(result2.total, 2);
});

/* ============================================================
 * Concurrency cap (3 cases)
 * ============================================================ */

test('walk respects default concurrency = 4', async () => {
    const fake = makeFakeController({ defaultDelay: 25 });
    const walker = createIngestWalker({ controller: fake.controller });
    const uris = Array.from({ length: 10 }, (_, i) => `u${i}`);
    await walker.walk(uris);
    // With 10 sources at 25ms each and default concurrency 4, peak in-flight
    // should be exactly 4.
    assert.equal(fake.watermark, 4);
});

test('walk with concurrency: 1 runs strictly sequential, results in input order', async () => {
    const fake = makeFakeController({ defaultDelay: 5 });
    const walker = createIngestWalker({ controller: fake.controller, concurrency: 1 });
    const uris = ['a', 'b', 'c', 'd'];
    const result = await walker.walk(uris);
    assert.equal(fake.watermark, 1);
    assert.deepEqual(
        result.results.map((r) => r.source_uri),
        uris,
        'concurrency:1 should preserve input order',
    );
});

test('walk with concurrency > sources caps at #sources', async () => {
    const fake = makeFakeController({ defaultDelay: 10 });
    const walker = createIngestWalker({ controller: fake.controller, concurrency: 8 });
    const uris = ['a', 'b', 'c', 'd', 'e'];
    await walker.walk(uris);
    // 5 sources should mean watermark <= 5 (could be <5 if scheduling is uneven,
    // but on most runtimes hits exactly 5; assert <=5 to avoid flakiness).
    assert.ok(fake.watermark <= 5, `watermark ${fake.watermark} should be <= 5`);
    assert.ok(fake.watermark >= 1, `watermark ${fake.watermark} should be >= 1`);
});

/* ============================================================
 * Per-source error isolation (3 cases)
 * ============================================================ */

test('walk over mixed status results aggregates per-source counts', async () => {
    const fake = makeFakeController({
        byUri: {
            a: ingestResult('a', { status: 'ingested', added: 3, removed: 1, embedded: 3 }),
            b: ingestResult('b', { status: 'noop', added: 0, removed: 0, embedded: 0 }),
            c: ingestResult('c', {
                status: 'failed',
                added: 0,
                removed: 0,
                embedded: 0,
                error: new Error('controller-side failed'),
            }),
            d: ingestResult('d', { status: 'ingested', added: 2, removed: 0, embedded: 1, embed_failures: 1 }),
            e: ingestResult('e', { status: 'noop', added: 0, removed: 0, embedded: 0 }),
            f: ingestResult('f', { status: 'ingested', added: 1, removed: 2 }),
        },
    });
    const walker = createIngestWalker({ controller: fake.controller, concurrency: 2 });
    const result = await walker.walk(['a', 'b', 'c', 'd', 'e', 'f']);
    assert.equal(result.total, 6);
    assert.equal(result.ingested, 3);
    assert.equal(result.noop, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.chunksAdded, 6);
    assert.equal(result.chunksRemoved, 3);
    assert.equal(result.embedFailures, 1);
});

test('controller throwing produces a synthesized failed IngestResult', async () => {
    const boom = new Error('unexpected throw');
    const fake = makeFakeController({
        throwFor: { b: boom },
    });
    const walker = createIngestWalker({ controller: fake.controller, concurrency: 1 });
    const result = await walker.walk(['a', 'b', 'c']);
    assert.equal(result.total, 3);
    assert.equal(result.results.length, 3);
    assert.equal(result.failed, 1);
    assert.equal(result.ingested, 2);
    const failed = result.results.find((r) => r.status === 'failed');
    assert.ok(failed, 'walker should synthesize a failed result for the thrower');
    assert.equal(failed.source_uri, 'b');
    assert.equal(failed.error, boom);
    assert.equal(failed.content_hash, null);
    assert.equal(failed.added, 0);
    assert.equal(failed.removed, 0);
    assert.equal(failed.embedded, 0);
    assert.equal(failed.embed_failures, 0);
});

test('walk does not reject when every source returns failed status', async () => {
    const fake = makeFakeController({
        byUri: {
            a: ingestResult('a', { status: 'failed', added: 0, error: new Error('a fail') }),
            b: ingestResult('b', { status: 'failed', added: 0, error: new Error('b fail') }),
            c: ingestResult('c', { status: 'failed', added: 0, error: new Error('c fail') }),
        },
    });
    const walker = createIngestWalker({ controller: fake.controller });
    const result = await walker.walk(['a', 'b', 'c']);
    assert.equal(result.total, 3);
    assert.equal(result.failed, 3);
    assert.equal(result.ingested, 0);
    assert.equal(result.noop, 0);
});

/* ============================================================
 * Aggregation (4 cases)
 * ============================================================ */

test('aggregate sum invariants hold across mixed results', async () => {
    const fake = makeFakeController({
        byUri: {
            a: ingestResult('a', { added: 5, removed: 1, embed_failures: 0 }),
            b: ingestResult('b', { added: 2, removed: 3, embed_failures: 2 }),
            c: ingestResult('c', { added: 0, removed: 0, embed_failures: 0 }),
        },
    });
    const walker = createIngestWalker({ controller: fake.controller });
    const result = await walker.walk(['a', 'b', 'c']);
    const sumAdded = result.results.reduce((a, r) => a + r.added, 0);
    const sumRemoved = result.results.reduce((a, r) => a + r.removed, 0);
    const sumEmbedF = result.results.reduce((a, r) => a + r.embed_failures, 0);
    assert.equal(result.chunksAdded, sumAdded);
    assert.equal(result.chunksRemoved, sumRemoved);
    assert.equal(result.embedFailures, sumEmbedF);
});

test('total === results.length === ingested + noop + failed', async () => {
    const fake = makeFakeController({
        byUri: {
            a: ingestResult('a', { status: 'ingested' }),
            b: ingestResult('b', { status: 'noop' }),
            c: ingestResult('c', { status: 'failed', error: new Error('x') }),
            d: ingestResult('d', { status: 'ingested' }),
        },
    });
    const walker = createIngestWalker({ controller: fake.controller });
    const result = await walker.walk(['a', 'b', 'c', 'd']);
    assert.equal(result.total, 4);
    assert.equal(result.results.length, 4);
    assert.equal(result.ingested + result.noop + result.failed, result.total);
});

test('durationMs uses injected clock and is non-negative', async () => {
    const ticks = [1000, 1250]; // start, end
    let i = 0;
    const now = () => ticks[i++];
    const fake = makeFakeController();
    const walker = createIngestWalker({ controller: fake.controller, now });
    const result = await walker.walk(['a', 'b']);
    assert.equal(result.durationMs, 250);
});

test('stats() accumulates across walks and returns a snapshot clone', async () => {
    const fake = makeFakeController({
        byUri: {
            a: ingestResult('a', { status: 'ingested', added: 2, removed: 0 }),
            b: ingestResult('b', { status: 'noop', added: 0, removed: 0, embedded: 0 }),
        },
    });
    const walker = createIngestWalker({ controller: fake.controller });

    await walker.walk(['a', 'b']);
    const snap1 = walker.stats();
    assert.equal(snap1.walks, 1);
    assert.equal(snap1.sources, 2);
    assert.equal(snap1.ingested, 1);
    assert.equal(snap1.noop, 1);
    assert.equal(snap1.chunksAdded, 2);

    await walker.walk(['a']);
    const snap2 = walker.stats();
    assert.equal(snap2.walks, 2);
    assert.equal(snap2.sources, 3);
    assert.equal(snap2.ingested, 2);
    assert.equal(snap2.noop, 1);

    // Mutating the snapshot must not affect future reads (snapshot clone).
    snap2.walks = 999;
    const snap3 = walker.stats();
    assert.equal(snap3.walks, 2);
});

/* ============================================================
 * Progress callback (3 cases)
 * ============================================================ */

test('onProgress invoked once per completed source with strictly increasing done', async () => {
    const fake = makeFakeController();
    const calls = [];
    const onProgress = (done, total, latestResult) => {
        calls.push({ done, total, uri: latestResult.source_uri });
    };
    const walker = createIngestWalker({ controller: fake.controller, onProgress, concurrency: 1 });
    await walker.walk(['a', 'b', 'c']);
    assert.equal(calls.length, 3);
    assert.deepEqual(
        calls.map((c) => c.done),
        [1, 2, 3],
    );
    assert.deepEqual(
        calls.map((c) => c.total),
        [3, 3, 3],
        'array input passes real total',
    );
});

test('onProgress receives the matching IngestResult per call', async () => {
    const fake = makeFakeController({
        byUri: {
            a: ingestResult('a', { added: 11 }),
            b: ingestResult('b', { added: 22 }),
        },
    });
    const seen = [];
    const onProgress = (_d, _t, r) => seen.push(r);
    const walker = createIngestWalker({ controller: fake.controller, onProgress, concurrency: 1 });
    const result = await walker.walk(['a', 'b']);
    assert.equal(seen.length, 2);
    // Each onProgress call's latestResult must be `===` to a result entry.
    for (const r of seen) {
        assert.ok(result.results.includes(r), 'onProgress latestResult must be in results[]');
    }
    assert.equal(seen[0].added, 11);
    assert.equal(seen[1].added, 22);
});

test('onProgress throwing does not abort the walk', async () => {
    const fake = makeFakeController();
    let invocations = 0;
    const onProgress = () => {
        invocations += 1;
        throw new Error('progress boom');
    };
    const walker = createIngestWalker({ controller: fake.controller, onProgress, concurrency: 1 });
    const result = await walker.walk(['a', 'b', 'c']);
    assert.equal(result.total, 3, 'walk completes despite onProgress throws');
    assert.equal(invocations, 3, 'onProgress called once per source');
});

test('onProgress total === -1 for AsyncIterable input', async () => {
    const fake = makeFakeController();
    const totals = [];
    const onProgress = (_d, t, _r) => totals.push(t);
    const walker = createIngestWalker({ controller: fake.controller, onProgress, concurrency: 1 });
    async function* stream() {
        yield 'a';
        yield 'b';
    }
    await walker.walk(stream());
    assert.deepEqual(totals, [-1, -1]);
});

/* ============================================================
 * Abort (3 cases)
 * ============================================================ */

test('pre-aborted signal returns immediately with total: 0, aborted: true', async () => {
    const fake = makeFakeController();
    const walker = createIngestWalker({ controller: fake.controller });
    const ac = new AbortController();
    ac.abort();
    const result = await walker.walk(['a', 'b', 'c'], { signal: ac.signal });
    assert.equal(result.total, 0);
    assert.equal(result.aborted, true);
    assert.deepEqual(result.results, []);
    assert.equal(fake.calls.length, 0, 'no controller calls when pre-aborted');
});

test('mid-walk abort: in-flight finishes, no new dispatch', async () => {
    // 20 sources, 25ms each, concurrency 2. Abort after first result lands.
    const fake = makeFakeController({ defaultDelay: 25 });
    const ac = new AbortController();
    let firedAbort = false;
    const onProgress = (done, _total, _r) => {
        if (done >= 1 && !firedAbort) {
            firedAbort = true;
            ac.abort();
        }
    };
    const walker = createIngestWalker({
        controller: fake.controller,
        onProgress,
        concurrency: 2,
    });
    const uris = Array.from({ length: 20 }, (_, i) => `u${i}`);
    const result = await walker.walk(uris, { signal: ac.signal });
    assert.equal(result.aborted, true);
    // At least 1 in-flight call finished; the second worker's in-flight
    // call also finishes (per the documented in-flight-finish guarantee).
    // So total is >= 1 and < 20 (no new dispatch after abort).
    assert.ok(result.total >= 1, `total ${result.total} should be >= 1`);
    assert.ok(result.total < 20, `total ${result.total} should be < 20 (abort halted dispatch)`);
});

test('abort with concurrency: 1 stops further dispatch after current source', async () => {
    const fake = makeFakeController({ defaultDelay: 5 });
    const ac = new AbortController();
    const onProgress = (done) => {
        if (done === 1) ac.abort();
    };
    const walker = createIngestWalker({
        controller: fake.controller,
        onProgress,
        concurrency: 1,
    });
    const result = await walker.walk(['a', 'b', 'c', 'd'], { signal: ac.signal });
    assert.equal(result.aborted, true);
    assert.equal(result.total, 1, 'concurrency:1 + abort after first → only the first dispatched');
    assert.deepEqual(
        result.results.map((r) => r.source_uri),
        ['a'],
    );
});

/* ============================================================
 * Order / determinism (1 case)
 * ============================================================ */

test('with concurrency > 1 results land in completion order, not input order', async () => {
    // a is slowest, c is fastest; concurrency 3 means all three start ~together,
    // and results should arrive c, b, a.
    const fake = makeFakeController({
        delayFor: { a: 60, b: 30, c: 5 },
    });
    const walker = createIngestWalker({ controller: fake.controller, concurrency: 3 });
    const result = await walker.walk(['a', 'b', 'c']);
    assert.deepEqual(
        result.results.map((r) => r.source_uri),
        ['c', 'b', 'a'],
        'results in completion (delay) order, not input order',
    );
});

/* ============================================================
 * Bonus: AsyncIterable yielding non-string element rejects (covers §6 edge)
 * ============================================================ */

test('AsyncIterable yielding non-string causes walk() to reject with TypeError', async () => {
    const fake = makeFakeController();
    const walker = createIngestWalker({ controller: fake.controller });
    async function* bad() {
        yield 'ok';
        yield /** @type {any} */ (42);
    }
    await assert.rejects(walker.walk(bad()), /non-empty strings/);
});
