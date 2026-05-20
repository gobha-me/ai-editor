/**
 * Lint test for the 2.71.0 `cache:` field on tool registrations
 * (gitea#472).
 *
 * Why this exists — the dup-cache assumes `(toolName, args)` is a pure
 * function of state. Tools where it isn't (`read_current_file`,
 * `ask_user`, `list_dirty_files`, `list_open_tabs`, ...) must bypass the
 * cache. Pre-2.71.0 they were hand-listed in `STATEFUL_READ_TOOLS`;
 * authors of new tools didn't see the list and each new aggregating read
 * reopened the same wound (gitea#301 → github#39 → 2.10.0 Tier 3a →
 * gitea#472 — fourth instance of the recurring pattern documented at
 * `project_edit_file_stale_cache_deadlock.md`).
 *
 * The 2.71.0 fix lifts the cache classification onto the tool descriptor
 * itself — `cache: 'by-args' | 'never'` on the definition passed to
 * `ToolRegistry.register()`. This test enforces conscious classification
 * at registration time:
 *
 *   1. **Migration completeness** — every name in the legacy
 *      `STATEFUL_READ_TOOLS` const must also have `cache: 'never'` at
 *      its registration site. Catches the case where the legacy const
 *      drifted ahead of the registry.
 *
 *   2. **No-whack-a-mole guard** — every registered tool whose name
 *      matches a stale-prone shape (`list_*`, `find_*`, `get_*_status`,
 *      `*_logs`, ...) MUST declare `cache:` explicitly. New aggregating
 *      reads cannot land without the author touching this classification
 *      — the lint failure points them at the field, the field's
 *      JSDoc explains the policy.
 *
 *   3. **#472 spot-check** — `list_dirty_files` is registered with
 *      `cache: 'never'`. Lock the actual fix in.
 *
 * Source-scan approach (no runtime registry) — mirrors
 * `tests/test-chat-tool-name-literals.mjs`. We slice each tool source
 * file at `register('NAME',` positions and ask whether the resulting
 * registration block contains a `cache:` literal. Same shape as the
 * existing parity-against-source-truth tests; no DOM/State boot required.
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STATEFUL_READ_TOOLS } from '../js/chat/tool-classifications.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const TOOLS_DIR = join(REPO_ROOT, 'js', 'tools');

/**
 * Tools whose name matches a stale-prone shape but whose result IS
 * actually a pure function of args (e.g. `list_tool_categories` is a
 * static catalog enumeration over the in-process registry — admitted
 * tools change but the categorical structure does not within a turn).
 *
 * Keep this small. When in doubt, declare `cache:` explicitly at the
 * registration site rather than expanding this allow-list. Each entry
 * here is an exception that needs justification.
 */
const STALE_PRONE_NAME_ALLOWLIST = new Set([
    // `list_tool_categories` enumerates the registry's category metadata
    // — args-keyed cache is fine because the categorical structure is
    // stable across a session (MCP-driven mutations change tool members,
    // not category labels).
    'list_tool_categories',
    // `list_tools_by_category` filters the catalog by category-id arg —
    // result varies with admitted-tools set, but the dup-cache window is
    // bounded (one round trip) and a stale answer is recoverable via
    // `find_tool` rather than blocking the model.
    'list_tools_by_category',
]);

/**
 * Name-pattern matcher: tools that aggregate / read remote/repo/index
 * state and therefore tend to be stale-prone. Used to gate the no-whack-
 * a-mole assertion — tools matching these patterns MUST declare `cache:`
 * unless they're on the allow-list above.
 */
function isStaleProneName(name) {
    return /^(list|find|get)_/.test(name)
        || /_status$/.test(name)
        || /_logs$/.test(name);
}

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/**
 * Slice each tool source file at `register('NAME',` positions. Returns
 * a Map<toolName, registrationBlockSource>. The block runs from one
 * `register('NAME',` up to just before the next `register('OTHER',` (or
 * EOF). Multiple registrations per file are each their own block.
 *
 * Note: comments are stripped first so a `// cache: 'never'` comment
 * doesn't masquerade as a real declaration.
 */
