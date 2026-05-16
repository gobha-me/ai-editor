# Profiles and Tools

Profile-based admission for the LLM tool surface. Each profile enumerates the tool names it admits in `tools.admit`; [`Profiles.filterTools`](../js/profiles/registry.js) is the sole admission gate, called by both the per-turn API tools array and the system-prompt tool TOC.

For the deep admission contract — five classification axes, three carve-outs (`'*'`, `'<prefix>__*'`, default-OFF), inheritance operators, forward-evolution rules — see [`ICD-tool-registry.md`](ICD-tool-registry.md). For the profile contract itself (budget / retrieval / memory / compression / tools / task-ledger slices), see [`DESIGN-profiles.md`](DESIGN-profiles.md) §"Inheritance > Tool admission".

For per-tool descriptions and examples, see [`TOOLS.md`](TOOLS.md).

---

## Built-in profiles

Ten profiles ship. The picker exposes three (`chat.v1`, `coder.v1`, `kb.v1`); seven are synthetic — registered for `Profiles.get` / `Profiles.has` lookup but excluded from `Profiles.list()`.

### Picker profiles

#### 💬 `chat.v1` — standard chat

The canonical baseline; every other profile inherits from it. Conversational + read-shaped tool surface (52 entries: 51 literal + `'mcp__*'` glob). Issue / PR write tools deliberately excluded — those relocated to `coder.v1` at 2.56.0 to close the github#40 paper-cut.

#### 💻 `coder.v1` — coding assistant

Inherits from `chat.v1`. Adds the full code-edit cohort (`edit_file`, `replace_lines`, `commit_files`, `run_code`, …), the issue / PR write cohort (`create_issue`, `update_issue`, `add_issue_comment`, `create_pull_request`, `merge_pull_request`, `add_pr_review`), preview drivers (Tier 2 + 3a), `delegate_task` (sub-agent fan-out), and admin tools (`set_active_project`, `sync_releases`, `submit_script_for_approval`). 76 entries total (75 literal + `'mcp__*'` glob). Flips `scriptAutomation.enabled` / `preview.enabled` / `subagent.enabled` to `true`.

#### 📚 `kb.v1` — knowledge-base assistant

Inherits from `chat.v1`. Read-only by construction — every entry in the admit list is read-shaped, agreeing with the `KB_SYSTEM_PROMPT` addendum (*"answer only from attached docs, cite line ranges, no edits"*). 33 entries, **no `'mcp__*'` glob** (MCP servers may be mutating; the trust boundary is the server config, not the picker profile). Disables compression and the task ledger entirely.

### Synthetic profiles

Registered in [`js/profiles/registry.js`](../js/profiles/registry.js)'s `SYNTHETIC_ENTRIES` for lookup but hidden from the picker. Three categories:

- **Legacy-role migration targets** — `full.v1`, `pm.v1`, `reviewer.v1`, `plugin-dev.v1`. The 2.0.0 migration script (slice 3) targets these for users whose pre-2.0 `settings.role` was `'full'` / `'pm'` / `'reviewer'` / `'plugin-dev'`. `full.v1`'s `admit: ['*']` is the wholesale-bypass sentinel.
- **Phase-2 architectural surfaces** — `chat_multi.v1`, `rp.v1`. Shipped as data at 2.6.0 but excluded from the picker until their declared overrides become user-observable. Picker promotion gated on per-profile `systemPrompt` addenda (the lift that promoted `kb.v1` to the picker at 2.8.0).
- **Sub-agent trust-boundary profile** — `subagent.v1` (2.49.0.0). Names the trust boundary for `delegate_task`-spawned child agents; structurally never enters the picker. Carries an explicit per-tool admit list and **deliberately omits the `'mcp__*'` glob** — the explicit-admission discipline is the trust boundary.

---

## How admission works

Two short rules describe the runtime gate:

1. **Profile-side enumeration.** Every profile declares `tools.admit: string[]`. A tool admits when its `function.name` appears literally in the array.
2. **Three carve-outs.**
   - `'*'` as a single entry → wholesale bypass (returns every registered tool). `full.v1` only.
   - `'<prefix>__*'` glob entries → admit every tool whose name begins with `<prefix>__`. Every picker profile except `kb.v1` carries `'mcp__*'` to admit MCP-bridge tools (named `mcp__<serverId>__<toolName>`) without per-server enumeration.
   - Inherited admit lists narrow / widen via `tools.admit_remove` and `tools.admit_add` operators — see [`DESIGN-profiles.md`](DESIGN-profiles.md) §"Inheritance > Tool admission". Operator keys never appear on the resolved profile.

