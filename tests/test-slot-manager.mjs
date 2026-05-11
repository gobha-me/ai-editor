/**
 * Tests for the SlotManager renderer that ships against the locked contract
 * in docs/DESIGN-git-providers-and-ui-extensions.md §4 (lines 193-412).
 *
 * Pure-logic Node tests; the appendChild path uses a stub HTMLElement
 * class so the production `el instanceof HTMLElement` check exercises the
 * element-mount branch. document.querySelector is overridden per-test to
 * provide a recording stub container.
 *
 * Test isolation: SlotManager is a singleton; each test uses unique
 * pluginIds and cleans up via removeByPlugin() at the end.
 */
import './_node-shim.mjs';

// HTMLElement stub must be installed BEFORE slot-manager.js loads — the
// production module's `el instanceof HTMLElement` check captures the
// global at module-eval time.
class StubElement {}
globalThis.HTMLElement = StubElement;

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SlotManager, applyProviderContributions } from '../js/slot-manager.js';
import { EventBus } from '../js/core.js';
import { GitProviderRegistry } from '../js/git-providers/registry.js';

function makeStubContainer() {
    return {
        innerHTML: '',
        _appended: [],
        _inserted: [],
        appendChild(el) { this._appended.push(el); },
        insertAdjacentHTML(_pos, html) { this._inserted.push(html); },
    };
}

function withStubContainer(slotId, container, fn) {
    const originalQuery = document.querySelector;
    document.querySelector = (sel) => (sel === `[data-slot="${slotId}"]` ? container : null);
    try { fn(); } finally { document.querySelector = originalQuery; }
}

function captureWarn(fn) {
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => { warnings.push(args); };
    try { fn(); } finally { console.warn = original; }
    return warnings;
}

function captureError(fn) {
    const errors = [];
    const original = console.error;
    console.error = (...args) => { errors.push(args); };
    try { fn(); } finally { console.error = original; }
    return errors;
}

/* ============================================================ */
/* contribute() — registration + sort                           */
/* ============================================================ */

test('contribute() appends to slot array and sorts by priority ascending', () => {
    SlotManager.contribute('status-bar', { pluginId: 't1-a', render: () => '<a/>', priority: 50 });
    SlotManager.contribute('status-bar', { pluginId: 't1-b', render: () => '<b/>', priority: 10 });
    SlotManager.contribute('status-bar', { pluginId: 't1-c', render: () => '<c/>', priority: 90 });

    const entries = SlotManager._contributions.get('status-bar') || [];
    const t1 = entries.filter(e => e.pluginId.startsWith('t1-'));
    assert.deepEqual(t1.map(e => e.pluginId), ['t1-b', 't1-a', 't1-c']);

    SlotManager.removeByPlugin('t1-a');
    SlotManager.removeByPlugin('t1-b');
    SlotManager.removeByPlugin('t1-c');
});

test('explicit priority: 0 sorts before default 50 (uses ?? not ||)', () => {
    SlotManager.contribute('status-bar', { pluginId: 't2-default', render: () => '<a/>' });
    SlotManager.contribute('status-bar', { pluginId: 't2-zero', render: () => '<b/>', priority: 0 });

    const t2 = (SlotManager._contributions.get('status-bar') || [])
        .filter(e => e.pluginId.startsWith('t2-'));
    assert.deepEqual(t2.map(e => e.pluginId), ['t2-zero', 't2-default']);

    SlotManager.removeByPlugin('t2-default');
    SlotManager.removeByPlugin('t2-zero');
});

test('insertion order preserved on equal priority (stable sort)', () => {
    SlotManager.contribute('status-bar', { pluginId: 't3-first', render: () => '<a/>', priority: 50 });
    SlotManager.contribute('status-bar', { pluginId: 't3-second', render: () => '<b/>', priority: 50 });
    SlotManager.contribute('status-bar', { pluginId: 't3-third', render: () => '<c/>', priority: 50 });

    const t3 = (SlotManager._contributions.get('status-bar') || [])
        .filter(e => e.pluginId.startsWith('t3-'));
    assert.deepEqual(t3.map(e => e.pluginId), ['t3-first', 't3-second', 't3-third']);

    SlotManager.removeByPlugin('t3-first');
    SlotManager.removeByPlugin('t3-second');
    SlotManager.removeByPlugin('t3-third');
});

