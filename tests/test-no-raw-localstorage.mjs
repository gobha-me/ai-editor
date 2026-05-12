/**
 * Anti-regression CI guard: every raw `localStorage.*` call site in `js/`
 * must live inside the Storage module itself (`js/core.js`). All other
 * modules route through the `Storage` API — `Storage.get`, `Storage.set`,
 * `Storage.remove`, `Storage.migrateLegacyKey`.
 *
 * Why this exists — the 2.40.0 storage-discipline sweep (`docs/audit-2026-Q2/inventory.md`
 * §plumbing/storage entries) replaced ~17 ad-hoc `localStorage.setItem` /
 * `getItem` / `removeItem` call sites scattered across 6 files with the
 * Storage wrapper. Memory `feedback_storage_idb_authoritative.md` notes
 * that raw localStorage usage is a recurring miss (incidents 1.5.9 #16 and
 * 1.6.5): IDB is authoritative, localStorage is best-effort, and direct
 * `localStorage.*` calls bypass the IDB persistence layer — quota events
 * silently lose data the Storage wrapper would have preserved. This test
 * makes the regression class loud.
 *
 * Strips line + block comments before matching so doc-comments referencing
 * `localStorage` (legitimate background prose) don't trip the guard.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const JS_ROOT = join(__dirname, '..', 'js');

// Files allowed to call raw localStorage — i.e. the Storage module itself,
// which owns the persistence layer.
const ALLOWLIST = new Set([
    'js/core.js',
]);

const LOCALSTORAGE_PATTERN = /\blocalStorage\.(?:getItem|setItem|removeItem|clear|key|length)\b/;

function stripComments(src) {
    // Drop /* … */ blocks first (greedy non-newline matches across lines),
    // then // line tails. Conservative — does not parse string literals,
    // but no string literal in this repo embeds a `localStorage.foo(` token
    // that would survive after this pass.
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

function walkJsFiles(dir, acc = []) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
            walkJsFiles(full, acc);
        } else if (entry.endsWith('.js')) {
            acc.push(full);
        }
    }
    return acc;
}

test('no raw localStorage.* calls outside js/core.js (Storage module)', () => {
    const repoRoot = join(__dirname, '..');
    const offenders = [];

    for (const fullPath of walkJsFiles(JS_ROOT)) {
        const relPath = relative(repoRoot, fullPath);
        if (ALLOWLIST.has(relPath)) continue;

        const src = readFileSync(fullPath, 'utf8');
        const stripped = stripComments(src);
        if (LOCALSTORAGE_PATTERN.test(stripped)) {
            // Pull the offending lines (post-strip) for an actionable failure.
            const hits = stripped.split('\n')
                .map((line, i) => ({ line: line.trim(), n: i + 1 }))
                .filter(({ line }) => LOCALSTORAGE_PATTERN.test(line))
                .slice(0, 3);
            offenders.push({ file: relPath, hits });
        }
    }

    if (offenders.length > 0) {
        const detail = offenders.map(({ file, hits }) =>
            `  ${file}:\n${hits.map(h => `    L${h.n}: ${h.line}`).join('\n')}`
        ).join('\n');
        assert.fail(
            `Raw localStorage.* call found outside the Storage allow-list.\n` +
            `Route through Storage.get / Storage.set / Storage.remove, or use ` +
            `Storage.migrateLegacyKey for pre-2.40.0 legacy-key bootstrap.\n` +
            `Offenders:\n${detail}`
        );
    }
});

test('allowlist sanity — Storage modules themselves still use localStorage internally', () => {
    // Tripwire: if someone removes the raw-localStorage layer entirely (e.g.
    // moves Storage to IDB-only), this test reminds them to retire the
    // allowlist too instead of leaving dead entries.
    const repoRoot = join(__dirname, '..');
    for (const relPath of ALLOWLIST) {
        const src = readFileSync(join(repoRoot, relPath), 'utf8');
        assert.ok(
            LOCALSTORAGE_PATTERN.test(stripComments(src)),
            `${relPath} is allowlisted but no longer calls raw localStorage — retire the allowlist entry`,
        );
    }
});
