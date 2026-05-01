/**
 * Browser smoke tests for the Settings → MCP Servers panel (1.4.2).
 *
 * Pins the integration contract:
 *   - Renders one row per registered MCP server with label, URL, transport
 *     and tool-count meta.
 *   - Empty registry shows the "+ Add MCP Server" empty-state line.
 *   - Status pill resolution: ok / warn (_unreachable, no URL) / disabled.
 *   - showServerEditor(id) populates the form fields from the registry
 *     record; showServerEditor(null) blanks them.
 *
 * Test isolation: MCPServerRegistry is a module singleton; we wipe it via
 * the `__test_reset` seam and restore the pre-test state on teardown.
 */

import { MCPServerRegistry } from '../js/mcp/registry.js';
import {
    __test_renderMCPServersList,
    __test_showServerEditor,
} from '../js/settings/mcp-servers-tab.js';

const { T } = window;

T.suite('MCP Servers panel — 1.4.2');

// ----- DOM scaffold (mirrors html/settings-tabs.html) -----

const fixture = document.createElement('div');
fixture.innerHTML = `
    <div class="settings-tab-content" id="tabMCPServers">
        <div class="conn">
            <div id="mcpServersList"></div>
            <button id="btnAddMCPServer"></button>
        </div>
        <div id="mcpServerEditor" style="display: none;">
            <h4 id="mcpServerEditorTitle">New MCP Server</h4>
            <input id="mcpEditId">
            <input id="mcpEditLabel">
            <input id="mcpEditUrl">
            <input id="mcpEditToken">
            <select id="mcpEditTransport">
                <option value="streamable-http">Streamable HTTP</option>
                <option value="sse">SSE</option>
            </select>
            <input type="checkbox" id="mcpEditEnabled">
            <div id="mcpServerTestResult"></div>
        </div>
    </div>
`;
document.body.appendChild(fixture);

// ----- Snapshot + seed -----

const priorServers = MCPServerRegistry.serialize();
MCPServerRegistry.__test_reset();

MCPServerRegistry.addServer({
    id: 'fs-demo',
    label: 'Filesystem Demo',
    url: 'https://mcp.example/fs',
    token: 'tok-1',
    transport: 'streamable-http',
    enabled: true,
});
MCPServerRegistry.updateServer('fs-demo', { _toolCount: 4, _lastSync: Date.now() });

MCPServerRegistry.addServer({
    id: 'gh-demo',
    label: 'GitHub MCP',
    url: 'https://mcp.example/gh',
    transport: 'sse',
    enabled: false,
});

// ----- Row rendering -----

__test_renderMCPServersList();

const rows = fixture.querySelectorAll('#mcpServersList .conn__row');
T.eq(rows.length, 2, 'Renders one row per server');

const fsRow = fixture.querySelector('[data-mcp-id="fs-demo"]');
T.assert(fsRow, 'Row for fs-demo is queryable by data-mcp-id');
T.assert(fsRow.textContent.includes('mcp.example/fs'), 'fs-demo row meta includes URL');
T.assert(fsRow.textContent.includes('streamable-http'), 'fs-demo row meta includes transport');
T.assert(fsRow.textContent.includes('4 tools'), 'fs-demo row meta includes tool count');
T.assert(fsRow.querySelector('.conn__status--ok'), 'fs-demo (enabled, has URL) shows status--ok');

const ghRow = fixture.querySelector('[data-mcp-id="gh-demo"]');
T.assert(ghRow.classList.contains('conn__row--disabled'), 'gh-demo (enabled:false) carries disabled modifier');
T.assert(ghRow.querySelector('.conn__status--disabled'), 'gh-demo renders status--disabled');

// ----- Empty state -----

MCPServerRegistry.__test_reset();
__test_renderMCPServersList();
const empty = fixture.querySelector('#mcpServersList .conn__empty');
T.assert(empty, 'Empty registry renders the empty-state line');
T.assert(
    empty.textContent.toLowerCase().includes('add mcp server'),
    'Empty-state line includes the "Add MCP Server" CTA copy'
);

// ----- Editor populate-from-registry round-trip -----

MCPServerRegistry.__test_reset();
MCPServerRegistry.addServer({
    id: 'edit-demo',
    label: 'Edit Demo',
    url: 'https://mcp.example/x',
    token: 'tok-x',
    transport: 'sse',
    enabled: false,
});

__test_showServerEditor('edit-demo');
T.eq(fixture.querySelector('#mcpEditLabel').value, 'Edit Demo', 'Editor label populated');
T.eq(fixture.querySelector('#mcpEditUrl').value, 'https://mcp.example/x', 'Editor URL populated');
T.eq(fixture.querySelector('#mcpEditToken').value, 'tok-x', 'Editor token populated');
T.eq(fixture.querySelector('#mcpEditTransport').value, 'sse', 'Editor transport populated');
T.eq(fixture.querySelector('#mcpEditEnabled').checked, false, 'Editor enabled checkbox populated');
T.eq(fixture.querySelector('#mcpServerEditorTitle').textContent, 'Edit MCP Server', 'Editor title reads "Edit"');

// ----- Editor reset for new -----

__test_showServerEditor(null);
T.eq(fixture.querySelector('#mcpEditLabel').value, '', 'New: label blank');
T.eq(fixture.querySelector('#mcpEditUrl').value, '', 'New: URL blank');
T.eq(fixture.querySelector('#mcpEditToken').value, '', 'New: token blank');
T.eq(fixture.querySelector('#mcpEditTransport').value, 'streamable-http', 'New: transport defaults to streamable-http');
T.eq(fixture.querySelector('#mcpEditEnabled').checked, true, 'New: enabled defaults to true');
T.eq(fixture.querySelector('#mcpServerEditorTitle').textContent, 'New MCP Server', 'Editor title reads "New"');

// ----- Teardown: restore registry state -----

MCPServerRegistry.__test_reset();
MCPServerRegistry.loadServers(priorServers);
fixture.remove();
