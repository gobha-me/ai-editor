/**
 * Anti-regression CI guard: every tool-name string literal that the `js/chat/`
 * module switches on or compares against must name a real registered tool.
 *
 * The chat module does case-dispatch on tool
 * names in three places — `summarizeToolArgs` / `summarizeToolResult`
 * (`js/chat/messages.js`) for compact tool-call rendering, `_writeRange`
 * / `_readRange` (`js/chat/turn-enrich.js`) for FileOp range extraction,
 * and `REQUIRED_TOOL_PARAMS` (`js/chat/tools.js`) for required-args
 * validation. Pre-2.44.0.0 a tool rename in `js/tools/*.js#register(...)`
 * would silently degrade these three surfaces — the renamed tool falls
 * through to the `default:` branch (summarization), to `null` (range
 * extraction), or to "let it through" (validation), and the regression
 * stays invisible until a user reports degraded UI.
 *
 * The slice's investigation rejected pure centralization (a single
 * `TOOL_NAMES` constant): the switch/case sites are more readable as
 * literals than as `case TOOL_NAMES.read_lines:`. Coverage is the right
 * shape — same idiom as `tests/test-no-raw-localstorage.mjs` (2.40.0)
 * and `tests/test-no-inline-onclick.mjs` (2.32.0): glob source, regex-
 * extract, cross-reference against a canonical set.
 *
 * Source of truth — every `register('NAME', ...)` call inside `js/tools/
 * *.js`, where `register` resolves to either `ToolRegistry.register` (top-
 * level side-effect registrations) or the `registry` argument shadowed
 * inside `register<X>Tools(registry)` helpers. We scan the source files
 * directly instead of booting the runtime registry — same anti-drift
 * property without pulling in the DOM/State/EventBus dependency graph.
 *
 * Allow-list — `peek_read_lines` is the one literal in chat module code
 * (`js/chat/turn-enrich.js`) that names a meta-tool layered on top of
 * `read_lines` rather than a directly registered tool. It's a real concept
 * in the codebase (`js/intelligence/...`); admit it explicitly here.
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

// Literal that names a meta-tool layered above `read_lines`, not a
// `register('peek_read_lines', ...)` call. Used in `_readRange` to share
// the read-line range-extraction path. Admit explicitly so the parity
// guards stay strict for everything else.
const ALLOWED_NON_REGISTERED = new Set([
    'peek_read_lines',
]);

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

function readRegisteredToolNames() {
    const names = new Set();
    const pattern = /(?:ToolRegistry|registry)\.register\s*\(\s*['"]([a-z_][a-z0-9_]*)['"]/g;
    for (const entry of readdirSync(TOOLS_DIR)) {
        if (!entry.endsWith('.js')) continue;
        const src = stripComments(readFileSync(join(TOOLS_DIR, entry), 'utf8'));
        let m;
        while ((m = pattern.exec(src)) !== null) {
            names.add(m[1]);
        }
    }
    return names;
}

function extractCaseLabels(src, fnName) {
    const fnStart = src.indexOf(`function ${fnName}`);
    if (fnStart < 0) return null;
    const bodyStart = src.indexOf('{', fnStart);
    if (bodyStart < 0) return null;
    let depth = 0;
    let bodyEnd = -1;
    for (let i = bodyStart; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) { bodyEnd = i; break; }
        }
    }
    if (bodyEnd < 0) return null;
    const body = src.slice(bodyStart, bodyEnd);
    const labels = new Set();
    const caseRe = /case\s+['"]([a-z_][a-z0-9_]*)['"]\s*:/g;
    let m;
    while ((m = caseRe.exec(body)) !== null) {
        labels.add(m[1]);
    }
    return labels;
}

function extractEqualityLiterals(src) {
    const names = new Set();
    const eqRe = /toolName\s*===\s*['"]([a-z_][a-z0-9_]*)['"]/g;
    const startsRe = /toolName\.startsWith\s*\(\s*['"]([a-z_][a-z0-9_]*)['"]/g;
    let m;
    while ((m = eqRe.exec(src)) !== null) names.add(m[1]);
    while ((m = startsRe.exec(src)) !== null) names.add(m[1]);
    return names;
}

function summarizeUnknowns(label, names, registered) {
    const unknown = [...names].filter(n => !registered.has(n) && !ALLOWED_NON_REGISTERED.has(n));
    if (unknown.length === 0) return null;
    return `${label}: ${unknown.sort().join(', ')}`;
}

// ============================================
// Case A — REQUIRED_TOOL_PARAMS parity
// ============================================

test('REQUIRED_TOOL_PARAMS keys all name registered tools', () => {
    const registered = readRegisteredToolNames();
    const detail = summarizeUnknowns(
        'js/chat/tools.js#REQUIRED_TOOL_PARAMS',
        Object.keys(REQUIRED_TOOL_PARAMS),
        registered,
    );
    assert.equal(
        detail,
        null,
        `REQUIRED_TOOL_PARAMS contains key(s) not registered in js/tools/*.js — ${detail}\n` +
        `Either the registry was renamed and this map wasn't updated, or the\n` +
        `key was never a real tool. Update the map and re-run.`,
    );
});

// ============================================
// Case B — messages.js switch cases
// ============================================

test('js/chat/messages.js summarizer switch cases all name registered tools', () => {
    const registered = readRegisteredToolNames();
    const src = stripComments(
        readFileSync(join(REPO_ROOT, 'js', 'chat', 'messages.js'), 'utf8'),
    );

    const args = extractCaseLabels(src, 'summarizeToolArgs');
    const result = extractCaseLabels(src, 'summarizeToolResult');

    assert.ok(args && args.size > 0, 'summarizeToolArgs case-label extraction returned empty — regex regression?');
    assert.ok(result && result.size > 0, 'summarizeToolResult case-label extraction returned empty — regex regression?');

    const argsDetail = summarizeUnknowns('summarizeToolArgs', args, registered);
    const resultDetail = summarizeUnknowns('summarizeToolResult', result, registered);

    const failures = [argsDetail, resultDetail].filter(Boolean);
    assert.deepEqual(
        failures,
        [],
        `js/chat/messages.js switch case(s) reference unregistered tool name(s):\n` +
        `  ${failures.join('\n  ')}\n` +
        `A tool rename in js/tools/*.js leaves these case labels as dead code —\n` +
        `update the switch or remove the stale label.`,
    );
});

// ============================================
// Case C — turn-enrich.js equality / startsWith literals
// ============================================

test('js/chat/turn-enrich.js toolName ===/startsWith literals all name registered tools', () => {
    const registered = readRegisteredToolNames();
    const src = stripComments(
        readFileSync(join(REPO_ROOT, 'js', 'chat', 'turn-enrich.js'), 'utf8'),
    );

    const literals = extractEqualityLiterals(src);
    assert.ok(literals.size > 0, 'turn-enrich.js literal extraction returned empty — regex regression?');

    const detail = summarizeUnknowns('js/chat/turn-enrich.js', literals, registered);
    assert.equal(
        detail,
        null,
        `turn-enrich.js compares toolName against unregistered name(s) — ${detail}\n` +
        `FileOp range extraction for that tool will silently return null. If the\n` +
        `tool was renamed, update the equality check; if it never existed, drop it.`,
    );
});

// ============================================
// Case D — sanity: registered set is non-trivial
// ============================================

test('readRegisteredToolNames() returns the canonical registry set', () => {
    const registered = readRegisteredToolNames();
    assert.ok(
        registered.size >= 30,
        `Registered tool count looked at ${registered.size} — expected ≥ 30 across js/tools/*.js. Scanner regex regression?`,
    );
    // Spot-check a stable handful that have been in the registry for many minors.
    for (const canonical of ['read_file', 'read_lines', 'edit_file', 'create_file', 'commit_files']) {
        assert.ok(
            registered.has(canonical),
            `readRegisteredToolNames missed '${canonical}' — scanner regex is broken.`,
        );
    }
});
