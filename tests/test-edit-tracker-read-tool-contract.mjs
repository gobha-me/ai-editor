/**
 * Anti-regression CI guard: every read tool in `js/tools/*.js` must call
 * `EditTracker.recordRead(` inside its handler body. The staleness clock
 * read by `EditTracker.checkStale` (consumed by `replace_lines` /
 * `insert_lines` / `delete_lines`) only resets when a read tool calls
 * `recordRead` — a missing call leaves the next edit measuring staleness
 * against an older read, even when the model just re-read the file.
 *
 * Why this exists — gitea#485 root cause was exactly that gap. `read_file`
 * at `js/tools/file-tools.js` (added later than its siblings) omitted the
 * `recordRead` call. A qwen-3-6-plus session against HTML-Games burned
 * 5.87M tokens / $3.78 / 149 requests on a 4-file end-screen because the
 * model entered a 30+ iteration loop: re-read, attempt edit, get
 * `Last read was 717s / 728s / 739s ... 1313s ago`, re-read, repeat. Every
 * fresh read returned full content but never reset the clock; eventually
 * the model gave up on `edit_file` and switched to `write_file`, which
 * introduced its own bugs (see HTML-Games PR #278 hotfix).
 *
 * Sibling tools all already call `recordRead`:
 *   - `read_current_file` at `js/tools/file-tools.js`
 *   - `open_file` at `js/tools/file-tools.js`
 *   - `read_lines` at `js/tools/scan-tools.js`
 *
 * The fix at 2.79.0 added the `recordRead` call to `read_file`. This lint
 * pins all four call sites at once so a future rename or new read tool
 * can't silently re-open the gap.
 *
 * Shape: source-scan, mirrors `tests/test-editor-compartment-ordering.mjs`
 * (2.72.0) — read file, `stripComments`, locate the `registry.register('NAME',
 * async (args) => {` boundary, brace-walk to the matching `}`, regex-anchor
 * `EditTracker.recordRead(` inside the extracted body. Same `read file →
 * stripComments → regex-anchor in extracted function body` idiom called out
 * as a settled source-scan-precedent in ROADMAP §"Testing & CI."
 *
 * Runs under `node --test`.
 *
 * @since 2.79.0
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const FILE_TOOLS = join(REPO_ROOT, 'js', 'tools', 'file-tools.js');
const SCAN_TOOLS = join(REPO_ROOT, 'js', 'tools', 'scan-tools.js');

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/**
 * Extract the arrow-function body of `registry.register('NAME', async (...) => { ... }, {...})`.
 * Returns the substring between the matching `{` and `}` of the handler body, or null
 * if no such registration is found.
 */
function extractHandlerBody(src, toolName) {
    const registerRe = new RegExp(
        `registry\\.register\\s*\\(\\s*['"]${toolName}['"]\\s*,\\s*async\\s*\\([^)]*\\)\\s*=>\\s*\\{`,
    );
    const m = registerRe.exec(src);
    if (!m) return null;
    // The matched substring ends at the opening `{` of the handler body.
    const bodyStart = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = bodyStart; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return src.slice(bodyStart, i);
        }
    }
    return null;
}

const TARGETS = [
    { file: FILE_TOOLS, name: 'read_file' },
    { file: FILE_TOOLS, name: 'read_current_file' },
    { file: FILE_TOOLS, name: 'open_file' },
    { file: SCAN_TOOLS, name: 'read_lines' },
];

const RECORD_READ_RE = /EditTracker\.recordRead\s*\(/;

for (const { file, name } of TARGETS) {
    test(`${name} handler calls EditTracker.recordRead`, () => {
        const src = stripComments(readFileSync(file, 'utf8'));
        const body = extractHandlerBody(src, name);
        assert.ok(
            body,
            `Could not locate registry.register('${name}', async (...) => { ... }) in ${file}. ` +
            `If the registration shape changed (named handler, sync function, different argument shape), ` +
            `update extractHandlerBody in this test.`,
        );
        assert.match(
            body,
            RECORD_READ_RE,
            `${name} handler body must call EditTracker.recordRead(...) so that EditTracker.checkStale ` +
            `measures staleness from this read — not from a prior read whose content the model has ` +
            `already seen and superseded. Missing this call reproduces gitea#485 (loop until exhaustion).`,
        );
    });
}
