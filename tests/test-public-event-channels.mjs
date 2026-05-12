/**
 * Tests for the `PUBLIC_EVENT_CHANNELS` registry — the documented set of
 * EventBus channels that plugins (and other third-party consumers) may
 * subscribe to.
 *
 * **2.39.0.0 (2026-Q2 audit sweep, slice 1)** — the pre-2.39.0.0 plugin-dev
 * profile addendum at `js/profiles/plugin-dev-v1.js:151-159` hand-listed
 * the public channels inside a system-prompt template literal. That string
 * (a) contained 6 misleading entries (`file:created`/`file:deleted`/
 * `file:renamed` claimed under "Files", `issues:loaded`/`issue:created`/
 * `issue:updated` claimed under "Issues") that were never emitted by any
 * module in `js/`, and (b) silently drifted from the actual emit sites
 * because nothing pulled them from a single source.
 *
 * `PUBLIC_EVENT_CHANNELS` (`js/events/public-channels.js`) is now the
 * source of truth; `renderPublicEventChannels()` projects it into the
 * plugin-dev addendum at module-load time. This test pins:
 *
 *   - the registry's frozen shape;
 *   - the `renderPublicEventChannels` projection;
 *   - documents the 4 audit-inventory clusters whose channels were flagged
 *     as "0 internal subscribers" — plugin lifecycle, `editor:lines*`,
 *     `ghostText:*`, `mergeConflict:*` — as intentional extension points;
 *   - a codebase-parity guard: every registry entry has at least one
 *     `EventBus.emit('X'` call in `js/`. Drifting either way trips the test.
 *
 * Pure-logic plus a one-shot filesystem walk for the parity guard.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    PUBLIC_EVENT_CHANNELS,
    GROUP_LABELS,
    renderPublicEventChannels,
    forSlot,
} from '../js/events/public-channels.js';
import { PLUGIN_DEV_SYSTEM_PROMPT } from '../js/profiles/plugin-dev-v1.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const JS_ROOT = join(__dirname, '..', 'js');

// ============================================
// Registry shape
// ============================================

test('PUBLIC_EVENT_CHANNELS — top-level object is frozen', () => {
    assert.ok(Object.isFrozen(PUBLIC_EVENT_CHANNELS));
});

test('PUBLIC_EVENT_CHANNELS — each group array is frozen', () => {
    for (const [key, entries] of Object.entries(PUBLIC_EVENT_CHANNELS)) {
        assert.ok(Array.isArray(entries), `${key} should be an array`);
        assert.ok(Object.isFrozen(entries), `${key} array should be frozen`);
        for (const entry of entries) {
            assert.ok(Object.isFrozen(entry), `entry ${entry.name} should be frozen`);
            assert.equal(typeof entry.name, 'string');
            assert.ok(entry.name.length > 0, 'entry.name must be non-empty');
            if (entry.payload !== undefined) {
                assert.equal(typeof entry.payload, 'string');
            }
        }
    }
});

test('GROUP_LABELS — covers every PUBLIC_EVENT_CHANNELS key', () => {
    for (const key of Object.keys(PUBLIC_EVENT_CHANNELS)) {
        assert.ok(GROUP_LABELS[key], `missing GROUP_LABELS entry for ${key}`);
    }
    // And vice versa — no orphan labels.
    for (const key of Object.keys(GROUP_LABELS)) {
        assert.ok(PUBLIC_EVENT_CHANNELS[key], `GROUP_LABELS has orphan key ${key}`);
    }
});

test('PUBLIC_EVENT_CHANNELS — no duplicate channel names across groups', () => {
    const seen = new Map();
    for (const [group, entries] of Object.entries(PUBLIC_EVENT_CHANNELS)) {
        for (const entry of entries) {
            if (seen.has(entry.name)) {
                assert.fail(`duplicate channel ${entry.name}: ${seen.get(entry.name)} and ${group}`);
            }
            seen.set(entry.name, group);
        }
    }
});

// ============================================
// renderPublicEventChannels — projection
// ============================================

test('renderPublicEventChannels — one line per non-empty group, in GROUP_LABELS order', () => {
    const rendered = renderPublicEventChannels();
    const lines = rendered.split('\n');
    const groupKeys = Object.keys(GROUP_LABELS);
    assert.equal(lines.length, groupKeys.length);
    for (let i = 0; i < groupKeys.length; i++) {
        const label = GROUP_LABELS[groupKeys[i]];
        assert.ok(
            lines[i].startsWith(`${label}: `),
            `line ${i} should start with "${label}: ", got "${lines[i]}"`,
        );
    }
});

test('renderPublicEventChannels — payload descriptors render in parens', () => {
    const rendered = renderPublicEventChannels();
    assert.match(rendered, /llm:generating \(bool\)/);
    assert.match(rendered, /chat:message \(\{ role, content, timestamp \}\)/);
});

test('renderPublicEventChannels — comma-separated within a group', () => {
    const rendered = renderPublicEventChannels();
    // Pick a group with multiple entries: Chat has 5 entries, none with payloads after the first.
    const chatLine = rendered.split('\n').find(l => l.startsWith('Chat: '));
    assert.ok(chatLine, 'expected Chat line');
    assert.ok(
        chatLine.includes('chat:cleared, chat:pruned, chat:editAndResend, chat:stashFlushed'),
        `Chat line missing comma-separated entries: "${chatLine}"`,
    );
});

// ============================================
// Audit-inventory cluster designation
// ============================================

test('plugin lifecycle channels — inventory cluster designated as public', () => {
    const pluginNames = PUBLIC_EVENT_CHANNELS.plugin.map(e => e.name);
    // The 5 channels the 2026-Q2 inventory flagged as "0 internal subscribers"
    // (line 203 entry — these are intentional plugin-extension points).
    for (const name of [
        'plugin:configChanged',
        'plugin:installed',
        'plugin:mcpServerRegistered',
        'plugin:modalRegistered',
        'plugin:uninstalled',
    ]) {
        assert.ok(pluginNames.includes(name), `plugin group missing ${name}`);
    }
});

test('editor:lines* channels — inventory cluster designated as public', () => {
    const editorNames = PUBLIC_EVENT_CHANNELS.editor.map(e => e.name);
    for (const name of ['editor:linesReplaced', 'editor:linesInserted', 'editor:linesDeleted']) {
        assert.ok(editorNames.includes(name), `editor group missing ${name}`);
    }
});

test('ghostText:* channels — inventory cluster designated as public', () => {
    const names = PUBLIC_EVENT_CHANNELS.ghostText.map(e => e.name);
    for (const name of [
        'ghostText:requested',
        'ghostText:received',
        'ghostText:empty',
        'ghostText:failed',
        'ghostText:accepted',
        'ghostText:dismissed',
    ]) {
        assert.ok(names.includes(name), `ghostText group missing ${name}`);
    }
});

test('mergeConflict:* channels — inventory cluster designated as public', () => {
    const names = PUBLIC_EVENT_CHANNELS.mergeConflict.map(e => e.name);
    for (const name of [
        'mergeConflict:opened',
        'mergeConflict:resolved',
        'mergeConflict:aborted',
        'mergeConflict:aiResolve:start',
        'mergeConflict:aiResolve:success',
        'mergeConflict:aiResolve:error',
    ]) {
        assert.ok(names.includes(name), `mergeConflict group missing ${name}`);
    }
});

// ----------
// 2.39.0.1 (sweep wave slice 2) — git:* cluster
//
// Inventory entry #8 listed 13 channels with 0 internal subscribers; entry
// #3 named `git:branchCreated` (dual-naming with UI-level `branch:created`)
// and called for the same audit on `git:branchDeleted`. The audit also
// missed `git:issueUpdated`, which shares the same shape as the listed
// issue channels and is included here.

test('git:* provider-level cluster — entry-#8 inventory channels designated as public', () => {
    const names = PUBLIC_EVENT_CHANNELS.git.map(e => e.name);
    for (const name of [
        'git:repoCreated',
        'git:branchCreated',
        'git:issueCreated',
        'git:issueCommented',
        'git:mrCreated',
        'git:prMerged',
        'git:prReviewSubmitted',
        'git:ciRerun',
    ]) {
        assert.ok(names.includes(name), `git group missing ${name}`);
    }
});

test('git:* cluster — git.js paired-start emits designated as public', () => {
    const names = PUBLIC_EVENT_CHANNELS.git.map(e => e.name);
    for (const name of [
        'git:loadingFile',
        'git:fileLoaded',
        'git:saving',
        'git:batchSaving',
        'git:folderDeleted',
        'git:folderRenamed',
    ]) {
        assert.ok(names.includes(name), `git group missing ${name}`);
    }
});

test('git:* cluster — entry-#3 dual-naming resolution (git:branchCreated + git:branchDeleted in registry)', () => {
    const names = PUBLIC_EVENT_CHANNELS.git.map(e => e.name);
    // The UI-level companion `branch:created` is already in the registry
    // (carries `{sourceBranch, targetBranch}`); the provider-level
    // `git:branchCreated` carries `{connectionId, owner, repo, name}` and
    // is its complement, not its duplicate.
    assert.ok(names.includes('branch:created'), 'expected UI-level branch:created');
    assert.ok(names.includes('git:branchCreated'), 'expected provider-level git:branchCreated');
    assert.ok(names.includes('git:branchDeleted'), 'expected provider-level git:branchDeleted (entry #3 "same audit")');
});

test('git:* cluster — git:issueUpdated audit-miss caught', () => {
    // The 2026-Q2 inventory enumerated git:issueCreated and git:issueCommented
    // but missed git:issueUpdated, which is emitted by all three providers
    // and shares the same shape. The slice-2 triage adds it to the registry.
    const names = PUBLIC_EVENT_CHANNELS.git.map(e => e.name);
    assert.ok(names.includes('git:issueUpdated'), 'git group missing git:issueUpdated');
});

test('git:* cluster — provider-level payload descriptors carry the connectionId shape', () => {
    const providerLevel = [
        'git:repoCreated',
        'git:branchCreated',
        'git:branchDeleted',
        'git:fileCreated',
        'git:issueCreated',
        'git:issueCommented',
        'git:issueUpdated',
        'git:mrCreated',
        'git:prMerged',
        'git:prReviewSubmitted',
        'git:ciRerun',
    ];
    for (const name of providerLevel) {
        const entry = PUBLIC_EVENT_CHANNELS.git.find(e => e.name === name);
        assert.ok(entry, `expected ${name} in git group`);
        assert.ok(
            entry.payload && entry.payload.includes('connectionId'),
            `${name} payload should document connectionId; got "${entry.payload}"`,
        );
    }
});

// ============================================
// Hand-list corrections
// ============================================

test('registry corrects pre-2.39.0.0 hand-list — Files uses fs:* not file:*', () => {
    const fileNames = PUBLIC_EVENT_CHANNELS.files.map(e => e.name);
    // The hand-list claimed these existed; they never did.
    for (const stale of ['file:created', 'file:deleted', 'file:renamed']) {
        assert.equal(fileNames.includes(stale), false, `stale claim ${stale} should not be in registry`);
    }
    // The real channels.
    for (const real of ['fs:created', 'fs:updated', 'fs:deleted', 'fs:renamed']) {
        assert.ok(fileNames.includes(real), `real channel ${real} should be in registry`);
    }
});

test('registry corrects pre-2.39.0.0 hand-list — Issues uses issues:render/refresh', () => {
    const issueNames = PUBLIC_EVENT_CHANNELS.issues.map(e => e.name);
    for (const stale of ['issues:loaded', 'issue:created', 'issue:updated']) {
        assert.equal(issueNames.includes(stale), false, `stale claim ${stale} should not be in registry`);
    }
    for (const real of ['issues:render', 'issues:refresh']) {
        assert.ok(issueNames.includes(real), `real channel ${real} should be in registry`);
    }
});

// ============================================
// Plugin-dev addendum integration
// ============================================

test('PLUGIN_DEV_SYSTEM_PROMPT — embeds the rendered registry block', () => {
    const rendered = renderPublicEventChannels();
    assert.ok(
        PLUGIN_DEV_SYSTEM_PROMPT.includes(rendered),
        'plugin-dev system prompt should embed the renderPublicEventChannels() output verbatim',
    );
});

test('PLUGIN_DEV_SYSTEM_PROMPT — has no template-substitution leftovers', () => {
    // Belt-and-braces: the template literal computes once at module load,
    // so an unresolved `${...}` would surface as a literal substring.
    assert.equal(
        PLUGIN_DEV_SYSTEM_PROMPT.includes('${renderPublicEventChannels'),
        false,
        'system prompt should not leak the template-literal expression',
    );
});

test('PLUGIN_DEV_SYSTEM_PROMPT — preserves the EVENTBUS EVENTS heading', () => {
    assert.match(
        PLUGIN_DEV_SYSTEM_PROMPT,
        /## EVENTBUS EVENTS \(subscribe with EventBus\.on\)/,
    );
});

test('PLUGIN_DEV_SYSTEM_PROMPT — does not retain pre-2.39.0.0 stale claims', () => {
    // The 6 claims that were never emitted.
    for (const stale of [
        'file:created',
        'file:deleted',
        'file:renamed',
        'issues:loaded',
        'issue:created',
        'issue:updated',
    ]) {
        assert.equal(
            PLUGIN_DEV_SYSTEM_PROMPT.includes(stale),
            false,
            `plugin-dev prompt should not retain stale claim "${stale}"`,
        );
    }
});

// ============================================
// Parity guard — every registry channel is actually emitted somewhere
// ============================================

/**
 * Walk `js/` and return every `EventBus.emit(...)` channel name we can
 * detect as a string literal. Template-literal calls like
 * `EventBus.emit(\`slot:${id}:changed\`)` are skipped — those aren't
 * public channels (and aren't in the registry).
 *
 * **2.41.0** — the slots group is covered separately by the
 * "slots group covered via forSlot()" test below, because the dispatcher
 * at `js/slot-manager.js` calls `forSlot(slotId)` with the slotId
 * variable (not a literal), so the literal-pattern collector can't
 * resolve it. Every other group still goes through this collector.
 *
 * @returns {Set<string>}
 */
