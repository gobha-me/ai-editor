# Delegated Task Contract

**Status:** Implemented for a single bounded child task. Parallel and recursive
delegation are not scheduled.

`delegate_task` creates one isolated child request through
`js/chat/subagent-runner.js`. `subagent.v1` supplies its default profile and the
approval card shows the requested task and capability summary before execution.

## Invariants

- The child receives the explicit delegated task and bounded project context, not
  an implicit copy of the parent's full conversation.
- The resolved child profile may only narrow the parent's available capabilities.
  It cannot grant missing tools, plugin/MCP authority, or side effects.
- Approval occurs before the child model call. Rejection, timeout, provider
  failure, and cancellation return structured terminal results.
- Per-call model, duration, output, and cost ceilings are enforced. Child cost is
  attributed separately and also included in the parent request total.
- The parent receives a structured result and bounded transcript. Persisted
  transcripts have a fixed turn cap.
- A child cannot delegate another child. The registry and prompt both enforce the
  non-recursive boundary.

The delivered capability satisfies the original single-child MVP. Any future
parallel or nested design requires new observed demand, a fresh issue, and an
updated authority/cost contract. Tests cover profile resolution, approval,
transcript persistence, cost attribution, limits, and tool registration.
