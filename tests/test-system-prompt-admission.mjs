/**
 * Tests for the dynamic tool enumeration in `js/prompts.js` (1.3.15 —
 * System-prompt admission alignment, prereq for 1.3.16 meta-tools).
 *
 * Asserts:
 *   - When the Composer is active and admitted ToolDefs are passed, the
 *     system prompt enumerates exactly those names.
 *   - When the Composer is bypassed (`composerActive: false`) or the call
 *     site doesn't pass admittedDefs, the prompt falls back to the legacy
 *     21-tool enumeration.
 *   - Drift catch: every legacy tool name absent from the admitted set is
 *     also absent from the rendered prompt.
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSystemPrompt } from '../js/prompts.js';

// ============================================
// Fixture admitted set — mirrors the 6 essentials from
// CODER_V1.tools.static that the Composer admits in 1.3.14.
// ============================================

const ADMITTED_FIXTURE = [
    { name: 'read_file', description: 'Read the full content of a file.' },
    { name: 'read_lines', description: 'Read a line range.' },
    { name: 'scan_file', description: 'Scan a file for top-level symbols.' },
    { name: 'edit_file', description: 'Edit a file by line range.' },
    { name: 'commit_files', description: 'Commit staged files.' },
    { name: 'list_dirty_files', description: 'List uncommitted files.' },
];

// The 21 tool names hardcoded in the pre-1.3.15 enumeration, plus the two
// dead references (`read_issue`, `search_project`) that 1.3.15 removed
// from the issue/triage blocks. The drift test asserts none of these
// (other than the admitted ones) appear in the dynamic-mode prompt.
const LEGACY_TOOL_NAMES = [
    'read_current_file', 'read_lines', 'replace_lines', 'insert_lines', 'delete_lines',
    'edit_file', 'write_file', 'get_project_tree', 'open_file', 'read_file',
    'list_open_tabs', 'create_file', 'search_in_files', 'find_relevant_files',
    'create_pull_request', 'list_pull_requests', 'commit_files', 'list_dirty_files',
    'list_projects', 'set_active_project', 'peek_project_tree', 'peek_project_file',
    'scratchpad_write', 'scratchpad_read', 'scratchpad_clear', 'run_code',
];
const DEAD_NAMES_REMOVED = ['read_issue', 'search_project'];

const ADMITTED_NAMES = new Set(ADMITTED_FIXTURE.map(td => td.name));

// ============================================
// Dynamic mode — Composer active
// ============================================

test('buildSystemPrompt dynamic mode enumerates exactly the admitted names', () => {
    const prompt = buildSystemPrompt({ admittedDefs: ADMITTED_FIXTURE, composerActive: true });

    for (const td of ADMITTED_FIXTURE) {
        assert.ok(
            prompt.includes(`(${td.name})`),
            `expected enumeration to include "(${td.name})", but it did not`
        );
    }
});

test('buildSystemPrompt dynamic mode does NOT enumerate non-admitted legacy names', () => {
    const prompt = buildSystemPrompt({ admittedDefs: ADMITTED_FIXTURE, composerActive: true });

    // Carve out a slice that's specifically the enumeration block —
    // narrow regex looking for the bullet pattern at the top of the prompt.
    // Anything outside of "(name)" parens elsewhere in the prompt body is
    // covered by the broader drift test below.
    const enumerationBlock = prompt.split('You have access to these tools:')[1].split('📝 SCRATCHPAD')[0];

    for (const name of LEGACY_TOOL_NAMES) {
        if (ADMITTED_NAMES.has(name)) continue;
        assert.ok(
            !enumerationBlock.includes(`(${name})`),
            `enumeration leaked non-admitted tool "(${name})" — drift gap reopened`
        );
    }
});

// ============================================
// Legacy fallback — Composer bypassed / no args
// ============================================

test('buildSystemPrompt with composerActive=false falls back to legacy enumeration', () => {
    const prompt = buildSystemPrompt({ composerActive: false });
    // The legacy block is the canonical 21-tool enumeration. A handful of
    // representative names that 1.3.14 *removed* from coder admission but
    // the legacy block still lists.
    assert.ok(prompt.includes('find_relevant_files'), 'legacy block should mention find_relevant_files');
    assert.ok(prompt.includes('peek_project_tree'), 'legacy block should mention peek_project_tree');
    assert.ok(prompt.includes('scratchpad_write'), 'legacy block should mention scratchpad_write');
    assert.ok(prompt.includes('list_projects'), 'legacy block should mention list_projects');
});

test('buildSystemPrompt with no args falls back to legacy enumeration', () => {
    // Backwards-compat — generateEdit / analyzeIssue call buildSystemPrompt()
    // with no opts. The legacy block must still render.
    const prompt = buildSystemPrompt();
    assert.ok(prompt.includes('find_relevant_files'));
    assert.ok(prompt.includes('peek_project_tree'));
});

// ============================================
// Drift catch — across the whole prompt body
// ============================================

test('drift catch: dynamic-mode prompt body never word-mentions a non-admitted legacy tool', () => {
    const prompt = buildSystemPrompt({ admittedDefs: ADMITTED_FIXTURE, composerActive: true });

    for (const name of LEGACY_TOOL_NAMES) {
        if (ADMITTED_NAMES.has(name)) continue;
        const re = new RegExp(`\\b${name.replace(/_/g, '_')}\\b`);
        assert.ok(
            !re.test(prompt),
            `prompt contains stray reference to non-admitted tool "${name}" — drift gap reopened`
        );
    }
});

test('dead references read_issue and search_project no longer appear in any mode', () => {
    for (const opts of [{}, { composerActive: false }, { admittedDefs: ADMITTED_FIXTURE, composerActive: true }]) {
        const prompt = buildSystemPrompt(opts);
        for (const dead of DEAD_NAMES_REMOVED) {
            assert.ok(
                !prompt.includes(dead),
                `prompt rendered with ${JSON.stringify(opts)} still references removed name "${dead}"`
            );
        }
    }
});

// ============================================
// Empty-admitted edge case
// ============================================

test('buildSystemPrompt with empty admittedDefs renders the empty-state line', () => {
    const prompt = buildSystemPrompt({ admittedDefs: [], composerActive: true });
    assert.ok(prompt.includes('no tools currently admitted'));
});
