/**
 * Workspace-settings file-layer tests (1.4.4).
 *
 * Mirror the memory file-layer test structure: lifecycle (enable/disable +
 * snapshot/restore), loadFromGit reads + merges, recordChanges populates
 * pending, resetToGlobal restores a single key, opt-in registry round-trips,
 * unsafe keys land in diagnostics not State.settings.
 */
import './_node-shim.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { State, Storage } from '../js/core.js';
import {
    enable,
    disable,
    loadFromGit,
    recordChanges,
    resetToGlobal,
    getPendingContent,
    listPendingPaths,
    discardPendingWrites,
    getDiagnostics,
    clearDiagnostics,
    isEnabled,
    getActiveWorkspaceId,
    getAppliedOverrides,
    getOriginalGlobal,
    getOriginalGlobals,
    isOptedIn,
    setOptedIn,
    FILE_PATH,
    _setGitClientForTests,
    _setReapplyVisualSettingsForTests,
    _resetForTests,
} from '../js/intelligence/workspace-settings/index.js';

const WS_ID = 'gitea/jeff/demo';

function makeFakeGit(filesByPath = {}) {
    return {
        getFile: async (_owner, _repo, path) => {
            if (path in filesByPath) return { content: filesByPath[path] };
            const err = new Error('not found');
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            err.status = 404;
            throw err;
        },
    };
}

let reapplyCalls = 0;

beforeEach(() => {
    _resetForTests();
    Storage.set('settings', null);
    State.settings.theme = 'refined';
    State.settings.uiScale = 100;
    State.settings.role = 'full';
    State.settings.showLineNumbers = true;
    State.settings.editorFontSize = 14;
    Storage.set('workspaceSettings.optIn', null);
    reapplyCalls = 0;
    _setReapplyVisualSettingsForTests(() => { reapplyCalls++; });
});

/* ============================================================ */
/* opt-in registry                                              */
/* ============================================================ */

test('isOptedIn defaults to false; setOptedIn flips and persists', () => {
    assert.equal(isOptedIn(WS_ID), false);
    setOptedIn(WS_ID, true);
    assert.equal(isOptedIn(WS_ID), true);
    setOptedIn(WS_ID, false);
    assert.equal(isOptedIn(WS_ID), false);
});

test('isOptedIn rejects empty / non-string workspace ids', () => {
    assert.equal(isOptedIn(''), false);
    assert.equal(isOptedIn(null), false);
    assert.equal(isOptedIn(undefined), false);
});

/* ============================================================ */
/* enable / disable lifecycle                                   */
/* ============================================================ */

test('enable snapshots safelisted globals; disable restores them', async () => {
    State.settings.theme = 'refined';
    State.settings.uiScale = 100;

    await enable(WS_ID);
    assert.equal(isEnabled(), true);
    assert.equal(getActiveWorkspaceId(), WS_ID);
    assert.equal(getOriginalGlobal('theme'), 'refined');
    assert.equal(getOriginalGlobal('uiScale'), 100);

    // Simulate workspace override applied.
    State.settings.theme = 'editorial';
    State.settings.uiScale = 130;

    disable();
    assert.equal(isEnabled(), false);
    assert.equal(getActiveWorkspaceId(), null);
    assert.equal(State.settings.theme, 'refined');
    assert.equal(State.settings.uiScale, 100);
});

test('enable rejects empty workspace id', async () => {
    await assert.rejects(() => enable(''), /workspaceId must be a non-empty string/);
});

test('enable is idempotent for the same workspace, throws for a different one', async () => {
    await enable(WS_ID);
    await enable(WS_ID); // should not throw
    await assert.rejects(() => enable('gitea/jeff/other'), /disable\(\) before switching/);
});

test('disable is a no-op when not enabled', () => {
    disable();
    assert.equal(isEnabled(), false);
});

/* ============================================================ */
/* loadFromGit                                                  */
/* ============================================================ */

test('loadFromGit no-op when file is absent', async () => {
    await enable(WS_ID);
    _setGitClientForTests(makeFakeGit({}));
    const result = await loadFromGit({ owner: 'jeff', repo: 'demo', branch: 'main' });
    assert.deepEqual(result, { applied: 0, rejected: 0, warnings: 0 });
    assert.equal(State.settings.theme, 'refined');
    assert.equal(reapplyCalls, 0);
});