/* ============================================================ */
/* contribute() — guards                                        */
/* ============================================================ */

test('unknown slot ID is rejected with a warning and no append', () => {
    const warns = captureWarn(() => {
        SlotManager.contribute('not-a-real-slot', { pluginId: 't4', render: () => '<x/>' });
    });
    assert.equal(warns.length, 1);
    assert.equal(warns[0][0], '[SlotManager] unknown slot');
    assert.equal(SlotManager._contributions.has('not-a-real-slot'), false);
});

test('unrecognized version is rejected with a warning; "1.1" and missing version both accepted', () => {
    const warns = captureWarn(() => {
        SlotManager.contribute('status-bar', { pluginId: 't5-bad', render: () => '<x/>', version: '9.9' });
    });
    assert.equal(warns.length, 1);
    assert.equal(warns[0][0], '[SlotManager] unrecognized version');

    SlotManager.contribute('status-bar', { pluginId: 't5-good-explicit', render: () => '<x/>', version: '1.1' });
    SlotManager.contribute('status-bar', { pluginId: 't5-good-missing', render: () => '<x/>' });
    const ids = (SlotManager._contributions.get('status-bar') || [])
        .map(e => e.pluginId).filter(p => p.startsWith('t5-'));
    assert.deepEqual(ids.sort(), ['t5-good-explicit', 't5-good-missing']);

    SlotManager.removeByPlugin('t5-good-explicit');
    SlotManager.removeByPlugin('t5-good-missing');
});

/* ============================================================ */
/* renderSlot() — mount paths                                   */
/* ============================================================ */

test('renderSlot() mounts string returns via insertAdjacentHTML', () => {
    const container = makeStubContainer();
    withStubContainer('status-bar', container, () => {
        SlotManager.contribute('status-bar', { pluginId: 't6', render: () => '<span>x</span>' });
    });
    assert.deepEqual(container._inserted, ['<span>x</span>']);
    assert.equal(container._appended.length, 0);
    SlotManager.removeByPlugin('t6');
});

test('renderSlot() mounts HTMLElement returns via appendChild', () => {
    const container = makeStubContainer();
    const el = new StubElement();
    withStubContainer('status-bar', container, () => {
        SlotManager.contribute('status-bar', { pluginId: 't7', render: () => el });
    });
    assert.deepEqual(container._appended, [el]);
    assert.equal(container._inserted.length, 0);
    SlotManager.removeByPlugin('t7');
});

test('renderSlot() skips contributions whose render is null/undefined (rails-before-renderers forward-compat)', () => {
    const container = makeStubContainer();
    withStubContainer('status-bar', container, () => {
        SlotManager.contribute('status-bar', { pluginId: 't8a', render: null });
        SlotManager.contribute('status-bar', { pluginId: 't8b', render: () => '<live/>' });
    });
    assert.deepEqual(container._inserted, ['<live/>']);
    SlotManager.removeByPlugin('t8a');
    SlotManager.removeByPlugin('t8b');
});

test('renderSlot() catches per-contribution errors and continues to siblings', () => {
    const container = makeStubContainer();
    let errors;
    withStubContainer('status-bar', container, () => {
        errors = captureError(() => {
            SlotManager.contribute('status-bar', {
                pluginId: 't9-bad',
                render: () => { throw new Error('boom'); },
            });
            SlotManager.contribute('status-bar', {
                pluginId: 't9-good',
                render: () => '<good/>',
            });
        });
    });
    assert.deepEqual(container._inserted, ['<good/>']);
    const matching = errors.filter(args => args[0] === '[SlotManager] render failed');
    assert.ok(matching.length >= 1, 'render failure logged');
    const payload = matching[0][1];
    assert.equal(payload.pluginId, 't9-bad');
    assert.equal(payload.slotId, 'status-bar');
    assert.ok(payload.error instanceof Error);

    SlotManager.removeByPlugin('t9-bad');
    SlotManager.removeByPlugin('t9-good');
});

