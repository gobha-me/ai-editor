/**
 * Browser smoke tests for the chat scratchpad visibility panel
 * (1.8.4 / github#34).
 *
 * Pins the integration contract:
 *   - Mounting `ScratchpadPanel` into a fixture renders header + count.
 *   - Empty state shows "hasn't recorded any notes yet" copy when
 *     `State.scratchpad = {}`.
 *   - Entries appear (one `<details>` per key) when scratchpad has data,
 *     in alphabetical key order.
 *   - The panel re-renders when `EventBus.emit('scratchpad:changed', …)`
 *     fires (the emission added in `js/tools/scratchpad-tools.js` 1.8.4).
 *   - The cleanup fn returned by `mountPreact` empties the fixture and
 *     unsubscribes from all three EventBus channels (scratchpad:changed,
 *     conversation:loaded, conversation:created).
 *   - Post-cleanup `EventBus.emit('scratchpad:changed', …)` does not
 *     repopulate the fixture or throw.
 *
 * Mirrors `tests/test-memory-tab.js` shape and listener-count baseline
 * pattern.
 */

import { mountPreact } from '../js/utils/preact-mount.js';
import { State, EventBus } from '../js/core.js';

const { T } = window;

T.suite('Scratchpad Panel — DOM integration (1.8.4 / github#34)');

const FIXTURE_ID = 'scratchpad-panel-fixture';

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

// MutationObserver-based wait — same rationale as test-memory-tab.js
// (rAF + setTimeout get throttled when the page is backgrounded).
async function _waitFor(fixture, predicate, label) {
    if (predicate()) return true;
    return new Promise((resolve) => {
        let timer = null;
        const observer = new MutationObserver(() => {
            if (predicate()) {
                clearTimeout(timer);
                observer.disconnect();
                resolve(true);
            }
        });
        observer.observe(fixture, { childList: true, subtree: true });
        timer = setTimeout(() => {
            observer.disconnect();
            T.assert(false, `Timed out waiting: ${label}`);
            resolve(false);
        }, 5000);
    });
}

let cleanup = null;
let fixture = null;
const _savedScratchpad = State.scratchpad;

try {
    // Listener-count baseline — the panel subscribes to three channels;
    // cleanup must restore each to baseline.
    const baseline = {
        s: (EventBus._listeners['scratchpad:changed'] || []).length,
        l: (EventBus._listeners['conversation:loaded'] || []).length,
        c: (EventBus._listeners['conversation:created'] || []).length,
    };

    fixture = _ensureFixture();
    fixture.innerHTML = '';

    // Empty state first.
    State.scratchpad = {};

    const mod = await import('../js/chat/scratchpad-panel/ScratchpadPanel.js');
    cleanup = await mountPreact(fixture, mod.ScratchpadPanel, {});

    T.assert(typeof cleanup === 'function', 'mountPreact returns cleanup fn');

    // Header + count badge always render (regardless of expand state).
    const headerOk = await _waitFor(
        fixture,
        () => fixture.querySelector('.scratchpad-panel__toggle') !== null,
        'header toggle present',
    );
    T.assert(headerOk, 'Header toggle reaches DOM');

    const countEl = fixture.querySelector('.scratchpad-panel__count');
    T.assert(countEl !== null, 'Count badge in DOM');
    T.eq(countEl.textContent, '0', 'Count is 0 when scratchpad is empty');

    // Expand the panel — empty-state copy then renders.
    fixture.querySelector('.scratchpad-panel__toggle').click();
    const emptyOk = await _waitFor(
        fixture,
        () => {
            const el = fixture.querySelector('.scratchpad-panel__empty');
            return el && /hasn't recorded any notes/i.test(el.textContent || '');
        },
        'empty-state copy rendered',
    );
    T.assert(emptyOk, 'Empty state shows expected copy');

    // Live update on event emission. The component reads `State.scratchpad`
    // each render, so we mutate state then emit.
    State.scratchpad = { foo: 'first note', bar: 'second note' };
    EventBus.emit('scratchpad:changed', { key: 'foo', action: 'write' });

    const entriesOk = await _waitFor(
        fixture,
        () => fixture.querySelectorAll('.scratchpad-panel__entry').length === 2,
        'two entries after write',
    );
    T.assert(entriesOk, 'Two entries rendered after scratchpad:changed');

    // Alphabetical key order — `bar` before `foo`.
    const keys = Array.from(fixture.querySelectorAll('.scratchpad-panel__entry-key'))
        .map((e) => (e.textContent || '').trim());
    T.eq(keys[0], 'bar', 'First entry key is alphabetically first');
    T.eq(keys[1], 'foo', 'Second entry key follows');

    // Count badge updates.
    T.eq(fixture.querySelector('.scratchpad-panel__count').textContent, '2', 'Count badge updates to 2');

    // conversation:loaded triggers re-render. Mutate to empty + emit.
    State.scratchpad = {};
    EventBus.emit('conversation:loaded', { id: 'test-conv' });
    const reloadOk = await _waitFor(
        fixture,
        () => fixture.querySelector('.scratchpad-panel__count').textContent === '0',
        'count drops to 0 after conversation:loaded',
    );
    T.assert(reloadOk, 'Conversation switch resets the rendered count');

    // Cleanup tears down the tree and unsubscribes.
    cleanup();
    cleanup = null;
    T.eq(fixture.children.length, 0, 'cleanup() empties the fixture');

    const after = {
        s: (EventBus._listeners['scratchpad:changed'] || []).length,
        l: (EventBus._listeners['conversation:loaded'] || []).length,
        c: (EventBus._listeners['conversation:created'] || []).length,
    };
    T.eq(after.s, baseline.s, 'cleanup() unsubscribes scratchpad:changed');
    T.eq(after.l, baseline.l, 'cleanup() unsubscribes conversation:loaded');
    T.eq(after.c, baseline.c, 'cleanup() unsubscribes conversation:created');

    // Post-cleanup emit must not repopulate or throw.
    State.scratchpad = { ghost: 'after cleanup' };
    EventBus.emit('scratchpad:changed', { key: 'ghost', action: 'write' });
    await new Promise((r) => setTimeout(r, 30));
    T.eq(fixture.children.length, 0, 'Post-cleanup emit does not repopulate fixture');
} catch (err) {
    T.assert(false, 'Scratchpad panel suite failed', err && err.stack ? err.stack : String(err));
} finally {
    if (cleanup) {
        try { cleanup(); } catch { /* ignore */ }
    }
    if (fixture && fixture.parentNode) fixture.parentNode.removeChild(fixture);
    State.scratchpad = _savedScratchpad;
}
