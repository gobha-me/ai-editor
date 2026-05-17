/**
 * Tests for the Plugins lifecycle in js/core.js — specifically that
 * `setEnabled(id, true)` runs the plugin's `init()` for plugins that
 * shipped with `defaultEnabled: false` and skipped boot-time init.
 *
 * Regression: before this fix, setEnabled only flipped the boolean and
 * emitted plugin:enabledChanged, but never called init(). Plugins like
 * release-sync (defaultEnabled:false) registered at boot, got skipped
 * by the boot-time Plugins.init() loop, and stayed UI-less even after
 * a user toggled them on in Settings — registerButton/registerModal/
 * registerTool calls live inside init(), so they never fired.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Plugins, EventBus } from '../js/core.js';

function makePlugin(id, { defaultEnabled = false, init = null } = {}) {
    return {
        id,
        name: id,
        version: '0.0.0-test',
        defaultEnabled,
        init: init || (async () => ({})),
    };
}

/* ============================================================ */
/* setEnabled runs init() on first enable                       */
/* ============================================================ */

test('setEnabled(true) on a defaultEnabled:false plugin runs init() and registers buttons', async () => {
    let initCalls = 0;
    const id = 'lifecycle-test-1';
    const manifest = makePlugin(id, {
        defaultEnabled: false,
        init: async () => {
            initCalls++;
            Plugins.registerButton(id, { icon: '🧪', label: 'Test', onClick: () => {} });
            return { ready: true };
        },
    });

    Plugins.register(manifest);
    assert.equal(initCalls, 0, 'init not called at register time');
    assert.equal(Plugins.getButtons().some((b) => b.pluginId === id), false, 'no button before enable');

    await Plugins.setEnabled(id, true);

    assert.equal(initCalls, 1, 'init called exactly once');
    assert.equal(Plugins.get(id).enabled, true);
    assert.equal(Plugins.get(id).instance?.ready, true, 'instance captured from init() return');
    assert.ok(Plugins.getButtons().some((b) => b.pluginId === id), 'button registered after enable');
});

test('setEnabled(true) on a plugin that was already enabled is a no-op for init', async () => {
    let initCalls = 0;
    const id = 'lifecycle-test-2';
    Plugins.register(makePlugin(id, {
        defaultEnabled: true,
        init: async () => {
            initCalls++;
            return {};
        },
    }));

    // Simulate boot-time init.
    await Plugins.init(id);
    assert.equal(initCalls, 1);

    // Re-enabling a plugin that's already enabled and has an instance — no re-init.
    await Plugins.setEnabled(id, true);
    assert.equal(initCalls, 1, 'init not called again');
});

test('setEnabled(false) does not run init', async () => {
    let initCalls = 0;
    const id = 'lifecycle-test-3';
    Plugins.register(makePlugin(id, {
        defaultEnabled: true,
        init: async () => {
            initCalls++;
            return {};
        },
    }));
    await Plugins.init(id);
    assert.equal(initCalls, 1);

    await Plugins.setEnabled(id, false);
    assert.equal(Plugins.get(id).enabled, false);
    assert.equal(initCalls, 1, 'disabling never re-triggers init');
});

test('disable then re-enable does not run init twice (instance already set)', async () => {
    let initCalls = 0;
    const id = 'lifecycle-test-4';
    Plugins.register(makePlugin(id, {
        defaultEnabled: true,
        init: async () => {
            initCalls++;
            return { value: 'first' };
        },
    }));
    await Plugins.init(id);
    assert.equal(initCalls, 1);

    await Plugins.setEnabled(id, false);
    await Plugins.setEnabled(id, true);

    // The plugin already has an instance from the first init — re-init
    // would double-register buttons/tools, so we deliberately skip.
    assert.equal(initCalls, 1, 'no re-init on toggle off→on when instance exists');
    assert.equal(Plugins.get(id).enabled, true);
});

test('init() throwing on enable surfaces in console but leaves enabled=true', async () => {
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
        const id = 'lifecycle-test-5';
        Plugins.register(makePlugin(id, {
            defaultEnabled: false,
            init: async () => {
                throw new Error('init bomb');
            },
        }));

        await Plugins.setEnabled(id, true);
        assert.equal(Plugins.get(id).enabled, true, 'flag still set even when init throws');
        assert.equal(Plugins.get(id).instance, null, 'instance never assigned on throw');
        assert.ok(errors.some((e) => e.includes('Plugin init failed on enable') && e.includes(id)), 'error logged');
    } finally {
        console.error = origError;
    }
});

