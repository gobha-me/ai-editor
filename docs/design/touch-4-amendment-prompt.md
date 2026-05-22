# Touch 4 — Claude Design kickoff: 3.X multi-role surface

**Status:** Kickoff prompt. Not yet sent. Paste the block below into claude.ai/design when ready.
**Trigger:** Jeff decides 2.X is winding down enough to engage Touch 4.
**Returns to:** `docs/design/touch-4-*/` (new bundle directory; follows the Touch 1 / Touch 2 / Touch 3 convention).
**Composes with:** [Touch 3 Window v2 / Sessions](touch-3-left-pane-and-window/) — already-shipped four surfaces + the still-parked Sessions surface. Touch 4 builds *on* Touch 3, does not replace it.

---

## How to use this file

1. Read it end-to-end yourself first — adjust anything you want to push on before the design session.
2. Open a fresh chat at claude.ai/design.
3. Paste **everything between the `===PROMPT START===` and `===PROMPT END===` markers** as the first message. The prompt is self-contained.
4. The design assistant will likely have follow-up questions before mocking; answer those, then let it work.
5. When the bundle returns, store it at `docs/design/touch-4-amendment-runtime/` (or similar — match the convention). Open a backfeed loop via [`OPEN-QUESTIONS.md`](OPEN-QUESTIONS.md) for any ambiguity that surfaces during 3.X implementation.

---

## ===PROMPT START===

Hi — Jeff (the founder of an open-source browser-based code editor called **ai-editor**) here. I'm kicking off a design touch for a major version transition. This is Touch 4 in our ongoing engagement. Previous touches:

- **Touch 1** (April 2026): Memory UX — inline consent card, settings tab, commit-modal warning. Shipped at 1.3.0.
- **Touch 2** (April 2026): Whole-app facelift — top bar, settings sidebar, connections N-of-each, debug panel, help panel, themes-as-plugin contract, Lucide icons, fonts, rem scaling. Shipped across 1.3.5–1.3.13.
- **Touch 3** (May 2026): Left pane v2, PR Review, Merge Conflict Resolver, zip-flow, **Window v2 / Sessions**. Four shipped; Window v2 / Sessions is parked behind 2.0 because "session" inherits its shape from the profile contract that lands in 2.0.

**Touch 4 is the big one.** ai-editor is moving from "an editor that talks to an LLM" to "a hosted multi-role agentic system whose surface includes an editor." I need design direction on the UX of that change before architecture commits.

## What's changing

The project has been operating under a methodology I co-developed with Claude over the last few months — *Coherence at Speed* — a structured way to keep LLM-driven coding sessions from drifting. We've adopted the base methodology on the project content layer (architecture docs, ICDs, roadmap bands, re-evaluation cadence). That's been working.

Now there's an **amendment** to the methodology that names six roles — Human, Architect (stateful judgment), PM (stateful mechanics), Coder (fresh per milestone), Reviewer (fresh per PR), Tester (advisory) — and a work queue that all roles read and write through. The roles never share a session. Mechanical work (dispatching, plan approval, precedent detection, memory curation) moves off the human and onto stateful internal roles. The human stays on the gates (Phase 0 taste, ratification at escalation, methodology overrides).

**ai-editor 3.X.X is going to be that amendment, embodied as the editor's runtime.** Today ai-editor is a single-loop chat surface with sub-agents bolted on (Phase 1 sub-agents shipped at 2.49.0 — restrictive read-only profile, approval card, bounded ceilings). Under 3.X the sub-agent shape generalizes: every Coder spawn is a fresh session, Reviewer is fresh per PR, Architect and PM are persistent across wakes, the user mostly observes rather than approves every step.

That's a product-shape change, not a feature addition. I need UX direction.

## What I need from this session

I want a design bundle in the shape of Touches 1/2/3 — HTML/CSS/JS prototypes, chat transcript capturing the *intent*, pushback memo where you think I'm wrong. The surfaces I think matter:

### 1. The role-state surface

Architect and PM are stateful. Architect is judgment-heavy and wakes on re-eval cadence + PM escalation + human direction. PM is mechanics-heavy and wakes on scheduler tick + infrastructure events (PR open, CI status, merge, bounce). **The user should be able to see what each role is doing, has done recently, and is currently thinking about.**

Open questions for you:
- Is this a dedicated pane (alongside the existing chat / files / editor)?
- Is it a persistent ticker that lives somewhere in the chrome?
- Is it pull-only ("show me Architect's state") or push (notifications when state changes)?
- How do Architect and PM differ visually? They're different *kinds* of role.

### 2. The work queue as visible substrate

The amendment makes the queue the source of truth — not the conversation. Today's chat history is conversation-shaped; under 3.X it becomes one view onto a queue of typed items (milestone, milestone_plan, PR, re_eval_paper, re_eval_code_aware, icd_prep, escalation, proposal, td_entry, test_audit, memory_proposal, chat_decision, sub-task).

Open questions:
- Does the user see the queue directly, or only through role-shaped views ("Architect's view," "PM's view," "the conversation view")?
- When the chat surface shows a Coder's work, is that a derived view onto queue items, or is it still a chat with the queue annotating it?
- How do escalations surface? The chain is Coder → PM → Architect → Human; the user is the last link.

### 3. Fresh-Coder spawn UX

