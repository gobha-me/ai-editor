# ICD — MCP bridge contract

> **Status:** initial draft, `RE-EVAL following 2.55.0`. Sixth subsystem in the ICD-backfill program per [`ROADMAP.md`](ROADMAP.md) §"Per-subsystem ICD backfill program" target #6. Tracks the contract for `js/mcp/` — the connect/disconnect bridge ([`bridge.js`](../js/mcp/bridge.js), 232 LOC), the JSON-RPC 2.0 client ([`protocol.js`](../js/mcp/protocol.js), 281 LOC), the connection registry ([`registry.js`](../js/mcp/registry.js), 211 LOC), and the discovery/catalog ecosystem ([`catalog.js`](../js/mcp/catalog.js) + [`catalog-fetch.js`](../js/mcp/catalog-fetch.js) + [`catalog-merge.js`](../js/mcp/catalog-merge.js) + [`catalog-source.js`](../js/mcp/catalog-source.js) + [`auto-test.js`](../js/mcp/auto-test.js), 699 LOC combined). Tool admission downstream of the bridge is **out of scope** — that's [`ICD-tool-registry.md`](ICD-tool-registry.md), which this ICD's Registration axis hands off to via `'mcp__*'` glob entries in profile `tools.admit` arrays. Prior ICDs ([#1 chat-handlers, 2.42.0; #2 intelligence-composers, 2.45.0; #3 tool-registry, 2.46.0; #4 git-providers, 2.49.0; #5 retrieval-manager, 2.52.0](ROADMAP.md)) describe orthogonal seams. Code-aware findings from authoring feed back to ROADMAP as `[strong]`-band rows in 2.61.0+; **three** surface this pass (see §"Code-aware findings").

## Purpose

`js/mcp/bridge.js` owns the connect/disconnect orchestration that translates a Model Context Protocol server's `tools/list` result into `ToolRegistry` entries with namespaced names + per-server categories, and routes the matching `tools/call` requests back over the wire. It is the bidirectional bridge between (a) an opaque external MCP server speaking JSON-RPC 2.0 over HTTP and (b) the in-process tool registry whose admission semantics are owned by ICD #3.

Five sub-systems consume this contract: the picker profiles (`chat.v1`, `coder.v1`) and the plugin overlay (`plugin-dev.v1`) admit MCP tools via the `'mcp__*'` glob entry in their `tools.admit` arrays — admission flows entirely through the post-2.54.0 profile-side gate, not through bridge-time tagging; the `subagent.v1` profile deliberately **omits** the glob as a trust-boundary measure; the Settings → MCP Servers tab ([`js/settings/mcp-servers-tab.js`](../js/settings/mcp-servers-tab.js)) drives Add / Edit / Remove / Test + the Browse Catalog picker; the bundled `mcp-bridge` plugin ([`js/plugins/mcp-bridge.js`](../js/plugins/mcp-bridge.js)) calls `loadServers(...)` at init and connects every enabled server on boot; the sticky task ledger ([`js/chat/task-state.js`](../js/chat/task-state.js)) consumes `sweepLedgersByToolId(toolId => isOwnedBy(serverId, toolId))` on disconnect to drop orphan records.

