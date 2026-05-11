/**
 * Phase 4 anti-regression coverage — asserts the inline-handlers migration
 * stays migrated. After Phases 1–3b (shipped 2.27.0 → 2.31.0), every
 * `onclick=` in html/* + js/ui/* + js/chat/messages.js was retired in favor
 * of `data-action=` + a delegated mount listener. This test fails if any
 * future PR sneaks an inline `onclick=` back in.
 *
 * See docs/DESIGN-html-inline-handlers-migration.md §Phase 4.
 *
 * Scope:
 *  - html/ : every .html template must be onclick-free. The 5 dispatchers
 *    cover every interactive element previously wired here.
 *  - js/   : JS-rendered HTML strings that include inline `onclick="…"` are
 *    flagged. Non-onclick inline handlers (`ondblclick=`, `onchange=`,
 *    `onkeydown=`) are intentionally out of Phase 3's scope and skipped.
 *
 * The remaining `window.*` aliases in js/app.js exist precisely to serve
 * those out-of-scope residuals. Removing the residuals (a future patch)
 * lets the corresponding aliases retire too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = new URL('../', import.meta.url).pathname;

function walk(dir, exts) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
            if (name === 'node_modules' || name === 'vendor') continue;
            out.push(...walk(full, exts));
        } else if (exts.some(e => name.endsWith(e))) {
            out.push(full);
        }
    }
    return out;
}

function scan(files, pattern, { skipCommentLines = false } = {}) {
    const offenders = [];
    for (const file of files) {
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
            if (skipCommentLines) {
                const t = line.trimStart();
                if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
            }
            if (pattern.test(line)) {
                offenders.push(`${file.slice(REPO_ROOT.length)}:${i + 1}: ${line.trim()}`);
            }
        });
    }
    return offenders;
}

test('html/*.html contains no inline onclick=', () => {
    const files = walk(join(REPO_ROOT, 'html'), ['.html']);
    const offenders = scan(files, /\bonclick\s*=/i);
    assert.equal(
        offenders.length,
        0,
        `Inline onclick= attribute(s) found — migrate to data-action + delegated listener (see docs/DESIGN-html-inline-handlers-migration.md):\n${offenders.join('\n')}`,
    );
});

test('js/ JS-rendered HTML strings contain no inline onclick=', () => {
    const files = walk(join(REPO_ROOT, 'js'), ['.js']);
    const offenders = scan(files, /onclick\s*=\s*["'`]/, { skipCommentLines: true });
    assert.equal(
        offenders.length,
        0,
        `JS-rendered inline onclick= found — route through mountXxx() data-action dispatcher instead:\n${offenders.join('\n')}`,
    );
});
