# `github#37` Phase 2 — eight deferred design questions

> **Status:** Pre-architecture. Not a commitment. See [`discussion/README.md`](README.md).
> **Phase 1 shipped 1.6.13** — repo-root `CLAUDE.md` autoloads on `git:projectLoaded` into `State.projectConventions` and renders as a `<PROJECT_CONVENTIONS>` block in the editor system prompt (trusted; not `<UNTRUSTED_*>`-wrapped). See [CHANGELOG §1.6.13](../../CHANGELOG.md).
> **Trigger to promote any of these into ROADMAP fuzzy-band or higher:** dogfood signal. Do conventions stay short and uncontroversial (Phase 1 is the whole answer), or does friction surface around any of these knobs?
> **Public issue:** [github#37](https://github.com/gobha-me/ai-editor/issues/37) (`Design: project-conventions file (CLAUDE.md analogue)`).

---

## Decided in Phase 1 (don't re-litigate)

- **Filename:** `CLAUDE.md` at repo root.
- **Trust model:** committed by the project maintainer → trusted → NOT wrapped in `<UNTRUSTED_*>` markers.
- **Loading event:** `git:projectLoaded`.
- **Storage:** `State.projectConventions`.
- **Render shape:** `<PROJECT_CONVENTIONS>` block in the editor system prompt.

The eight open questions below are the **Phase 2** scope — re-scoped from real dogfood signal, not speculation.

---

## The eight open questions

### (a) Location

Repo-root `CLAUDE.md` (Phase 1 ship) vs `.aieditor/conventions.md` vs `docs/CONVENTIONS.md`.

**Trade-offs.** Repo-root is what Phase 1 picked because the analogue (Claude Code) uses it; the file is visible to every tool. `.aieditor/conventions.md` would namespace the file under the same dir-tree as `.aieditor/memory/*` (workspace memory; see ROADMAP Decision §1). `docs/CONVENTIONS.md` would treat conventions as project documentation, alongside ROADMAP/ARCHITECTURE/etc.

**Trigger to promote:** a project that has a meaningful `docs/CONVENTIONS.md` file *not authored as a Claude-aware analogue*, where dual-sourcing creates friction.

### (b) Loading lifecycle

Session-start (current) vs every-turn vs lazy.

**Trade-offs.** Session-start is cheap but the file is stale if the user edits `CLAUDE.md` mid-session (and they do — when they realize the model is missing a convention, the first reflex is to add a line and expect it to take effect). Every-turn re-reads cost a file fetch per turn. Lazy = re-read on-demand via a `read_conventions` tool, surfaced only when the model asks.

**Trigger to promote:** dogfood signal that the model is missing recently-added conventions because the session predates the edit.

### (c) Role interaction

Per-role sections (e.g. `## For coder`, `## For chat`) vs undifferentiated.

**Trade-offs.** Undifferentiated is what Phase 1 ships and matches Claude Code's analogue. Per-role would mean the system prompt only renders the active role's section. Risk: convention-fragmentation; the same rule restated three times. Counter-risk: long conventions docs blow the token budget across roles that don't need every rule.

**Trigger to promote:** dogfood signal that conventions are getting long enough to need per-role pruning, or that role-specific rules are surfacing.

### (d) Memory-subsystem boundary

Where is the line between "project memory" (this file) and "user memory" (the memory subsystem in `.aieditor/memory/*`)?

**Trade-offs.** Phase 1 implicitly draws the line as "CLAUDE.md = static project rules, memory = dynamic per-user observations" — but the line isn't enforced by the loading code. A user could put dynamic notes in CLAUDE.md and the system would render them.

**Trigger to promote:** memory subsystem's repo-mode (per ROADMAP Decision §1) producing memory files that overlap CLAUDE.md content, OR user feedback that the boundary is unclear.

### (e) Project-switch behavior

Active-project (current) vs branch-scoped.

**Trade-offs.** Active-project ties CLAUDE.md to whatever the user's active git connection points at; switching projects swaps the file. Branch-scoped would mean each branch's `CLAUDE.md` is its own — useful if a branch is iterating on conventions; confusing if the convention changes silently when the user switches branches mid-conversation.

**Trigger to promote:** mid-session branch-switch behavior surfacing (the conversation context says X, the new branch's CLAUDE.md says Y).

### (f) Versioning

Active branch vs local checkout; mid-session branch switch.

**Trade-offs.** Closely related to (e). The Phase 1 implementation loads from the active branch via `Git.getFile`. If the user has uncommitted local changes to CLAUDE.md, those don't load — the model sees the committed version. This is the right default for trust, but may surprise users.

**Trigger to promote:** user reports their CLAUDE.md edit didn't take effect because they hadn't committed.

### (g) Length cap / compression integration

The file is currently rendered verbatim into the system prompt. Long CLAUDE.md files compete for token budget with the rest of the prompt.

**Trade-offs.** Cap as policy ("CLAUDE.md must stay under N tokens") vs cap as mechanic (the compression subsystem truncates / summarizes when over budget) vs no cap (warn but render whatever the user committed).

**Trigger to promote:** the compression subsystem (ROADMAP Compression bucket, currently gated on cost-dashboard export) landing — at which point the conventions file becomes one more thing to compress.

### (h) System-prompt enumeration parity

Per [`feedback_prompts_js_parallel_enumeration.md`](../../.claude/projects/-config-Projects-ai-editor/memory/feedback_prompts_js_parallel_enumeration.md) the system-prompt enumeration in `js/prompts.js` parallels other registries (tools registry, untrusted-kinds registry, etc.) — adding a new convention-aware mechanism without trimming both halves of the enumeration is a recurring miss.

**Trigger to promote:** another parallel-enumeration miss specifically tied to CLAUDE.md handling (e.g. a new prompt section that mentions conventions but the conventions file doesn't list itself in a registry).

### (i) Empty-state UX

What does the editor show / tell the model when no `CLAUDE.md` exists? Phase 1 silently renders no `<PROJECT_CONVENTIONS>` block.

**Trade-offs.** Silent is current. An empty-state nudge ("This project has no CLAUDE.md — would you like to create one from a template?") would surface the feature; risk is nag-fatigue.

**Trigger to promote:** user feedback that they didn't know CLAUDE.md was a feature, OR template demand once enough conventions have been authored across projects to seed a useful template.

---

## What this doc is NOT

- Not a Phase 2 design. Each question above might end up as its own design doc or as "Phase 1 was sufficient." The thinking here exists so the design session, when it happens, doesn't re-derive the eight questions from scratch.
- Not a roadmap commitment. ROADMAP §"Known open issues" carries the github#37-Phase-2 row as `[fuzzy]` until dogfood signal arrives.

## Cross-references

- [`CHANGELOG.md`](../../CHANGELOG.md) §1.6.13 — Phase 1 ship details.
- [`docs/SECURITY.md`](../SECURITY.md) §"Untrusted issue / PR / comment content" — adjacent trust-model context.
- ROADMAP §"Known open issues" — github#37 Phase 2 row.