/* ============================================================ */
/* refreshEvent + removeByPlugin                                */
/* ============================================================ */

test('refreshEvent triggers renderSlot when EventBus emits', () => {
    const container = makeStubContainer();
    let renderCount = 0;
    withStubContainer('status-bar', container, () => {
        SlotManager.contribute('status-bar', {
            pluginId: 't10',
            render: () => { renderCount++; return '<n/>'; },
            refreshEvent: 't10:refresh',
        });
        assert.equal(renderCount, 1, 'initial render on contribute');

        EventBus.emit('t10:refresh');
        assert.equal(renderCount, 2, 'render fires on refreshEvent');
    });
    SlotManager.removeByPlugin('t10');
});

test('removeByPlugin() detaches refreshEvent listeners and removes contributions', () => {
    const container = makeStubContainer();
    let renderCount = 0;
    withStubContainer('status-bar', container, () => {
        SlotManager.contribute('status-bar', {
            pluginId: 't11',
            render: () => { renderCount++; return '<n/>'; },
            refreshEvent: 't11:refresh',
        });
        assert.equal(renderCount, 1);

        SlotManager.removeByPlugin('t11');
        renderCount = 0;
        EventBus.emit('t11:refresh');
        assert.equal(renderCount, 0, 'no render after removeByPlugin');

        const remaining = (SlotManager._contributions.get('status-bar') || [])
            .filter(c => c.pluginId === 't11');
        assert.equal(remaining.length, 0);
    });
});

test('renderAll() invokes renderSlot for every slot with contributions', () => {
    const containers = {
        'status-bar': makeStubContainer(),
        'chat-input-row': makeStubContainer(),
    };
    const originalQuery = document.querySelector;
    document.querySelector = (sel) => {
        const m = /^\[data-slot="([^"]+)"\]$/.exec(sel);
        return m ? (containers[m[1]] ?? null) : null;
    };
    try {
        SlotManager.contribute('status-bar', { pluginId: 't12-sb', render: () => '<s/>' });
        SlotManager.contribute('chat-input-row', { pluginId: 't12-cir', render: () => '<c/>' });
        containers['status-bar']._inserted = [];
        containers['chat-input-row']._inserted = [];

        SlotManager.renderAll();
        assert.deepEqual(containers['status-bar']._inserted, ['<s/>']);
        assert.deepEqual(containers['chat-input-row']._inserted, ['<c/>']);
    } finally {
        document.querySelector = originalQuery;
        SlotManager.removeByPlugin('t12-sb');
        SlotManager.removeByPlugin('t12-cir');
    }
});

/* ============================================================ */
/* applyProviderContributions()                                 */
/* ============================================================ */

test('applyProviderContributions() does not throw when GitProviderRegistry is empty/render-less', () => {
    assert.doesNotThrow(() => applyProviderContributions());
});

test('applyProviderContributions() registers panels with render functions and silently skips render-less ones', () => {
    GitProviderRegistry.register({
        id: 'slot-test-prov',
        name: 'SlotTest Provider',
        contributes: {
            panels: [
                {
                    id: 'slot-test-panel-renderless',
                    slot: 'sidebar-panels',
                    title: 'No Renderer',
                    priority: 20,
                },
                {
                    id: 'slot-test-panel-rendered',
                    slot: 'sidebar-panels',
                    title: 'With Renderer',
                    render: () => '<div>hello</div>',
                    priority: 10,
                },
            ],
            tools: [],
            settings: [],
            menuItems: [],
        },
    });
    try {
        const warns = captureWarn(() => applyProviderContributions());
        assert.equal(warns.length, 0, 'no warnings — render-less entries skipped silently');

        const entries = (SlotManager._contributions.get('sidebar-panels') || [])
            .filter(c => c.pluginId === 'slot-test-prov');
        assert.equal(entries.length, 1, 'only the render-bearing panel got contributed');
        assert.equal(typeof entries[0].render, 'function');
        assert.equal(entries[0].priority, 10);
    } finally {
        SlotManager.removeByPlugin('slot-test-prov');
    }
});