**Default OFF for new tools.** A newly-registered tool that no profile lists is callable by no profile. A registry-side `console.warn` ([`js/tools/registry.js`](../js/tools/registry.js) `register()`, gitea#439) surfaces it at boot. A CI gate test ([`tests/test-profile-admit-coverage.mjs`](../tests/test-profile-admit-coverage.mjs)) asserts coverage at test time.

---

## Tool admit matrix

Hand-curated at 2.56.0 (gitea#440). Source of truth lives in [`js/profiles/{chat,coder,kb}-v1.js`](../js/profiles/) — the buckets below regroup the same names by purpose for readability.

### Conversation + interaction — all picker profiles

`ask_user`, `find_tool`, `list_tool_categories`, `list_tools_by_category`

### File reads + navigation — all picker profiles

`open_file`, `read_current_file`, `read_file`, `read_lines`, `read_function`, `scan_file`, `find_references`, `search_in_files`, `list_open_tabs`, `get_project_tree`, `goto_line`, `select_range`

### Peek (cross-project) — all picker profiles

`peek_project_tree`, `peek_project_file`, `peek_read_lines`

### Project management — `chat.v1` + `coder.v1`

`list_projects` (both); `set_active_project` (coder only — admin shape)

### Embeddings + retrieval — all picker profiles, with one coder-only

`find_relevant_files`, `get_embeddings_status` (all picker); `index_project` (coder only — mutates the embeddings store)

### Scratchpad + todo

- **`chat.v1` + `coder.v1`** — read + write + clear: `scratchpad_read`, `scratchpad_write`, `scratchpad_clear`, `todo_read`, `todo_write`
- **`kb.v1`** — reads only: `scratchpad_read`, `todo_read` (mutating variants dropped to honor the read-only system-prompt constraint)

### Memory

- **`chat.v1` + `coder.v1`** — `memory_recall`, `memory_remember`, `memory_revise`
- **`kb.v1`** — `memory_recall` only

### Issue read + CI — all picker profiles

`list_issues`, `read_issue`, `list_pull_requests`, `read_pull_request`, `get_ci_status`, `get_ci_logs`, `git_log`

### Issue + PR writes — `coder.v1` only

`add_issue_comment`, `create_issue`, `update_issue`, `add_pr_review`, `create_pull_request`, `merge_pull_request`

> **2.56.0 paper-cut closure.** Pre-2.56.0 these reached `chat.v1` through the byte-equivalent migration of the legacy `'pm'` / `'reviewer'` tags. The hand-curation pass relocated them to `coder.v1` where the actual mutation surface lives.

### Code edits + execution — `coder.v1` only

`create_file`, `delete_file`, `write_file`, `edit_file`, `insert_at_cursor`, `insert_lines`, `delete_lines`, `replace_lines`, `replace_selection`, `run_code`, `commit_files`, `list_dirty_files`, `wait_for_ci`

### Plan-Mode + script + sub-agent gates

- **Plan-Mode submit + read** — `submit_plan_for_approval`, `read_approved_plan` on `chat.v1` + `coder.v1`; `read_approved_plan` only on `kb.v1`.
- **Tier-0 script automation** — `submit_script_for_approval` on `coder.v1` only.
- **Sub-agents** — `delegate_task` on `coder.v1` only.
- **Release sync** — `sync_releases` on `coder.v1` only (admin-shape).

### Preview tools

- **`coder.v1`** — full Tier 1 / 2 / 3a: `preview_start`, `preview_stop`, `preview_list`, `preview_console_logs`, `preview_errors`, `preview_logs`, `preview_network`, `preview_snapshot`, `preview_click`, `preview_fill`, `preview_inspect`, `preview_resize`.
- **`chat.v1`** — admitted in the admit list but stripped at runtime by `applyPreviewToolFilter` (since `chat.v1.preview.enabled === false`).
- **`kb.v1`** — deliberately omitted from the admit list (mirrors the runtime filter — admit list is self-describing of what kb.v1 actually exposes).

### MCP-bridge glob — `chat.v1` + `coder.v1`

`'mcp__*'` — admits every tool whose name begins with `mcp__`. `kb.v1` and `subagent.v1` omit the glob: MCP servers can be mutating, and trust requires explicit per-tool admission rather than a wholesale prefix grant.

---

## Tool counts per profile

| Profile | Admit entries | Runtime effective | Note |
|---|---|---|---|
| `chat.v1` | 52 (51 + `'mcp__*'`) | varies with MCP servers | Conversational + read-shaped |
| `coder.v1` | 76 (75 + `'mcp__*'`) | varies with MCP servers | Full code + write + admin |
| `kb.v1` | 33 (no glob) | 33 | Read-only by construction |
| `full.v1` | `['*']` | all registered tools | Wholesale bypass |
| `subagent.v1` | 8 explicit (no glob) | 8 | Trust-boundary discipline |

Fewer admitted tools = smaller `tools[]` array sent to the LLM = lower input cost and faster first-token latency. Pick the narrowest profile that fits the task.

---

## Adding a new tool

```javascript
registry.register('my_new_tool', async (args) => {
    // handler
}, {
    type: 'function',
    function: {
        name: 'my_new_tool',
        description: '...',
        parameters: { type: 'object', properties: { /* ... */ }, required: [] },
    },
    readOnly: true,  // optional — opt in so Plan Mode admits the tool while planning
});
```

**No `roles:` field.** Tool admission is profile-side now (gitea#438 / 2.54.0). The registry stores the definition + handler; admission is decided exclusively by which profiles list `'my_new_tool'` in their `tools.admit` array.

**To make the tool callable, edit at least one profile.** Add the name to the relevant profile's admit list at [`js/profiles/chat-v1.js`](../js/profiles/chat-v1.js), [`coder-v1.js`](../js/profiles/coder-v1.js), or [`kb-v1.js`](../js/profiles/kb-v1.js). Choose by surface intent:

| Surface fit | Where to add |
|---|---|
| Pure read or navigation, safe for every chat | `chat.v1` (and inherited by `coder.v1` / `kb.v1` unless explicitly removed via `admit_remove`) |
| Mutates files, runs code, drives a preview, calls CI / sub-agents | `coder.v1` only |
| Read-only and safe under the KB system prompt | Also add to `kb.v1` |

**The default-OFF dev warning** fires at boot if no profile admits the tool: `[ToolRegistry] tool '<name>' is not admitted by any profile; add to profile X.tools.admit`. The CI gate test ([`tests/test-profile-admit-coverage.mjs`](../tests/test-profile-admit-coverage.mjs)) fails the build under the same condition. Both are antibodies against silent-vanish — the failure mode where a tool registers every boot but is callable nowhere.

---

## Adding a new profile

A user-authored profile authoring API is **deferred to Phase 4** per the github#40 paper decisions ([`docs/discussion/user-built-profile-trees.md`](discussion/user-built-profile-trees.md)). Today profiles live as `.js` files under [`js/profiles/`](../js/profiles/) and register in [`registry.js`](../js/profiles/registry.js)'s `ENTRIES` (picker) or `SYNTHETIC_ENTRIES` (lookup-only).

To prototype a new profile in-tree:

1. Author the profile object per the [`Profile`](../js/profiles/profile-contract.js) typedef. Declare `base: 'chat.v1'` (or another canonical base) and override only the slices that diverge. See [`DESIGN-profiles.md`](DESIGN-profiles.md) §"Canonical Profiles" for the override patterns.
2. Declare `tools.admit` explicitly, or use `tools.admit_add` / `tools.admit_remove` to narrow / widen the inherited list. **Never set `tools.admit = ['all']`** — that string is just a literal tool name now; the legacy "all" tag is retired. Use `'*'` only if you really mean wholesale bypass.
3. Register in `ENTRIES` (picker-visible) or `SYNTHETIC_ENTRIES` (lookup-only) at [`js/profiles/registry.js`](../js/profiles/registry.js). Picker entries get a `label` and `description` for the tooltip.
4. Run [`tests/test-profile-admit-coverage.mjs`](../tests/test-profile-admit-coverage.mjs) — every entry in your admit list must be a known tool, and adding the profile should not break any other profile's coverage gate.

The retired `Roles.register()` plugin API has no successor — plugins no longer extend the profile set. Plugin authors who need surface-specific tool admission should target [`coder.v1`](../js/profiles/coder-v1.js)'s admit list or wait for the Phase 4 authoring API.

---

## MCP server admission

MCP-bridge tools register under names of the form `mcp__<serverId>__<toolName>` (see [`js/mcp/bridge.js`](../js/mcp/bridge.js)). They're admitted by the `'mcp__*'` glob entry that every picker profile except `kb.v1` carries. The legacy per-server `roles:` config field is preserved in storage for back-compat (users may have set it pre-2.54.0) but **no longer consumed by the bridge** — narrower per-server admission is the responsibility of gitea#442 (`plugin.enabled` capability-flag overlay).

To restrict an MCP server's tools to a subset of profiles today, the option is editor-side: remove the `'mcp__*'` glob from the relevant profile's admit list and enumerate the per-server tool names individually. `kb.v1` already does this — it carries no glob so MCP tools are not callable from KB sessions regardless of which servers are connected.

---

## References

- Source: [`js/tools/registry.js`](../js/tools/registry.js), [`js/profiles/registry.js`](../js/profiles/registry.js), [`js/profiles/inheritance.js`](../js/profiles/inheritance.js), [`js/profiles/{chat,coder,kb,full,pm,reviewer,plugin-dev,chat-multi,rp,subagent}-v1.js`](../js/profiles/).
- Contract docs: [`ICD-tool-registry.md`](ICD-tool-registry.md) — admission seam (read the §⚠️ Superseded banner for the pre-2.54.0 model); [`DESIGN-profiles.md`](DESIGN-profiles.md) — profile schema + inheritance + Two-View Configuration.
- Paper-session decisions: [`discussion/profiles-pick-tools.md`](discussion/profiles-pick-tools.md), [`discussion/plugin-dev-mode-vs-profile.md`](discussion/plugin-dev-mode-vs-profile.md), [`discussion/user-built-profile-trees.md`](discussion/user-built-profile-trees.md).
- Tests: [`tests/test-profile-admit-coverage.mjs`](../tests/test-profile-admit-coverage.mjs) (coverage gate), [`tests/test-profile-filter-tools.mjs`](../tests/test-profile-filter-tools.mjs) (filter semantics), [`tests/test-profiles-inheritance.mjs`](../tests/test-profiles-inheritance.mjs) (`admit_add` / `admit_remove` operators).
