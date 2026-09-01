/**
 * Anti-regression CI guard: every `EventBus.emit(`slot:${...}:changed`)` or
 * `EventBus.on(`slot:${...}:changed`, ...)` template-literal call in `js/`
 * must route through the `forSlot(slotId)` helper at
 * `js/events/public-channels.js`. The only files allowed to construct the
 * raw `slot:${id}:changed` template literally are the helper itself (the
 * shape definition) and the emit-site dispatcher in `js/slot-manager.js`
 * — but even those should call `forSlot()` in production paths.
 *
 * The slot-channel boundary replaced the dynamic-name pattern
 * with `forSlot(slotId)` so the channel name becomes grep-discoverable and
 * input validation rejects malformed slot ids (e.g. `'rail:views'` would
 * silently produce `slot:rail:views:changed` under the old template literal).
 * This test makes any future raw template-literal regression loud.
 *
 * Strips line + block comments before matching so doc-comments referencing
 * the channel shape (legitimate background prose) don't trip the guard.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const JS_ROOT = join(__dirname, '..', 'js');

// Files allowed to keep raw `slot:${...}:changed` references:
// - `js/events/public-channels.js` owns the canonical `forSlot()` helper
//   and declares the production literal (`slot:rail-views:changed`).
const ALLOWLIST = new Set([
    'js/events/public-channels.js',
]);

// Match template-literal slot-channel constructions in either an emit or
// an on() position. The `\s*\`` portion catches whitespace between the
// paren and backtick.
const RAW_SLOT_PATTERN = /EventBus\.(?:emit|on)\(\s*`slot:\$\{/;

function stripComments(src) {
    // Drop /* … */ blocks first, then // line tails. Same shape as
    // tests/test-no-raw-localstorage.mjs — conservative, does not parse
    // string literals, but no string literal in this repo embeds the
    // `EventBus.emit(\`slot:${` token after this pass.
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

test('no raw EventBus.emit/on(`slot:${id}:changed`) template-literals outside the helper file', () => {
    const repoRoot = join(__dirname, '..');
    const offenders = [];

    for (const fullPath of walkJsFiles(JS_ROOT)) {
        const relPath = relative(repoRoot, fullPath);
        if (ALLOWLIST.has(relPath)) continue;

        const src = readFileSync(fullPath, 'utf8');
        const stripped = stripComments(src);
        if (RAW_SLOT_PATTERN.test(stripped)) {
            const hits = stripped.split('\n')
                .map((line, i) => ({ line: line.trim(), n: i + 1 }))
                .filter(({ line }) => RAW_SLOT_PATTERN.test(line))
                .slice(0, 3);
            offenders.push({ file: relPath, hits });
        }
    }

    if (offenders.length > 0) {
        const detail = offenders.map(({ file, hits }) =>
            `  ${file}:\n${hits.map(h => `    L${h.n}: ${h.line}`).join('\n')}`
        ).join('\n');
        assert.fail(
            `Raw \`slot:\${id}:changed\` template-literal found outside the helper allow-list.\n` +
            `Route through \`forSlot(slotId)\` from js/events/public-channels.js.\n` +
            `Offenders:\n${detail}`
        );
    }
});

test('allowlist sanity — public-channels.js exports the forSlot helper', () => {
    // Tripwire: if forSlot is renamed or removed, the allowlist entry stops
    // representing the canonical helper and should be retired alongside.
    const repoRoot = join(__dirname, '..');
    const src = readFileSync(join(repoRoot, 'js/events/public-channels.js'), 'utf8');
    const stripped = stripComments(src);
    assert.ok(
        /export\s+function\s+forSlot\b/.test(stripped),
        'js/events/public-channels.js is allowlisted but no longer exports forSlot — retire the allowlist entry',
    );
});
