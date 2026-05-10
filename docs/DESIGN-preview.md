# DESIGN — In-Editor Preview & Verify

**Status:** Draft — design pass triggered by the 2026-05-08 Sokoban dogfood incident on HTML-Games. No version slot is requested by this doc beyond a parallel-track row in `docs/ROADMAP.md` §"2.X path → Parallel 1.X tracks" for Tier 1; Tiers 2/3 phase behind dogfood signal.
**Depends on:** the project file API (`js/git.js` — `Git.getFile`, `Git.getFileTree`) as the read surface that supplies the iframe; the chat tool registry (`js/tools/registry.js`) as the trust boundary new tools must respect; the §1.16.0 Tier-0 sandbox Worker security posture (`js/workers/script-runner-worker.js`) as the established template for "user code runs nowhere reachable from the host page."
**Related memory:** `project_dogfood_test_battery.md` (the HTML-Games substrate this gap was found on), `project_tier0_sandbox_validated.md` (cost-collapse evidence the tier model is reproducing), `project_cost_quality_tradeoff.md` (steering frame).
**Supersedes:** the `docs/ROADMAP.md` §"3.0 / Post-2.0 candidates" "Browser-in-browser preview" stub. That entry framed it as a 3.x maybe; this design pulls Tier 1 forward to a 1.X parallel track on the strength of the Sokoban evidence.

---

## Problem

ai-editor's tool catalog has no surface for "load the page in a browser, observe what happens, report back." The agent edits files, the editor renders syntax highlighting, the test runners (where they exist) execute Node code — but the *running product* is invisible to the loop. For any project whose correctness depends on the browser actually executing the JavaScript and binding events to a rendered DOM, the agent is editing in the dark.

