/**
 * Anti-regression CI guard: every tool with a `REQUIRED_TOOL_PARAMS` entry
 * must lead its tool-definition `description` with a `**Required:** <param-
 * list>.` prefix matching the required-params array verbatim (order-
 * preserving, comma-space separator).
 *
 * Why this exists — gitea#422. In a 2026-05-14 qwen-3-6-plus AAR, the model
 * called `create_file`, `read_lines`, and `search_in_files` without their
 * required params. Each cost a round-trip because the model reads the
 * description prose, decides the tool is right, and constructs args from
 * training-data priors before looking at the JSON schema. Surfacing the
 * required-set at the head of the description lets the model see it in the
 * same place it sees the prose. This test pins the convention so a future
 * description rewrite that drops the prefix surfaces as a test failure.
 *
 * Idiom — same source-scan + regex approach as
 * `tests/test-chat-tool-name-literals.mjs`. We do not boot the runtime
 * registry (it pulls in DOM/State/EventBus dependencies); reading
 * `js/tools/*.js` source directly is sufficient.
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REQUIRED_TOOL_PARAMS } from '../js/chat/tools.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const TOOLS_DIR = join(REPO_ROOT, 'js', 'tools');

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/**
 * Walk all `js/tools/*.js` files and extract every `{name: 'X', description:
 * 'Y'}` pair from the `function:` blocks. Returns a Map(name → description).
 *
 * The pair regex matches `name: 'X'` followed by (any chars that aren't a
 * closing brace) and then `description: 'Y'`. The description content
 * supports backslash escapes (e.g. `\'` for apostrophes inside the string).
 */
function readToolDescriptions() {
    const map = new Map();
    const pairRe = /name:\s*'([a-z_][a-z0-9_]*)'[^}]*?description:\s*'((?:[^'\\]|\\.)*)'/gs;
    for (const entry of readdirSync(TOOLS_DIR)) {
        if (!entry.endsWith('.js')) continue;
        const src = stripComments(readFileSync(join(TOOLS_DIR, entry), 'utf8'));
        let m;
        while ((m = pairRe.exec(src)) !== null) {
            // First occurrence wins. Tools register exactly once each — a
            // duplicate name would be a separate bug surfaced by
            // test-chat-tool-name-literals.mjs.
            if (!map.has(m[1])) {
                map.set(m[1], m[2]);
            }
        }
    }
    return map;
}

test('description scanner picks up the canonical tool set', () => {
    const map = readToolDescriptions();
    assert.ok(map.size >= 30, `expected ≥30 tool descriptions, got ${map.size} — regex regression?`);
    // Spot-check a stable handful.
    for (const canonical of ['read_file', 'read_lines', 'edit_file', 'create_file', 'search_in_files']) {
        assert.ok(map.has(canonical), `scanner missed '${canonical}' description`);
    }
});

test('every REQUIRED_TOOL_PARAMS tool description leads with **Required:** <param-list>.', () => {
    const descriptions = readToolDescriptions();
    const failures = [];

    for (const [tool, params] of Object.entries(REQUIRED_TOOL_PARAMS)) {
        const desc = descriptions.get(tool);
        if (!desc) {
            failures.push(`${tool}: no description found in js/tools/*.js (registration missing?)`);
            continue;
        }
        const expected = `**Required:** ${params.join(', ')}.`;
        if (!desc.startsWith(expected)) {
            failures.push(
                `${tool}: description does not start with '${expected}'\n` +
                `    actual prefix: '${desc.slice(0, Math.max(80, expected.length + 10))}...'`,
            );
        }
    }

    assert.deepEqual(
        failures,
        [],
        `Tool description prefix drift — gitea#422 convention is\n` +
        `'**Required:** <comma-separated-required-params>.' as the first sentence.\n\n` +
        `Failures:\n  ${failures.join('\n  ')}\n\n` +
        `Fix: edit the description string in js/tools/<file>.js to lead with the\n` +
        `required-params clause, then re-run this test.`,
    );
});

test('REQUIRED_TOOL_PARAMS lists are non-empty and well-formed', () => {
    // Defensive — if someone empties a required-params array, the prefix
    // would degenerate to '**Required:** .' which is incoherent.
    for (const [tool, params] of Object.entries(REQUIRED_TOOL_PARAMS)) {
        assert.ok(Array.isArray(params), `${tool} required-params must be an array`);
        assert.ok(params.length > 0, `${tool} required-params is empty — drop the key from the map instead`);
        for (const p of params) {
            assert.equal(typeof p, 'string', `${tool} required-params must be strings`);
            assert.ok(p.length > 0, `${tool} required-params has an empty string`);
            assert.match(p, /^[a-z_][a-z0-9_]*$/, `${tool} required-param '${p}' is not a valid identifier`);
        }
    }
});
