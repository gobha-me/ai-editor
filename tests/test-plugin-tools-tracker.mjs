/**
 * Tests for the Plugins._toolOrigins tracker (Plugin Discoverability,
 * 2.1.0). The tracker maps `toolName → pluginId` so the new
 * Settings → Plugins → "Plugin Tools" subsection can list which
 * plugin owns which registered tool.
 *
 * Coverage:
 * - registerTool() populates `_toolOrigins`
 * - getRegisteredTools() joins `_toolOrigins` against the live
 *   ToolRegistry (returns the tool's description and roles)
 * - tools:unregistered event removes the entry (proving the listener
 *   wired at module load is alive)
 * - re-registering a tool overwrites the pluginId (mirrors
 *   ToolRegistry's re-register behavior)
 * - getRegisteredTools() filters out tools the registry has dropped
 *   even if `_toolOrigins` still has them (defensive)
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Plugins, EventBus } from '../js/core.js';

function makePlugin(id) {
    return { id, name: id, version: '0.0.0-test', defaultEnabled: true };
}

const noopHandler = async () => ({ ok: true });

test('registerTool populates _toolOrigins and getRegisteredTools surfaces it', async () => {
    Plugins.register(makePlugin('tracker-plugin-a'));
    const ok = await Plugins.registerTool('tracker-plugin-a', {
        name: 'tracker_tool_a',
        description: 'tool A description',
        parameters: { type: 'object', properties: {}, required: [] },
        roles: 'all',
        handler: noopHandler,
    });
    assert.equal(ok, true);
    assert.equal(Plugins._toolOrigins.get('tracker_tool_a'), 'tracker-plugin-a');

    const tools = Plugins.getRegisteredTools();
    const entry = tools.find(t => t.name === 'tracker_tool_a');
    assert.ok(entry, 'tracker_tool_a should be in getRegisteredTools()');
    assert.equal(entry.pluginId, 'tracker-plugin-a');
    assert.equal(entry.description, 'tool A description');
    assert.equal(entry.roles, 'all');
});

test('tools:unregistered event drops the _toolOrigins entry', async () => {
    Plugins.register(makePlugin('tracker-plugin-b'));
    await Plugins.registerTool('tracker-plugin-b', {
        name: 'tracker_tool_b',
        description: 'tool B',
        parameters: { type: 'object', properties: {}, required: [] },
        roles: 'all',
        handler: noopHandler,
    });
    assert.equal(Plugins._toolOrigins.has('tracker_tool_b'), true);

    EventBus.emit('tools:unregistered', { name: 'tracker_tool_b' });
    assert.equal(Plugins._toolOrigins.has('tracker_tool_b'), false,
        'listener bound at module load should clean up the map entry');
});

test('re-registering a tool overwrites the pluginId in _toolOrigins', async () => {
    Plugins.register(makePlugin('tracker-plugin-c'));
    Plugins.register(makePlugin('tracker-plugin-c2'));

    await Plugins.registerTool('tracker-plugin-c', {
        name: 'tracker_tool_c',
        description: 'first registration',
        parameters: { type: 'object', properties: {}, required: [] },
        roles: 'all',
        handler: noopHandler,
    });
    assert.equal(Plugins._toolOrigins.get('tracker_tool_c'), 'tracker-plugin-c');

    await Plugins.registerTool('tracker-plugin-c2', {
        name: 'tracker_tool_c',
        description: 'second registration',
        parameters: { type: 'object', properties: {}, required: [] },
        roles: 'all',
        handler: noopHandler,
    });
    assert.equal(Plugins._toolOrigins.get('tracker_tool_c'), 'tracker-plugin-c2',
        'second register should overwrite the origin');

    // And getRegisteredTools should reflect the new owner + description.
    const tools = Plugins.getRegisteredTools();
    const entry = tools.find(t => t.name === 'tracker_tool_c');
    assert.equal(entry.pluginId, 'tracker-plugin-c2');
    assert.equal(entry.description, 'second registration');
});

test('getRegisteredTools filters out tools dropped from the registry', async () => {
    Plugins.register(makePlugin('tracker-plugin-d'));
    await Plugins.registerTool('tracker-plugin-d', {
        name: 'tracker_tool_d',
        description: 'tool D',
        parameters: { type: 'object', properties: {}, required: [] },
        roles: 'all',
        handler: noopHandler,
    });

    // Simulate the registry dropping the tool out from under us WITHOUT
    // emitting tools:unregistered. (This shouldn't happen in practice —
    // ToolRegistry.unregister always emits — but the read-side filter
    // is the defensive seam.)
    const def = Plugins._toolRegistry.definitions.find(d => d.function?.name === 'tracker_tool_d');
    const idx = Plugins._toolRegistry.definitions.indexOf(def);
    Plugins._toolRegistry.definitions.splice(idx, 1);

    const tools = Plugins.getRegisteredTools();
    assert.equal(tools.find(t => t.name === 'tracker_tool_d'), undefined,
        'tool dropped from registry must not surface even if _toolOrigins still has it');
});

test('getRegisteredTools returns [] before any plugin has registered a tool', () => {
    // Snapshot the namespace's internal cache, force the empty path,
    // restore. Anything earlier in this test file populates _toolRegistry,
    // so we have to roll it back to exercise the no-registry guard.
    const cached = Plugins._toolRegistry;
    Plugins._toolRegistry = null;
    try {
        assert.deepEqual(Plugins.getRegisteredTools(), []);
    } finally {
        Plugins._toolRegistry = cached;
    }
});
