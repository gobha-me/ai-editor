/**
 * Tests for the help loader's cross-doc link rewrite (gitea#324 follow-up).
 *
 * Background: `docs/PLUGIN.md` contains `[SECURITY.md](SECURITY.md)`. The
 * help slide-out renders that doc as the "Plugin SDK" page. Without the
 * loader-side rewrite, clicking the link either downloads the markdown
 * or 404s in the SPA. The fix wires `<a>` tags whose href resolves to a
 * known help-page basename to in-app navigation; external links and
 * same-page anchors must pass through unchanged.
 *
 * Two layers covered here:
 *   1. `rewriteCrossDocLinks` — pure-string transform, easy to assert on.
 *   2. `renderDocInto` end-to-end — feeds a markdown blob through stubbed
 *      marked + DOMPurify and asserts the panel.innerHTML carries the
 *      rewritten anchors.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rewriteCrossDocLinks, renderDocInto, clearCache } from '../js/help/markdown-loader.js';

test('rewriteCrossDocLinks: SECURITY.md href routes to security page', () => {
    const out = rewriteCrossDocLinks('<a href="SECURITY.md">read this</a>');
    assert.match(out, /data-help-page="security"/);
    assert.match(out, /href="#"/);
    assert.match(out, /class="help__internal-link"/);
});

test('rewriteCrossDocLinks: PLUGIN.md href routes to plugin-sdk page', () => {
    const out = rewriteCrossDocLinks('<a href="PLUGIN.md">plugins</a>');
    assert.match(out, /data-help-page="plugin-sdk"/);
});

test('rewriteCrossDocLinks: external https link is untouched', () => {
    const input = '<a href="https://example.com">ext</a>';
    assert.equal(rewriteCrossDocLinks(input), input);
});

test('rewriteCrossDocLinks: same-page anchor is untouched', () => {
    const input = '<a href="#section">jump</a>';
    assert.equal(rewriteCrossDocLinks(input), input);
});

test('rewriteCrossDocLinks: unknown filename is untouched', () => {
    const input = '<a href="UNKNOWN.md">nope</a>';
    assert.equal(rewriteCrossDocLinks(input), input);
});

test('rewriteCrossDocLinks: nested path resolves to basename', () => {
    const out = rewriteCrossDocLinks('<a href="docs/SECURITY.md">deep</a>');
    assert.match(out, /data-help-page="security"/);
});

test('rewriteCrossDocLinks: fragment after .md is stripped before lookup', () => {
    const out = rewriteCrossDocLinks('<a href="SECURITY.md#section">deep</a>');
    assert.match(out, /data-help-page="security"/);
});

test('renderDocInto: rewrites cross-doc links and leaves externals alone', async () => {
    clearCache();

    // Stub marked to convert [label](url) → <a href="url">label</a>. This is
    // the only marked feature the rewrite cares about; the rest of marked is
    // exercised in the browser suite.
    globalThis.window.marked = {
        parse: (md) => md.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>'),
    };
    // Pass-through DOMPurify — sanitization isn't under test here.
    globalThis.window.DOMPurify = { sanitize: (h) => h };

    // Stub fetch to feed our markdown blob. Mirrors the shape that
    // markdown-loader.js#fetchDocText expects.
    const md = [
        '[link](SECURITY.md)',
        '[plugin](PLUGIN.md)',
        '[ext](https://example.com)',
    ].join('\n\n');
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => 'text/markdown' },
        text: async () => md,
    });

    try {
        const panel = globalThis.document.createElement('div');
        await renderDocInto(panel, 'docs/PLUGIN.md');
        const html = panel.innerHTML;

        assert.match(html, /data-help-page="security"/, 'SECURITY.md should route to security page');
        assert.match(html, /data-help-page="plugin-sdk"/, 'PLUGIN.md should route to plugin-sdk page');
        assert.match(html, /href="https:\/\/example\.com"/, 'external link href should remain intact');
        assert.doesNotMatch(html, /data-help-page="[^"]*example/, 'external link should not be rewritten');
    } finally {
        globalThis.fetch = realFetch;
        delete globalThis.window.marked;
        delete globalThis.window.DOMPurify;
        clearCache();
    }
});
