# Left Pane Redesign

_Started 2026-05-01 10:50 UTC_

---

## User

Facelift part 3?

where to start I think we should focus on the left pane

I just merged a PR - but I am sure you can design a better experience without seeing what is already there

yes the left pane is crowded, are you thinking tabs for files/issues/prs? or do you have something else in mind

PR are a pain point, if I want to truly "review" the code and changes I have to leave ai-editor and go to the appropriate Repo BE

I should in theory be able to do everything here

merge conflict resolution is that possible in a pure browser application? just a random thought

well, you are the profession designer so I will put this into your hands

## Assistant

_[tool: list_files]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: list_files]_

_[tool: snip]_

_[tool: read_file]_

_[tool: update_todos]_

_[tool: read_file]_

_[tool: snip]_

_[tool: write_file]_

I'll dive in. Quick plan I'm committing to before writing:

**Left pane** — three directions in increasing ambition:
1. **Tabs** (the predictable answer): Files/Issues/PRs as a tab strip
2. **Activity rail** (VSCode/Cursor lineage): icon rail + one content panel — room for Search, Branches, History without crowding
3. **Unified "Workbench"** (the bet): one stream organized by *branch*, where issues badge the files they reference and PRs surface inline as code-review tasks

**PR Review** — full takeover of the editor area when you open one. File tree of changes / diff / conversation rail. Tabs: Conversation · Files · Commits · Checks. AI review summary up top (it *is* an AI editor). Approve/Request/Comment dock at the bottom.

**Merge conflicts** — yes, very possible in-browser. Three-pane (Theirs / Resolved / Ours) with per-hunk Accept buttons, conflict minimap, and an AI "resolve this" per hunk.

Let me build.

_[tool: write_file]_

_[tool: snip]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: done]_

_[tool: snip]_

_[tool: fork_verifier_agent]_

Added a new top section — **Left pane**, **PR Review**, and **Merge conflicts** — at the top of the canvas, above the existing strategy memo.

**Left pane** — three directions, easiest to most opinionated:
- **A. Tabs** — Files / Issues / PRs as a tab strip. The honest, conventional answer.
- **B. Activity rail** — VSCode-style icon rail with Search, Branches, History added. Best if you expect more verbs to appear in the pane over time.
- **C. Workbench** — single stream organized around what's *active* on this branch: a "Reviewing" card up top, your local changes inline, then issues that *touch the files you've edited*, then files at the bottom. The most opinionated answer; assumes the user usually has one thing in flight.

**PR Review** — full takeover of the editor area. File tree of changes left, side-by-side diff center, inline comment threads anchored to lines, AI review summary banner, and a sticky review dock at the bottom (Comment / Request changes / Approve / Submit). Conversation tab shows the threaded history.

**Merge conflicts** — yes, very doable in-browser. Three-pane (Theirs / Resolved / Ours), per-hunk Accept Theirs / Both / Ours, an "AI resolve" per hunk, and a conflict minimap on the right. The middle pane is the editable result — empty by default with a "let AI try" CTA, populated once you take a side or edit.

Both themes (Refined IDE and Editorial Calm) ship for the locked surfaces; PR Review and Merge get one Editorial variant each so you can see the type-system stretch under heavier content.

## User

workbench is nice, but part of the utility of ai-editor is:

click ticket → click start → LLM goes to work (sometimes opening a PR when its done one it its own) → PR is opened

features I have: create file / dir - delete file / dir - rename, create branch, create Release (ai button for release notes ← I use this as the sole method of release)

branch selection, I have one branch drop down and we added the branch view at the top but its more or less static

the tabs are limiting, I am not a fan of VSCode but I think they nailed it, useless you can fix the issues with Workbench its close but something about seems like it would get in the way of work instead of enhancing it

## Assistant

_[tool: snip]_

_[tool: write_file]_

_[tool: snip]_

_[tool: write_file]_

_[tool: grep]_

_[tool: str_replace_edit]_

_[tool: done]_

_[tool: update_todos]_

_[tool: fork_verifier_agent]_

A new **Left pane v2** section is now at the top of the canvas, above the earlier exploration:

- **Rail is the chassis** (B was right). Tabs dropped.
- **Tasks** — new verb. Surfaces in-flight agents with progress, current step, tokens. Done tasks show "Open PR." This is the ticket→start→LLM→PR loop made visible.
- **Issues** — every open issue has a prominent **▶ Start** button. Running ones show a live pulse and link to their task.
- **Branches** — real switcher: ↑/↓ counts, switch / delete / **Cut release** inline. Conflict and agent branches are tagged.
- **Releases** — AI release-notes draft card pinned at the top with a Generate notes CTA.
- **Files** — hover-actions on each row (new in folder, rename, delete), plus a tiny **Now strip** (changes count, agent activity) so the workbench's best idea survives without taking over the pane.
- Branch switcher pinned above the pane content, not buried.

Both themes available; Editorial Calm shipped for Tasks so you can see the type system stretch.

## User

claude code and I are wrapping up 1.X and are about to cut 2.X profiles, this is intelligence layer stuff

with this side panel view, the "file" view in the middle becomes what?

you took this to a place I didn't expect AND LOVE IT - with merge conflict resolution yes we could have multiple branches of the smae project or multiple project running in one browser WTF dude this hurts my head

but either way does chat become "dominate" instead of being pushed to the right? 

start of by place this new right pane into the existing window, then lets figure how this big idea changes the window even if the details are blurry, we can work that out later

## Assistant

_[tool: snip]_

_[tool: grep]_

_[tool: grep]_

_[tool: snip]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: str_replace_edit]_

_[tool: done]_

_[tool: fork_verifier_agent]_

A new **Window v2** section is now at the top of the canvas, with the v2 left pane embedded in a full window shell (1600×900). Three states to react to:

**1. Welcome — chat-dominant idle**
The middle becomes a *stage*, not "the file." When nothing is open, it shows a Welcome with the four ways into work (Issues / PRs / Tasks / Releases). Chat sits alongside it, full-height, ready.

**2. Task running — diff + chat**
You hit ▶ Start on issue #131. The agent opens a session tab in the top bar (`#131 memory flicker`), the stage flips to a live diff of what it's editing, and chat docks beside it showing the back-and-forth. The chat is the spine — the editor docks beside it.

**3. Chat focus — full-bleed**
Rail collapses to icons. Chat fills a comfortable reading column. For when you're just steering the agent and don't need to see code.

**The big idea your message unlocked: Sessions.**
Each tab in the top bar is a self-contained session = branch + task + chat + open files. You can have `main` (workspace), `#131` (agent running), `#145` (agent in review), and `PR #84` (you reviewing) all open at once. Switching tabs swaps the entire middle+chat in lockstep. Multi-project would be the same pattern at one level up — the project switcher next to the brand becomes a real tab strip.

**Answers to your questions:**
- *Middle becomes:* a stage that swaps mode based on what the active session is doing (welcome / file / diff / PR review / conflict resolver / task timeline).
- *Chat dominant:* yes. It moves out of the right pane into the center-right, full-height, and gets a focus mode. The model picker and notes that lived in the right pane collapse into the chat header.
- *Multi-branch in one browser:* sessions tabs make this real. The merge-conflict resolver becomes just another stage mode.

Editorial Calm variant of the welcome shipped too so you can see how the type stretches at full size.

