# Intelligence Composition Contract

**Status:** Implemented umbrella; individual capabilities remain profile-gated.

The intelligence layer composes bounded context and capabilities for a request.
It does not own provider transport or grant execution authority.

## Components

- Retrieval selects project and conversation evidence.
- Memory supplies user-approved durable facts.
- Compression reduces old conversation turns while preserving required pairs and
  recent context.
- Tool composition selects definitions from the registry under a profile budget.
- Cost accounting records provider usage and enforces user-configured warnings.
- Workspace settings optionally overlay a safelisted subset of configuration.

## Composition rules

- Every contribution retains its author and trust class. Retrieved repository
  text, tool output, plugin text, and MCP text are untrusted data, not system
  instructions.
- Budgets are hard ceilings. A subsystem that cannot fit reports exclusion or
  truncation; it does not silently exceed the request budget.
- Profiles select configuration and capabilities. They cannot bypass the public
  tool registry, sanitization, provider reachability, or approval boundaries.
- Stable identities are content-derived where caching or persistence depends on
  them. Schema/version changes fail closed and require explicit migration.
- Optional subsystems degrade independently. Retrieval or memory failure must not
  corrupt the conversation or fabricate context.

Focused contracts define the public shapes. Cross-subsystem orchestration belongs
in profile resolution, prompt construction, and the chat loop rather than direct
subsystem-to-subsystem mutation.
