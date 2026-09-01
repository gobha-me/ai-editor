# Tool Registry and Admission Contract

**Status:** Implemented.

`js/tools/registry.js` owns executable tools. `js/intelligence/tools/` owns the
catalog and bounded set of definitions exposed to a model. Discovery and
execution are separate boundaries.

## Core Contracts and Tool Identity

- Tool names are unique. Registration supplies the handler, JSON-schema-shaped
  parameters, description, cache policy, and side-effect classification.
- Stable tool IDs derive from profile namespace, canonical name, and version.
- Plugins and MCP servers register through the same public boundary and must be
  able to unregister every contributed name.

## The Tool Catalog, Meta-Tools, and Admission

- The active profile, tool catalog, task ledger, discovery result, and budget
  determine which definitions are shown to the model.
- Static tools remain available as configured; discovered tools are bounded and
  recorded in the task ledger.
- Plan mode checks occur at execution, before role or handler dispatch. Session
  working-state exceptions are closed and explicit.
- Side-effect classification is authoritative. A missing classification does not
  silently become safe.
- Cache policy is declared at registration. Mutating or stale-prone tools use
  `never`; by-argument caching must preserve the original result shape.

Discovery meta-tools expose categories and bounded search without making the
entire registry static. Under budget pressure, non-static admissions use
task-use/LRU evidence and report eviction diagnostics.

## Tool Ledger Integration

Discovery and invocation update the session task ledger so subsequent turns can
reuse relevant tools without turning the ledger into durable memory.

## Tool-Authored Failure Shape

Tool-authored refusal or validation failure returns `{ error, code, ... }` with a
code from the closed set and enough structured data for recovery. Success payloads
must not use a false `success` flag as an alternate error envelope. Exceptions
remain transport/runtime failures for the loop to classify.

Registry, admission, side-effect, cache, and failure-shape tests are the
executable contract. User-facing descriptions live in [TOOLS.md](TOOLS.md).
