/**
 * Browser smoke tests for Settings → Memory tab (Memory PR #5).
 *
 * Pins the integration contract:
 *   - Mounting `MemoryTab` into a fixture div renders one row per active
 *     record returned by `store.list({ scope, owner })`.
 *   - Records created while the tree is mounted appear in the DOM
 *     within one microtask cycle (live-update via `MEMORY_EVENTS`).
 *   - `softDelete()` removes the row.
 *   - The cleanup fn returned by `mountPreact` empties the fixture and
 *     leaves no dangling EventBus subscriptions.
 *
 * Pure unit tests for the Preact mount helper, store CRUD, and audit log
 * already live in their own .mjs node:test suites. This file is
 * specifically the DOM/integration seam.
 *
 * Test isolation: swaps the memory subsystem's IDB layer for an in-memory
 * fake via `_setIDBImpl(createMemoryFakeIDB())`, so the test never
 * touches the user's persistent memory store. The fake is reset to the
 * real impl at the end so other suites can read real IDB.
 */

import {
    create,
    softDelete,
    list,
    _setIDBImpl,
    _resetIDBImpl,
    createMemoryFakeIDB,
    getOrCreateUserOwnerId,
    MEMORY_EVENTS,
} from '../js/intelligence/memory/index.js';
import { mountPreact } from '../js/utils/preact-mount.js';
import { EventBus, Storage } from '../js/core.js';

const { T } = window;

T.suite('Memory Tab — DOM integration');

// Swap to a fresh fake before any store mutation. The fake is purely
// in-memory; resets isolate this suite from other browser test pages.
_setIDBImpl(createMemoryFakeIDB());

// Pin the user-scope owner so seeds and the rendered tab agree. Both
// `_loadAllRecords()` (in MemoryTab.js) and our seed loop call the same
// `getOrCreateUserOwnerId()` resolver — preset Storage so it returns
// a deterministic value instead of generating a per-run UUID.
const PINNED_USER_ID = 'test:memory-tab';
Storage.set('memoryUserId', PINNED_USER_ID);
const OWNER = getOrCreateUserOwnerId();
const FIXTURE_ID = 'memory-tab-fixture';

function _ensureFixture() {
    let el = document.getElementById(FIXTURE_ID);
    if (!el) {
        el = document.createElement('div');
        el.id = FIXTURE_ID;
        // Off-screen but in the DOM tree so layout-sensitive code paths run.
        el.style.position = 'absolute';
        el.style.left = '-9999px';
        el.style.top = '0';
        document.body.appendChild(el);
    }
    return el;
}

async function _seed() {
    await create({
        scope: 'user',
        owner_id_or_workspace_id: OWNER,
        key: 'preferred_indent',
        value: '4 spaces, never tabs',
        category: 'preferences',
        source: 'user_explicit',
        created_by: 'user:test',
        actor: 'user:test',
    });
    await create({
        scope: 'user',
        owner_id_or_workspace_id: OWNER,
        key: 'commit_style',
        value: 'Conventional Commits',
        category: 'preferences',
        source: 'user_explicit',
        created_by: 'user:test',
        actor: 'user:test',
    });
    await create({
        scope: 'user',
        owner_id_or_workspace_id: OWNER,
        key: 'test_runner',
        value: 'node:test',
        category: 'preferences',
        source: 'agent_proposed',
        created_by: 'agent:test',
        actor: 'agent:test',
    });
}

async function _waitForRows(fixture, count, label) {
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
        const rows = fixture.querySelectorAll('.mem-row').length;
        if (rows === count) return true;
        await new Promise((r) => setTimeout(r, 10));
    }
    T.eq(fixture.querySelectorAll('.mem-row').length, count, label);
    return false;
}

let cleanup = null;
let fixture = null;

