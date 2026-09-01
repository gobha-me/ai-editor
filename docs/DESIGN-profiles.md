# Profile Contract

**Status:** Implemented.

Profiles select coherent prompt, retrieval, memory, compression, tool, preview,
plugin, and task-ledger behavior. They are data registered in
`js/profiles/registry.js` and resolved through `js/profiles/resolve.js`.

## The Profile Contract

Each profile may define prompt directives plus retrieval, memory, compression,
tools, preview, plugin, automation, and task-ledger configuration. Resolvers own
defaults and return bounded normalized values.

## Inheritance and Failure Modes

- `chat.v1` is the base contract. Named profiles may inherit from one parent;
  missing parents and cycles are errors.
- Object fields merge recursively. Lists and scalar values replace parent values
  unless a field's contract states otherwise.
- The active conversation profile wins over the global setting. Lookup-only
  profiles such as the delegated-task profile are not automatically shown in the
  picker.
- Resolvers return normalized capability-specific shapes. Callers do not read
  arbitrary profile properties directly.
- A profile may narrow tool access but cannot grant an unregistered tool or
  bypass side-effect, plan-mode, plugin, MCP, or approval policy.

## Canonical Profiles

The registry currently includes chat, coder, knowledge-base, project-management,
reviewer, full, plugin-development, multi-chat, role-play, and delegated-task
profiles. Presence in the registry is an implementation fact, not a roadmap
commitment. Picker exposure and lookup-only registration remain separate.

Task ledgers are session working state with bounded capacity; they are not durable
memory. Profile migration supports stored legacy role values without changing
the authoritative resolved shape. Tests under `tests/test-profile*.mjs` pin
inheritance, registry visibility, resolution, and capability budgets.

## Budget Shape and Task Ledger

Token budgets reserve prompt, retrieved evidence, memory, tools, and output
capacity without exceeding the model window. Task-ledger capacity is finite and
old admission records are evicted deterministically. Novelty thresholds are
profile data, not global policy.
