# Touch 3 — Window v2 / Sessions / chat-as-spine thinking

> **Status:** Pre-architecture. Not a commitment. See [`discussion/README.md`](README.md).
> **Context:** Touch 3 design bundle lives at [`docs/design/touch-3-left-pane-and-window/`](../design/touch-3-left-pane-and-window/) — full deliverable (`README.md` + `chat2.md` Touch 3 chat transcript + `Facelift.html` canvas + JSX/CSS files). The four sub-surfaces (Rail v2, PR Review, Merge Conflict Resolver, zip-flow) have all shipped; **Window v2 / Sessions is the only Touch 3 surface left.** This discussion doc captures the load-bearing thinking that separates "what's been decided" from "what's still open" without trying to be the design itself.
> **Trigger to promote:** 2.0.0 ships (role-removal slice) — Window v2 / Sessions becomes a `[strong]` ROADMAP slot at that point, because the profile contract is what "session" inherits from.
> **Post-2.0 dependency.** Hard. See decision in ROADMAP §"Deferred / parked → Touch 3 deliverables."

---

## What's already decided (don't re-litigate)

From the Touch 3 design transcript (`chat2.md`) and from ROADMAP Decisions:

- **Middle pane becomes a stage** that swaps mode (welcome / file / diff / PR review / conflict / task timeline). Chat earns the center-right column full-height with a focus mode (rail collapsed).
- **Sessions tabs in the top bar** — each tab = self-contained branch + task + chat + open files. Multi-branch / multi-project concurrent in one window.
- **Hard prerequisite met:** production rate-limit pacer (shipped 2.9.0, per ROADMAP Compression bucket §"Provider rate-limit respect"). Multiple concurrent agents in one window saturate per-provider caps; without the pacer, Window v2 ships broken.
- **Hard prerequisite:** the role selector retires at 2.0.0. A "session" is naturally a profile instance — building Sessions before profiles ship doubles the rework risk. Quoted from the Touch 3 design chat: *"claude code and I are wrapping up 1.X and are about to cut 2.X profiles, this is intelligence layer stuff"*.

## What's still open

These are the questions the Window v2 / Sessions architecture session will need to answer. Each is a candidate discussion-doc-of-its-own once it surfaces during architecture work.

### Session ↔ profile binding

A session uses *one* profile at a time (one tab, one profile). But:
- Does switching profiles within a session preserve the chat history? (Today, profile switch is rare and doesn't survive.)
- Does the picker live in the session tab's chrome or in a settings-style overlay?
- Per-session profile override vs per-call override (the sub-agent design doc just shipped 2.37.0 has per-call profile override on the `delegate_task` API — does Sessions inherit that pattern or invert it?)

### Session storage

Per-session storage seam — chat history + task ledger + open-file set — vs storing per-conversation today. What's the persistence shape?
- IDB-keyed by session ID (cleanest; matches current chat history per-conversation pattern).
- Plus optional `.aieditor/sessions/*` for git-tracked sessions (extends ROADMAP Decision §1's two-tier memory pattern to sessions).
- Cross-window session-list (single source of truth across browser tabs, or per-window-local)?

### Session quota and eviction

The chat-history quota story (per `feedback_storage_idb_authoritative.md`: IDB is authoritative, localStorage is best-effort) extends to sessions. With multiple concurrent sessions, the eviction policy (ROADMAP "Deferred / parked → Other deferred → ChatHistoryStore encapsulation" item, parked) becomes more load-bearing.

### Concurrent-tool-loop interactions

Two sessions running tool loops simultaneously:
- Share the same `ToolRegistry`? (Today: yes; registry is module-singleton.)
- Share the same retrieval-index state? Cost store? Memory subsystem?
- What happens on `tools:unregistered` events when only one session is using the affected MCP server?

### "Multi-project" specifically

Touch 3 says "multi-project concurrent in one window." Today's `git.js` facade resolves an *active* connection per call. Either:
- Sessions carry their own active connection (`State.git` becomes `State.sessions[id].git`).
- A tool call receives its session's connection via context (already partially scaffolded by sub-agent design's `SubAgentContext`).
- Or: explicit per-session refactor of the git layer, which is large.

This is the biggest architecture question. The answer determines the surface area of the Sessions refactor; could be small (sessions own connection refs, tools route by session) or could be a git-layer rewrite.

### Chat focus mode + chat-input lifecycle

Touch 3 says chat earns the center-right column full-height with a focus mode. Today's `chat-input.js` is mounted to a static DOM root. Either:
- Sessions instance their own chat-input mounts.
- Single chat-input that switches its bound conversation on session switch.

Bundle includes `pushback.jsx` (per the design transcript) — read before implementing.

---

## What this doc is NOT

- Not a design for Window v2 / Sessions. The design will live as a `docs/DESIGN-sessions.md` or similar when the architecture session happens.
- Not a roadmap commitment. ROADMAP §"Deferred / parked → Touch 3 deliverables" carries the row with a hard dependency on 2.0.0.

## Cross-references

- [`docs/design/touch-3-left-pane-and-window/`](../design/touch-3-left-pane-and-window/) — full Touch 3 design bundle.
- [`docs/design/touch-3-left-pane-and-window/chats/chat2.md`](../design/touch-3-left-pane-and-window/chats/chat2.md) — Touch 3 chat transcript; the source of "post-2.0 by design" framing.
- [`docs/DESIGN-sub-agents.md`](../DESIGN-sub-agents.md) — adjacent design that introduced `SubAgentContext` (per-call tool/profile binding pattern Sessions may inherit).
- ROADMAP §"Decisions" §10 — claude.ai/design three-touch engagement model.
- Memory: `project_design_engagement.md` — Touch 3 reception context.
