/**
 * Tests for 2.17.1 — tool-return invisible-Unicode scan.
 *
 * The registry-level helper `scanToolReturn(name, result)` (see
 * js/tools/registry.js) is what every tool dispatch flows through after
 * its handler resolves. Findings attach to `result._security.invisibleUnicode`
 * in the same shape `read_issue` / `read_pull_request` populated since 1.6.12,
 * so the chat-side render path surfaces both with one branch.
 *
 * Pure-logic checks — `scanToolReturn` doesn't touch the registry's profile
 * gate, so the tests exercise the helper directly without registering tools.
 *
 * NOTE on test fixtures: the CI invisible-Unicode lint greps every .mjs file
 * in tests/ for literal flagged codepoints. Constructing fixtures via
 * `String.fromCodePoint(0x202E)` keeps the source pure ASCII so the lint
 * stays green; the runtime string still carries the live codepoint.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanToolReturn } from '../js/tools/registry.js';

const CP = String.fromCodePoint;

/** Capture console.warn calls for assertions; restore after. */
function withCapturedWarn(fn) {
    const captured = [];
    const original = console.warn;
    console.warn = (...args) => { captured.push(args); };
    try {
        fn(captured);
    } finally {
        console.warn = original;
    }
}

test('clean ASCII payload — no _security attached', () => {
    const result = { result: 'plain text', count: 7 };
    scanToolReturn('synthetic_tool', result);
    assert.equal(result._security, undefined);
});

test('bidi-override (U+202E) flagged — codepoint surfaced in firstFindings', () => {
    const result = { result: `a${CP(0x202E)}b` };
    scanToolReturn('synthetic_tool', result);
    assert.ok(result._security?.invisibleUnicode, 'expected _security.invisibleUnicode to be populated');
    assert.equal(result._security.invisibleUnicode.count, 1);
    assert.equal(result._security.invisibleUnicode.source, 'synthetic_tool');
    assert.equal(result._security.invisibleUnicode.firstFindings[0].codepoint, 'U+202E');
});

test('zero-width (U+200B) in nested field — stringification path catches it', () => {
    const result = { data: { snippet: `foo${CP(0x200B)}bar`, other: 42 } };
    scanToolReturn('synthetic_tool', result);
    assert.ok(result._security?.invisibleUnicode, 'expected scan to reach nested string fields');
    assert.equal(result._security.invisibleUnicode.count, 1);
    assert.equal(result._security.invisibleUnicode.firstFindings[0].codepoint, 'U+200B');
});

test('tags-block (U+E0041 — Glassworm carrier) flagged', () => {
    const result = { result: `x${CP(0xE0041)}y` };
    scanToolReturn('synthetic_tool', result);
    assert.ok(result._security?.invisibleUnicode);
    assert.equal(result._security.invisibleUnicode.count, 1);
    assert.equal(result._security.invisibleUnicode.firstFindings[0].codepoint, 'U+E0041');
});

test('pre-attached _security.invisibleUnicode is not overwritten', () => {
    // Mimics issue/PR tools: the tool handler did its own narrower scan
    // and attached findings before returning. Registry must not clobber.
    const sentinel = {
        source: 'pretend_issue_body',
        count: 999,
        families: ['custom'],
        firstFindings: [{ codepoint: 'U+FEFF', name: 'sentinel' }]
    };
    const result = {
        // Intentionally also contains an invisible char — registry would
        // otherwise re-scan and overwrite. The skip-when-populated guard
        // is what we're verifying.
        result: `a${CP(0x202E)}b`,
        _security: { invisibleUnicode: sentinel }
    };
    scanToolReturn('synthetic_tool', result);
    assert.equal(result._security.invisibleUnicode, sentinel, 'sentinel object identity preserved');
    assert.equal(result._security.invisibleUnicode.count, 999);
});

test('5 MB clean payload — completes quickly and attaches nothing', () => {
    const big = 'a'.repeat(5_000_000);
    const result = { data: big };
    const start = Date.now();
    scanToolReturn('synthetic_tool', result);
    const elapsed = Date.now() - start;
    assert.equal(result._security, undefined, 'clean text should not attach _security');
    // Generous bound — single regex sweep + one O(n) line-index pass on
    // 5 MB. Real wall time on a dev box is sub-200ms; 2s is just a
    // pathological-hang smoke test.
    assert.ok(elapsed < 2000, `expected scan under 2s, took ${elapsed}ms`);
});

test('11 MB payload — exceeds soft cap, scan skipped, console.warn emitted', () => {
    const huge = 'a'.repeat(11_000_000);
    const result = { data: huge };
    withCapturedWarn((captured) => {
        scanToolReturn('synthetic_tool', result);
        assert.equal(result._security, undefined, 'oversized payload must skip the scan');
        const sawSizeSkip = captured.some(args =>
            args.some(a => typeof a === 'string' && a.includes('exceeds'))
        );
        assert.ok(sawSizeSkip, 'expected a console.warn about the size cap');
    });
});

test('console.warn fires when invisible-Unicode is found', () => {
    const result = { result: `a${CP(0x202E)}b` };
    withCapturedWarn((captured) => {
        scanToolReturn('synthetic_tool', result);
        const sawSecurityWarn = captured.some(args =>
            args.some(a => typeof a === 'string' && a.includes('invisible-unicode in tool return'))
        );
        assert.ok(sawSecurityWarn, 'expected a console.warn carrying the invisible-unicode finding');
    });
});