The 2026-05-08 dogfood run on Sokoban (HTML-Games, [`xcaliber/HTML-Games`](https://git.gobha.me/xcaliber/HTML-Games) PR #170) is the load-bearing evidence. The agent (Qwen 3 Coder, edit-by-edit) shipped a 1325-line first cut of a Sokoban game whose `js/game.js` referenced `#level-display` — an element that did not exist in `index.html`. The runtime path was:

> `loadLevel(0)` → `updateUI()` → `levelEl.textContent = …` → **TypeError on null**, thrown silently from inside the bootstrap. `bindEvents()` never runs. The page renders the static HTML board and looks correct in any view that doesn't execute the script. Every arrow key, every on-screen button, every reset / next-level control is a no-op. End-to-end dead.

The fix commit's own description (`3328f57`):

> *"js/game.js referenced #level-display which doesn't exist in index.html, so updateUI() threw on first call inside loadLevel(0) and bindEvents() never ran — every key and button was a no-op."*

The bug shape generalizes. Any browser app that depends on `document.getElementById` / `querySelector` / event-binding succeeding *during* boot exhibits this pattern: a thrown error early in the sequence skips the rest of the boot, the page renders enough to *look* right, and nothing interactive works. Static-analysis tools (linters, type checkers, the existing AST chunker) cannot catch it because the binding contract lives across a JS file and an HTML file that the lint surface does not cross-reference. The model itself cannot catch it without running the page.

Qwen wasn't sloppy. It edited file-by-file, with the test scaffolding the catalog provides, and produced internally consistent code at every step. The gap is platform-level: ai-editor never gave the model a way to say "load this and tell me whether it boots."

The thesis of this document is that the right answer is a **tiered preview surface**: a sandboxed iframe + a small set of preview tools, mirroring the Claude Code preview MCP that already runs against this codebase. Tier 1 (static iframe + URL return) catches the "did anything render at all" class. Tier 2 (console + error capture) catches the Sokoban class — an uncaught `TypeError` during boot — at the cost of one more sprint. Tier 3 (a driveable preview with click / fill / eval / snapshot) catches integration-shape bugs that need the user to *do something* before the bug is visible. Each tier admits a strictly larger blast radius; the design says so explicitly so a future implementer can't conflate them.

### What this is not

- **Not a CI replacement.** A preview that boots a single page once is not a test runner. It is a feedback loop the model can read on the same turn it ships an edit. CI still runs.
- **Not a browser-in-browser dev environment.** No file-tree mount inside the preview; no terminal; no in-iframe code editor. The preview shows the *output* of the workspace, not the workspace itself.
- **Not a hosting surface.** The preview URL is per-workspace, scoped to the agent's session, and does not become a public deploy. Cogfall's production deployment path stays where it is.
- **Not a script-execution surface.** Tier-0 of LLM-authored automation (`submit_script_for_approval`) is the read-only fs walk. The preview surface is the read-only *browser execution* of files already in the workspace. They are siblings, not the same surface.
- **Not a way to bypass Plan Mode.** Preview tools are read-only against the workspace (the agent can observe; it cannot edit through the preview). They are catalog-admitted with `readOnly: true` for the same reason `read_file` is.

---

## Goals

1. **Close the Sokoban class.** A boot-time `TypeError` in user code surfaces in a tool-result the agent reads on the same turn, without the human having to load the page and report back.
2. **Mirror the Claude Code preview MCP surface.** The reference implementation already runs against ai-editor itself; mirroring its tool names and signatures means the model's existing preview-tool training carries over and the human reviewer's mental model is unchanged across surfaces. (See *Per-Tier Tool Surface* for the full mapping.)
3. **Sandbox-iframe first.** The preview iframe runs at a distinct origin (or with `sandbox` attribute equivalents) from the editor; CSP blocks the iframe from reaching the editor's `window`. This mirrors the §1.16.0 Tier-0 Worker security posture: the catalog stays the trust boundary; the preview adds *one* well-bounded surface whose blast radius is contained at the iframe boundary.
4. **Tiered admission of risk.** Tier 1 admits "the iframe can read what we serve it." Tier 2 admits "the iframe can postMessage logs back." Tier 3 admits "a sidecar process drives the iframe." Each tier is its own gate.
5. **Graceful no-op for build-step projects at Tier 1.** Cogfall (Vite/TS/Pixi) does not run from raw `index.html`; the preview surface returns a structured `requires_build_step: true` envelope rather than misleading "broken" output. Tier 3 introduces a per-workspace dev-server sidecar that handles those cases.
6. **Cost-discoverable.** The preview surface adds tool calls to the catalog; every call's tokens land in the existing cost store under each tool's name. Tokens-saved-vs-counterfactual ("the model would have asked the user to manually open and report") is a stub now, real once Tier 2 produces a corpus.

---

## Non-Goals

- A general-purpose embedded browser. The preview is a curated iframe, not a Chromium control surface.
- Cross-origin reach from the iframe. The preview cannot fetch the user's other tabs, cookies for unrelated origins, or LAN endpoints. CSP enforces this.
- Multi-user concurrency. One preview per workspace, single-tab. (The Touch 3 Sessions architecture in `ROADMAP.md` may want one preview per session later; that is its own design pass.)
- Persistent preview URLs. Every preview is bound to the editor session that started it; closing the editor closes the preview.
- Mobile / responsive testing as a v1 affordance. `preview_resize` is in the Tier 3 surface for parity with the reference MCP, but device-emulation as a dogfood priority is downstream.
- Recording / playback. No "save this preview interaction as a regression test" in v1.
- Auto-driving the preview. Tier 3 *exposes* drive tools (click / fill / eval); the *agent* decides when to use them. No "automatically click every button after every edit" mode.

---

## The Load-Bearing Decision: The Iframe Sandbox Is the Trust Boundary

The most common failure mode in any "let the model preview the page" surface is treating the gate as a *property of the URL*: an authenticated origin serves the workspace, the agent loads it, all behavior is implicitly trusted because the host is. That is the wrong model. The workspace contains LLM-authored JavaScript; loading it on the editor's own origin would give that JavaScript reach into `localStorage`, the API tokens stored there, the chat history, and every cookie on the editor domain.

The correct seam is a **sandboxed iframe at a distinct origin** (or, equivalently, an iframe with the full `sandbox` attribute set and CSP isolation), into which the workspace files are served. The iframe gets its own origin's `localStorage`, its own cookie jar, no reach into the editor's `window` (the `sandbox` attribute blocks `window.parent`-shaped escape), and a CSP that disallows outbound network except to URLs the user has explicitly allowlisted at admission time.

This mirrors the §1.16.0 Tier-0 Worker security posture file-for-file at the boundary level:

| §1.16.0 Worker | This design (preview iframe) | Why mirrored |
|---|---|---|
| Forbidden globals (`fetch`, `localStorage`, `indexedDB`, `crypto`, `navigator`) shadowed with throwing accessors | CSP `default-src 'self'`; iframe `sandbox="allow-scripts"` (no `allow-same-origin`); no allow-list URLs at Tier 1 | Both deny outbound side-channels by default; both let the user widen the deny-list explicitly later. |
| User code runs in a Worker — `self.window` is undefined | User code runs in an iframe — `window.parent` is cross-origin and blocked | Both put a hard process / origin boundary between user code and the host's State / tokens. |
| Adapter layer (`Git.getFile` / `Git.getFileTree`) is the *only* reach-back from the Worker | postMessage shim (Tier 2+) is the *only* reach-back from the iframe | Both surfaces define a small, named, audited reach-back; nothing else. |
| Trust delta: the script can read what the chat already could | Trust delta: the iframe can render what the chat already could | Both phrase the delta as "no new exposure" rather than "we trust the user code." |

The iframe sandbox is the catalog's analogue. The catalog stays the boundary at the *tool* level (preview tools must be admitted, declared `readOnly: true`, registered in `js/tools/preview-tools.js`). The iframe sandbox stays the boundary at the *content* level (LLM-authored JS in the workspace runs there, never on the editor origin). Push back on this before building anything else.

---

## Three-Tier Delivery Shape

The "what does preview admit" question has no single right answer; the right answer is a tier list with explicit risk admission at each step.

| Tier | What it admits | New risk over previous tier | Gate complexity required |
|---|---|---|---|
| **Tier 1 — static preview** | Sandboxed iframe at `editor.gobha.ai/preview/{workspace}/{path}` (or local-path equivalent in self-hosted). Workspace files served as static assets. Agent gets back a URL. | Agent can render the workspace. **The user could already view files in the editor.** No new exposure relative to existing tools. The iframe boundary blocks reach into the editor origin. | CSP + `sandbox` attribute on the iframe element; per-workspace path routing; no cross-workspace leak. |
| **Tier 2 — console + error capture** | Tier 1 + an injected shim that mirrors `console.{log,info,warn,error,debug}` and `window.onerror` / `unhandledrejection` over `postMessage` to the editor. Agent gets `preview_console_logs` and `preview_errors`. | The editor receives strings the iframe chose to send. Strings can be large, can include user input echoed via `console.log`, can mention secrets the user pasted into the page. Buffer-bomb / log-spam is a DoS vector. | Buffer cap + line cap + truncation; `postMessage` origin check rejects everything but the preview origin; the shim runs *before* user code so user code can't unhook it. |
| **Tier 3 — driveable preview** | Tier 2 + Playwright sidecar (or equivalent) that exposes `preview_eval`, `preview_click`, `preview_fill`, `preview_snapshot`, `preview_inspect`, `preview_screenshot`, `preview_resize`, `preview_network`. Build-step projects (Vite/Webpack) get a per-workspace `npm run dev` sidecar. Tier 1 gracefully no-ops on those projects until the sidecar is in. | The model can synthesize keystrokes / clicks / arbitrary JS into the preview. A `preview_eval` of a string the model authored is exactly the inverted-trust-surface that motivated `submit_script_for_approval`'s per-invocation gate. The sidecar process is now load-bearing for the safety story. | Per-invocation gate on `preview_eval` (see *Open Questions*); allowlist of selectors for `preview_click`/`preview_fill`; sidecar lifecycle bounded to the editor session; sidecar process isolation (separate uid / container) for self-hosted. |

The empirical case for the surface (the Sokoban evidence) is **entirely Tier 2** — a `console.error` from the uncaught TypeError lands in `preview_console_logs`, the agent reads it, fixes the binding, re-previews. Tier 1 alone would catch the all-blank-page class but not the Sokoban class (the page *does* render; only the script is dead). Tier 3 is what closes integration-shape bugs (does pressing arrow-up move the player?) but is a strictly larger admission and carries a per-invocation gate concern that Tiers 1–2 do not.

The version-slotting question for Tiers 2–3 is downstream of measurement on Tier 1. If Tier 1 ships and the dogfood shows Tier 1 alone reduces "agent-shipped-broken-page" incidents materially, Tier 2 still earns its slot for the Sokoban class specifically. Tier 3 ships when a measured class of bug is reachable only by driving the page.

---

## Per-Tier Tool Surface

The Claude Code preview MCP that runs against this very codebase is the reference. The mapping is dense for a reason: the more lifecycle stages match, the more the model's existing preview-tool muscle memory carries over, and the more code paths in the implementation are reuse rather than reinvention.

### Tier 1

| Tool | Signature | Returns | Notes |
|---|---|---|---|
| `preview_start({path?})` | `{path}` defaults to `index.html`. The path is workspace-relative. | `{serverId, url, requires_build_step?: true}` | If a `package.json` with a `dev` script is detected and Tier 3's sidecar is not enabled, return `requires_build_step: true` with no URL. The agent learns to check this envelope. |
| `preview_stop({serverId})` | — | `{stopped: true}` | Closes the iframe / route. Idempotent. |
| `preview_list()` | — | `{servers: [{serverId, path, url}]}` | Mirrors the reference MCP's `preview_list`. |

`preview_start` is the load-bearing tool. Mirroring the reference MCP's name (rather than a more literal `preview_iframe_url`) means the model's training already routes "I want to see the page" to this tool name. The `serverId` thread is preserved end-to-end so that Tier 3 sidecars slot in without renaming the surface.

### Tier 2

| Tool | Signature | Returns | Notes |
|---|---|---|---|
| `preview_console_logs({serverId, level?, lines?})` | `level ∈ {all, error, warn}`; `lines` ≤ 200, default 50. | `{logs: [{level, message, ts}], truncated?: boolean}` | The shim mirrors `console.*` over `postMessage`. Buffer cap is 1 MB; oldest lines drop on overflow. |
| `preview_errors({serverId, lines?})` | `lines` ≤ 100, default 50. | `{errors: [{message, source, line, col, stack?, ts}], truncated?: boolean}` | Wires into `window.onerror` *and* `unhandledrejection`. The Sokoban class lands here. |
| `preview_logs({serverId, level?, lines?, search?})` | Server-side preview-host logs (route 404s, asset-resolution failures). | `{logs: […]}` | Useful for "the asset didn't exist in the workspace at the path the page asked for" — distinct from the in-page console. |
| `preview_network({serverId, requestId?, filter?})` | `filter ∈ {all, failed}`. With `requestId`, returns the response body for that request. Without, lists requests. | `{requests: […]}` or `{request: {…}, body: '…'}` | Mirrors the reference MCP. Useful when the page boots but a `fetch('/api/foo')` fails because the workspace has no `/api/foo`. |

These four tools are the difference between "the page rendered" and "the page *worked*." `preview_console_logs` is the load-bearing one for the Sokoban class — uncaught TypeErrors during boot land there as `console.error` strings, and the agent's fix-loop closes on the same turn.

### Tier 3

| Tool | Signature | Returns | Notes |
|---|---|---|---|
| `preview_snapshot({serverId})` | — | `{snapshot: '<accessibility tree>', uids: {…}}` | Reference MCP's preferred verifier — exact text content, roles, element UIDs. Cheaper and more deterministic than screenshots. |
| `preview_screenshot({serverId})` | — | `{screenshot: '<base64-jpeg>'}` | Reference MCP labels this "Good for layout, but DO NOT rely on it for verifying colors / fonts / styles — use `preview_inspect` instead." Same caveat applies here. |
| `preview_inspect({serverId, selector, styles?})` | — | `{textContent, className, tagName, id, computedStyle: {…}, boundingBox: {…}}` | Best tool for verifying visual properties; structured output suits the model better than pixel-grading a screenshot. |
| `preview_click({serverId, selector, doubleClick?})` | — | `{clicked: true}` or error envelope | Per-invocation gate question for `preview_eval` doesn't fire here because the *selector* is the input, not arbitrary code. |
| `preview_fill({serverId, selector, value})` | — | `{filled: true}` | Same gate logic as `preview_click`. |
| `preview_eval({serverId, expression})` | — | `{result: <JSON>}` or error envelope | **The per-invocation-gate-bearing tool.** The `expression` is LLM-authored arbitrary JS injected into the iframe context. See *Open Questions* — v1 is "approval card mirroring `submit_script_for_approval`" or "selector-only tools and no `preview_eval`." Decision is downstream of Tier 1+2 measurement. |
| `preview_resize({serverId, preset?, width?, height?, colorScheme?})` | `preset ∈ {mobile, tablet, desktop}`. | `{resized: true}` | Lower-priority for the Sokoban case but parity-essential for the reference MCP shape. |

The Tier 3 surface sub-divides at `preview_eval` specifically: every other tool's argument is a *selector* (a static string the user can audit at review time), but `preview_eval`'s argument *is* the effect, in the same way `submit_script_for_approval`'s `source` is the effect. The mitigation pattern is identical — a per-invocation gate, mounting an approval card before execution. The simpler v1 path is to ship Tier 3 *without* `preview_eval` and revisit when a measured use case surfaces that the selector-shaped tools cannot serve.

---

## Security Boundary

The boundary breakdown, mirroring `DESIGN-llm-authored-automation.md` §"Sandbox Seam":

| Layer | What it enforces | How it enforces |
|---|---|---|
| **Origin separation** | The iframe cannot reach `editor.gobha.ai`'s `window`, `localStorage`, `indexedDB`, or cookies. | Distinct origin (`preview.editor.gobha.ai/{workspace}/{path}`) for the iframe. CSP `frame-ancestors` allows *only* the editor origin. The iframe `sandbox="allow-scripts"` attribute (no `allow-same-origin`) makes the cross-origin posture concrete. |
| **CSP** | The iframe cannot phone home or load third-party JS. | `default-src 'self'`; `connect-src 'self'`; `img-src 'self' data:`; `style-src 'self' 'unsafe-inline'` (inline styles are common in workspace HTML). Fetches outside `'self'` blocked. |
| **postMessage origin check** | Only messages from the preview origin reach the editor; only messages from the editor reach the preview. | Both sides verify `event.origin` against the known origin pair before dispatching. Mismatched-origin messages are dropped silently with a console warning. |
| **Service Worker / route handler** | The workspace path namespace (`/{workspace}/{path}`) is served from in-editor `Git.getFile` adapters, not the host filesystem. | A Service Worker registered on the preview origin intercepts iframe `fetch`es and resolves them against the workspace's virtual file tree — same pattern as the §3.0 candidate "Browser-in-browser preview" entry, now load-bearing. The host filesystem is never the source. |
| **Worker shim load order** | The Tier 2 console / error shim runs *before* user code, so user code cannot unhook it. | The Service Worker injects a `<script>` block at the head of every served HTML document; that block is the shim. The shim seals its own references and freezes the relevant globals before yielding to user code. |
| **No `allow-same-origin`** | The iframe's JavaScript treats the parent as cross-origin and cannot reach `window.parent.State`. | Confirmed with the `sandbox` attribute. Tier 1 ships with `allow-scripts` only; Tier 3 may need `allow-forms` for `preview_fill`, but that is a sandbox-attribute flag, not an origin-relaxation. |
| **Sidecar process isolation (Tier 3)** | A `npm run dev` sidecar runs as a constrained user / in a container, with no reach into the editor's environment. | Self-hosted: Docker container per workspace, network-namespace-isolated, mounted read-only on the workspace dir. Editor.gobha.ai-hosted: per-workspace Kubernetes pod, no service-account, ephemeral. Sidecar lifetime bounded to the editor session. |

The trust delta versus today's editor:

- **Tier 1:** ~zero. The iframe can render what the editor's file tree already exposes; nothing leaves the iframe.
- **Tier 2:** small. The iframe sends strings to the editor over postMessage. Buffer caps + truncation make the DoS vector bounded; the strings are inert (rendered into a tool-result, not executed).
- **Tier 3:** non-trivial. A sidecar process runs on the host's network. The mitigation is process isolation (container / pod), and the per-invocation gate on `preview_eval` if it ships at all.

---

## Failure Modes

| Failure | Behavior | Surfaced as |
|---|---|---|
| `preview_start` on a project with `package.json` + `dev` script and no Tier 3 sidecar | Tool returns `{requires_build_step: true, hint: 'Tier 3 sidecar not enabled for this workspace'}` | The agent learns to either skip preview or escalate to a human "enable preview sidecar?" turn. |
| Workspace has no `index.html` and no `path` argument was given | Tool returns `{error: 'no_entrypoint'}` | The model can re-call with an explicit path. |
| Iframe `fetch` for a workspace path that doesn't exist | Service Worker returns 404; appears in `preview_logs` and `preview_network` | The agent reads either log and notices the missing file. |
| Iframe throws an uncaught error during boot (the Sokoban class) | Error captured by `window.onerror` shim → `preview_errors` | Agent reads `preview_errors` on the same turn. |
| User-side `console.log` / `console.error` from workspace JS | Captured by shim → `preview_console_logs` | Same turn. |
| Iframe `console.log` floods the buffer | Buffer cap drops oldest first; `truncated: true` flag set | Agent sees the flag and either re-runs with a tighter probe or accepts the truncation. |
| Iframe attempts `fetch('https://example.com/api')` | CSP blocks; reported in `preview_network` as `failed` | Agent learns the workspace can't reach external APIs at the current tier. |
| Iframe attempts `window.parent.postMessage(secrets)` | postMessage origin check rejects it (it's cross-origin) | The shim ignores the message; nothing reaches the editor's State. |
| Workspace JS attempts to unhook the console shim | Shim's references are sealed; reassignment to `console.*` does not affect the captured side | Logs continue to flow. |
| `preview_eval` (Tier 3) submits a string that throws | Sidecar evaluates, captures the throw, returns `{error, stack}` | Same shape as the reference MCP. |
| `preview_eval` with a long-running expression | Sidecar enforces a hard timeout (default 5s); returns `{error: 'timeout'}` | Mirrors the §1.16.0 Worker timeout pattern. |
| Sidecar process crashes mid-session | All tools for that `serverId` return `{error: 'sidecar_unavailable'}` | Agent must `preview_start` again. |
| Two `preview_start` calls for the same workspace path | Returns the existing `serverId`; idempotent | Mirrors the reference MCP. |

---

## Comparison to Existing In-Loop Tools

The preview surface joins three existing in-loop interaction primitives. They are not redundant; they sit at different points in the loop.

| Surface | What it does | When the model uses it | Trust posture |
|---|---|---|---|
| `submit_script_for_approval` (§1.16.0) | Read-only fs walk over the workspace; runs in Tier-0 Worker; per-invocation gated. | "I have a question that's a single dense pass over the file tree" (dead-CSS audit, unused-export sweep). | Catalog admission + per-invocation gate. |
| `submit_plan_for_approval` (§1.10.0) | Pauses the loop on a markdown plan the user reviews. | "Before I do anything destructive, gate me on the plan." | Catalog admission + per-invocation gate. |
| `ask_user` (§1.9.0) | Pauses the loop on a structured question. | "I need a single piece of input I cannot derive from the workspace." | Catalog admission only (the question itself is data). |
| **Preview tools (this doc)** | Render the workspace in a sandbox; observe; report logs / errors / DOM. | "I shipped a change; does the page actually work?" | Catalog admission. Tier 1–2 read-only against workspace. Tier 3 selector-shaped tools read-only against workspace. `preview_eval` (if it ships) carries a per-invocation gate. |

The Sokoban class is *not* served by any of the existing three. `submit_script_for_approval` could theoretically lint the HTML/JS for cross-references and catch the `#level-display` mismatch, but that is a custom ad-hoc audit per app shape; the preview surface catches the general class with no per-app work.

---

## First-Ship Scope (Tier 1)

The smallest useful first PR.

| | |
|---|---|
| **Tier** | Tier 1 only. |
| **Sandbox** | Sandboxed iframe at a distinct preview origin (or `sandbox="allow-scripts"` no-`allow-same-origin` for self-hosted single-origin deploys). Service Worker resolves workspace paths via `Git.getFile` adapter. |
| **Tool definitions** | Three new tools — `preview_start`, `preview_stop`, `preview_list` — registered in `js/tools/preview-tools.js`. All `readOnly: true`, `roles: 'all'`. |
| **Service Worker** | One new file, `js/preview/service-worker.js`. Intercepts iframe `fetch`. Serves from `Git.getFileTree` / `Git.getFile`. Returns 404 for paths not in the tree. Logs to a per-`serverId` ring buffer. |
| **Iframe host** | New `html/preview.html` (the parent host page that mounts the iframe with `sandbox="allow-scripts"` and the Service Worker registered). Editor surface mounts the host as the second pane / overlay. |
| **CSP** | `Content-Security-Policy: default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors <editor-origin>;` on the preview origin. |
| **Build-step detection** | If `Git.getFile('package.json')` resolves and parses with a `scripts.dev`, `preview_start` returns `{requires_build_step: true}` instead of a URL. Cogfall lands here at Tier 1. |
| **Profile config** | New `profile.preview: {enabled: bool}` block. Default `enabled: true` for `coder.v1`; `enabled: false` for `chat.v1` and `kb.v1`. The Settings → Tools row gates with the standard two-view convention. |
| **Settings UI** | One row in Settings → Tools (or Settings → Advanced if the Tools tab is not present at slot time): toggle `enabled`. Two-view contract per `DESIGN-profiles.md` Appendix B applies. |
| **Tests** | One Node `tests/test-preview-tools.mjs` for the registry/handler shape; one browser test for the Service Worker round-trip with a fixture file tree (Sokoban-shaped). CI auto-globs the `.mjs` test. |
| **CHANGELOG** | New `### Feature` block under the version this lands at. |

**PR-size estimate:** *Feature minor.* In the same shape as the §1.16.0 LLM-authored-automation Phase 1 PR. Rough sizing: 6–10 files net new (3 tool defs + 1 SW + 1 host HTML + 1 settings row + 2 tests + 1 docs row), ~700–1000 LOC, no migrations. Target: a single feature minor (bumps the minor version), not a multi-PR arc.

---

## Out of Scope (For the First Ship — and Possibly Forever)

The next implementer will be tempted to pull these in. The design says no.

- **Tier 2 in the first ship.** The console shim is a real chunk of work (origin verification, buffer caps, freeze-before-user-code ordering). Ship Tier 1 first, prove the iframe boundary, then layer the shim. The Sokoban class waits one more sprint; the boundary is more important than the catch.
- **Tier 3 in the first ship.** Sidecars require lifecycle management, container / pod isolation, and a per-workspace `npm run dev` story. Out of v1.
- **`preview_eval` ever, possibly.** Selector-shaped tools (`click`, `fill`, `inspect`) are sufficient for most "did the user-flow work" probes. Arbitrary-JS injection inverts the trust surface in the same way an `eval` tool would. If the surface graduates, it does so with a per-invocation gate identical to `submit_script_for_approval`.
- **Recording.** "Replay this preview interaction as a test" is its own design pass. Not v1.
- **Multi-page workspace navigation.** Tier 1's preview is one path per `serverId`. The agent calls `preview_start` again with a different `path`. No SPA routing affordances baked in.
- **Cross-workspace preview.** The preview is bound to a single workspace. No "preview repo A's index.html alongside repo B's CSS."
- **Mobile-emulation as a measured priority.** `preview_resize` ships at Tier 3 for parity with the reference MCP, but device-shape coverage is downstream.
- **Auto-refresh on file save.** Tier 1's preview reflects the workspace at `preview_start` time. Re-loads happen on the next call. "Hot reload as the agent edits" is a Tier 3+ story (and probably needs a sidecar).
- **Auth-aware preview.** Workspaces whose pages depend on the user being logged into a backend are a Tier 3 concern at minimum; the v1 sandbox cannot serve cross-origin auth.
- **Console output longer than 1 MB.** Hard buffer cap with truncation; head + tail / structured-only / streaming alternatives are follow-ups.

---

## Open Questions

What this design pass could not resolve. Each must be answered before code starts.

| Question | Why open | Who answers it |
|---|---|---|
| Self-hosted deploy with a single origin | The cleanest boundary is "different origin"; self-hosted users may have only one. Fallback is `sandbox="allow-scripts"` with no `allow-same-origin`, but reach-back is then `postMessage`-only with strict origin check on `null`. | Implementation default; document the trade-off. |
| Where the preview pane lives in the UI | Touch 3 Window v2 (`docs/ROADMAP.md` §"Touch 3 deliverables") makes the middle pane a stage; preview is one stage mode. Pre-Window-v2 it lives as a slide-over or second-pane swap. | Tied to Window v2 land timing. v1 can ship as a slide-over without blocking. |
| How `preview_console_logs` interacts with the editor's existing LLM-debug log surface | Both are time-ordered log streams; merging them risks confusion. | Default to keeping them separate; the preview log is per-`serverId`. The Notes / Debug tray gets a "preview" sub-tab when Tier 2 ships. |
| Whether `preview_eval` ever ships | Inverts trust surface; selector tools cover most cases. | Decide downstream of Tier 1+2 measurement. Default position: don't ship. |
| Per-workspace sidecar lifetimes (Tier 3) | A long-running `npm run dev` sidecar costs RAM. | Bounded to the editor session; killed on close; restart on demand. |
| What happens to a preview when the workspace branch changes | The user switches branches mid-preview; the iframe is stale. | Tier 1: refresh on next `preview_start`; emit a `preview:stale` event the host pane can render. Tier 3 with hot-reload: revisit. |
| Whether the iframe host runs on the same port as the editor | Same-port + path-based routing is simpler self-host; cross-origin requires a port or subdomain. | Implementation default; document. Both are admissible; the security boundary survives either. |
| How `requires_build_step` translates for Cogfall specifically | Cogfall has `vite`; the Tier 3 sidecar shape needs to know how to start it. | Out of v1. Cogfall remains a "preview not available at Tier 1" project until Tier 3 ships. |

---

## Phased Delivery

**Phase 1 — Tier 1 (static iframe + 3 tools).** First ship, as scoped above. Multi-file feature minor. Catches the "page didn't render at all" class. Establishes the iframe boundary as the trust surface.

**Phase 2 — Tier 2 (console + error capture + 4 tools).** Closes the Sokoban class specifically. Requires the load-order discipline (shim runs before user code, freezes its references). Independent PR; gated on Phase 1 having shipped + at least one dogfood incident where Tier 1 was insufficient.

**Phase 3a — Tier 3a selector-shaped tools, iframe-driven (`snapshot`, `click`, `fill`, `inspect`, `resize`).** *(✅ shipped 2.10.0)* No new infrastructure — bidirectional `postMessage` extension to the existing shim (`dir: 'req'` / `dir: 'res'` correlated by `requestId`). Reference-sealed DOM primitives (`Document.prototype.querySelector`, `getComputedStyle`, native `value` setter via `Object.getOwnPropertyDescriptor`) so workspace JS cannot poison the driving path. `preview_snapshot` writes `data-preview-uid="u_N"` directly onto the live DOM during walk; follow-up `preview_click({selector: '[data-preview-uid="u_5"]'})` resolves robustly under DOM mutation without shim-side state. **`preview_eval` decision settled in this phase — does not ship.** Selector-shaped tools cover the agent's actual probes; arbitrary-JS injection inverts trust unjustified by anything Tier 1+2 surfaced. **`preview_screenshot` deferred** — needs html2canvas-class lift; not v1.

**Phase 3b — Tier 3b sidecar + build-step support.** Playwright sidecar (or equivalent), container/pod isolation, per-workspace `npm run dev` lifecycle. Closes the Cogfall (Vite/TS/Pixi) class specifically — build-step projects that currently return `requires_build_step: true` at Tier 1 become previewable. Substantially larger PR than 3a (sidecar lifecycle, process isolation, dev-server orchestration). Gated on dogfood producing a probe that Tier 3a's selector-shaped tools + Tier 2's capture readers + Tier 1's static iframe cannot serve. May never ship if HTML-Games-style targets remain the dogfood substrate; a Cogfall-shaped target arriving in dogfood would fire the gate.

**Phase 4 — `preview_eval` with per-invocation gate, conditionally.** Originally framed as "only if Phase 3 surfaces a measured class of probe that selectors cannot serve." Phase 3a's surface is the experiment; the decision recorded above ("does not ship") supersedes this row unless 3a measurement reverses it.

**Phase 5 — Recording / playback.** Captures preview interactions as regression tests; saves them into the workspace. Its own consent + storage design.

The phased delivery is intentionally back-loaded with "may not earn its slot" gates, mirroring `DESIGN-llm-authored-automation.md` §"Phased Delivery." The first ship is the only one this design commits to; everything else is a question Phase 1's data will answer.

---

## Adjacent Work (Out of Scope for This Design)

Two platform-fix tickets surfaced in the same 2026-05-08 conversation that produced this design. Both are HTML-Games (consumer-repo) issues, not ai-editor issues. They are flagged here so a reader of this design has the full context, but they are not filed by this PR.

- **(a) HTML-Games CI gating.** [`html-games/.gitea/workflows/pr-checks.yaml`](https://git.gobha.me/xcaliber/HTML-Games/src/branch/main/.gitea/workflows/pr-checks.yaml) has `paths: cogfall/**`, so PRs that touch only vanilla-JS games (Sokoban, Pong, Snake, Forge-Defense, Reclamation-Wars, Space-Invaders) skip CI entirely. Sokoban PR #170's TypeError shipped with no CI exposure as a result. Drop the `paths` filter (or extend it to all game directories) so vanilla-JS PRs run *some* check.
- **(b) HTML-Games rollout on tag.** [`html-games/.gitea/workflows/build-and-push.yaml`](https://git.gobha.me/xcaliber/HTML-Games/src/branch/main/.gitea/workflows/build-and-push.yaml) builds + pushes the image but does not `kubectl rollout restart`, so a new image at `registry.gobha.me:5000/xcaliber/html-games:latest` does not actually replace the running pod until manual intervention. Append a `kubectl rollout restart` step (with the appropriate kubeconfig secret).

Both are platform-side fixes that improve the dogfood loop's signal independent of this preview design. They are filed separately by the user.

---

## What This Document Commits To

- **The iframe sandbox is the trust boundary.** Workspace LLM-authored JS runs in a distinct-origin (or fully-`sandbox`-attributed) iframe; the editor's `window`, `localStorage`, and tokens are unreachable from inside. This mirrors §1.16.0's Worker boundary at the content-execution level.
- **Three tiers, explicitly gated.** Tier 1 (static iframe) ships first; Tier 2 (console + error capture) closes the Sokoban class one sprint later; Tier 3 (driveable preview) graduates only against measured demand. Each tier admits a strictly larger blast radius.
- **Mirror the Claude Code preview MCP surface.** Tool names and signatures match the reference (`preview_start`, `preview_console_logs`, `preview_eval`, `preview_snapshot`, etc.) so the model's existing training carries over and the human reviewer's mental model is consistent.
- **`preview_eval` is the one tool that may never ship.** Selector-shaped tools cover most probes; arbitrary-JS injection requires per-invocation gating and may not earn its slot.
- **Cost-discoverable from day one.** Per-tool tokens recorded into the existing cost store; tokens-saved-vs-counterfactual is a stub now and a real metric once Tier 2 produces a corpus.
- **Adjacent work flagged, not filed.** The HTML-Games CI / rollout fixes are platform-side and stay out of this design's scope.
- **Supersedes the §3.0 "Browser-in-browser preview" stub.** That entry framed it as a 3.x maybe; this design pulls Tier 1 forward to a 1.X parallel track based on the Sokoban evidence.

These are the load-bearing decisions. Push back on any of them before building.
