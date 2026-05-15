/**
 * `ToolRegistry.register` default-OFF dev warning (gitea#439 / 2.55.0).
 *
 * After the 2.54.0 inversion (gitea#438), profiles enumerate explicit tool
 * names in `tools.admit`. A newly-registered tool admitted by no profile is
 * silently unreachable — recoverable failure mode, but invisible without a
 * surfaced signal. `register()` now scans every profile via
 * `Profiles.findAdmittingProfiles` after the store updates and emits one
 * `console.warn` if the new tool is not admitted anywhere.
 *
 * Acceptance pins (from gitea#439):
 *   - Unadmitted tool → exactly one warn naming the tool + suggesting
 *     `add to profile X.tools.admit`.
 *   - Admitted tool (literal OR `<prefix>__*` glob match) → no warn.
 *   - Re-registration → no warn (existingIdx-branch suppression; HMR /
 *     MCP-reconnect noise antibody).
 *   - `'*'` sentinel does NOT count as admission (full.v1's bypass is
 *     exactly the silent-vanish case this warning surfaces).
 *
 * Pure logic; no DOM/Storage/fetch. Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ToolRegistry } from '../js/tools/registry.js';

// ============================================
// Inline captureWarn — copied idiom from `tests/test-slot-manager.mjs:44-50`
// (no shared test helper module; convention is to inline). Returns the
// captured warning argument tuples and restores `console.warn` even on
// throw.
// ============================================
function captureWarn(fn) {
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => { warnings.push(args); };
    try { fn(); } finally { console.warn = original; }
    return warnings;
}

function defFor(name) {
    return {
        type: 'function',
        function: {
            name,
            description: `Test fixture — ${name}`,
            parameters: { type: 'object', properties: {} },
        },
    };
}

// ============================================
// Unadmitted tool → exactly one warn.
// ============================================

test("register() warns once when tool name is in zero profile admit arrays", () => {
    ToolRegistry.clear();
    const name = 'zz_unadmitted_test_tool';
    const warnings = captureWarn(() => {
        ToolRegistry.register(name, async () => ({}), defFor(name));
    });
    assert.equal(warnings.length, 1, `expected exactly 1 warn; got ${warnings.length}`);
    const msg = warnings[0][0];
    assert.match(msg, /zz_unadmitted_test_tool/, 'warning should name the tool');
    assert.match(msg, /add to profile .*\.tools\.admit/, 'warning should suggest the fix');
});

// ============================================
// Literally-admitted tool → no warn.
// ============================================

test("register() emits no warning when tool name is literally in at least one profile admit", () => {
    ToolRegistry.clear();
    // `read_file` is in chat.v1 / coder.v1 / kb.v1 / subagent.v1 admit lists.
    const warnings = captureWarn(() => {
        ToolRegistry.register('read_file', async () => ({}), defFor('read_file'));
    });
    assert.equal(warnings.length, 0, `expected zero warns; got ${JSON.stringify(warnings)}`);
});

// ============================================
// `mcp__*` glob match → no warn.
// ============================================

test("register() emits no warning when tool name matches a profile's '<prefix>__*' glob", () => {
    ToolRegistry.clear();
    // Picker profiles carry `'mcp__*'` in admit; `mcp__test__synthetic`
    // should match the glob even though no literal entry exists.
    const name = 'mcp__test__synthetic';
    const warnings = captureWarn(() => {
        ToolRegistry.register(name, async () => ({}), defFor(name));
    });
    assert.equal(warnings.length, 0, `expected zero warns; got ${JSON.stringify(warnings)}`);
});

// ============================================
// Re-registration → no additional warn (existingIdx-branch suppression).
// ============================================

test("register() suppresses the admit-coverage scan on re-registration (HMR/MCP-reconnect antibody)", () => {
    ToolRegistry.clear();
    const name = 'zz_unadmitted_reregister_test';
    const warnings = captureWarn(() => {
        // First register — should warn (unadmitted).
        ToolRegistry.register(name, async () => ({}), defFor(name));
        // Re-register the same name — should NOT warn again, even though
        // it's still unadmitted. The first call already surfaced it.
        ToolRegistry.register(name, async () => ({}), defFor(name));
    });
    assert.equal(warnings.length, 1, `expected 1 warn (re-register suppressed); got ${warnings.length}`);
    assert.match(warnings[0][0], /zz_unadmitted_reregister_test/);
});

// ============================================
// `'*'` sentinel must NOT count as admission.
// ============================================

test("register() warns even when full.v1's '*' sentinel would otherwise match (silent-vanish guard)", () => {
    ToolRegistry.clear();
    // Pick a name in no picker / synthetic profile's literal or glob admit.
    // If `'*'` counted, full.v1 would admit and zero warns would fire.
    const name = 'zz_only_admitted_via_star_sentinel';
    const warnings = captureWarn(() => {
        ToolRegistry.register(name, async () => ({}), defFor(name));
    });
    assert.equal(warnings.length, 1, `expected 1 warn (full.v1 '*' must not count); got ${warnings.length}`);
});
