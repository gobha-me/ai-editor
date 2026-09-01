# Current Implementation Contracts

These documents describe implemented behavior on `main`. They are not a backlog
and do not reserve future phases or releases.

| Contract | Authority |
|---|---|
| [Agent loop](DESIGN-agent-loop.md) | Turn lifecycle, tool-result envelopes, cache and progress guards |
| [Compression](DESIGN-compression.md) | Deterministic history compaction decisions |
| [Intelligence](DESIGN-intelligence.md) | Composition and trust-label boundaries |
| [Memory](DESIGN-memory.md) | Curated records, consent, scopes, and persistence |
| [Profiles](DESIGN-profiles.md) | Profile inheritance and capability resolution |
| [Retrieval](DESIGN-retrieval.md) | Ingest, stable chunk identity, routing, and bounded composition |
| [Tools](DESIGN-tools.md) | Registry, admission, execution policy, and structured failures |
| [Git providers](DESIGN-git-providers.md) | Provider-neutral Git API and reachability behavior |
| [MCP](DESIGN-mcp.md) | Server registry, protocol, catalog, and reversible tool bridge |
| [Plugins](PLUGIN.md) | Manifest, lifecycle, permissions, and installed-plugin behavior |
| [Preview](DESIGN-preview.md) | Isolated preview lifecycle and observation/action tools |
| [Approved automation](DESIGN-llm-authored-automation.md) | Script approval and worker limits |
| [Delegated tasks](DESIGN-sub-agents.md) | The shipped single-child delegation boundary |
| [UI event dispatch](DESIGN-ui-event-dispatch.md) | Delegated actions and the no-inline-handler invariant |

[ARCHITECTURE.md](ARCHITECTURE.md) owns the system map. [SECURITY.md](SECURITY.md)
owns security policy. [ROADMAP.md](ROADMAP.md) owns product outcomes and
deferrals. User-facing tool and profile guidance lives in [TOOLS.md](TOOLS.md)
and [PROFILES_AND_TOOLS.md](PROFILES_AND_TOOLS.md).

When behavior and prose disagree, fail closed, inspect the executable tests, and
repair the stale side in the same change. Historical reasoning remains available
from Git history; do not copy it into current contracts.
