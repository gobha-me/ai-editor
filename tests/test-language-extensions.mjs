/**
 * Curated language→extensions map regression (2.4.0).
 *
 * Guards the small static map at `js/intelligence/retrieval/
 * language-extensions.js` against drift. The ingest-ordering pass
 * relies on it to convert provider language stats into per-extension
 * weights — losing a common language would silently demote files of
 * that language to "unknown extension" (sorts last but still indexed).
 *
 * Also covers `estimateTokensFromSize` so the byte→token converter
 * the ingest budget consumes never regresses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    LANGUAGE_EXTENSIONS,
    extensionsFor,
    languageForExtension,
    extensionOf,
} from '../js/intelligence/retrieval/language-extensions.js';
import {
    estimateTokensFromSize,
    estimateTokens,
    CHARS_PER_TOKEN,
} from '../js/intelligence/compression/tokens.js';

/* ---------------- LANGUAGE_EXTENSIONS shape ---------------- */

test('every entry value is a non-empty array of dot-prefixed lowercase strings', () => {
    for (const [language, exts] of Object.entries(LANGUAGE_EXTENSIONS)) {
        assert.ok(Array.isArray(exts), `${language} must map to an array`);
        assert.ok(exts.length > 0, `${language} must have at least one extension`);
        for (const ext of exts) {
            assert.equal(typeof ext, 'string', `${language}: ext must be string`);
            assert.ok(ext.startsWith('.'), `${language}: ext "${ext}" must start with .`);
            assert.equal(ext, ext.toLowerCase(), `${language}: ext "${ext}" must be lowercase`);
        }
    }
});

test('common code-editor staples are present', () => {
    // Cheap sanity guard against accidentally deleting the obvious.
    const required = [
        'JavaScript', 'TypeScript', 'Python', 'Go', 'Rust',
        'Java', 'C', 'C++', 'C#', 'Ruby', 'PHP',
        'HTML', 'CSS', 'JSON', 'YAML', 'Markdown', 'Shell',
    ];
    for (const lang of required) {
        assert.ok(LANGUAGE_EXTENSIONS[lang], `missing required language: ${lang}`);
    }
});

test('JavaScript and TypeScript cover their canonical extensions', () => {
    const js = new Set(LANGUAGE_EXTENSIONS['JavaScript']);
    for (const ext of ['.js', '.mjs', '.cjs', '.jsx']) {
        assert.ok(js.has(ext), `JavaScript should include ${ext}`);
    }
    const ts = new Set(LANGUAGE_EXTENSIONS['TypeScript']);
    for (const ext of ['.ts', '.tsx']) {
        assert.ok(ts.has(ext), `TypeScript should include ${ext}`);
    }
});

/* ---------------- extensionsFor ---------------- */

test('extensionsFor returns the canonical list for a known language', () => {
    const exts = extensionsFor('Python');
    assert.ok(exts.includes('.py'));
});

test('extensionsFor returns empty array for unknown language', () => {
    assert.deepEqual(extensionsFor('UnknownLang'), []);
    assert.deepEqual(extensionsFor(''), []);
    // @ts-expect-error - defensive: callers may pass non-strings on a bad provider response
    assert.deepEqual(extensionsFor(null), []);
    // @ts-expect-error
    assert.deepEqual(extensionsFor(undefined), []);
});

/* ---------------- languageForExtension ---------------- */

test('languageForExtension resolves dot-prefixed extensions to the primary language', () => {
    assert.equal(languageForExtension('.js'), 'JavaScript');
    assert.equal(languageForExtension('.ts'), 'TypeScript');
    assert.equal(languageForExtension('.py'), 'Python');
    assert.equal(languageForExtension('.go'), 'Go');
});

test('languageForExtension is case-insensitive on extension', () => {
    assert.equal(languageForExtension('.JS'), 'JavaScript');
    assert.equal(languageForExtension('.Py'), 'Python');
});

test('languageForExtension returns null for unknown extensions', () => {
    assert.equal(languageForExtension('.xyz'), null);
    assert.equal(languageForExtension(''), null);
    // @ts-expect-error
    assert.equal(languageForExtension(null), null);
});

/* ---------------- extensionOf ---------------- */

test('extensionOf extracts the lowercase trailing extension', () => {
    assert.equal(extensionOf('foo.js'), '.js');
    assert.equal(extensionOf('src/foo/bar.TS'), '.ts');
    assert.equal(extensionOf('a/b/c.tar.gz'), '.gz');
});

test('extensionOf returns empty string for paths without extension', () => {
    assert.equal(extensionOf('Makefile'), '');
    assert.equal(extensionOf('src/Dockerfile'), '');
    assert.equal(extensionOf('README'), '');
});

test('extensionOf treats leading-dot files as extensionless', () => {
    // ".gitignore" / ".eslintrc" — single leading dot, no real extension.
    assert.equal(extensionOf('.gitignore'), '');
    assert.equal(extensionOf('src/.env'), '');
});

test('extensionOf is robust to bad input', () => {
    assert.equal(extensionOf(''), '');
    // @ts-expect-error
    assert.equal(extensionOf(null), '');
    // @ts-expect-error
    assert.equal(extensionOf(123), '');
});

/* ---------------- estimateTokensFromSize ---------------- */

test('estimateTokensFromSize agrees with estimateTokens on equivalent input', () => {
    const content = 'a'.repeat(7000);
    assert.equal(estimateTokensFromSize(content.length), estimateTokens(content));
});

test('estimateTokensFromSize uses the documented divisor', () => {
    // 7 bytes -> ceil(7 / 3.5) = 2
    assert.equal(estimateTokensFromSize(7), Math.ceil(7 / CHARS_PER_TOKEN));
    assert.equal(estimateTokensFromSize(7), 2);
});

test('estimateTokensFromSize returns 0 for missing/invalid sizes', () => {
    assert.equal(estimateTokensFromSize(0), 0);
    assert.equal(estimateTokensFromSize(-1), 0);
    assert.equal(estimateTokensFromSize(NaN), 0);
    assert.equal(estimateTokensFromSize(Infinity), 0);
    assert.equal(estimateTokensFromSize(null), 0);
    assert.equal(estimateTokensFromSize(undefined), 0);
    // @ts-expect-error
    assert.equal(estimateTokensFromSize('100'), 0);
});