try {
    // Pre-mount listener-count snapshot — the MemoryTab subscribes to all
    // three MEMORY_EVENTS channels, so our cleanup assertion compares
    // against this baseline.
    const baseline = {
        c: (EventBus._listeners[MEMORY_EVENTS.CREATED] || []).length,
        u: (EventBus._listeners[MEMORY_EVENTS.UPDATED] || []).length,
        d: (EventBus._listeners[MEMORY_EVENTS.DELETED] || []).length,
    };

    await _seed();
    const initial = await list({ scope: 'user', owner_id_or_workspace_id: OWNER });
    T.eq(initial.length, 3, 'Seeded 3 user-scope records via store.create()');

    fixture = _ensureFixture();
    fixture.innerHTML = ''; // Defensive — start empty.

    const mod = await import('../js/settings/memory-tab/MemoryTab.js');
    cleanup = await mountPreact(fixture, mod.MemoryTab, {});

    T.assert(typeof cleanup === 'function', 'mountPreact returns cleanup fn');

    // Initial render — the useEffect-driven list() resolves on the next
    // microtask. _waitForRows polls until the row count matches.
    const initialOk = await _waitForRows(fixture, 3, 'Initial render shows 3 rows');
    T.assert(initialOk, 'Initial render reached 3 rows within deadline');

    // Live update on create.
    await create({
        scope: 'user',
        owner_id_or_workspace_id: OWNER,
        key: 'editor_keys',
        value: 'vim',
        category: 'preferences',
        source: 'user_explicit',
        created_by: 'user:test',
        actor: 'user:test',
    });
    const liveCreateOk = await _waitForRows(fixture, 4, 'Row count rises to 4 after create');
    T.assert(liveCreateOk, 'Created record appears live without manual refresh');

    // Live update on softDelete.
    const all = await list({ scope: 'user', owner_id_or_workspace_id: OWNER });
    await softDelete(all[0].id, { actor: 'user:test', reason: 'test cleanup' });
    const liveDeleteOk = await _waitForRows(fixture, 3, 'Row count drops back to 3 after softDelete');
    T.assert(liveDeleteOk, 'Soft-deleted record disappears live');

    // DOM shape — first row exposes scope badge + key.
    const firstRow = fixture.querySelector('.mem-row');
    T.assert(firstRow !== null, 'At least one .mem-row in the DOM');
    T.assert(firstRow.querySelector('.mem-scope-badge--user') !== null, 'Row carries user-scope badge');
    T.assert(firstRow.querySelector('.mem-row__key') !== null, 'Row exposes a key cell');

    // Toolbar count badge updates after live changes.
    const countText = fixture.querySelector('.mem-toolbar__count')?.textContent || '';
    T.assert(/3 entries/.test(countText), `Toolbar count reflects 3 entries (got "${countText}")`);

    // Cleanup tears down the tree + unsubscribes from all three channels.
    cleanup();
    cleanup = null;
    T.eq(fixture.children.length, 0, 'cleanup() empties the fixture');

    const afterCleanup = {
        c: (EventBus._listeners[MEMORY_EVENTS.CREATED] || []).length,
        u: (EventBus._listeners[MEMORY_EVENTS.UPDATED] || []).length,
        d: (EventBus._listeners[MEMORY_EVENTS.DELETED] || []).length,
    };
    T.eq(afterCleanup.c, baseline.c, 'cleanup() unsubscribes memory:created');
    T.eq(afterCleanup.u, baseline.u, 'cleanup() unsubscribes memory:updated');
    T.eq(afterCleanup.d, baseline.d, 'cleanup() unsubscribes memory:deleted');

    // Post-cleanup mutations don't throw and don't repopulate the fixture.
    await create({
        scope: 'user',
        owner_id_or_workspace_id: OWNER,
        key: 'after_cleanup',
        value: 'should not render',
        category: 'preferences',
        source: 'user_explicit',
        created_by: 'user:test',
        actor: 'user:test',
    });
    await new Promise((r) => setTimeout(r, 30));
    T.eq(fixture.children.length, 0, 'Post-cleanup create() does not repopulate fixture');
} catch (err) {
    T.assert(false, 'Memory tab integration suite failed', err && err.stack ? err.stack : String(err));
} finally {
    if (cleanup) {
        try { cleanup(); } catch { /* ignore */ }
    }
    if (fixture && fixture.parentNode) fixture.parentNode.removeChild(fixture);
    _resetIDBImpl();
    // Restore: drop the pinned user id so other suites don't inherit it.
    try { Storage.remove('memoryUserId'); } catch { /* ignore */ }
}
