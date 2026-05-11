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
// stores. The `roles` field is normalized to `_registeredRoles` on register.
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

// Ensure the registry is empty after each test that mutates it.
function cleanRegistry() {
    const names = ToolRegistry.getDefinitions().map(d => d.function && d.function.name).filter(Boolean);
    for (const n of names) ToolRegistry.unregister(n);
}

// ============================================
// Composer-active branch — 1.3.15 behavior preserved
// ============================================

test('buildSystemPrompt Composer-active mode enumerates exactly the admitted names', () => {
    const prompt = buildSystemPrompt({ admittedDefs: ADMITTED_FIXTURE, composerActive: true });
    for (const td of ADMITTED_FIXTURE) {
        assert.ok(
            prompt.includes(`(${td.name})`),
            `expected enumeration to include "(${td.name})", but it did not`
        );
    }
});

test('buildSystemPrompt Composer-active mode does NOT enumerate non-admitted legacy names', () => {
    const prompt = buildSystemPrompt({ admittedDefs: ADMITTED_FIXTURE, composerActive: true });
    const enumerationBlock = prompt.split('You have access to these tools:')[1].split('📝 SCRATCHPAD')[0];
    for (const name of LEGACY_TOOL_NAMES) {
        if (ADMITTED_NAMES.has(name)) continue;
        assert.ok(
            !enumerationBlock.includes(`(${name})`),
            `enumeration leaked non-admitted tool "(${name})" — drift gap reopened`
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
    // chat.v1 admits any tool tagged roles: 'all' (filterTools short-circuit).
    ToolRegistry.register('fake_universal_tool', () => {}, defFor('fake_universal_tool', 'all', 'A universally-admitted test tool.'));
    try {
        const prompt = buildSystemPrompt({ composerActive: false });
        assert.ok(prompt.includes('(fake_universal_tool)'), 'all-tagged tool should appear in the chat.v1 enumeration');
        assert.ok(prompt.includes('A universally-admitted test tool.'), 'description should appear alongside the name');
    } finally {
        cleanRegistry();
    }
});

test('non-Composer mode respects profile filtering — coder-only tools do NOT appear for chat.v1', () => {
    cleanRegistry();
    ToolRegistry.register('fake_coder_only', () => {}, defFor('fake_coder_only', ['coder'], 'Coder-only test tool.'));
    ToolRegistry.register('fake_pm_visible', () => {}, defFor('fake_pm_visible', ['pm'], 'PM-visible test tool.'));
    try {
        const prompt = buildSystemPrompt({ composerActive: false });
        assert.ok(!prompt.includes('(fake_coder_only)'), 'coder-only tool must be filtered out for chat.v1');
        // chat.v1's allowed_groups includes 'pm' (per js/profiles/chat-v1.js)
        // — the pm-tagged tool surfaces.
        assert.ok(prompt.includes('(fake_pm_visible)'), 'pm-tagged tool must appear under chat.v1');
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
    ToolRegistry.register('noargs_probe_tool', () => {}, defFor('noargs_probe_tool', 'all'));
    try {
        const prompt = buildSystemPrompt();
        assert.ok(prompt.includes('(noargs_probe_tool)'), 'no-args call must derive the enumeration, not skip it');
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
    ToolRegistry.register('scratchpad_write', () => {}, defFor('scratchpad_write', 'all', 'Persist notes to a scratchpad.'));
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