The bridge first shipped at 1.4.2 (HTTP streamable transport only); the catalog ecosystem followed at 2.3.0 (bundled curated 8-entry catalog, github#27 Phase 1); the Smithery registry adapter + cache + merge landed at 2.15.0 (Phase 2 slice 1); the auto-test policy + post-Save toast landed at 2.16.0 (Phase 2 slice 2). The admission inversion at 2.54.0 changed the bridge's role from "tag-stamping during registration" to "pure name-registering" — the `server.roles` field on persisted records is now a dead-letter (see §Code-aware findings). **This ICD freezes the connection lifecycle, the registration name-shape, the disconnect cleanup contract, and the catalog/discovery surface so the next contributor reading the bridge sees what's load-bearing vs. what's incidental.**

## The seam at a glance

| | Surface | Path | LOC | Trigger |
|---|---|---|---|---|
| **Connect/disconnect bridge** | `connect` / `disconnect` / `disconnectAll` / `getRegisteredToolNames` (4 public exports + 1 `__test` seam) | [`bridge.js`](../js/mcp/bridge.js) | 232 | `Settings → MCP Servers` Save / Remove / Toggle; `plugins/mcp-bridge.js` boot loop; `?mcpBridge=off` kill-switch |
| **JSON-RPC client** | `initialize` / `toolsList` / `toolsCall` / `abort` (3 public methods + abort + `__test` seam) | [`protocol.js`](../js/mcp/protocol.js) | 281 | Called by the bridge per connect + per `tools/call` invocation; `abort(serverId)` on disconnect or tab unload |
| **Server registry** | `MCPServerRegistry` namespace (10 methods + `LEGACY_GROUP_TAGS` constant) | [`registry.js`](../js/mcp/registry.js) | 211 | `loadServers` at boot; `addServer` / `updateServer` / `removeServer` from the Settings tab; `testConnection` from the auto-test path |
| **Bundled catalog** | `MCP_CATALOG` (frozen 8-entry array) + `categoryIcon` + `catalogEntryToStarter` | [`catalog.js`](../js/mcp/catalog.js) | 212 | Browse Catalog picker render + pre-fill into the add-server form |
| **Remote catalog source** | `fetchRemoteList` + `parseSmitheryListResponse` + `parseSmitheryDetailResponse` + `smitheryDetailToConnection` | [`catalog-source.js`](../js/mcp/catalog-source.js) | 202 | Catalog-fetch IO layer; pure parsers separately exported for node tests |
| **Catalog fetch with cache** | `getRemoteCatalog` (3-tier fallback: fresh / cache / stale-cache / bundled) | [`catalog-fetch.js`](../js/mcp/catalog-fetch.js) | 119 | Browse Catalog picker first open; backgrounded with `kv` IDB store (`mcp_catalog_remote_v1` + `mcp_catalog_remote_meta_v1`) |
| **Catalog merge** | `mergeCatalogs(bundled, remote)` — pure; bundled-wins-on-collision | [`catalog-merge.js`](../js/mcp/catalog-merge.js) | 81 | Browse Catalog picker render step (after fetch resolves) |
| **Auto-test policy** | `shouldAutoTest({preSave, postSave})` + `formatTestResultToast({label, result})` — pure | [`auto-test.js`](../js/mcp/auto-test.js) | 85 | Settings tab fires after Save when the policy admits |

Total surface: 8 files / 1423 LOC. The bridge proper is the smallest module (232 LOC); the protocol client is the largest (281 LOC). The catalog ecosystem (4 files, 614 LOC) is paper-spec'd as github#27 Phase 1 + Phase 2 slice 1 + slice 2 — see [`DESIGN-mcp-discovery.md`](DESIGN-mcp-discovery.md) for the per-slice rationale.

## The five classification axes

Each axis names a question the seam answers across the bridge + protocol + registry + catalog surfaces. The first three (Connection, Registration, Invocation) describe *the wire-side lifecycle*; the last two (Cleanup, Discovery) describe *the user-visible affordances*.

| Axis | Question | Where it's declared | Where it's read |
|---|---|---|---|
| **Connection axis** | How does the bridge establish a per-server session, and what state does it maintain across calls? | `bridge.connect(serverId)` ([`bridge.js:130`](../js/mcp/bridge.js)) drives `protocol.initialize` → `protocol.toolsList`; per-server `Mcp-Session-Id` cookie captured on initialize and echoed on every subsequent call via `buildHeaders` ([`protocol.js:94`](../js/mcp/protocol.js)). `_sessions: Map<serverId, {initialized, sessionId}>` ([`protocol.js:46`](../js/mcp/protocol.js)) is the per-server session state. On any RPC failure post-initialize, `protocol.abort(serverId)` clears both the in-flight set and the session. | `MCPServerRegistry.testConnection(cfg)` ([`registry.js:169`](../js/mcp/registry.js)) drives the same initialize → toolsList pair against a synthetic probe id (`__test_${Date.now()}`) without mutating the registry. The Settings auto-test path consumes the result envelope; the Browse Catalog picker does not (catalog entries are unverified until Save). |
| **Registration axis** | How does `tools/list` become `ToolRegistry` entries, and what's the naming + de-dup contract? | `makeRegistration(server, mcpTool)` ([`bridge.js:83`](../js/mcp/bridge.js)) builds `{localName, definition, handler}`. **Naming convention:** `mcp__<serverId>__<toolName>` ([`bridge.js:27,39`](../js/mcp/bridge.js)) — double-underscore prefix (`mcp__`) + double-underscore separator. Verified opaque downstream: no consumer splits MCP tool names on `_`. `_registeredToolNames: Map<serverId, string[]>` ([`bridge.js:30`](../js/mcp/bridge.js)) is the per-server registration manifest; populated on connect, drained on disconnect, used as the cleanup driver. **Per-tool registration is via `ToolRegistry.register(localName, handler, definition)` only** — no `roles:`, no `_registeredRoles`, no per-tool tag (this is the post-2.54.0 inversion; see §Code-aware findings). | Admission is profile-side: every picker profile (`chat.v1`, `coder.v1`, `plugin-dev.v1`) declares `'mcp__*'` in its `tools.admit` glob; `subagent.v1` deliberately omits it. The category field `mcp.<serverId>` ([`bridge.js:99`](../js/mcp/bridge.js)) drives grouping in the LLM debug modal's tool catalogue + the tools-by-category prompt block. |
| **Invocation axis** | How does an LLM `tools/call` round-trip get marshalled + the result flattened? | The per-tool handler ([`bridge.js:102`](../js/mcp/bridge.js)) closes over `(serverId, mcpToolName)` and on each invocation: (1) re-resolves the live server via `MCPServerRegistry.getServer(serverId)`; (2) gates on `live.enabled` (disabled server → `{error: "MCP server 'X' is disabled..."}` widened at 1.6.10 to point at the recovery action); (3) calls `protocol.toolsCall(live, mcpToolName, args || {})` returning the spec's `{content, isError}` envelope; (4) flattens via `flattenCallResult` ([`bridge.js:61`](../js/mcp/bridge.js)) — concatenates `content[*].text` parts, summarizes `image` / `resource` parts as `[image mime]` / `[resource uri]` placeholders, JSON-stringifies unknown parts; (5) returns `{result: text}` on success, `{error: message}` on `isError: true` or thrown protocol errors. | The handler is invoked by `ToolRegistry.execute(toolName, args)` — the same path every other tool uses; the bridge has no parallel invocation surface. Errors thread through the standard tool envelope (no MCP-specific failure mode in the LLM-visible result). |
| **Cleanup axis** | What does disconnect do, and what cross-module state has to settle before the next connect? | `bridge.disconnect(serverId, opts)` ([`bridge.js:182`](../js/mcp/bridge.js)) — four steps in order: (1) `ToolRegistry.unregister(name)` for every name in `_registeredToolNames.get(serverId)`; (2) `_registeredToolNames.delete(serverId)`; (3) `protocol.abort(serverId)` cancels in-flight `AbortController`s + deletes the session record; (4) `sweepLedgersByToolId(toolId => isOwnedBy(serverId, toolId))` if `opts.sweepLedgers !== false` — drops orphan records from every live `TaskLedger`. The `sweepLedgers: false` opt-out exists for one path: the connect-time pre-flight teardown ([`bridge.js:137`](../js/mcp/bridge.js)) clears stale registrations from a server-side schema change without nuking the ledger entries that should re-attach to the re-registered names. | `disconnectAll()` ([`bridge.js:211`](../js/mcp/bridge.js)) iterates `_registeredToolNames.keys()` and disconnects each — used by `?mcpBridge=off` kill-switch + the test reset helper. The `protocol.__test.resetState()` clears the global `_inflight` + `_sessions` maps + resets the JSON-RPC id counter; the bridge `__test.reset()` clears `_registeredToolNames`. Test isolation requires both. |
| **Discovery axis** | How does the user find + add a server they didn't already have? | The Browse Catalog picker (Settings → MCP Servers → Browse Catalog) consumes the **merged** catalog: bundled [`MCP_CATALOG`](../js/mcp/catalog.js) (8 curated entries, ships with the release) + remote `getRemoteCatalog()` from [`catalog-fetch.js`](../js/mcp/catalog-fetch.js) (Smithery `registry.smithery.ai/servers?q=is:remote&pageSize=100`, cached 24h in `kv` IDB store, 3-tier fallback fresh/cache/stale-cache/bundled). [`mergeCatalogs`](../js/mcp/catalog-merge.js) is pure + bundled-wins-on-collision (hard collision = same `id`; soft collision = same lowercased trimmed `name`). On entry pick, [`catalogEntryToStarter`](../js/mcp/catalog.js) returns a pre-fill object (label + url + transport + `roles: 'all'` + `token: ''`) consumed by `showServerEditor(null, starter)`. URL placeholders (`{owner}`, `{API_KEY}`, etc.) preserved verbatim — user substitutes before Save. **Catalog entries never carry secrets** ([`catalog.js:194`](../js/mcp/catalog.js) — invariant pinned by `tests/test-mcp-catalog-prefill.mjs`). | The pre-fill flows into the standard add-server form; on Save, `MCPServerRegistry.addServer(cfg)` validates + persists, then the auto-test policy ([`auto-test.js`](../js/mcp/auto-test.js)) decides whether to fire `testConnection` and surface a follow-up toast. Auto-test skips: label-only edits, disabled servers, server records missing `url`. |

Five axes × four protocol entry points (initialize / tools-list / tools-call / abort) × three persistence tiers (in-memory bridge map + IDB-persisted server records + IDB-cached remote catalog) is the surface this ICD pins.

## Per-axis contract

### Connection axis — session lifecycle invariants

The bridge enforces six invariants on connect / reconnect:

1. **Connect is idempotent.** `bridge.connect(serverId)` runs `await disconnect(serverId, {sweepLedgers: false})` first ([`bridge.js:137`](../js/mcp/bridge.js)) — calling connect twice cleanly reconnects without leaking registrations or ledger entries. The `sweepLedgers: false` opt-out exists for this path only; the explicit disconnect API defaults to sweeping.
2. **Initialize + initialized notification.** Per MCP spec: client sends `initialize` JSON-RPC request → captures `Mcp-Session-Id` response header → sends `notifications/initialized` (no id, no response, best-effort fire-and-forget at [`protocol.js:228`](../js/mcp/protocol.js)). `notifications/initialized` failure is swallowed — the spec admits servers that don't require it.
3. **`Mcp-Session-Id` is per-server + persisted across calls.** `_sessions.set(serverId, {initialized, sessionId})` ([`protocol.js:46,182`](../js/mcp/protocol.js)) — every subsequent RPC reads the session record and echoes the id via `buildHeaders` ([`protocol.js:101`](../js/mcp/protocol.js)).
4. **Timeout = 30s per request.** `REQUEST_TIMEOUT_MS = 30000` ([`protocol.js:29`](../js/mcp/protocol.js)) — `setTimeout` calls `controller.abort('mcp-timeout')` which surfaces as `EditorError(NETWORK_TIMEOUT)`. Timeout is per RPC, not per connect; a slow `tools/list` can stall the whole connect, surface a connect failure, and leave the registry record marked `_unreachable: true`.
5. **Unreachable + lastSync are runtime-only fields.** Updated on connect success / failure ([`bridge.js:158,168`](../js/mcp/bridge.js)); persisted but stripped on `serialize()` ([`registry.js:193`](../js/mcp/registry.js)) — they reset to defaults on next `loadServers`. The persisted core is `(id, label, url, token, transport, enabled, roles)`.
6. **Response content-type dispatch.** `readJsonRpcResponse` ([`protocol.js:115`](../js/mcp/protocol.js)) accepts either `application/json` (single response) or `text/event-stream` (one or more SSE-framed JSON-RPC messages — match by `id`). Unknown content-type throws `EditorError(LLM_API_ERROR)`. **The request body is always POST with a single JSON-RPC envelope** — the bridge does not implement the SSE-spec request shape (`POST messages, GET /sse`). See §Code-aware findings #2.

### Registration axis — naming convention + dedup invariants

1. **`mcp__<serverId>__<toolName>` is the canonical name.** Double-underscore prefix (`TOOL_NAME_PREFIX = 'mcp__'` at [`bridge.js:27`](../js/mcp/bridge.js)) + double-underscore separator. The `_` literal is opaque downstream — no consumer splits the name; the prefix membership check `isOwnedBy(serverId, name)` is `name.startsWith('mcp__' + serverId + '__')` ([`bridge.js:50`](../js/mcp/bridge.js)).
2. **`category: 'mcp.<serverId>'` is the registration grouping.** Dot separator (different from the name's double-underscore) drives the LLM debug modal's tool catalogue + the tools-by-category prompt block. Distinct from name parsing — categories are first-class registry fields.
3. **`inputSchema` passthrough or empty-object default.** If `mcpTool.inputSchema` is a non-null object, use it verbatim; otherwise default to `{type: 'object', properties: {}, required: []}` ([`bridge.js:88`](../js/mcp/bridge.js)). No schema munging, no validation pre-call.
4. **Description is `[MCP <serverLabel>] <description>` prefix** ([`bridge.js:85`](../js/mcp/bridge.js)) — surfaces the MCP origin to the LLM in the tool's prompt-visible description so the model can reason about provenance.
5. **No `roles:` field on the registered definition.** The post-2.54.0 contract: registration is admission-tag-free; admission is profile-side via `tools.admit` glob `'mcp__*'`. Pinned at [`tests/test-mcp-bridge.mjs:259`](../tests/test-mcp-bridge.mjs) — `def.roles === undefined && def._registeredRoles === undefined`.
6. **Per-tool register failures degrade, not abort.** `ToolRegistry.register(localName, ...)` throwing (name collision, validation) → `console.warn` + skip that tool; other tools still register ([`bridge.js:152`](../js/mcp/bridge.js)). The bridge's connect result reflects the partial count via `toolCount = registered.length`.

### Invocation axis — tools/call marshalling + result flattening

The per-tool handler closure ([`bridge.js:102`](../js/mcp/bridge.js)) carries `(server.id, mcpTool.name)`. Five steps per invocation:

1. **Re-resolve the server.** `MCPServerRegistry.getServer(server.id)` is read each call (not closure-captured) — handles the case where the user edits the server URL between connect and call.
2. **Disabled-server gate.** `!live || !live.enabled` → `{error: "MCP server 'X' is disabled. Re-enable it in Settings → MCP Servers, or use a different tool."}` ([`bridge.js:105`](../js/mcp/bridge.js)). The error string format is load-bearing — the LLM uses it to decide whether to retry or switch tools.
3. **`tools/call` RPC.** `await protocol.toolsCall(live, mcpToolName, args || {})` — args default to `{}` so callers that pass `null` don't trigger a protocol error.
4. **Result flattening.** `flattenCallResult(envelope)` ([`bridge.js:61`](../js/mcp/bridge.js)) — concatenate every `content[*].text` part with `\n`, summarize `image` / `resource` parts as `[image <mime>]` / `[resource <uri>]` strings, JSON-stringify unknown parts. `isError: true` flips `ok` to `false`.
5. **Return envelope.** `{result: text}` on success, `{error: "MCP tool X reported isError: ..." | thrown message}` on failure. The envelope matches the standard `ToolRegistry.execute` contract — no MCP-specific failure mode threads to the LLM.

**Image + resource part summarization is intentionally lossy.** The bridge does not surface base64 image data, blob URLs, or binary resource contents — only their presence + metadata. A future multi-modal MCP path would need a richer flatten contract; today, the LLM sees a placeholder string.

### Cleanup axis — disconnect cascade

Four steps in strict order ([`bridge.js:182`](../js/mcp/bridge.js)):

1. **Unregister registered tools.** Iterate `_registeredToolNames.get(serverId) || []`; call `ToolRegistry.unregister(name)` for each; count successes.
2. **Drop the registration record.** `_registeredToolNames.delete(serverId)`.
3. **Abort in-flight requests.** `protocol.abort(serverId)` — calls `controller.abort('mcp-disconnected')` on every `AbortController` in `_inflight.get(serverId)`, deletes the inflight set, deletes the session record. The abort reason surfaces as `EditorError(NETWORK_OFFLINE)` to any pending caller ([`protocol.js:197`](../js/mcp/protocol.js)).
4. **Sweep sticky-ledger orphans** (default; opt-out via `{sweepLedgers: false}`). `sweepLedgersByToolId(toolId => isOwnedBy(serverId, toolId))` iterates every live `TaskLedger` and drops entries whose `tool_id` matches the prefix predicate. Without this sweep, a sticky ledger entry pointing at a now-unregistered tool name would survive forever.

**The `sweepLedgers: false` opt-out has exactly one caller: the connect-time pre-flight teardown.** A reconnect after a server-side schema change should preserve ledger entries that will re-attach to the re-registered names; an explicit disconnect should not.

### Discovery axis — bundled catalog + Smithery merge + auto-test

The discovery surface answers "how does a user find a server to add?" — orthogonal to the bridge proper, but co-located in `js/mcp/` because the lifecycle (Catalog pick → Pre-fill → Save → Auto-test → Connect) crosses module boundaries.

**Bundled catalog ([`catalog.js`](../js/mcp/catalog.js)).** Hand-curated `Object.freeze([...])` of 8 entries (DeepWiki, GitMCP, Semgrep, Apify, Firecrawl, Linear, Notion, Sentry). Entry shape: `{id, name, description, category, url, transport, requiresToken, tokenHint?, docsUrl, authNote?}`. Two categories with OAuth caveats today (Linear, Notion) carry `authNote` strings flagging bearer-token-as-workaround until OAuth lands in Phase 1.5. The freeze + invariants are tested via `tests/test-mcp-catalog.mjs`.

**Remote source ([`catalog-source.js`](../js/mcp/catalog-source.js)).** Smithery adapter — LIST endpoint paginated, DETAIL endpoint fetched lazily on user pick. `?q=is:remote` filter excludes stdio entries the bridge can't speak to. Pure parsers (`parseSmitheryListResponse`, `parseSmitheryDetailResponse`) exported separately; IO functions take an injected `fetchImpl` for node-test stubbing.

**Fetch + cache ([`catalog-fetch.js`](../js/mcp/catalog-fetch.js)).** 3-tier fallback under `kv` IDB store (`mcp_catalog_remote_v1` entries + `mcp_catalog_remote_meta_v1` meta) with 24h TTL. Tiers: fresh (within TTL) → cache → fresh fetch → stale cache → bundled-only. Network + IDB errors never throw; `source` field on the return tells the caller which tier resolved.

**Merge ([`catalog-merge.js`](../js/mcp/catalog-merge.js)).** Pure. Bundled entries first in declared order; remote entries that didn't collide follow. Collision rules: hard collision = same `id` → drop remote; soft collision = same lowercased trimmed `name` → drop remote. Bundled always wins — they ship with full `tokenHint` / `authNote` strings + URLs ready to use without a follow-up DETAIL fetch.

**Pre-fill ([`catalog.js`](../js/mcp/catalog.js) `catalogEntryToStarter`).** Pure transformer. Invariants pinned by `tests/test-mcp-catalog-prefill.mjs`: `token` always `''` (catalog never carries secrets); `transport` falls back to `'streamable-http'` on unrecognised value; `roles` defaults to `'all'` (dead-letter post-2.54.0 — see §Code-aware findings #1); URL placeholders preserved verbatim; null input → null return.

**Auto-test ([`auto-test.js`](../js/mcp/auto-test.js)).** Pure decision pair. `shouldAutoTest({preSave, postSave})` admits the test on: adds when enabled; edits when `url` / `token` / `transport` changed; edits when toggled disabled → enabled. Skips: label-only renames; disabled-on-Save; missing url. `formatTestResultToast({label, result})` shapes the post-Save toast — success = "✅ connected — N tool(s) advertised"; failure = "⚠️ <error>. Edit the server to fix." The toast follows the Save toast as a follow-up; the auto-test never blocks the Save acknowledgment.

## Interaction matrix

### Shared contract (load-bearing, do not split)

- **Bridge module-scoped state is intentional.** `_registeredToolNames: Map<serverId, string[]>` ([`bridge.js:30`](../js/mcp/bridge.js)) and protocol's `_inflight: Map<serverId, Set<AbortController>>` + `_sessions: Map<serverId, {initialized, sessionId}>` ([`protocol.js:37,46`](../js/mcp/protocol.js)) are the single sources of truth for in-process bridge state. No `State` slot, no IDB persistence — these are reconstructed on every bridge boot via `plugins/mcp-bridge.js → MCPServerRegistry.loadServers → for each enabled: bridge.connect`.
- **`MCPServerRegistry` mirrors `GitProviderRegistry` deliberately** ([`registry.js:5–9`](../js/mcp/registry.js)). Same shape, same persistence pattern, same Test/Add/Remove/Edit verbs. The deliberate symmetry lets Settings → MCP Servers tab copy the Git connections-tab skeleton without inventing a new vocabulary. Future generic "N-of-each connection" surfaces should adopt the same shape.
- **Naming `mcp__<serverId>__<toolName>` is opaque downstream.** No consumer splits MCP tool names on `_`. The `isOwnedBy(serverId, name)` predicate is the canonical membership test; new consumers (e.g. trust-boundary filters, per-server quota enforcers) MUST use it rather than re-implementing the prefix check.
- **Admission flows through `tools.admit` `'mcp__*'` glob, not through bridge-time tagging.** Post-2.54.0 inversion: the bridge does not stamp `roles:` or `_registeredRoles` on the registered definition; admission is decided at `Profiles.filterTools` time against the active profile's admit list. Per-server admission narrowing (when it lands) goes via hand-curated admit lists in `tools.admit` (gitea#440 pattern) or the `plugin.enabled` overlay (gitea#442 pattern), not via re-introducing per-server tags.
- **Browser-only.** The bridge speaks HTTP/SSE only; no stdio. Stdio MCP servers require a backend relay companion that doesn't exist today; the catalog's `?q=is:remote` Smithery filter enforces this at discovery time.

### Disjoint surfaces

- **Protocol is bridge-agnostic.** [`protocol.js`](../js/mcp/protocol.js) does not reference `ToolRegistry`, the bridge module, or `State`. It's a pure JSON-RPC 2.0 client over fetch + AbortController; the bridge composes it with the registry. The `MCPServerRegistry.testConnection` path bypasses the bridge entirely and drives protocol directly.
- **Catalog ecosystem is connection-agnostic.** None of the four catalog modules import `bridge.js`, `protocol.js`, or `ToolRegistry`. The catalog hands off to the standard `addServer` + auto-test flow once the user clicks the picker entry — there's no bypass path that pre-connects from a catalog entry.
- **Auto-test is bridge-agnostic.** [`auto-test.js`](../js/mcp/auto-test.js) decides whether to fire `testConnection` and shapes the toast — but the call itself goes to `MCPServerRegistry.testConnection`, not to `bridge.connect`. Save-then-Test is intentionally not Save-then-Connect; the user toggling Enabled is the connect trigger (handled by the bundled plugin's settings-change listener).
- **The sticky-ledger sweep predicate is pure.** `sweepLedgersByToolId(toolId => isOwnedBy(serverId, toolId))` — the bridge passes a closure; the ledger module knows nothing about MCP naming. New ledger-sweep callers (e.g. an "unregister this plugin's tools" sweep) reuse the same `sweepLedgersByToolId` entry-point with a different predicate.

### Open invariants (not asserted today)

- **No test pins the `MCPServerRegistry` public surface shape.** `Object.keys(MCPServerRegistry).sort()` could regress (a renamed method, a silently-dropped getter) and only the production call sites would surface. Same gap ICD #4 cited for `BASE_GIT_PROVIDER` (resolved at 2.50.0 via `tests/test-provider-capabilities-shape.mjs`); same shape applies here. See §Code-aware findings #3.
- **No test pins `bridge.js`'s public exports.** Same gap; the four-export contract `{connect, disconnect, disconnectAll, getRegisteredToolNames}` + the `__test` introspection seam could regress silently.
- **No test asserts the registration definition shape over time.** [`tests/test-mcp-bridge.mjs:259`](../tests/test-mcp-bridge.mjs) pins the post-2.54.0 absence of `roles` / `_registeredRoles`; it does not pin the positive-shape (`{type: 'function', function: {name, description, parameters}, category}`). A registration shape drift (e.g. moving `category` into `function` per OpenAPI evolution) would silently break the LLM debug modal's grouping without a test.

## Code-aware findings (feed back to ROADMAP as 2.61.0+ rows)

Authoring this ICD surfaced **three** drift items worth tracking. Per re-eval methodology, one is suggested for the next code minor's `[strong]` row; the others stay queued.

### 1. `server.roles` field is dead post-2.54.0 — UX + docstring drift

The admission inversion at 2.54.0 retired per-tool `roles:` tagging in favor of profile-side `tools.admit` enumeration. The bridge stopped copying `server.roles` onto tool definitions (pinned by [`tests/test-mcp-bridge.mjs:259`](../tests/test-mcp-bridge.mjs)) — but the `server.roles` field itself remains:

- **Persisted in IDB** ([`registry.js:194`](../js/mcp/registry.js)) — every saved server record carries it
- **Edited in the Settings UI** — [`js/settings/mcp-servers-tab.js:151,197`](../js/settings/mcp-servers-tab.js) renders role checkboxes + the "Allowed Roles:" label that the 2.57.0 sweep already updated to read "Profiles"
- **Validated by `normaliseRoles()`** ([`registry.js:44`](../js/mcp/registry.js)) against `LEGACY_GROUP_TAGS = ['full', 'coder', 'pm', 'reviewer', 'plugin-dev']`
- **Documented as load-bearing** at [`registry.js:28–36`](../js/mcp/registry.js) — the docstring claims "post-2.0.0 they're consumed as group tags by `Profile.tools.allowed_groups`" which is **wrong** post-2.54.0 (`allowed_groups` retired; `tools.admit` enumerates names directly)

**Suggested fix shape for next code minor:** Three options, ordered by invasiveness:

- **(a) Documentation-only fix** (smallest): Rewrite the `LEGACY_GROUP_TAGS` docstring at [`registry.js:28–36`](../js/mcp/registry.js) to call out the post-2.54.0 dead-letter status; preserve the field for back-compat with persisted records. Note in the Settings → MCP Servers tab that the per-server roles UI is presently a no-op. Single-file edit + UI copy update.
- **(b) Hide the UI** (medium): Drop the role checkboxes + label from `js/settings/mcp-servers-tab.js`; keep the field persisted (zero migration risk). Adds back-compat docstring at the registry. ~2-file edit + 1 test update.
- **(c) Remove the field** (largest): Migration to drop `server.roles` from persisted records; remove `normaliseRoles` + `LEGACY_GROUP_TAGS`; drop UI. Cleanest end-state but requires a one-shot migration in the storage layer and a deprecation cycle.

**Recommendation: (a) for the next code minor.** Captures the dead-letter status without the migration risk; defer (b) and (c) until a real user-facing pain surfaces. Composes with the 2.57.0 user-visible Roles → Profiles rename — same shape (in-place doc/UI correction, no semantic change).

**Why this matters:** Future plugin profile authoring (Phase 4) will want per-server admission semantics; the dead `server.roles` field is a foot-gun for users who set it expecting it to do something. The 2.54.0 inversion removed the consumer; the producer is now load-bearing-looking-but-isn't, which is the worst shape for a settings field.

### 2. `transport: 'sse'` is plumbed end-to-end but falls through to streamable-http

`VALID_TRANSPORTS = new Set(['streamable-http', 'sse'])` ([`registry.js:25`](../js/mcp/registry.js)) admits SSE; the bundled catalog ships two SSE entries (Firecrawl, Linear). The protocol module's module docstring ([`protocol.js:5–13`](../js/mcp/protocol.js)) candidly states:

> "1.4.2 ships only the streamable-http path; the transport field is plumbed but 'sse' falls through to streamable-http with a logged warning. A dedicated SSE transport lands when a real-world server forces it."

But `rpc()` ([`protocol.js:151`](../js/mcp/protocol.js)) actually does **not** dispatch on transport — it always POSTs with `Accept: application/json, text/event-stream`. The SSE-spec request shape (`POST messages, GET /sse for the response stream`) is not implemented. Servers strict about the SSE-spec request flow will silently fail at connect time; servers that accept POST-with-SSE-Accept will work and surface as streamable-http behind the scenes.

**Suggested fix shape (queued, not promoted):** Two options:

- **(a) Honest reject** — `MCPServerRegistry.addServer` + `updateServer` reject `transport: 'sse'` with a "not yet supported, use streamable-http" error; drop the SSE entries from the bundled catalog (or convert them if the upstream servers support streamable-http on the same endpoint).
- **(b) Real SSE transport** — implement the GET-and-listen path in protocol.js; add a per-transport dispatch in `rpc()`; reuse the existing `_sessions` + `_inflight` maps. Larger surface; pairs naturally with the github#27 Phase 1.5 OAuth work (different transport, same protocol module).

**Why this is queued, not promoted:** The current behavior is "silently maybe-works" depending on the server's tolerance for non-spec POSTs. Until a real user files a connection failure tied to SSE strictness, the cost-of-fixing exceeds the cost-of-documenting. Worth pairing with Phase 1.5 OAuth implementation when that DESIGN doc lands.

### 3. No shape-pinning test for `MCPServerRegistry` or `bridge` public surfaces

`Object.keys(MCPServerRegistry).sort()` and `Object.keys(bridge).sort()` could regress silently — a renamed method, a deleted getter, a refactor that splits an export — and only production call sites would surface the break. Same gap ICD #4 cited for `BASE_GIT_PROVIDER` (resolved at 2.50.0 via [`tests/test-provider-capabilities-shape.mjs`](../tests/test-provider-capabilities-shape.mjs)) and ICD #5 cited for `RetrievalManager` (still open).

**Suggested fix shape (queued, not promoted):** Add `tests/test-mcp-bridge-shape.mjs` and `tests/test-mcp-registry-shape.mjs` (or a single combined file) pinning:
- `bridge`: `{connect, disconnect, disconnectAll, getRegisteredToolNames, __test}` — exactly five exports.
- `MCPServerRegistry`: the 10-method surface (`loadServers, addServer, updateServer, removeServer, getServer, listServers, testConnection, serialize, __test_reset`) — exactly nine plus the constant.
- `protocol`: `{initialize, toolsList, toolsCall, abort, __test}` — exactly five.

Same idiom as `test-provider-capabilities-shape.mjs`; ~60 LOC across three exports; node-test compatible (no DOM coupling for the protocol + registry; bridge imports `ToolRegistry` which is already node-loadable).

**Why this is queued, not promoted:** Mechanical; not blocking anything. Worth bundling with the next intentional bridge edit (e.g. the finding #1 docstring fix above) so the shape-pin lands alongside a real change rather than as standalone churn.

### Other observations (not promoted)

- **Bridge `__test.reset()` and `protocol.__test.resetState()` must be called together** for clean inter-test isolation. Tests that only reset one observe stale state from the other. The combined contract isn't documented at the test seam.
- **`_registeredToolNames` is never persisted.** Tab reload → empty map → reconnect-on-boot via `plugins/mcp-bridge.js`. This is the right shape (sessions and registrations are runtime state), but the boot-loop's "reconnect every enabled server" pass can stack ~30s timeouts × N servers if multiple are unreachable.
- **`MCP_CATALOG` is frozen but `getRemoteCatalog` returns mutable entries.** The merge step doesn't `Object.freeze` the merged output; downstream consumers (the picker render) could mutate entries without trips. Not a bug today; flagged as a future hardening if a consumer starts caching the merged catalog.
- **`flattenCallResult` JSON-stringifies unknown content parts.** A future MCP spec evolution adding new `content[*].type` values would surface as `JSON.stringify(c)` in the LLM-visible result rather than as a typed summary. Not drift; documented degradation path.
- **The `catalogEntryToStarter` `roles: 'all'` default** is the same dead-letter as finding #1, but on the catalog-pick path. Fix lands as part of finding #1's UX cleanup.

## Forward-evolution rules

### When adding a new MCP transport

1. **Add to `VALID_TRANSPORTS`** in [`registry.js`](../js/mcp/registry.js) and update `normaliseRoles`-equivalent transport coercion if shape changes.
2. **Dispatch in `rpc()`** at [`protocol.js:151`](../js/mcp/protocol.js) on `server.transport` rather than always POSTing — adds a real SSE branch (GET /sse listener + separate POST messages endpoint) or a future stdio-via-relay branch.
3. **Bundle catalog entries** that use the new transport explicitly mark `transport: '<name>'` — the Smithery source already normalizes the field via `smitheryDetailToConnection`.
4. **Update this ICD's Connection axis section** + the §Code-aware findings #2 resolution note.

### When adding a new MCP method beyond `tools/*`

The bridge handles only `tools/list` + `tools/call`; the MCP spec also has `resources/list`, `resources/read`, `prompts/list`, `prompts/get`. Adding any of these means:

1. **Add the RPC wrapper to [`protocol.js`](../js/mcp/protocol.js)** — mirror `toolsList` / `toolsCall` shape.
2. **Decide the bridge surfacing.** Resources could become read-only tools (`mcp__<serverId>__resource__<uri>`); prompts could be admitted via a different registry seam entirely.
3. **Update the registration naming convention if collisions are possible.** `mcp__<serverId>__tools__<name>` vs `mcp__<serverId>__resources__<name>` may be cleaner than re-using the unified namespace.
4. **Update the `getRegisteredToolNames` + `isOwnedBy` semantics** to reflect the multi-method registration footprint.
5. **Update this ICD's Registration + Invocation axes.**

### When adding a new catalog entry (existing bundled catalog)

Per the inline runbook in [`catalog.js:39–47`](../js/mcp/catalog.js): pick a slug id (`^[a-z0-9][a-z0-9-]*$`), add to `MCP_CATALOG`, fill `tokenHint` if `requiresToken: true`, run `node --test tests/test-mcp-catalog.mjs`. The data tests enforce: distinct slugs; valid category; HTTP/SSE-only transport; `tokenHint` present when `requiresToken: true`; `docsUrl` valid.

### When adding per-server admission narrowing (post finding #1 resolution)

The post-2.54.0 contract decides admission at profile-side `Profiles.filterTools`. Adding per-server narrowing means:

1. **Profile-side hand-curate** — add specific `mcp__<serverId>__*` globs to `tools.admit` in the relevant profile; remove the broader `'mcp__*'` glob if it's now over-permissive. Mirror the gitea#440 pattern.
2. **Or capability-overlay** — add an `<name>.enabled` flag mirroring `plugin.enabled`/`preview.enabled`; the runtime filter wires the per-server admit list. Mirror the gitea#442 pattern.
3. **Update [`ICD-tool-registry.md`](ICD-tool-registry.md) §"Per-export contract"** — admission contract evolution lives there.

## References

- **Source — bridge:** [`js/mcp/bridge.js`](../js/mcp/bridge.js) (232 LOC; 4 public exports + 1 `__test` seam; module-scoped `_registeredToolNames`).
- **Source — protocol:** [`js/mcp/protocol.js`](../js/mcp/protocol.js) (281 LOC; JSON-RPC 2.0 over fetch + AbortController; per-server `_inflight` + `_sessions` maps; 30s request timeout).
- **Source — server registry:** [`js/mcp/registry.js`](../js/mcp/registry.js) (211 LOC; `MCPServerRegistry` namespace mirroring `GitProviderRegistry`; `LEGACY_GROUP_TAGS` constant, dead-letter post-2.54.0).
- **Source — catalog ecosystem:** [`js/mcp/catalog.js`](../js/mcp/catalog.js) (bundled 8-entry array + `categoryIcon` + `catalogEntryToStarter`); [`catalog-source.js`](../js/mcp/catalog-source.js) (Smithery adapter; pure parsers + IO with injected `fetchImpl`); [`catalog-fetch.js`](../js/mcp/catalog-fetch.js) (3-tier IDB-cached fallback); [`catalog-merge.js`](../js/mcp/catalog-merge.js) (pure; bundled-wins-on-collision); [`auto-test.js`](../js/mcp/auto-test.js) (pure Save-time decision pair).
- **Production consumers:** [`js/settings/mcp-servers-tab.js`](../js/settings/mcp-servers-tab.js) (Add / Edit / Remove / Test / Browse Catalog UI); [`js/plugins/mcp-bridge.js`](../js/plugins/mcp-bridge.js) (boot-time `loadServers` + connect-every-enabled); [`js/chat/task-state.js`](../js/chat/task-state.js) (`sweepLedgersByToolId` ledger drain).
- **Tests (node):** `tests/test-mcp-bridge.mjs` (connect/disconnect/reconnect; post-2.54.0 no-roles invariant); `tests/test-mcp-protocol.mjs` (JSON-RPC framing; SSE-content-type parsing; timeout / abort); `tests/test-mcp-registry.mjs` (10-method registry surface; `LEGACY_GROUP_TAGS` validation); `tests/test-mcp-catalog.mjs` (data-shape invariants); `tests/test-mcp-catalog-prefill.mjs` (`catalogEntryToStarter` invariants — no token leak); `tests/test-mcp-catalog-source.mjs` (Smithery parser); `tests/test-mcp-catalog-fetch.mjs` (3-tier fallback under injected IDB + fetch); `tests/test-mcp-catalog-merge.mjs` (bundled-wins-on-collision); `tests/test-mcp-auto-test.mjs` (`shouldAutoTest` + `formatTestResultToast`).
- **Design contracts:** No dedicated `DESIGN-mcp-*.md` yet. The catalog + auto-test surfaces were sliced directly off github#27 (Phase 1 / Phase 2 slice 1 / Phase 2 slice 2 — see CHANGELOG entries for 2.3.0 / 2.15.0 / 2.16.0). A `docs/DESIGN-mcp-oauth.md` authoring slot is queued per [`ROADMAP.md`](ROADMAP.md) §"Known open issues" github#27 row (security-surface — Phase 2 OAuth flows; no specific milestone target yet).
- **Cross-ICD:** [`ICD-tool-registry.md`](ICD-tool-registry.md) §"Per-export contract" (the admission gate this ICD's Registration axis hands off to; `'mcp__*'` glob membership). [`ICD-git-providers.md`](ICD-git-providers.md) §"Functional defaults" (the parallel `GitProviderRegistry` shape that `MCPServerRegistry` deliberately mirrors).
- **Methodology:** [`ROADMAP.md`](ROADMAP.md) §"Per-subsystem ICD backfill program" (this ICD is target #6; remaining candidates for the next slot: editor instance, plugin lifecycle — profiles registry deferred per `project_profile_admission_paper`).
- **History anchors:** 1.4.2 (initial bridge + protocol + registry — streamable-http only); 1.6.10 (disabled-server error string widened to point at recovery action); 2.3.0 (bundled `MCP_CATALOG` 8-entry curated list; github#27 Phase 1); 2.15.0 (Smithery source + fetch + merge; github#27 Phase 2 slice 1); 2.16.0 (auto-test policy + post-Save toast; github#27 Phase 2 slice 2); 2.54.0 (admission inversion — bridge stopped tagging `roles:` on registered tools; `server.roles` became a dead-letter); 2.57.0 (user-visible Roles → Profiles rename — Settings tab label updated, internal symbol preserved).
