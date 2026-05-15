/**
 * Tests for the compact tools-table-of-contents in `js/prompts.js`.
 *
 * **2.51.0** — `renderToolEnumeration` switched from per-tool bullets
 * (`- <description> (<name>)`) to a category-grouped TOC:
 *
 *   TOOLS (N admitted):
 *     name, name, name — <category short label>
 *     name — <category short label>
 *
 * Origin: gitea#426 — 2026-05-14 AAR of a `qwen-3-6-plus` session against
 * `xcaliber/HTML-Games#215` observed the model burning 5–6 requests /
 * ~5k tokens just discovering its admitted tool set. The TOC eliminates
 * the routine discovery loop (the schema is the *reference*; the TOC is
 * the *directory*).
 *
 * Tests cover:
 *   - **Shape pin** — multi-category admission renders the expected header
 *     and grouped per-category lines in alphabetical order.
 *   - **Empty-state** — zero-admit produces `TOOLS (0 admitted):` plus the
 *     preserved empty-state line.
 *   - **Single-tool** — one-tool admit reuses the same line shape.
 *   - **Token budget** — a realistic 22-tool admission stays under ~250
 *     tokens (~25% headroom over the issue's 200-token target).
 *   - **Misc fallback** — a tool absent from the live registry lands
 *     under `misc` rather than crashing the renderer.
 *   - **Alphabetical category order** — diverse admission orders by
 *     category slug, not admission order.
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSystemPrompt } from '../js/prompts.js';
import { ToolRegistry } from '../js/tools/registry.js';

function defFor(name, roles, description) {
    return {
        function: {
            name,
            description: description || `Test tool ${name}.`,
            parameters: { type: 'object', properties: {} },
        },
        roles,
    };
}

function cleanRegistry() {
    const names = ToolRegistry.getDefinitions().map(d => d.function && d.function.name).filter(Boolean);
    for (const n of names) ToolRegistry.unregister(n);
}

// Slice the TOC block out of a rendered prompt. The TOC sits between the
// "You have access to these tools:" preamble and the next prompt section
// ('📝 SCRATCHPAD' when scratchpad_write is admitted, else '🚨 EFFICIENCY').
function tocBlock(prompt) {
    const afterPreamble = prompt.split('You have access to these tools:')[1] || '';
    const upper = afterPreamble.indexOf('📝 SCRATCHPAD');
    const fallback = afterPreamble.indexOf('🚨');
    const end = upper >= 0 ? upper : (fallback >= 0 ? fallback : afterPreamble.length);
    return afterPreamble.slice(0, end);
}

test('TOC: header line carries the admitted count', () => {
    cleanRegistry();
    const admittedDefs = [
        { name: 'read_file', description: 'Read a file.' },
        { name: 'read_lines', description: 'Read a line range.' },
        { name: 'edit_file', description: 'Edit a file.' },
    ];
    const prompt = buildSystemPrompt({ admittedDefs, composerActive: true });
    assert.ok(prompt.includes('TOOLS (3 admitted):'), 'header should report admitted count');
});

test('TOC: multi-category admission groups names per category, one line per category', () => {
    cleanRegistry();
    // Populate the registry so the renderer's category lookups resolve to
    // real CATEGORY_BY_NAME entries (not 'misc').
    for (const n of ['read_file', 'read_lines', 'edit_file', 'commit_files']) {
        ToolRegistry.register(n, () => {}, defFor(n, 'all'));
    }
    try {
        const admittedDefs = [
            { name: 'read_file', description: 'Read a file.' },
            { name: 'read_lines', description: 'Read a line range.' },
            { name: 'edit_file', description: 'Edit a file.' },
            { name: 'commit_files', description: 'Commit files.' },
        ];
        const prompt = buildSystemPrompt({ admittedDefs, composerActive: true });
        const toc = tocBlock(prompt);

        // Names grouped together under their shared category.
        assert.ok(toc.includes('read_file, read_lines'), 'two-read tools should share one category line');
        // edit_file and commit_files are alone in their respective categories.
        assert.ok(/\bedit_file\s+—/.test(toc), 'edit_file should sit on its own category line with em-dash separator');
        assert.ok(/\bcommit_files\s+—/.test(toc), 'commit_files should sit on its own category line with em-dash separator');
    } finally {
        cleanRegistry();
    }
});

test('TOC: empty admission renders the preserved empty-state line', () => {
    cleanRegistry();
    const prompt = buildSystemPrompt({ admittedDefs: [], composerActive: true });
    assert.ok(prompt.includes('TOOLS (0 admitted):'), 'empty-state header still reports the count');
    assert.ok(
        prompt.includes('no tools currently admitted'),
        'pre-existing empty-state diagnostic line should survive the shape change'
    );
});

test('TOC: single-tool admission renders a single category line', () => {
    cleanRegistry();
    ToolRegistry.register('read_file', () => {}, defFor('read_file', 'all'));
    try {
        const prompt = buildSystemPrompt({
            admittedDefs: [{ name: 'read_file', description: 'Read a file.' }],
            composerActive: true,
        });
        assert.ok(prompt.includes('TOOLS (1 admitted):'));
        const toc = tocBlock(prompt);
        // Exactly one category line — count `\n  ` indent prefixes inside the
        // TOC body (header + one indented line).
        const indentedLines = toc.split('\n').filter(l => l.startsWith('  ') && l.trim().length > 0);
        assert.equal(indentedLines.length, 1, 'expected exactly one category line');
        assert.ok(/\bread_file\s+—/.test(indentedLines[0]), 'category line shape includes the name + em-dash');
    } finally {
        cleanRegistry();
    }
});

test('TOC: token budget — 22-tool fixture stays under ~250 tokens (25% headroom over the 200-token target)', () => {
    cleanRegistry();
    const fixture = [
        'read_file', 'read_lines', 'read_current_file', 'read_function',
        'edit_file', 'replace_lines', 'insert_lines', 'delete_lines',
        'create_file', 'write_file', 'delete_file',
        'scan_file', 'search_in_files', 'find_relevant_files',
        'open_file', 'list_open_tabs',
        'get_project_tree', 'commit_files', 'list_dirty_files',
        'scratchpad_write', 'scratchpad_read', 'find_tool',
    ];
    for (const n of fixture) {
        ToolRegistry.register(n, () => {}, defFor(n, 'all', `Description for ${n}.`));
    }
    try {
        const admittedDefs = fixture.map(n => ({ name: n, description: `Description for ${n}.` }));
        const prompt = buildSystemPrompt({ admittedDefs, composerActive: true });
        const toc = tocBlock(prompt);
        // Add back the "TOOLS (" prefix length the splitter dropped.
        const tocChars = 'TOOLS ('.length + toc.length;
        const approxTokens = Math.ceil(tocChars / 4);
        assert.ok(
            approxTokens < 250,
            `TOC block ~${approxTokens} tokens — exceeded the 250-token budget; renderer regressed to a verbose shape`
        );
    } finally {
        cleanRegistry();
    }
});

test('TOC: unregistered tool name falls back to misc category', () => {
    cleanRegistry();
    // No ToolRegistry.register call — Catalog.listAll() returns empty, every
    // admitted name should land under 'misc' to surface the gap.
    const prompt = buildSystemPrompt({
        admittedDefs: [{ name: 'totally_unknown_tool', description: 'Unknown.' }],
        composerActive: true,
    });
    const toc = tocBlock(prompt);
    assert.ok(toc.includes('totally_unknown_tool'), 'name should still appear in the TOC');
    assert.ok(toc.includes('misc'), 'unregistered tool should land in the misc category fallback');
});

test('TOC: categories ordered alphabetically across diverse admission', () => {
    cleanRegistry();
    // Register one tool per category — meta, code.file.read, code.git.pr,
    // scratchpad — and admit them in a non-alphabetical order. The TOC must
    // re-sort by category slug.
    ToolRegistry.register('list_tool_categories', () => {}, defFor('list_tool_categories', 'all'));
    ToolRegistry.register('read_file', () => {}, defFor('read_file', 'all'));
    ToolRegistry.register('create_pull_request', () => {}, defFor('create_pull_request', 'all'));
    ToolRegistry.register('scratchpad_write', () => {}, defFor('scratchpad_write', 'all'));
    try {
        const admittedDefs = [
            { name: 'scratchpad_write', description: 'sp' },
            { name: 'read_file', description: 'rf' },
            { name: 'create_pull_request', description: 'pr' },
            { name: 'list_tool_categories', description: 'meta' },
        ];
        const prompt = buildSystemPrompt({ admittedDefs, composerActive: true });
        const toc = tocBlock(prompt);
        // Expected order: code.file.read, code.git.pr, meta, scratchpad.
        const expected = ['read_file', 'create_pull_request', 'list_tool_categories', 'scratchpad_write'];
        const positions = expected.map(n => toc.indexOf(n));
        for (let i = 0; i < positions.length; i++) {
            assert.ok(positions[i] >= 0, `name "${expected[i]}" should appear in the TOC`);
        }
        for (let i = 1; i < positions.length; i++) {
            assert.ok(
                positions[i] > positions[i - 1],
                `expected "${expected[i]}" after "${expected[i - 1]}" (alphabetical category order); got positions ${JSON.stringify(positions)}`
            );
        }
    } finally {
        cleanRegistry();
    }
});
