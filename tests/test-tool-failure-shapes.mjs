/**
 * Source-scan lint for the T1 tool-authored failure shape contract
 * (`docs/DESIGN-tools.md` §"Tool-authored failure shape contract", 2026-05-21).
 *
 * The contract requires every tool-side rejection to carry a stable,
 * machine-readable identifier — not a free-form sentence. Ai-editor pins
 * this as a `code:` field alongside the existing human-readable `error:`
 * field (rationale: matches the registry catch-block precedent at
 * `js/tools/registry.js` for EditorError-throw failures, so tool-return
 * and tool-throw failures share one envelope shape).
 *
 * Scope (this PR, 2.78.0). The 11 high-churn tool handlers below are
 * declared T1-conformant — every `return { ... error: ... }` site in
 * their handler body must carry a `code:` field from `VALID_CODES`.
 * Other tools are not yet conformant; the lint reports them as pending
 * but does not fail on them (follow-on PRs will graduate them).
 *
 * Shape: source-scan, mirrors `tests/test-plan-mode-source-scan.mjs`.
 * Walks `js/tools/*.js`, resolves each `register('NAME', HANDLER, ...)`
 * to its handler body (either inline arrow at the register call site,
 * or a named function defined elsewhere in the same file — the
 * `ci-tools.js` pattern), then scans the body for return-error sites.
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const TOOLS_DIR = join(REPO_ROOT, 'js', 'tools');

/**
 * Tools whose failure returns must carry a stable `code:` field. Each
 * entry must be backed by a refactor at the registration site; adding
 * a name here without doing the refactor will fail the subtests below.
 *
 * @type {Set<string>}
 */
const T1_CONFORMANT_TOOLS = new Set([
    'edit_file',
    'write_file',
    'read_lines',
    'search_in_files',
    'get_ci_status',
    'wait_for_ci',
    'get_ci_logs',
    'read_plugin_source',
    'write_plugin_source',
    'run_plugin',
    'run_code',
]);

/**
 * Closed set of failure codes admissible in T1-conformant handlers. The
 * loop's per-tool `next_action_hint` registry keys on `(tool_name, code)`
 * pairs (DESIGN-agent-loop.md §"Envelope Shapes"); renaming any of these
 * is a contract break. Add new codes here only when the corresponding
 * recovery shape is named at the tool's return site.
 *
 * @type {Set<string>}
 */
const VALID_CODES = new Set([
    'stale_lines',
    'schema_validation_failed',
    'precondition_not_met',
    'path_not_found',
    'read_error',
    'write_error',
    'search_error',
    'ci_status_fetch_error',
    'ci_workflow_error',
    'ci_workflow_not_found',
    'ci_log_not_available',
    'plugin_execution_error',
    'code_execution_error',
    'edit_error',
    'editor_open_failed',
]);

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/**
 * Extract a brace-balanced block starting at `openBraceIdx` (which must
 * point at `{`). Returns the substring from `{` through the matching `}`
 * inclusive, or null if unbalanced. Handles string and template literals
 * so braces inside `"{"` / `` `${x}` `` don't break depth tracking.
 *
 * @param {string} src
 * @param {number} openBraceIdx
 * @returns {string|null}
 */
function extractBracedBlock(src, openBraceIdx) {
    if (src[openBraceIdx] !== '{') return null;
    let depth = 0;
    let i = openBraceIdx;
    let inString = null;
    let inTemplate = 0;
    let templateBraceDepth = [];
    while (i < src.length) {
        const ch = src[i];
        if (inString) {
            if (ch === '\\') { i += 2; continue; }
            if (ch === inString) inString = null;
        } else if (inTemplate) {
            if (ch === '\\') { i += 2; continue; }
            if (ch === '`') { inTemplate = 0; }
            else if (ch === '$' && src[i + 1] === '{') {
                templateBraceDepth.push(depth);
                depth++;
                i += 2;
                continue;
            } else if (ch === '}' && templateBraceDepth.length && depth - 1 === templateBraceDepth[templateBraceDepth.length - 1]) {
                templateBraceDepth.pop();
                depth--;
            }
        } else {
            if (ch === '"' || ch === "'") { inString = ch; }
            else if (ch === '`') { inTemplate = 1; }
            else if (ch === '{') { depth++; }
            else if (ch === '}') {
                depth--;
                if (depth === 0) return src.slice(openBraceIdx, i + 1);
            }
        }
        i++;
    }
    return null;
}

/**
 * Locate the body of a named function declaration `[async] function NAME(...) { ... }`
 * in the file source. Returns the brace-balanced body (with braces) or null.
 *
 * @param {string} src
 * @param {string} fnName
 * @returns {string|null}
 */
