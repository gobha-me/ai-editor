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

/* ============================================================ */
/* rail-views — structured slot (Decision 1, 2026-05-11)       */
/* ============================================================ */

function makeRailView(overrides = {}) {
    return {
        pluginId: overrides.pluginId ?? 'rv-test',
        slot: 'rail-views',
        view: {
            id: overrides.viewId ?? 'rv-test-id',
            label: overrides.label ?? 'Test view',
            icon: overrides.icon ?? '<svg/>',
            ...(overrides.badge !== undefined ? { badge: overrides.badge } : {}),
            ...(overrides.priority !== undefined ? { priority: overrides.priority } : {}),
        },
        render: overrides.render ?? (() => {}),
        ...(overrides.refreshEvent ? { refreshEvent: overrides.refreshEvent } : {}),
    };
}

test('rail-views accepts a well-formed structured contribution', () => {
    const rv = makeRailView({ pluginId: 'rv1', viewId: 'rv1' });
    SlotManager.contribute('rail-views', rv);
    try {
        const entries = SlotManager.getContributions('rail-views').filter(c => c.pluginId === 'rv1');
        assert.equal(entries.length, 1);
        assert.equal(entries[0].view.id, 'rv1');
        assert.equal(entries[0].view.label, 'Test view');
        assert.equal(typeof entries[0].render, 'function');
    } finally {
        SlotManager.removeByPlugin('rv1');
    }
});

test('rail-views rejects contributions missing the view shape', () => {
    const warns = captureWarn(() => {
        SlotManager.contribute('rail-views', {
            pluginId: 'rv-bad',
            slot: 'rail-views',
            render: () => {},
        });
    });
    assert.equal(warns.length, 1);
    assert.equal(warns[0][0], '[SlotManager] invalid structured contribution');
    assert.match(warns[0][1].reason, /missing view shape/);
    assert.equal(SlotManager.getContributions('rail-views').filter(c => c.pluginId === 'rv-bad').length, 0);
});

test('rail-views rejects contributions missing render(container)', () => {
    const warns = captureWarn(() => {
        SlotManager.contribute('rail-views', {
            pluginId: 'rv-norender',
            slot: 'rail-views',
            view: { id: 'rv-norender', label: 'L', icon: '<svg/>' },
        });
    });
    assert.equal(warns.length, 1);
    assert.match(warns[0][1].reason, /render\(container\) must be a function/);
});

test('rail-views rejects empty view.id / view.label', () => {
    const warnsId = captureWarn(() => {
        SlotManager.contribute('rail-views', makeRailView({ pluginId: 'rv-empty-id', viewId: '' }));
    });
    assert.match(warnsId[0][1].reason, /view\.id/);

    const warnsLabel = captureWarn(() => {
        SlotManager.contribute('rail-views', makeRailView({ pluginId: 'rv-empty-label', viewId: 'has-id', label: '' }));
    });
    assert.match(warnsLabel[0][1].reason, /view\.label/);
});

test('rail-views rejects non-function view.badge', () => {
    const warns = captureWarn(() => {
        SlotManager.contribute('rail-views', makeRailView({
            pluginId: 'rv-badge',
            viewId: 'rv-badge',
            badge: 5,
        }));
    });
    assert.match(warns[0][1].reason, /view\.badge/);
});

test('rail-views collision: second contribution with same view.id is skipped + warned', () => {
    SlotManager.contribute('rail-views', makeRailView({ pluginId: 'rv-c1', viewId: 'dup' }));
    try {
        const warns = captureWarn(() => {
            SlotManager.contribute('rail-views', makeRailView({ pluginId: 'rv-c2', viewId: 'dup' }));
        });
        assert.equal(warns.length, 1);
        assert.equal(warns[0][0], '[SlotManager] rail-views id collision');
        const all = SlotManager.getContributions('rail-views').filter(c => c.view?.id === 'dup');
        assert.equal(all.length, 1, 'only the first contribution survived');
        assert.equal(all[0].pluginId, 'rv-c1');
    } finally {
        SlotManager.removeByPlugin('rv-c1');
        SlotManager.removeByPlugin('rv-c2');
    }
});