test('loadFromGit applies safelisted keys + re-applies visual settings', async () => {
    await enable(WS_ID);
    const json = JSON.stringify({ theme: 'editorial', uiScale: 130 });
    _setGitClientForTests(makeFakeGit({ [FILE_PATH]: json }));

    const result = await loadFromGit({ owner: 'jeff', repo: 'demo', branch: 'main' });
    assert.equal(result.applied, 2);
    assert.equal(State.settings.theme, 'editorial');
    assert.equal(State.settings.uiScale, 130);
    assert.equal(reapplyCalls, 1);
});

test('loadFromGit strips unsafe keys with diagnostic warnings', async () => {
    await enable(WS_ID);
    const json = JSON.stringify({
        theme: 'editorial',
        llmApiKey: 'sk-evil',
        connections: [{ token: 'leaked' }],
    });
    _setGitClientForTests(makeFakeGit({ [FILE_PATH]: json }));

    const result = await loadFromGit({ owner: 'jeff', repo: 'demo', branch: 'main' });
    assert.equal(result.applied, 1);
    assert.equal(result.rejected, 2);

    assert.equal(State.settings.theme, 'editorial');
    assert.ok(!('llmApiKey' in getAppliedOverrides()));

    const diag = getDiagnostics();
    const stripped = diag.warnings.filter((w) => w.type === 'unsafe_key_stripped').map((w) => w.key);
    assert.equal(stripped.includes('llmApiKey'), true);
    assert.equal(stripped.includes('connections'), true);
});

test('loadFromGit rejects a malformed JSON file with a diagnostic', async () => {
    await enable(WS_ID);
    _setGitClientForTests(makeFakeGit({ [FILE_PATH]: '{ this is not json' }));

    const result = await loadFromGit({ owner: 'jeff', repo: 'demo', branch: 'main' });
    assert.equal(result.applied, 0);
    const diag = getDiagnostics();
    assert.equal(diag.warnings.some((w) => w.type === 'malformed_json'), true);
});

test('loadFromGit requires enable() first', async () => {
    await assert.rejects(
        () => loadFromGit({ owner: 'jeff', repo: 'demo' }),
        /enable\(workspaceId\) must be called first/,
    );
});

/* ============================================================ */
/* recordChanges                                                */
/* ============================================================ */

test('recordChanges populates pending file with current State.settings values', async () => {
    await enable(WS_ID);
    State.settings.theme = 'editorial';
    State.settings.uiScale = 110;

    recordChanges(['theme', 'uiScale']);
    const paths = listPendingPaths();
    assert.deepEqual(paths, [FILE_PATH]);

    const pending = getPendingContent(FILE_PATH);
    assert.ok(pending);
    const parsed = JSON.parse(pending);
    assert.deepEqual(parsed, { theme: 'editorial', uiScale: 110 });
});

test('recordChanges ignores non-safelisted keys', async () => {
    await enable(WS_ID);
    State.settings.theme = 'editorial';
    State.settings.llmApiKey = 'sk-evil';

    recordChanges(['theme', 'llmApiKey']);
    const pending = getPendingContent(FILE_PATH);
    assert.ok(pending);
    const parsed = JSON.parse(pending);
    assert.deepEqual(parsed, { theme: 'editorial' });
    assert.ok(!('llmApiKey' in getAppliedOverrides()));
});

test('recordChanges skips writes when value matches current applied override', async () => {
    await enable(WS_ID);
    State.settings.theme = 'editorial';
    recordChanges(['theme']);
    const before = getPendingContent(FILE_PATH);

    // Calling again with the same value is a no-op.
    recordChanges(['theme']);
    const after = getPendingContent(FILE_PATH);
    assert.equal(after, before);
});

test('recordChanges noop when not enabled', () => {
    State.settings.theme = 'editorial';
    recordChanges(['theme']);
    assert.deepEqual(listPendingPaths(), []);
});