function findFunctionBody(src, fnName) {
    const re = new RegExp(`(?:async\\s+)?function\\s+${fnName}\\s*\\(`, 'g');
    const m = re.exec(src);
    if (!m) return null;
    let i = m.index + m[0].length;
    let parenDepth = 1;
    while (i < src.length && parenDepth > 0) {
        if (src[i] === '(') parenDepth++;
        else if (src[i] === ')') parenDepth--;
        i++;
    }
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== '{') return null;
    return extractBracedBlock(src, i);
}

/**
 * Resolve every `register('NAME', HANDLER, ...)` to `{name, handlerSrc}`
 * where handlerSrc is the brace-balanced body of the handler.
 *
 * Two handler patterns supported:
 *   1. Inline arrow: `register('foo', async (args) => { ... }, { ... })`
 *   2. Named function reference: `register('foo', fooHandler, { ... })`
 *      — where `fooHandler` is `async function fooHandler(...) { ... }`
 *      defined elsewhere in the same file (the `ci-tools.js` pattern).
 *
 * @param {string} src
 * @returns {Array<{name: string, handlerSrc: string}>}
 */
function resolveHandlers(src) {
    const results = [];
    const startRe = /(?:ToolRegistry|registry)\.register\s*\(\s*['"]([a-z_][a-z0-9_]*)['"]\s*,\s*/g;
    let m;
    while ((m = startRe.exec(src)) !== null) {
        const name = m[1];
        let i = startRe.lastIndex;
        let handlerSrc = null;

        // Pattern A — inline arrow / function expression. Look for an
        // `=>` between here and the first top-level `{`; if present and
        // followed by `{`, that's the body.
        const ahead = src.slice(i, i + 200);
        if (/^(?:async\s+)?(?:\(|function\b)/.test(ahead)) {
            // Skip params: scan to matching ')'
            const parenIdx = src.indexOf('(', i);
            if (parenIdx !== -1) {
                let j = parenIdx + 1;
                let parenDepth = 1;
                while (j < src.length && parenDepth > 0) {
                    if (src[j] === '(') parenDepth++;
                    else if (src[j] === ')') parenDepth--;
                    j++;
                }
                // Skip whitespace + optional `=>`
                while (j < src.length && /\s/.test(src[j])) j++;
                if (src.slice(j, j + 2) === '=>') {
                    j += 2;
                    while (j < src.length && /\s/.test(src[j])) j++;
                }
                if (src[j] === '{') {
                    handlerSrc = extractBracedBlock(src, j);
                }
            }
        } else {
            // Pattern B — bare identifier reference.
            const idMatch = ahead.match(/^([a-zA-Z_$][\w$]*)/);
            if (idMatch) {
                handlerSrc = findFunctionBody(src, idMatch[1]);
            }
        }

        if (handlerSrc) results.push({ name, handlerSrc });
    }
    return results;
}

/**
 * Scan a handler body for `return { ... }` sites whose object literal
 * contains an `error:` field. Returns the list of object-literal source
 * substrings (each starting with `{` and ending with the matching `}`).
 *
 * @param {string} handlerSrc
 * @returns {string[]}
 */
function findReturnErrorSites(handlerSrc) {
    const sites = [];
    const re = /\breturn\s*\{/g;
    let m;
    while ((m = re.exec(handlerSrc)) !== null) {
        const objStart = handlerSrc.indexOf('{', m.index);
        const obj = extractBracedBlock(handlerSrc, objStart);
        if (!obj) continue;
        if (/\berror\s*:/.test(obj)) sites.push(obj);
    }
    return sites;
}

/**
 * Helpers that the conformant handlers delegate to. These functions
 * return failure shapes that propagate up through the handler via
 * `return helper(...)` — the lint cannot trace that flow via regex, so
 * we scan the helper body directly for the same code-field requirement.
 *
 * @type {Record<string, string[]>}
 */
const CONFORMANT_HELPERS = {
    'multifile-tools.js': ['ensureFileActive', '_detectWrongShape'],
    'ci-tools.js': ['projectOrError'],
};

function readToolsFiles() {
    const files = {};
    for (const entry of readdirSync(TOOLS_DIR)) {
        if (!entry.endsWith('.js')) continue;
        files[entry] = readFileSync(join(TOOLS_DIR, entry), 'utf8');
    }
    return files;
}

// ============================================================================
// Case A — every conformant tool's failure returns carry `code:`
// ============================================================================

test('every T1_CONFORMANT_TOOLS handler return-with-error site has a code: field', () => {
    const files = readToolsFiles();
    const missing = [];

    for (const [filename, raw] of Object.entries(files)) {
        const src = stripComments(raw);
        const handlers = resolveHandlers(src);

        for (const { name, handlerSrc } of handlers) {
            if (!T1_CONFORMANT_TOOLS.has(name)) continue;
            const sites = findReturnErrorSites(handlerSrc);
            for (const site of sites) {
                if (!/\bcode\s*:/.test(site)) {
                    missing.push(`${filename}::${name}  ->  ${site.slice(0, 80).replace(/\s+/g, ' ')}…`);
                }
            }
        }

        // Helpers delegated to by conformant handlers (propagation via
        // `return helper(...)` — error escapes the handler body wrapped
        // in a return-identifier, not a literal return-with-error, so
        // the regex above misses it. Scan helpers directly.
        for (const helper of CONFORMANT_HELPERS[filename] || []) {
            const body = findFunctionBody(src, helper);
            if (!body) continue;
            const sites = findReturnErrorSites(body);
            for (const site of sites) {
                if (!/\bcode\s*:/.test(site)) {
                    missing.push(`${filename}::${helper} (helper)  ->  ${site.slice(0, 80).replace(/\s+/g, ' ')}…`);
                }
            }
        }
    }

    assert.deepEqual(
        missing.sort(),
        [],
        `T1 failure-shape contract: the following return-with-error sites are missing a 'code:' field:\n\n  ${missing.sort().join('\n  ')}\n\n` +
        `Per docs/DESIGN-tools.md §"Tool-authored failure shape contract" (2026-05-21), every\n` +
        `tool-side rejection must carry a stable code identifier alongside the human-readable\n` +
        `narration. Add 'code: <valid_code>' from the closed set in this lint's VALID_CODES.`
    );
});

// ============================================================================
// Case B — every `code:` value used in conformant handlers is in VALID_CODES
// ============================================================================

test('every code: value in T1_CONFORMANT_TOOLS handlers is in VALID_CODES', () => {
    const files = readToolsFiles();
    const unknown = [];

    const collectFromBody = (filename, scope, body) => {
        const sites = findReturnErrorSites(body);
        for (const site of sites) {
            const codeMatch = site.match(/\bcode\s*:\s*['"]([a-z_][a-z0-9_]*)['"]/);
            if (!codeMatch) continue;
            const value = codeMatch[1];
            if (!VALID_CODES.has(value)) {
                unknown.push(`${filename}::${scope}  ->  code: '${value}'`);
            }
        }
    };

    for (const [filename, raw] of Object.entries(files)) {
        const src = stripComments(raw);
        const handlers = resolveHandlers(src);

        for (const { name, handlerSrc } of handlers) {
            if (!T1_CONFORMANT_TOOLS.has(name)) continue;
            collectFromBody(filename, name, handlerSrc);
        }

        for (const helper of CONFORMANT_HELPERS[filename] || []) {
            const body = findFunctionBody(src, helper);
            if (!body) continue;
            collectFromBody(filename, `${helper} (helper)`, body);
        }
    }

    assert.deepEqual(
        unknown.sort(),
        [],
        `T1 failure-shape contract: the following code values are not in VALID_CODES:\n\n  ${unknown.sort().join('\n  ')}\n\n` +
        `Either correct the code name or add the new code to VALID_CODES in this lint with a\n` +
        `recovery-shape note. The set is intentionally closed — the loop's per-tool\n` +
        `next_action_hint registry keys on these names.`
    );
});

// ============================================================================
// Case C — regression pin: edit_file stale-line path carries code: 'stale_lines'
// ============================================================================

test('edit_file stale-line failure carries code: \'stale_lines\' (4-6 extra turns per session)', () => {
    const raw = readFileSync(join(TOOLS_DIR, 'multifile-tools.js'), 'utf8');
    const src = stripComments(raw);
    const handlers = resolveHandlers(src);
    const editFile = handlers.find(h => h.name === 'edit_file');
    assert.ok(editFile, 'edit_file handler must be resolvable from multifile-tools.js');

    const occurrences = (editFile.handlerSrc.match(/code:\s*['"]stale_lines['"]/g) || []).length;
    assert.ok(
        occurrences >= 3,
        `edit_file handler must carry code: 'stale_lines' at all three stale-line return sites ` +
        `(replace, insert, delete). Found ${occurrences} occurrence(s). The opaque-rejection ` +
        `bug class (4-6 extra turns per dogfood session per the 2026-05-21 intelligence-layer ` +
        `audit) regresses if these are renamed or dropped.`
    );
});
