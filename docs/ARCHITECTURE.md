# AI Editor Architecture

This document describes the implementation on `main`. Git history and release
notes explain how it arrived here; they are not architecture authority.

## Runtime shape

AI Editor is a static browser application served by nginx. It has no application
backend. The browser talks directly to configured Git and LLM providers and keeps
local state in browser storage. The production container bundles every runtime
asset and requires no network access except the user-configured providers.

`html/index.html` loads `js/app.js`, which initializes storage, provider
registries, settings, project state, the editor, chat, panels, plugins, and
optional service-worker-backed preview support. `js/core.js` owns the shared
`State` object; feature modules should expose narrow functions or event channels
rather than create a second application state.

## Layers

| Layer | Primary modules | Responsibility |
|---|---|---|
| Application shell | `js/app.js`, `js/core.js`, `js/ui/` | Startup, shared state, panels, dialogs, delegated UI actions |
| Editor | `js/editor/`, `js/tab-manager.js` | CodeMirror lifetime, tabs, dirty state, diffs, blame, ghost text |
| Git | `js/git-providers/`, `js/git.js` | Provider-neutral repository, branch, file, issue, PR, and CI operations |
| Chat loop | `js/chat/`, `js/llm/` | Prompt construction, model transport, tool loop, approval cards, persistence |
| Intelligence | `js/intelligence/` | Retrieval, memory, compression, tool admission, costs, workspace settings |
| Profiles and tools | `js/profiles/`, `js/tools/` | Capability selection, public tool registry, execution policy, task ledger |
| Extensions | `js/plugin-loader.js`, `plugins/`, `js/mcp/` | Installed plugins and MCP-backed tool registration |
| Preview | `js/preview/`, `js/tools/preview-tools.js` | Isolated workspace preview, observation, and approved interaction |

## Request and tool flow

1. Chat accepts user text and attachments and stores the user-visible turn.
2. The active profile resolves prompt, retrieval, memory, compression, preview,
   plugin, and tool-admission settings.
3. Retrieval and memory contribute bounded, labelled context. Prompt assembly
   preserves authority boundaries between fixed instructions, user input, and
   retrieved or tool-produced content.
4. The configured LLM provider returns text and tool calls.
5. The chat loop checks plan-mode and approval policy, then dispatches admitted
   calls through `ToolRegistry`.
6. Tool results return structured success or failure envelopes, enter the
   conversation, and may continue the loop until a terminal response or guard.

The public registry in `js/tools/registry.js` is the execution boundary.
`js/intelligence/tools/` composes the subset shown to a model; it never grants a
capability that the registry or active profile disallows.

## Persistence

- General settings and conversation indexes use the storage helpers in
  `js/core.js` and `js/storage/`.
- Memory and retrieval data use dedicated IndexedDB stores.
- Optional workspace settings, memory, and session synchronization write only
  to their documented repository paths and retain explicit pending-write state.
- Dirty editor buffers remain authoritative until the user commits or discards
  them. Conversation changes must not silently destroy dirty editor state.

## Authority and failure boundaries

- Provider tokens remain in browser-owned settings and are sent only to their
  configured provider endpoints.
- Untrusted repository, model, MCP, plugin, and remote HTML content is treated
  as data. HTML rendering passes through the shared sanitization boundary.
- Tool admission is separate from tool execution. Side effects require the
  relevant profile capability and plan/approval state.
- File edits use read/staleness tracking; truncated searches and incomplete
  analysis must report their limits instead of appearing complete.
- Plugin and MCP registration is reversible. Disconnecting or disabling an
  extension removes its contributed tools.
- Preview code runs in the preview isolation boundary, not in the editor page's
  authority context.

See [SECURITY.md](SECURITY.md) for hostile-input and credential boundaries and
[DESIGN-INDEX.md](DESIGN-INDEX.md) for focused implementation contracts.

## Change rule

The code and tests are the final executable authority. Update a focused contract
when a public interface or load-bearing invariant changes. Put delivery history
in Git commits and releases, not in architecture documents.
