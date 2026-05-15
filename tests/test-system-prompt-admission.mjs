/**
 * Tests for the dynamic tool enumeration in `js/prompts.js`.
 *
 * **1.3.15** — System-prompt admission alignment for the Composer-active
 * coder path; the prompt's tool enumeration matches the Composer's admitted
 * `ToolDef[]` (`Catalog.getById` projection — flat `{name, description}`).
 *
 * **2.35.0 — `LEGACY_TOOL_ENUMERATION` retired** (2026-Q2 audit sweep).
 * Pre-2.35.0 the non-Composer path (kill-switch `?toolsCompose=off`,
 * non-coder profiles, no-arg callers like `generateEdit`) rendered a
 * hardcoded 24-bullet string that drifted as the registry grew —
 * `git_log` (1.5.x), CI tools (1.4.5), memory tools (1.16.0), preview
 * Tier 3a (2.10.0) and others were silently invisible. The branch now
 * derives the enumeration from `Profiles.filterTools(ToolRegistry
 * .getDefinitions(), profileName)`, matching the API tools-array
 * `getToolsForRole()` already publishes via the same filter.
 *
 * **2.51.0 — line shape switched to category-grouped TOC.** The pre-2.51.0
 * `- <description> (<name>)` bullets become `<name>, <name> — <category>`
 * lines per gitea#426. Per-tool descriptions are no longer redundantly
 * carried in the prompt; the OpenAI tools-array already carries them.
 * The positive assertions here grep the admitted names within the
 * enumeration block; description-in-prompt assertions have been removed.
 *
 * Tests cover:
 *   - **Composer-active branch** — unchanged from 1.3.15: enumerates exactly
 *     the admitted set, no leakage of non-admitted names.
 *   - **Non-Composer branch (post-2.35.0)** — projects registered defs into
 *     the renderer shape; empty-registry → empty-state line; profile
 *     filtering respected (a `coder`-only tool never appears for chat.v1).
 *   - **Drift catch** — the pre-2.35.0 hardcoded string content does NOT
 *     surface anywhere when nothing matches the new derivation path.
 *   - **Scratchpad-block admission gate** — block renders iff
 *     `scratchpad_write` is in the admitted set on both branches.
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSystemPrompt } from '../js/prompts.js';
import { ToolRegistry } from '../js/tools/registry.js';

// ============================================
// Fixture admitted set — flat `{name, description}` shape, mirroring the
// Composer's `Catalog.getById` output. Six essentials from
// `coder.v1.tools.static`.
// ============================================

const ADMITTED_FIXTURE = [
    { name: 'read_file', description: 'Read the full content of a file.' },
    { name: 'read_lines', description: 'Read a line range.' },
    { name: 'scan_file', description: 'Scan a file for top-level symbols.' },
    { name: 'edit_file', description: 'Edit a file by line range.' },
    { name: 'commit_files', description: 'Commit staged files.' },
    { name: 'list_dirty_files', description: 'List uncommitted files.' },
];

const ADMITTED_NAMES = new Set(ADMITTED_FIXTURE.map(td => td.name));

// Tool names hardcoded in the pre-1.3.15 enumeration. None of these should
// leak into the dynamic-mode prompt unless admitted, AND none of them
// should appear in the non-Composer prompt unless we register them on the
// in-memory ToolRegistry in a test (because the hardcoded string is gone).
const LEGACY_TOOL_NAMES = [
    'read_current_file', 'read_lines', 'replace_lines', 'insert_lines', 'delete_lines',
    'edit_file', 'write_file', 'get_project_tree', 'open_file', 'read_file',
    'list_open_tabs', 'create_file', 'search_in_files', 'find_relevant_files',
    'create_pull_request', 'list_pull_requests', 'commit_files', 'list_dirty_files',
    'list_projects', 'set_active_project', 'peek_project_tree', 'peek_project_file',
    'scratchpad_write', 'scratchpad_read', 'scratchpad_clear', 'run_code',
];
const DEAD_NAMES_REMOVED = ['read_issue', 'search_project'];

// Snippet copied verbatim from the pre-2.35.0 LEGACY_TOOL_ENUMERATION —
// must NOT appear in any rendered prompt now that the constant is retired.
const PRE_2_35_0_HARDCODED_PHRASE = '— PREFERRED for large files';

// Test-only tool def in the OpenAI-tool-schema shape that `ToolRegistry`
// stores. 2.54.0 (gitea#438) — the `roles` field is retired; admission
// is keyed off the function name vs. the active profile's `tools.admit`
// list, so test fakes register under production-admitted names.
function defFor(name, _legacyRolesIgnored, description) {
    return {
        function: {
            name,
            description: description || `Test tool ${name}.`,
            parameters: { type: 'object', properties: {} },
        },
    };
}

// Ensure the registry is empty after each test that mutates it.
function cleanRegistry() {
    const names = ToolRegistry.getDefinitions().map(d => d.function && d.function.name).filter(Boolean);
    for (const n of names) ToolRegistry.unregister(n);
}

// ============================================
// Composer-active branch — 1.3.15 behavior preserved
// ============================================

// Slice the enumeration block out of a rendered prompt. Pre-2.51.0 the
// upper bound was '📝 SCRATCHPAD' (which only appears when scratchpad_write
// is admitted); post-2.51.0 the TOC is always followed by '🚨 EFFICIENCY
// RULES' regardless. Try both for forward compat with future template
// reshuffles.
function enumerationBlock(prompt) {
    const afterPreamble = prompt.split('You have access to these tools:')[1] || '';
    const upper = afterPreamble.indexOf('📝 SCRATCHPAD');
    const fallback = afterPreamble.indexOf('🚨');
    const end = upper >= 0 ? upper : (fallback >= 0 ? fallback : afterPreamble.length);
    return afterPreamble.slice(0, end);
}

// 2.51.0 TOC line shape: `  name1, name2, name3 — <category label>`. The
// per-tool word-boundary check survives the shape change AND any later
// shape change that still embeds the canonical name (e.g. back to per-tool
// bullets, or to a JSON-shaped table). Tests that pinned `(${name})` were
// reading the wrong invariant.
function nameAppearsInBlock(block, name) {
    return new RegExp(`(?:^|[\\s,])${name}(?:[\\s,]|$)`, 'm').test(block);
}

test('buildSystemPrompt Composer-active mode enumerates exactly the admitted names', () => {
    const prompt = buildSystemPrompt({ admittedDefs: ADMITTED_FIXTURE, composerActive: true });
    const block = enumerationBlock(prompt);
    for (const td of ADMITTED_FIXTURE) {
        assert.ok(
            nameAppearsInBlock(block, td.name),
            `expected enumeration to include "${td.name}" as a word, but it did not`
        );
    }
});

test('buildSystemPrompt Composer-active mode does NOT enumerate non-admitted legacy names', () => {
    const prompt = buildSystemPrompt({ admittedDefs: ADMITTED_FIXTURE, composerActive: true });
    const block = enumerationBlock(prompt);
    for (const name of LEGACY_TOOL_NAMES) {
        if (ADMITTED_NAMES.has(name)) continue;
        assert.ok(
            !nameAppearsInBlock(block, name),
            `enumeration leaked non-admitted tool "${name}" — drift gap reopened`
        );
    }
});

test('drift catch: Composer-active prompt body never word-mentions a non-admitted legacy tool', () => {
    const prompt = buildSystemPrompt({ admittedDefs: ADMITTED_FIXTURE, composerActive: true });
    for (const name of LEGACY_TOOL_NAMES) {
        if (ADMITTED_NAMES.has(name)) continue;
        const re = new RegExp(`\\b${name}\\b`);
        assert.ok(
            !re.test(prompt),
            `prompt contains stray reference to non-admitted tool "${name}" — drift gap reopened`
        );
    }
});

test('Composer-active mode renders the empty-state line when admittedDefs is []', () => {
    const prompt = buildSystemPrompt({ admittedDefs: [], composerActive: true });
    assert.ok(prompt.includes('no tools currently admitted'));
});

// ============================================
// Non-Composer branch — 2.35.0 derivation
// ============================================

test('non-Composer mode renders empty-state line when ToolRegistry has no admitted defs', () => {
    cleanRegistry();
    const prompt = buildSystemPrompt({ composerActive: false });
    assert.ok(
        prompt.includes('no tools currently admitted'),
        'empty registry → empty-state enumeration on the non-Composer branch'
    );
});

test('non-Composer mode enumerates registered tools admitted to the active profile (chat.v1 default)', () => {
    cleanRegistry();
    // 2.54.0 (gitea#438) — admission is name-based. `read_file` is in
    // chat.v1.admit so a test registration under that name surfaces.
    ToolRegistry.register('read_file', () => {}, defFor('read_file', null, 'A universally-admitted test tool.'));
    try {
        const prompt = buildSystemPrompt({ composerActive: false });
        const block = enumerationBlock(prompt);
        assert.ok(
            nameAppearsInBlock(block, 'read_file'),
            'chat.v1.admit entry must surface in the chat.v1 enumeration'
        );
        // 2.51.0 — per-tool descriptions are no longer carried in the prompt
        // body (they live on the API tools-array). The description-in-prompt
        // assertion that lived here pre-2.51.0 has been removed; the name
        // assertion above is the load-bearing check.
    } finally {
        cleanRegistry();
    }
});

test('non-Composer mode respects profile filtering — coder-only tools do NOT appear for chat.v1', () => {
    cleanRegistry();
    // 2.54.0 (gitea#438) — name-based gate. `commit_files` is admitted
    // by coder.v1 only; `create_issue` is in chat.v1.admit (carries pm
    // surface). Both register; only the chat-admitted name surfaces.
    ToolRegistry.register('commit_files', () => {}, defFor('commit_files', null, 'Coder-only test tool (NOT in chat.v1.admit).'));
    ToolRegistry.register('create_issue', () => {}, defFor('create_issue', null, 'PM-visible test tool (in chat.v1.admit).'));
    try {
        const prompt = buildSystemPrompt({ composerActive: false });
        const block = enumerationBlock(prompt);
        assert.ok(
            !nameAppearsInBlock(block, 'commit_files'),
            'coder-only name must be filtered out for chat.v1 (not in chat.v1.admit)'
        );
        assert.ok(
            nameAppearsInBlock(block, 'create_issue'),
            'pm-surface name in chat.v1.admit must appear under chat.v1'
        );
    } finally {
        cleanRegistry();
    }
});

test('non-Composer mode does NOT leak the pre-2.35.0 hardcoded enumeration string', () => {
    cleanRegistry();
    const prompt = buildSystemPrompt({ composerActive: false });
    assert.ok(
        !prompt.includes(PRE_2_35_0_HARDCODED_PHRASE),
        'the retired LEGACY_TOOL_ENUMERATION phrase must not appear in any rendered prompt'
    );
});

test('no-args call (legacy generateEdit / commit-message path) goes through the non-Composer derivation', () => {
    cleanRegistry();
    // Use a chat.v1.admit name so the gate passes.
    ToolRegistry.register('read_file', () => {}, defFor('read_file', null));
    try {
        const prompt = buildSystemPrompt();
        const block = enumerationBlock(prompt);
        assert.ok(
            nameAppearsInBlock(block, 'read_file'),
            'no-args call must derive the enumeration, not skip it'
        );
    } finally {
        cleanRegistry();
    }
});

// ============================================
// Dead-reference removal — invariant across both branches
// ============================================

test('dead references read_issue and search_project no longer appear in any mode', () => {
    cleanRegistry();
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
// Scratchpad-block admission gate — uniform across branches
// ============================================

test('scratchpad instruction block renders when scratchpad_write is in the admitted set', () => {
    // Composer-active branch
    const promptDyn = buildSystemPrompt({
        admittedDefs: [...ADMITTED_FIXTURE, { name: 'scratchpad_write', description: 'Write to scratchpad.' }],
        composerActive: true,
    });
    assert.ok(promptDyn.includes('SCRATCHPAD'), 'block must render when scratchpad_write is admitted (Composer branch)');

    // Non-Composer branch
    cleanRegistry();
    ToolRegistry.register('scratchpad_write', () => {}, defFor('scratchpad_write', null, 'Persist notes to a scratchpad.'));
    try {
        const promptLeg = buildSystemPrompt({ composerActive: false });
        assert.ok(promptLeg.includes('SCRATCHPAD'), 'block must render when scratchpad_write is admitted (non-Composer branch)');
    } finally {
        cleanRegistry();
    }
});

test('scratchpad instruction block does NOT render when scratchpad_write is not in the admitted set', () => {
    // Composer-active branch with no scratchpad_write
    const promptDyn = buildSystemPrompt({ admittedDefs: ADMITTED_FIXTURE, composerActive: true });
    assert.ok(!promptDyn.includes('SCRATCHPAD'), 'block must NOT render when scratchpad_write is absent (Composer branch)');

    // Non-Composer branch with empty registry
    cleanRegistry();
    const promptLeg = buildSystemPrompt({ composerActive: false });
    assert.ok(!promptLeg.includes('SCRATCHPAD'), 'block must NOT render when scratchpad_write is absent (non-Composer branch)');
});