test('rail-views sorts by view.priority (lower first; default 50; insertion-stable on ties)', () => {
    // Insertion order: B(50), A(10), C(50)
    // Expected order : A(10), B(50), C(50)
    SlotManager.contribute('rail-views', makeRailView({ pluginId: 'p-b', viewId: 'vb', priority: 50, label: 'B' }));
    SlotManager.contribute('rail-views', makeRailView({ pluginId: 'p-a', viewId: 'va', priority: 10, label: 'A' }));
    SlotManager.contribute('rail-views', makeRailView({ pluginId: 'p-c', viewId: 'vc', priority: 50, label: 'C' }));
    try {
        const ids = SlotManager.getContributions('rail-views')
            .filter(c => ['va', 'vb', 'vc'].includes(c.view.id))
            .map(c => c.view.id);
        assert.deepEqual(ids, ['va', 'vb', 'vc']);
    } finally {
        SlotManager.removeByPlugin('p-a');
        SlotManager.removeByPlugin('p-b');
        SlotManager.removeByPlugin('p-c');
    }
});

test('hasViewId reflects current rail-views state', () => {
    assert.equal(SlotManager.hasViewId('hvi-ghost'), false);
    SlotManager.contribute('rail-views', makeRailView({ pluginId: 'hvi', viewId: 'hvi-present' }));
    try {
        assert.equal(SlotManager.hasViewId('hvi-present'), true);
        assert.equal(SlotManager.hasViewId('hvi-absent'), false);
    } finally {
        SlotManager.removeByPlugin('hvi');
    }
    assert.equal(SlotManager.hasViewId('hvi-present'), false, 'removeByPlugin frees the id');
});

test('rail-views renderSlot emits slot:rail-views:changed and does not touch DOM', () => {
    let emitted = 0;
    const off = EventBus.on('slot:rail-views:changed', () => { emitted += 1; });
    // Stub querySelector to fail loudly if SlotManager ever touched the DOM
    // for a structured slot.
    const originalQuery = document.querySelector;
    document.querySelector = (sel) => {
        if (sel === '[data-slot="rail-views"]') {
            throw new Error('rail-views must not be DOM-mounted by SlotManager');
        }
        return originalQuery.call(document, sel);
    };
    try {
        SlotManager.contribute('rail-views', makeRailView({ pluginId: 'rv-evt', viewId: 'rv-evt' }));
        // contribute -> renderSlot -> emits the event (at minimum once)
        assert.ok(emitted >= 1, `expected at least one slot:rail-views:changed emission, got ${emitted}`);
    } finally {
        document.querySelector = originalQuery;
        off();
        SlotManager.removeByPlugin('rv-evt');
    }
});

test('rail-views: refreshEvent triggers slot:rail-views:changed', () => {
    let emitted = 0;
    const off = EventBus.on('slot:rail-views:changed', () => { emitted += 1; });
    SlotManager.contribute('rail-views', makeRailView({
        pluginId: 'rv-rf',
        viewId: 'rv-rf',
        refreshEvent: 'rv-rf:refresh',
    }));
    try {
        const baseline = emitted;
        EventBus.emit('rv-rf:refresh');
        assert.ok(emitted > baseline, 'refreshEvent should re-emit slot:rail-views:changed');
    } finally {
        off();
        SlotManager.removeByPlugin('rv-rf');
    }
});

test('rail-views: applyProviderContributions wires structured panels from provider manifests', () => {
    GitProviderRegistry.register({
        id: 'rv-prov',
        name: 'Rail v2 Provider',
        contributes: {
            panels: [
                {
                    id: 'rv-prov-issues',
                    slot: 'rail-views',
                    view: { id: 'rv-prov-issues', label: 'Issues (P)', icon: '<svg/>', priority: 20 },
                    render: () => {},
                    refreshEvent: 'issues:refresh',
                },
            ],
            tools: [],
            settings: [],
            menuItems: [],
        },
    });
    try {
        applyProviderContributions();
        const entry = SlotManager.getContributions('rail-views')
            .find(c => c.pluginId === 'rv-prov');
        assert.ok(entry, 'provider rail-views contribution wired');
        assert.equal(entry.view.id, 'rv-prov-issues');
    } finally {
        SlotManager.removeByPlugin('rv-prov');
    }
});

test('getContributions returns a shallow copy (caller mutations do not affect store)', () => {
    SlotManager.contribute('rail-views', makeRailView({ pluginId: 'gc-1', viewId: 'gc-1' }));
    try {
        const copy = SlotManager.getContributions('rail-views');
        const initialLen = copy.length;
        copy.push({ pluginId: 'phantom' });
        const reread = SlotManager.getContributions('rail-views');
        assert.equal(reread.length, initialLen, 'internal store unchanged');
        assert.equal(reread.some(c => c.pluginId === 'phantom'), false);
    } finally {
        SlotManager.removeByPlugin('gc-1');
    }
});

test('getContributions for an empty slot returns an empty array', () => {
    const result = SlotManager.getContributions('rail-views-does-not-exist');
    assert.deepEqual(result, []);
});