function readRegistrationBlocks() {
    /** @type {Map<string, string>} */
    const blocks = new Map();
    const startRe = /(?:ToolRegistry|registry)\.register\s*\(\s*['"]([a-z_][a-z0-9_]*)['"]/g;

    for (const entry of readdirSync(TOOLS_DIR)) {
        if (!entry.endsWith('.js')) continue;
        const raw = readFileSync(join(TOOLS_DIR, entry), 'utf8');
        const src = stripComments(raw);

        // Collect every match position for this file in order.
        /** @type {{name:string, start:number}[]} */
        const matches = [];
        let m;
        startRe.lastIndex = 0;
        while ((m = startRe.exec(src)) !== null) {
            matches.push({ name: m[1], start: m.index });
        }

        for (let i = 0; i < matches.length; i++) {
            const start = matches[i].start;
            const end = i + 1 < matches.length ? matches[i + 1].start : src.length;
            blocks.set(matches[i].name, src.slice(start, end));
        }
    }

    return blocks;
}

/**
 * Extract the `cache: 'X'` literal value from a registration block, if
 * any. Returns `'never'`, `'by-args'`, or `null` (field absent).
 *
 * The match is strict — requires a leading word boundary so something
 * like `noCache: 'never'` or `cacheable: 'by-args'` doesn't false-match.
 */
function readCacheField(block) {
    const re = /\bcache\s*:\s*['"]([a-z\-]+)['"]/;
    const m = re.exec(block);
    return m ? m[1] : null;
}

// ============================================================================
// Case A — Migration completeness: every legacy STATEFUL_READ_TOOLS entry
// has `cache: 'never'` at its registration site
// ============================================================================

test('every legacy STATEFUL_READ_TOOLS entry has cache: \'never\' at registration', () => {
    const blocks = readRegistrationBlocks();
    const failures = [];
    for (const name of STATEFUL_READ_TOOLS) {
        const block = blocks.get(name);
        if (!block) {
            failures.push(`${name}: not found in js/tools/*.js (legacy hand-list drifted from registry)`);
            continue;
        }
        const cache = readCacheField(block);
        if (cache !== 'never') {
            failures.push(`${name}: declared cache=${JSON.stringify(cache)}; legacy STATEFUL_READ_TOOLS membership requires 'never'`);
        }
    }
    assert.deepEqual(
        failures,
        [],
        `Legacy STATEFUL_READ_TOOLS entries missing or mis-declared at registration:\n  ${failures.join('\n  ')}\n` +
        `These tools were hand-listed as cache-bypass pre-2.71.0; the 2.71.0 lift requires the same\n` +
        `decision to be expressed at the ToolRegistry.register() call site via cache: 'never'.`,
    );
});

// ============================================================================
// Case B — No-whack-a-mole: every stale-prone-named tool declares cache: explicitly
// ============================================================================

test('every stale-prone-named tool (list_*/find_*/get_*/*_status/*_logs) declares cache: explicitly', () => {
    const blocks = readRegistrationBlocks();
    const failures = [];
    for (const [name, block] of blocks) {
        if (!isStaleProneName(name)) continue;
        if (STALE_PRONE_NAME_ALLOWLIST.has(name)) continue;
        const cache = readCacheField(block);
        if (cache === null) {
            failures.push(name);
        }
    }
    assert.deepEqual(
        failures.sort(),
        [],
        `Tools matching stale-prone name shapes are registered without an explicit \`cache:\` field:\n  ` +
        failures.sort().join('\n  ') + `\n\n` +
        `These names (list_*, find_*, get_*, *_status, *_logs) tend to read repo/remote/index state\n` +
        `that mutates between calls. Either:\n` +
        `  • Add \`cache: 'never'\` to the registration (recommended for any aggregating read), OR\n` +
        `  • Add \`cache: 'by-args'\` if the result really IS a pure function of args, OR\n` +
        `  • Add the name to STALE_PRONE_NAME_ALLOWLIST in this test with justification.\n\n` +
        `Why this lint exists — gitea#472 is the fourth instance of the same recurring bug:\n` +
        `an aggregating read got hand-listed in STATEFUL_READ_TOOLS too late, after the model\n` +
        `had already trusted a stale \`_cached: true\` envelope. The classification belongs next\n` +
        `to the tool, not in a distant array. See \`js/tools/registry.js\` ToolDefinition.cache.`,
    );
});

// ============================================================================
// Case C — #472 fix lock-in
// ============================================================================

test('list_dirty_files is registered with cache: \'never\' (gitea#472 fix lock-in)', () => {
    const blocks = readRegistrationBlocks();
    const block = blocks.get('list_dirty_files');
    assert.ok(block, 'list_dirty_files registration not found in js/tools/*.js');
    assert.equal(
        readCacheField(block),
        'never',
        `list_dirty_files must declare \`cache: 'never'\` per gitea#472. The path-keyed cache\n` +
        `invalidator cannot match a no-arg entry, so any FILE_MUTATING_TOOLS call between two\n` +
        `\`list_dirty_files\` calls would have left a stale \`{files: []}\` envelope — the live\n` +
        `dogfood repro from 2026-05-20.`,
    );
});

// ============================================================================
// Case D — Cache values are constrained
// ============================================================================

test('every declared cache: value is one of the allowed strings (by-args | never)', () => {
    const blocks = readRegistrationBlocks();
    const ALLOWED = new Set(['by-args', 'never']);
    const failures = [];
    for (const [name, block] of blocks) {
        const cache = readCacheField(block);
        if (cache !== null && !ALLOWED.has(cache)) {
            failures.push(`${name}: cache=${JSON.stringify(cache)} is not in ${[...ALLOWED].join(' | ')}`);
        }
    }
    assert.deepEqual(
        failures,
        [],
        `Invalid cache: values found:\n  ${failures.join('\n  ')}\n` +
        `The ToolDefinition.cache field accepts only 'by-args' or 'never' at 2.71.0.`,
    );
});
