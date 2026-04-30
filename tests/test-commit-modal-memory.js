/**
 * Browser smoke tests for the commit-modal "Memory updates" renderer
 * (Memory PR #7, Touch 1 Flow 3A/3B).
 *
 * Exercises the renderer + click handlers from `commit-memory-section.js`
 * directly without pulling in the full commit-modal dependency tree.
 * The wire-up itself (commit.js → renderMemoryUpdatesSection → DOM mount)
 * is verified by the manual browser-preview workflow.
 *
 * Pins:
 *   - Flow 3A renders auto-stage panel with checked checkboxes and a
 *     working Show/Hide diff toggle (lazy-fills via getPendingContent).
 *   - Flow 3B renders the warning panel with three escape-hatch buttons
 *     and disabled checkboxes.
 *   - Discard click drops every visible path; the IDB store keeps the
 *     records.
 *
 * Test isolation: swaps the memory subsystem's IDB layer for an in-memory
 * fake; tears everything down in `finally`.
 */

import {
    create,
    enable as fileLayerEnable,
    disable as fileLayerDisable,
    list,
    listPendingPaths,
    _setIDBImpl,
    _resetIDBImpl,
    _resetFileLayerForTests,
    createMemoryFakeIDB,
} from '../js/intelligence/memory/index.js';
import {
    renderMemoryUpdatesSection,
    wireMemoryUpdatesSection,
} from '../js/ui/commit-memory-section.js';

const { T } = window;

T.suite('Commit modal — Memory updates section');

_setIDBImpl(createMemoryFakeIDB());

const WS = 'gitea:test/ai-editor-ph7';
const FIXTURE_ID = 'commit-mem-section-fixture';

function _ensureFixture() {
    let el = document.getElementById(FIXTURE_ID);
    if (!el) {
        el = document.createElement('div');
        el.id = FIXTURE_ID;
        el.style.position = 'absolute';
        el.style.left = '-9999px';
        el.style.top = '0';
        document.body.appendChild(el);
    }
    return el;
}

async function _waitFor(predicate, label, timeoutMs = 1500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 10));
    }
    T.assert(false, `Timeout waiting for: ${label}`);
    return false;
}

function _seedRecord(category, key) {
    return create({
        scope: 'workspace',
        owner_id_or_workspace_id: WS,
        key,
        value: 'value-for-' + key,
        category,
        source: 'user_explicit',
        created_by: 'user:test',
        actor: 'user:test',
    });
}

function _renderInto(fixture, props) {
    fixture.innerHTML = renderMemoryUpdatesSection(props);
    wireMemoryUpdatesSection(fixture);
}

let fixture = _ensureFixture();
let layerEnabled = false;

try {
    await fileLayerEnable(WS);
    layerEnabled = true;
    await _seedRecord('preferences', 'preferred_indent');
    await _seedRecord('decisions', 'why_node_test');
    // After seeding 2 records across 2 categories, the file layer
    // produces three pending paths: preferences.md, decisions.md, and
    // the auto-regenerated index.md.
    await _waitFor(() => listPendingPaths().length === 3, 'three pending paths after seed (two categories + index)');
    const pending = listPendingPaths();
    T.eq(pending.length, 3, 'pending path count includes index.md');

    // ---- Flow 3A — unprotected branch ----
    _renderInto(fixture, { isProtected: false, pendingPaths: pending, branch: 'feature/x' });

    T.assert(
        fixture.querySelector('.commit-section--mem') !== null,
        'Flow 3A renders commit-section--mem',
    );
    T.assert(
        fixture.querySelector('.commit-section--warn') === null,
        'Flow 3A does NOT render warning section',
    );
    T.eq(
        fixture.querySelectorAll('.commit-file--mem').length,
        pending.length,
        'Flow 3A row count matches pending paths',
    );
    const firstCheckbox = fixture.querySelector('.commit-file--mem input[type="checkbox"]');
    T.assert(firstCheckbox.checked === true, 'Flow 3A checkbox is checked by default');
    T.assert(firstCheckbox.disabled === false, 'Flow 3A checkbox is enabled');

    // ---- Show / Hide diff ----
    const toggle = fixture.querySelector('[data-mem-diff-toggle="0"]');
    T.assert(toggle !== null, 'Show diff link is present');
    toggle.click();
    const pre = fixture.querySelector('[data-mem-diff-target="0"]');
    T.assert(pre !== null && pre.hidden === false, 'Show diff reveals the <pre>');
    T.assert(
        /^\+ /m.test(pre.textContent || ''),
        `Diff preview has "+ " prefixed lines (got: ${(pre.textContent || '').slice(0, 60)})`,
    );
    T.eq(toggle.textContent, 'Hide diff', 'Toggle label flips to Hide diff');
    toggle.click();
    T.assert(pre.hidden === true, 'Hide diff hides the <pre>');
    T.eq(toggle.textContent, 'Show diff', 'Toggle label flips back to Show diff');

    // ---- Flow 3B — protected branch ----
    _renderInto(fixture, { isProtected: true, pendingPaths: pending, branch: 'main' });

    T.assert(
        fixture.querySelector('.commit-section--warn') !== null,
        'Flow 3B renders warning section',
    );
    T.assert(
        fixture.querySelector('.commit-section--mem') === null,
        'Flow 3B does NOT render the auto-stage variant',
    );
    T.assert(
        fixture.querySelector('[data-mem-action="branchOff"]') !== null,
        'Flow 3B exposes Branch off button',
    );
    T.assert(
        fixture.querySelector('[data-mem-action="keepPending"]') !== null,
        'Flow 3B exposes Keep pending button',
    );
    T.assert(
        fixture.querySelector('[data-mem-action="discard"]') !== null,
        'Flow 3B exposes Discard button',
    );
    const disabledBox = fixture.querySelector('.commit-file--mem input[type="checkbox"]');
    T.assert(disabledBox.disabled === true, 'Flow 3B checkbox is disabled');

    // ---- Discard clears pending paths but keeps IDB records ----
    const recordsBefore = await list({ scope: 'workspace', owner_id_or_workspace_id: WS });
    T.eq(recordsBefore.length, 2, '2 records in IDB before Discard');

    fixture.querySelector('[data-mem-action="discard"]').click();
    await _waitFor(() => listPendingPaths().length === 0, 'pending paths cleared after Discard');
    T.assert(
        fixture.querySelector('.commit-section') === null,
        'Discard removes the section from the DOM',
    );

    const recordsAfter = await list({ scope: 'workspace', owner_id_or_workspace_id: WS });
    T.eq(recordsAfter.length, 2, 'Discard does not touch IDB source records (only the projection)');

    // ---- Empty render — no pending paths ----
    fixture.innerHTML = renderMemoryUpdatesSection({
        isProtected: false,
        pendingPaths: [],
    });
    T.eq(fixture.innerHTML.trim(), '', 'No pending paths → renderer returns empty string');
} catch (err) {
    T.assert(
        false,
        'Commit modal memory section suite failed: ' + (err && err.stack ? err.stack : String(err)),
    );
} finally {
    try { if (layerEnabled) fileLayerDisable(); } catch { /* ignore */ }
    _resetFileLayerForTests();
    _resetIDBImpl();
    if (fixture && fixture.parentNode) fixture.parentNode.removeChild(fixture);
}