test('plugin:enabledChanged fires before init() completes', async () => {
    const events = [];
    const id = 'lifecycle-test-6';
    let initStarted = false;
    Plugins.register(makePlugin(id, {
        defaultEnabled: false,
        init: async () => {
            initStarted = true;
            // Defer one microtask so we can prove the event fired earlier.
            await Promise.resolve();
            return {};
        },
    }));

    EventBus.on('plugin:enabledChanged', (data) => {
        if (data.pluginId === id) events.push({ when: 'enabledChanged', initStarted });
    });
    EventBus.on('plugin:initialized', (data) => {
        if (data === id || data?.pluginId === id) events.push({ when: 'initialized' });
    });

    await Plugins.setEnabled(id, true);

    // enabledChanged should fire BEFORE init() runs, so initStarted is
    // still false at that point. (Listeners want the boolean visible
    // immediately so UI updates aren't blocked on async init.)
    const e = events.find((x) => x.when === 'enabledChanged');
    assert.ok(e, 'enabledChanged event observed');
    assert.equal(e.initStarted, false, 'enabledChanged fires before init() begins');
});

test('setEnabled on unknown plugin id is a quiet no-op', async () => {
    // Should not throw, should not log.
    await Plugins.setEnabled('does-not-exist', true);
    assert.equal(Plugins.get('does-not-exist'), undefined);
});

/* ============================================================ */
/* setEnabled runs destroy() on first disable (2.64.0 / ICD #7 #1) */
/* ============================================================ */

test('setEnabled(false) invokes manifest.destroy with (instance, config)', async () => {
    let destroyCalls = 0;
    let destroyArgs = null;
    const id = 'lifecycle-test-destroy-1';
    const manifest = {
        ...makePlugin(id, {
            defaultEnabled: true,
            init: async () => ({ ready: true }),
        }),
        destroy: async (instance, config) => {
            destroyCalls++;
            destroyArgs = { instance, config };
        },
    };
    Plugins.register(manifest);
    Plugins.setConfig(id, { key: 'value' });
    await Plugins.init(id);

    await Plugins.setEnabled(id, false);

    assert.equal(destroyCalls, 1, 'destroy called exactly once on disable');
    assert.deepEqual(destroyArgs.instance, { ready: true }, 'destroy received the init() return value');
    assert.deepEqual(destroyArgs.config, { key: 'value' }, 'destroy received the persisted config');
    assert.equal(Plugins.get(id).enabled, false);
    assert.equal(Plugins.get(id).instance, null, 'instance cleared after destroy');
});

test('setEnabled(false) twice does not invoke destroy twice', async () => {
    let destroyCalls = 0;
    const id = 'lifecycle-test-destroy-2';
    Plugins.register({
        ...makePlugin(id, {
            defaultEnabled: true,
            init: async () => ({}),
        }),
        destroy: async () => {
            destroyCalls++;
        },
    });
    await Plugins.init(id);

    await Plugins.setEnabled(id, false);
    await Plugins.setEnabled(id, false);

    assert.equal(destroyCalls, 1, 'destroy is idempotent across redundant disables');
});

test('destroy() throwing is logged but does not block disable persistence', async () => {
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
        const id = 'lifecycle-test-destroy-3';
        Plugins.register({
            ...makePlugin(id, {
                defaultEnabled: true,
                init: async () => ({}),
            }),
            destroy: async () => {
                throw new Error('destroy bomb');
            },
        });
        await Plugins.init(id);

        await Plugins.setEnabled(id, false);

        assert.equal(Plugins.get(id).enabled, false, 'disable persisted despite throw');
        assert.equal(Plugins.get(id).instance, null, 'instance cleared even when destroy throws');
        assert.ok(
            errors.some((e) => e.includes('Plugin destroy failed on disable') && e.includes(id)),
            'destroy failure logged with pluginId',
        );
    } finally {
        console.error = origError;
    }
});

test('setEnabled(false) on plugin without destroy hook is a quiet no-op', async () => {
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
        const id = 'lifecycle-test-destroy-4';
        Plugins.register(makePlugin(id, {
            defaultEnabled: true,
            init: async () => ({ ready: true }),
        }));
        await Plugins.init(id);

        await Plugins.setEnabled(id, false);

        assert.equal(Plugins.get(id).enabled, false);
        // Instance is preserved when no destroy is declared — the old
        // "skip re-init on toggle off→on" antibody still applies for
        // plugins without lifecycle cleanup.
        assert.deepEqual(Plugins.get(id).instance, { ready: true }, 'instance preserved when no destroy declared');
        assert.equal(errors.length, 0, 'no spurious console output when no destroy declared');
    } finally {
        console.error = origError;
    }
});
