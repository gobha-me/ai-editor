# Conversation Compression Contract

**Status:** Implemented and profile-gated.

`js/intelligence/compression/` converts chat messages to stable turns, applies
ordered decisions, and converts survivors back without mutating the source
history. `js/chat/compactor-integration.js` is the chat-side adapter.

## Core Contracts

- `compress(request)` returns survivors, diagnostics, and token accounting.
- Decisions are `Keep`, `Drop`, `Replace`, or `Summarize`; first non-keep
  decision wins for a turn.
- Tool calls and their results remain paired. A result must not survive without
  the call that gives it meaning.
- The configured recent-turn reserve is preserved unless the request itself is
  invalid.
- Subsumption and invalidation are deterministic. Optional summarization may call
  an LLM only through the supplied adapter and must report failure without
  discarding the original content.
- Synthesized turns are labelled with their reason and never impersonate user or
  tool-authored turns.

## The Five Rules and Pipeline Algorithm

Profiles provide the ordered enabled rules. The shipped rules cover subsumption,
invalidation, preservation of recent context, and optional summarization; absent
profile rules do nothing. The compactor evaluates turns in stable order, applies
the first non-keep decision, restores required pairs, then enforces budget and
returns diagnostics.

## Turn Identity and Stability

Turn identifiers derive from conversation order and timestamp inputs; consumers
must not rely on array position after compaction. Profiles own which rules are
enabled and their budgets. Tests under `tests/test-compression-*.mjs` pin rule
ordering, pairing, savings, and failure behavior.