function collectEmittedChannels() {
    const emitted = new Set();
    const literalPattern = /EventBus\.emit\(\s*['"]([a-zA-Z][a-zA-Z0-9_:.\-]*)['"]/g;
    function walk(dir) {
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            const st = statSync(full);
            if (st.isDirectory()) walk(full);
            else if (entry.endsWith('.js')) {
                const text = readFileSync(full, 'utf8');
                for (const match of text.matchAll(literalPattern)) {
                    emitted.add(match[1]);
                }
            }
        }
    }
    walk(JS_ROOT);
    return emitted;
}

// Groups whose emit-site indirection isn't literal-pattern matchable. The
// slots group is covered by its own dispatcher-aware test (below).
const PARITY_EXEMPT_GROUPS = new Set(['slots']);

test('every PUBLIC_EVENT_CHANNELS entry has at least one EventBus.emit(\'NAME\'…) call in js/', () => {
    const emitted = collectEmittedChannels();
    const missing = [];
    for (const [group, entries] of Object.entries(PUBLIC_EVENT_CHANNELS)) {
        if (PARITY_EXEMPT_GROUPS.has(group)) continue;
        for (const entry of entries) {
            if (!emitted.has(entry.name)) {
                missing.push(`${group}.${entry.name}`);
            }
        }
    }
    assert.deepEqual(missing, [], `registry-vs-codebase drift: ${missing.join(', ')}`);
});

test('slots group covered via forSlot() dispatcher — every entry maps to a STRUCTURED_SLOTS member', () => {
    // The slots group's emit-site indirection: SlotManager calls
    // `EventBus.emit(forSlot(slotId))` for any `slotId` in STRUCTURED_SLOTS.
    // This test pins (a) the dispatcher actually uses the helper, and
    // (b) every literal entry in PUBLIC_EVENT_CHANNELS.slots resolves to
    // a slotId that's a current STRUCTURED_SLOTS member — so a registry
    // entry for a no-longer-structured slot trips here loudly.
    const slotManagerSrc = readFileSync(join(JS_ROOT, 'slot-manager.js'), 'utf8');
    assert.match(
        slotManagerSrc,
        /EventBus\.emit\(\s*forSlot\(/,
        'js/slot-manager.js must use forSlot() to emit slot-changed channels',
    );
    // Pull STRUCTURED_SLOTS membership out of the source (no runtime import
    // because the module touches browser DOM at top level).
    const structuredMatch = slotManagerSrc.match(/const\s+STRUCTURED_SLOTS\s*=\s*new\s+Set\(\[([^\]]+)\]\)/);
    assert.ok(structuredMatch, 'STRUCTURED_SLOTS declaration not found in slot-manager.js');
    const structured = new Set(
        structuredMatch[1]
            .split(',')
            .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
            .filter(Boolean),
    );
    for (const entry of PUBLIC_EVENT_CHANNELS.slots) {
        const m = entry.name.match(/^slot:([^:]+):changed$/);
        assert.ok(m, `${entry.name} must follow slot:<id>:changed shape`);
        assert.ok(
            structured.has(m[1]),
            `${entry.name} declares slot id "${m[1]}" but STRUCTURED_SLOTS members are: ${[...structured].join(', ')}`,
        );
    }
});

// ============================================
// 2.39.0 fs:* parity confirmation (sweep wave slice 4 — final)
// ============================================

test('fs:* payload descriptors present and shape-correct', () => {
    // Shapes taken from the emit sites:
    //   fs:created  → js/ui/file-create.js:67     → { path, branch }
    //   fs:updated  → js/ui/commit.js:337         → { path, branch }
    //   fs:deleted  → js/file-tree.js:328/367     → { path, branch, isFolder? }
    //   fs:renamed  → js/ui/file-rename.js:150/192 → { oldPath, newPath, branch, isFolder? }
    const expected = {
        'fs:created': ['path', 'branch'],
        'fs:updated': ['path', 'branch'],
        'fs:deleted': ['path', 'branch', 'isFolder'],
        'fs:renamed': ['oldPath', 'newPath', 'branch', 'isFolder'],
    };
    for (const [name, axes] of Object.entries(expected)) {
        const entry = PUBLIC_EVENT_CHANNELS.files.find(e => e.name === name);
        assert.ok(entry, `expected ${name} in files group`);
        assert.ok(entry.payload, `${name} should carry a payload descriptor`);
        for (const axis of axes) {
            assert.ok(
                entry.payload.includes(axis),
                `${name} payload should document "${axis}"; got "${entry.payload}"`,
            );
        }
    }
});

test('fs:* audit-miss check — every fs: emit in js/ is declared public', () => {
    // Slice-4 parity-confirmation guard: if a 5th fs:* emit ever lands in
    // js/ without a corresponding PUBLIC_EVENT_CHANNELS.files entry, this
    // case lights up. Same shape as the slice-2 git:issueUpdated catch.
    const emitted = collectEmittedChannels();
    const fsEmitted = [...emitted].filter(n => n.startsWith('fs:'));
    const fsRegistered = new Set(PUBLIC_EVENT_CHANNELS.files.map(e => e.name));
    const undocumented = fsEmitted.filter(n => !fsRegistered.has(n));
    assert.deepEqual(
        undocumented,
        [],
        `fs:* emit-sites missing from registry: ${undocumented.join(', ')}`,
    );
});

test('fs:* payload-axis guard — every fs: entry documents a path axis', () => {
    // Pins the path-axis invariant: every fs:* descriptor must reference
    // either `path` (single-file ops) or both `oldPath` and `newPath`
    // (rename ops). Catches a future entry that forgets to name the file.
    const fsEntries = PUBLIC_EVENT_CHANNELS.files.filter(e => e.name.startsWith('fs:'));
    assert.ok(fsEntries.length >= 4, 'expected at least 4 fs:* entries');
    for (const entry of fsEntries) {
        assert.ok(entry.payload, `${entry.name} should carry a payload descriptor`);
        const hasPath = entry.payload.includes('path');
        const hasRenamePair = entry.payload.includes('oldPath') && entry.payload.includes('newPath');
        assert.ok(
            hasPath || hasRenamePair,
            `${entry.name} payload should document "path" or "oldPath/newPath"; got "${entry.payload}"`,
        );
    }
});

// ============================================
// 2.41.0 slot-channel hygiene — forSlot() helper + slots group
// ============================================

test('forSlot — round-trips canonical name for a known structured slot', () => {
    assert.equal(forSlot('rail-views'), 'slot:rail-views:changed');
});

test('forSlot — rejects empty / whitespace / non-string / colon-in-id', () => {
    assert.throws(() => forSlot(''), /non-empty string/);
    assert.throws(() => forSlot(undefined), /non-empty string/);
    assert.throws(() => forSlot(null), /non-empty string/);
    assert.throws(() => forSlot(123), /non-empty string/);
    assert.throws(() => forSlot('rail views'), /whitespace or ':'/);
    assert.throws(() => forSlot('rail-views\t'), /whitespace or ':'/);
    assert.throws(() => forSlot('rail:views'), /whitespace or ':'/);
    // Sanity: a well-formed novel slotId returns its canonical channel.
    assert.equal(forSlot('my-plugin-slot'), 'slot:my-plugin-slot:changed');
});

test('forSlot(\'rail-views\') matches PUBLIC_EVENT_CHANNELS.slots literal entry', () => {
    // Cross-check pin: the helper's output for the one production
    // structured slot must equal the literal name we declare in the
    // registry. Drift either way trips the case.
    const literalEntry = PUBLIC_EVENT_CHANNELS.slots.find(e => e.name === 'slot:rail-views:changed');
    assert.ok(literalEntry, 'expected slot:rail-views:changed literal in PUBLIC_EVENT_CHANNELS.slots');
    assert.equal(forSlot('rail-views'), literalEntry.name);
});

test('slots group — declared in GROUP_LABELS with non-empty label', () => {
    assert.equal(typeof GROUP_LABELS.slots, 'string');
    assert.ok(GROUP_LABELS.slots.length > 0, 'GROUP_LABELS.slots must be a non-empty label');
    assert.ok(Array.isArray(PUBLIC_EVENT_CHANNELS.slots));
    assert.ok(PUBLIC_EVENT_CHANNELS.slots.length >= 1, 'slots group should declare at least the production literal');
});
