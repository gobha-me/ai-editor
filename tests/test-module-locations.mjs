/**
 * Anti-regression CI guard: pinned module locations.
 *
 * Some `js/` directories or paths have been deliberately retired and must
 * not re-appear in future PRs. Each entry below names a retired path + the
 * slice that retired it; the test asserts:
 *   - the directory or file does NOT exist at the retired path
 *   - no live JS code imports from the retired path
 *
 * Why this exists — the 2026-Q2 audit-sweep wave (`docs/audit-2026-Q2/inventory.md`)
 * retired `js/managers/` at 2.44.0.3 (its lone occupant `search-manager.js`
 * moved to the top-level sibling `js/search-manager.js`; the singleton-class
 * shape matches the `tab-manager.js` / `project-manager.js` / `file-tree.js`
 * idiom). Future retirements append a row to RETIRED_PATHS.
 *
 * Strips line + block comments before import-string matching so doc-comments
 * that reference the old path (legitimate historical context — see e.g.
 * `js/search-manager.js`'s migration note) don't trip the guard.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const JS_ROOT = join(REPO_ROOT, 'js');

const RETIRED_PATHS = [
    {
        slice: '2.44.0.3',
        path: 'js/managers',
        kind: 'directory',
        importNeedle: 'managers/search-manager',
        rationale: 'Lone-occupant directory retired; `search-manager.js` moved to top-level sibling.',
    },
];

function stripComments(src) {
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

test('retired paths do not exist on disk', () => {
    for (const entry of RETIRED_PATHS) {
        const full = join(REPO_ROOT, entry.path);
        assert.ok(
            !existsSync(full),
            `Retired ${entry.kind} reappeared: ${entry.path}\n` +
            `Retired at slice ${entry.slice}. ${entry.rationale}`,
        );
    }
});

test('no live JS imports reference a retired path', () => {
    const offenders = [];

    for (const fullPath of walkJsFiles(JS_ROOT)) {
        const relPath = relative(REPO_ROOT, fullPath);
        const stripped = stripComments(readFileSync(fullPath, 'utf8'));

        for (const entry of RETIRED_PATHS) {
            if (stripped.includes(entry.importNeedle)) {
                const hits = stripped.split('\n')
                    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
                    .filter(({ line }) => line.includes(entry.importNeedle))
                    .slice(0, 3);
                offenders.push({ file: relPath, needle: entry.importNeedle, slice: entry.slice, hits });
            }
        }
    }

    if (offenders.length > 0) {
        const detail = offenders.map(({ file, needle, slice, hits }) =>
            `  ${file} (retired ${slice}, needle "${needle}"):\n${hits.map(h => `    L${h.n}: ${h.line}`).join('\n')}`
        ).join('\n');
        assert.fail(
            `Live import of a retired path found.\n` +
            `Update the import to the new module location.\n` +
            `Offenders:\n${detail}`
        );
    }
});
