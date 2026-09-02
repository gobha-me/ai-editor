# MCP Integration Contract

**Status:** Implemented for configured Streamable HTTP servers, with a bundled
and optional remote catalog. Legacy HTTP+SSE and stdio are not implemented.

`js/mcp/registry.js` persists server definitions. `js/mcp/protocol.js` performs
protocol requests. `js/mcp/bridge.js` connects servers and registers namespaced
tools in the public registry. Catalog modules supply starter configuration only;
they do not create trusted connections automatically.

## Invariants

- Server IDs are stable and unique. URLs, transport, enabled state, and auth
  configuration are validated before connection.
- Missing transport defaults to `streamable-http`; every explicit unsupported
  transport fails before network access. Persisted legacy records remain
  visible but load disabled until the user supplies a Streamable HTTP endpoint.
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
- Remote catalogs are cached and merged only after shape and transport
  validation. SSE-only records are not offered as usable connections. Catalog
  presence is not an endorsement and never carries credentials.

Tests cover registry migration, protocol framing, pagination, bridge cleanup,
catalog validation/merge/cache, profile admission, and auto-test behavior.