test('recordChanges skips keys that match the original global value (regression)', async () => {
    // Before the fix, scanning the whole SAFELIST after enable would mark
    // EVERY key as overridden because _appliedOverrides started empty —
    // every State value read as "different from prior" and got captured.
    // The contract: only mark a key as overridden when its CURRENT value
    // differs from the snapshotted original global.
    State.settings.theme = 'refined';
    State.settings.uiScale = 100;
    State.settings.role = 'full';
    State.settings.showLineNumbers = true;

    await enable(WS_ID);
    // No edits yet — all values match the snapshot.
    recordChanges(['theme', 'uiScale', 'role', 'showLineNumbers']);
    assert.deepEqual(getAppliedOverrides(), {});
    assert.deepEqual(listPendingPaths(), []);

    // Edit a single key.
    State.settings.theme = 'editorial';
    recordChanges(['theme', 'uiScale', 'role', 'showLineNumbers']);
    assert.deepEqual(getAppliedOverrides(), { theme: 'editorial' });

    // Revert the edit via the regular settings UI.
    State.settings.theme = 'refined';
    recordChanges(['theme', 'uiScale', 'role', 'showLineNumbers']);
    assert.deepEqual(getAppliedOverrides(), {});
    assert.deepEqual(listPendingPaths(), []);
});

/* ============================================================ */
/* resetToGlobal                                                */
/* ============================================================ */

test('resetToGlobal restores a single key + drops it from overrides', async () => {
    State.settings.theme = 'refined';
    State.settings.uiScale = 100;

    await enable(WS_ID);
    State.settings.theme = 'editorial';
    State.settings.uiScale = 130;
    recordChanges(['theme', 'uiScale']);

    resetToGlobal('theme');
    assert.equal(State.settings.theme, 'refined');
    assert.equal(State.settings.uiScale, 130); // not affected

    const pending = getPendingContent(FILE_PATH);
    const parsed = JSON.parse(pending);
    assert.deepEqual(parsed, { uiScale: 130 });
});

test('resetToGlobal removes the pending file entry when no overrides remain', async () => {
    await enable(WS_ID);
    State.settings.theme = 'editorial';
    recordChanges(['theme']);
    assert.equal(listPendingPaths().length, 1);

    resetToGlobal('theme');
    assert.equal(listPendingPaths().length, 0);
    assert.equal(getPendingContent(FILE_PATH), null);
});

test('resetToGlobal ignores non-safelisted and unknown keys', async () => {
    await enable(WS_ID);
    State.settings.theme = 'editorial';
    recordChanges(['theme']);

    resetToGlobal('llmApiKey');
    resetToGlobal('neverHeardOfMe');
    // theme override is still present
    assert.equal(State.settings.theme, 'editorial');
});

/* ============================================================ */
/* discardPendingWrites                                         */
/* ============================================================ */

test('discardPendingWrites drops paths without touching applied overrides', async () => {
    await enable(WS_ID);
    State.settings.theme = 'editorial';
    recordChanges(['theme']);

    const dropped = discardPendingWrites([FILE_PATH]);
    assert.deepEqual(dropped, [FILE_PATH]);
    assert.equal(listPendingPaths().length, 0);
    // Override still applied to State.settings.
    assert.equal(State.settings.theme, 'editorial');
    assert.deepEqual(getAppliedOverrides(), { theme: 'editorial' });
});

test('discardPendingWrites with no args drops everything', async () => {
    await enable(WS_ID);
    State.settings.theme = 'editorial';
    recordChanges(['theme']);
    const dropped = discardPendingWrites();
    assert.deepEqual(dropped, [FILE_PATH]);
});

/* ============================================================ */
/* getOriginalGlobals                                           */
/* ============================================================ */

test('getOriginalGlobals snapshot is independent of post-enable mutations', async () => {
    State.settings.theme = 'refined';
    State.settings.uiScale = 100;
    await enable(WS_ID);
    State.settings.theme = 'editorial';
    State.settings.uiScale = 130;

    const originals = getOriginalGlobals();
    assert.equal(originals.theme, 'refined');
    assert.equal(originals.uiScale, 100);
});

/* ============================================================ */
/* clearDiagnostics                                             */
/* ============================================================ */

test('clearDiagnostics empties accumulated warnings', async () => {
    await enable(WS_ID);
    const json = JSON.stringify({ llmApiKey: 'sk-evil' });
    _setGitClientForTests(makeFakeGit({ [FILE_PATH]: json }));
    await loadFromGit({ owner: 'jeff', repo: 'demo' });
    assert.ok(getDiagnostics().warnings.length > 0);
    clearDiagnostics();
    assert.equal(getDiagnostics().warnings.length, 0);
});
