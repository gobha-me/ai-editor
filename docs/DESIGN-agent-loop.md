# Agent Loop Contract

**Status:** Implemented.

`js/chat/handlers.js` starts a request and `js/chat/tool-loop-core.js` owns the
repeating model/tool cycle. `js/chat/agent-loop-contracts.js` centralizes the
envelope and loop-state vocabulary used by cache and refusal helpers.

## Invariants

- User input is recorded before model execution and remains distinguishable from
  system, retrieved, and tool-authored content.
- Only tool calls admitted by the active profile and execution policy reach
  `ToolRegistry.executeWithProfile`.
- Tool-authored failures use structured `{ error, code, ...recovery }` payloads.
  Transport exceptions remain exceptions; the loop must not turn arbitrary
  thrown text into a tool-authored success or refusal.
- Cached results retain their original payload and are marked as cached; cache
  policy must not hide mutations or stale reads.
- Duplicate-argument and same-tool-name guards terminate non-progressing loops.
  Exploration that advances a range or page counts as progress.
- Queued user input is drained in order at a safe turn boundary. A conversation
  switch clears session-scoped approval and task state.
- Terminal output is emitted once. Partial or refused execution must remain
  visible rather than being narrated as success.

### Authorship Rule

The component that detects a condition authors its structured result. Tools
author domain validation failures, the registry authors admission failures,
transport owns provider failures, and the loop authors cache, repetition, and
termination state. Consumers may add presentation but must not recast authorship.

## State and extension points

Loop state includes round and progress counters, call caches, queued input,
approval state, and the action log. Tool families extend behavior through the
registry and classification tables, not tool-name conditionals scattered across
rendering code. New envelope fields require paired consumer and regression-test
updates.

The main coverage is in `tests/test-tool-loop-*.mjs`,
`tests/test-agent-loop-contracts-citation.mjs`, plan-mode tests, queued-input
tests, and tool failure-shape tests.