Today's sub-agent (`delegate_task`) approval card is a single decision point with cost, profile, and tool capability summary. Under 3.X, Coder spawns are routine — PM dispatches them whenever a milestone is ready. The user should not approve every spawn (that's the rubber-stamping failure mode the amendment fixes), but the user should be able to see what's running.

Open questions:
- How does a running Coder feel different from a "the system is asking me something"?
- When the user *does* need to intervene (the Coder escalates a question to PM that PM escalates up), what is the surface?
- What does the Coder's plan look like in the surface? (Plan mode is preserved as a forcing function — Coder submits a plan, PM approves mechanically, the user only sees escalated plans.)

### 4. Pause / resume / ad-hoc chat

The amendment specifies pause types — escalation pause (PM → Architect blocked, Architect → Human blocked), manual pause. While paused, Human ↔ Architect chat happens. The chat decision invariant: every decision lands in a doc or queue mutation before the chat ends.

Open questions:
- What does "the system is paused" look like?
- What does the Architect-as-conversation-partner feel like? It's the only role that talks to Human directly.
- The amendment says Architect "summarises pending decisions and confirms before closing." How does the surface enforce this?

### 5. Cost visibility under multi-role

Multiple agents running simultaneously means cost is no longer one number per conversation. The existing cost dashboard (shipped at 1.2.1) shows per-conversation breakdown. Under 3.X the user needs: PM ticks (continuous, cheap), Coder spawns (bounded per milestone), Reviewer reviews (one per PR), Architect re-evals (periodic, expensive thinking).

Open questions:
- Per-role budgets vs single rolled cap?
- Where does this live — extend the existing cost dashboard, or new surface?
- What's the right granularity for the *running* number (during a session) vs the *historical* number (last week, last sprint)?

### 6. Composition with Touch 3 Sessions

Window v2 / Sessions parked post-2.0 — each tab is one profile + one branch + one chat + open files. Under 3.X a Session also contains its own queue scope: PM tick, Architect state, the works.

Open questions:
- Is there one global PM serving all open Sessions in a window, or one PM per Session?
- Can two Sessions in the same window have different role configurations (one with Tester enabled, one without)?
- When a Session is closed, what happens to its queue + role state? (Persisted in IDB / `.aieditor/`, garbage collected, or migrated?)

## What I don't need

- Mockups of role *prompts* — those are project artifacts, not UX.
- Coder's internal tool surface (read_file, search_in_files, etc.) — already designed.
- Anything about the underlying methodology — that's settled at the paper level; the implementation question is what surfaces it.

## Constraints worth knowing

- **No build step.** ai-editor is vanilla JS + Preact for new surfaces (Touch 1 established Preact via div-slot mounting). No bundler beyond a single esbuild pass for the Preact vendor bundle.
- **Single-global-state.** `State` is the single source of truth in the runtime; under 3.X the queue + role state lives in IDB, surfaced through State.
- **Themes-as-plugin.** Refined IDE (default) + Editorial Calm (bundled) — your designs should specify the `--tk-*` token additions if new ones are needed. Don't hardcode colors.
- **Browser-app envelope.** Stateful roles run in the browser (Web Worker is on the table for the scheduler tick); we don't have a server-side backend for this.

## Process expectations from prior touches

- Pushback memo first — load-bearing. The places I'm wrong are more valuable than the places I'm right. Prior pushbacks ranged 3–7 items each; that's a good target.
- Two themes (Refined / Editorial) for every locked surface.
- Chat transcript captures intent — write it as if a coding agent will read it (because one will).
- React+Babel JSX for prototype components is fine; the real ai-editor implementation uses Preact + htm.
- When you don't pick (Touch 2's chat panel left in exploration), say so explicitly so I know what's still mine to decide.

## Reading the existing record

You'll get more value out of these than from me re-describing:

- `docs/discussion/methodology-amendment.md` — the operational form of the amendment. It's long (~1500 lines). The Quick Reference (§1), Roles (§3), Triad Structure (§5), and Session Quickstarts (§17) are the structural core.
- `docs/discussion/3.0-amendment-implementation.md` — my list of load-bearing open questions for the 3.0 architecture session. This is what your touch is supposed to inform.
- `docs/METHODOLOGY-coherence-at-speed.md` — the base methodology this builds on (already adopted on the project content layer).
- `docs/discussion/touch-3-window-v2-sessions.md` — Touch 3's parked Sessions surface. 3.X has to compose with it.

That's enough to start. Push back where I'm wrong; ask follow-ups where I'm vague; mock the surfaces where the design has earned a commitment. Ship the bundle when it's ready.

— Jeff

## ===PROMPT END===

---

## Notes for Jeff before sending

- The prompt assumes Claude Design has access to read the four named docs in the repo. If that's not how the engagement actually works, paste excerpts inline before the closing signoff.
- The "constraints worth knowing" block is paraphrased from `project_constraints` memory + Touch 2 outputs. Adjust if a constraint shifts between now and when you send.
- If you want to compress the prompt: §1 (role-state) + §2 (queue substrate) + §3 (fresh-Coder spawn) are the load-bearing UX questions. §4–§6 are valuable but the design could return on a follow-on session. Cut §5 (cost) and §6 (Sessions composition) first if you want a tighter scope.
- After the bundle returns, file a memory entry pointing to `docs/design/touch-4-*/` (mirror the `project_design_engagement.md` pattern) and decide whether the 3.0 paper session runs immediately or waits for additional dogfood signal.
