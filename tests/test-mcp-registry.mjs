/**
 * Tests for `js/mcp/registry.js` — MCPServerRegistry CRUD + serialize.
 *
 * Pure data-layer tests. `testConnection` is exercised in test-mcp-bridge
 * where the protocol side is also stubbed.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MCPServerRegistry } from '../js/mcp/registry.js';

function reset() {
    MCPServerRegistry.__test_reset();
}

test('addServer: creates a record with safe defaults', () => {
    reset();
    const s = MCPServerRegistry.addServer({ id: 'fs', label: 'Filesystem', url: 'https://mcp.example/mcp' });
    assert.equal(s.id, 'fs');
    assert.equal(s.label, 'Filesystem');
    assert.equal(s.transport, 'streamable-http');
    assert.equal(s.enabled, true);
    assert.equal(s._toolCount, 0);
    assert.equal(s._lastSync, null);
    assert.equal(s._unreachable, false);
});

test('addServer: rejects duplicate IDs', () => {
    reset();
    MCPServerRegistry.addServer({ id: 'fs', url: 'https://x/mcp' });
    assert.throws(() => MCPServerRegistry.addServer({ id: 'fs', url: 'https://y/mcp' }), /already exists/);
});

test('addServer: requires id and url', () => {
    reset();
    assert.throws(() => MCPServerRegistry.addServer({ url: 'https://x/mcp' }), /id and url/);
    assert.throws(() => MCPServerRegistry.addServer({ id: 'fs' }), /id and url/);
});

test('addServer: invalid transport falls back to streamable-http', () => {
    reset();
    const s = MCPServerRegistry.addServer({ id: 'fs', url: 'https://x/mcp', transport: 'mystery' });
    assert.equal(s.transport, 'streamable-http');
});

test('updateServer: partial merge preserves untouched fields', () => {
    reset();
    MCPServerRegistry.addServer({ id: 'fs', label: 'old', url: 'https://x/mcp', token: 'tok' });
    const updated = MCPServerRegistry.updateServer('fs', { label: 'new' });
    assert.equal(updated.label, 'new');
    assert.equal(updated.token, 'tok');
});

test('updateServer: rejects unknown id', () => {
    reset();
    assert.throws(() => MCPServerRegistry.updateServer('ghost', { label: 'x' }), /not found/);
});

test('updateServer: rejects invalid transport (keeps prior)', () => {
    reset();
    MCPServerRegistry.addServer({ id: 'fs', url: 'https://x/mcp', transport: 'sse' });
    const updated = MCPServerRegistry.updateServer('fs', { transport: 'bogus' });
    assert.equal(updated.transport, 'sse');
});

test('removeServer: returns false for unknown id', () => {
    reset();
    assert.equal(MCPServerRegistry.removeServer('ghost'), false);
    MCPServerRegistry.addServer({ id: 'fs', url: 'https://x/mcp' });
    assert.equal(MCPServerRegistry.removeServer('fs'), true);
    assert.equal(MCPServerRegistry.getServer('fs'), null);
});

test('listServers: enabled-only filter', () => {
    reset();
    MCPServerRegistry.addServer({ id: 'a', url: 'https://x/a', enabled: true });
    MCPServerRegistry.addServer({ id: 'b', url: 'https://x/b', enabled: false });
    assert.equal(MCPServerRegistry.listServers().length, 2);
    assert.equal(MCPServerRegistry.listServers(true).length, 1);
    assert.equal(MCPServerRegistry.listServers(true)[0].id, 'a');
});

test('serialize: strips runtime fields', () => {
    reset();
    MCPServerRegistry.addServer({ id: 'fs', url: 'https://x/mcp', token: 'tok' });
    MCPServerRegistry.updateServer('fs', { _toolCount: 5, _lastSync: 1700000000, _unreachable: true });
    const [persisted] = MCPServerRegistry.serialize();
    assert.equal(persisted._toolCount, undefined);
    assert.equal(persisted._lastSync, undefined);
    assert.equal(persisted._unreachable, undefined);
    assert.equal(persisted.id, 'fs');
    assert.equal(persisted.token, 'tok');
});

test('loadServers: replaces in-memory state and coerces missing fields', () => {
    reset();
    MCPServerRegistry.addServer({ id: 'old', url: 'https://x/mcp' });
    MCPServerRegistry.loadServers([
        { id: 'fs', url: 'https://x/mcp' },
        { id: 'gh', url: 'https://x/gh', enabled: false },
    ]);
    const all = MCPServerRegistry.listServers();
    assert.equal(all.length, 2);
    assert.equal(all[0].id, 'fs');
    assert.equal(all[0].enabled, true);
    assert.equal(all[1].enabled, false);
});

test('loadServers: drops records missing id or url', () => {
    reset();
    MCPServerRegistry.loadServers([
        { id: 'good', url: 'https://x/good' },
        { id: '', url: 'https://x/orphan' },
        { id: 'noUrl' },
        null,
    ]);
    const all = MCPServerRegistry.listServers();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, 'good');
});
