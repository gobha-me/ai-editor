# MCP Integration Contract

**Status:** Implemented for configured streamable-HTTP and SSE servers, with a
bundled and optional remote catalog.

`js/mcp/registry.js` persists server definitions. `js/mcp/protocol.js` performs
protocol requests. `js/mcp/bridge.js` connects servers and registers namespaced
tools in the public registry. Catalog modules supply starter configuration only;
they do not create trusted connections automatically.

## Invariants

- Server IDs are stable and unique. URLs, transport, enabled state, and auth
  configuration are validated before connection.
- Initialization completes before tool discovery. Pagination and protocol errors
  are explicit; incomplete discovery is not a clean empty catalog.
- Contributed names use `mcp__<server-id>__<tool-name>` and retain a mapping to
  the originating server and remote name.
- Disconnect, disable, replacement, and failed reconnect remove every contributed
  tool before returning.
- MCP descriptions, schemas, and results are untrusted remote data. They do not
  override profile admission, plan-mode checks, sanitization, or output limits.
- Abort and timeout are per request/server. Late responses cannot satisfy a new
  request.
- Remote catalogs are cached and merged only after shape validation. Catalog
  presence is not an endorsement and never carries credentials.

Tests cover registry migration, protocol framing, pagination, bridge cleanup,
catalog validation/merge/cache, profile admission, and auto-test behavior.
