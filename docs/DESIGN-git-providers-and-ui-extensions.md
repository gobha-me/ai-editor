# Design: Git Provider Abstraction & UI Extensions

## Overview

Transform the hardcoded Gitea integration into a pluggable git provider system
mirroring the existing LLM `ProviderRegistry` pattern. Providers are declarative
manifests that an LLM can easily read, validate, and generate.

### Key differences from LLM providers

| Concern | LLM Providers | Git Providers |
|---------|--------------|---------------|
| Active at once | One | Many (all connections live) |
| Selection | Global dropdown | Per-project (connection owns repos) |
| State key | `apiProvider` | `connections[]` |
| UI surface | Settings only | Settings + sidebar + tools + panels |

---

## 1. Connection Model

```javascript
// State.settings.connections (persisted)
[
  {
    id: "home-gitea",          // Unique, user-assigned
    provider: "gitea",         // References GitProviderRegistry
    label: "Home Gitea",       // Display name
    url: "https://git.gobha.me",
    token: "abc123",
    enabled: true
  },
  {
    id: "github-personal",
    provider: "github",
    label: "GitHub",
    url: "https://api.github.com",  // Fixed for GitHub
    token: "ghp_...",
    enabled: true
  },
  {
    id: "work-gitea",
    provider: "gitea",
    label: "Work Gitea",
    url: "https://git.work.com",
    token: "xyz789",
    enabled: true
  }
]
```

Projects carry their connection ID:
```javascript
State.currentProject = {
  connectionId: "home-gitea",   // Which connection owns this
  owner: "xcaliber",
  repo: "ai-editor",
  ...
}
```

---

## 2. Git Provider Interface

Mirrors `ProviderRegistry` pattern. Each provider implements a normalized
interface; the core never calls provider-specific APIs directly.

```javascript
// js/git-providers/registry.js

const BASE_GIT_PROVIDER = {
  id: 'generic',
  name: 'Generic Git',
  icon: '📦',
  description: 'Base git provider interface',

  // Fixed URL for providers like GitHub (null = user-configurable)
  fixedUrl: null,

  // === Repository ===
  async listRepos(connection) {},
  async getRepo(connection, owner, repo) {},

  // === Branches ===
  async listBranches(connection, owner, repo) {},
  async createBranch(connection, owner, repo, name, from) {},
  async deleteBranch(connection, owner, repo, name) {},

  // === File Tree / Contents ===
  async getContents(connection, owner, repo, path, ref) {},
  async getFileTree(connection, owner, repo, ref, path) {},
  async getFile(connection, owner, repo, path, ref) {},

  // === File CRUD ===
  async createFile(connection, owner, repo, path, content, message, branch) {},
  async updateFile(connection, owner, repo, path, content, message, sha, branch) {},
  async deleteFile(connection, owner, repo, path, message, sha, branch) {},
  async renameFile(connection, owner, repo, oldPath, newPath, message, branch) {},
  async batchCommitFiles(connection, owner, repo, files, message, branch) {},

  // === Issues ===
  async listIssues(connection, owner, repo, state) {},
  async getIssue(connection, owner, repo, number) {},
  async createIssue(connection, owner, repo, title, body, labels) {},
  async getIssueComments(connection, owner, repo, number) {},
  async createIssueComment(connection, owner, repo, number, body) {},
  async updateIssueState(connection, owner, repo, number, state) {},

  // === Merge Requests (PRs/MRs — normalized name) ===
  async listMergeRequests(connection, owner, repo, state) {},
  async createMergeRequest(connection, owner, repo, title, body, head, base) {},

  // === CI/CD (optional — not all providers have this) ===
  async listWorkflowRuns(connection, owner, repo) { return []; },
  async getWorkflowRun(connection, owner, repo, runId) { return null; },

  // === UI Extensions (declarative) ===
  contributes: {
    panels: [],      // Sidebar panels
    tools: [],       // LLM tool definitions
    settings: [],    // Settings fields
    menuItems: []    // Context menu items
  }
};
```

### Return shapes are normalized

All providers return the same shapes. The provider translates from its
native API format. For example, GitHub's `pull_request` and GitLab's
`merge_request` both return:

```javascript
{
  number: 42,
  title: "Fix the thing",
  body: "Description...",
  state: "open",          // Normalized: open | closed | merged
  head: "feature-branch",
  base: "main",
  mergeable: true,
  url: "https://..."
}
```

---

## 3. GitProviderRegistry

```javascript
const GitProviderRegistry = {
  _providers: new Map(),
  _connections: [],           // Active connections

  register(provider) { ... },
  get(providerId) { ... },
  list() { ... },

  // Connection management
  addConnection(config) { ... },
  removeConnection(id) { ... },
  getConnection(id) { ... },
  listConnections() { ... },

  // Resolve: given a connectionId, return the provider + connection
  resolve(connectionId) {
    const conn = this.getConnection(connectionId);
    const provider = this.get(conn.provider);
    return { connection: conn, provider };
  },

  // Aggregate repos across all enabled connections
  async listAllRepos() {
    const results = [];
    for (const conn of this._connections.filter(c => c.enabled)) {
      const provider = this.get(conn.provider);
      const repos = await provider.listRepos(conn);
      results.push(...repos.map(r => ({
        ...r,
        connectionId: conn.id,
        connectionLabel: conn.label,
        providerIcon: provider.icon
      })));
    }
    return results;
  }
};
```

---

## 4. UI Extension System (Declarative Slots)

> **Implementation status:** Contract locked in 1.1.0 (this section);
> renderer (`js/slot-manager.js`) **shipped 2.22.0** against the contract
> below. Six `<div data-slot="...">` mount points wired across the app
> shell (the sixth, `rail-views`, added by the 2026-05-11 Rail v2
> reconciliation — see Decision 1 below); `applyProviderContributions()`
> fires at boot. Existing imperative renderers
> (`Plugins.registerButton()`, `Plugins.registerModal()`, hardcoded
> sidebar issues/PRs panels, top-bar status pills, settings connection
> cards) are unchanged — SlotManager is additive. Provider manifests
> today declare panel metadata without `render` functions, so the
> consumer skips them silently (forward-compat); migration of those
> imperative renderers into declarative `render` functions is per-surface
> follow-up work. See [CHANGELOG §2.22.0](../CHANGELOG.md).
>
> **Slot remap note (2.22.0).** The `status-bar` slot's "bottom of app
> shell" wording in the catalog table below predates the 1.3.6 Touch 2
> Restructure that consolidated status pills into the top-bar `.tb__right`.
> The 2.22.0 mount point lives in `html/header.html` inside `nav.tb__right`,
> matching the catalog's intent (compression / tool-count pills) even if
> not the literal "bottom" position.
>
> **Rail v2 reconciliation (2026-05-11).** Touch 3 Rail v2 (2.11.0)
> turned the sidebar's Files / Issues / Pull Requests / Branches panels
> into rail views — a vertical icon column + view-body containers
> toggled by `hidden`. The `sidebar-panels` slot mount lives **outside**
> the rail-content area (an additive surface below the rail), so a
> provider rendering a full Issues panel into `sidebar-panels` would
> show issues twice — once in the rail Issues view, once permanently
> below. Migration of the imperative `renderIssues()` /
> `renderPullRequests()` consumers is therefore blocked on a contract
> change. Resolved by adding a `rail-views` slot kind (see Decision 1):
> rail-view contributions carry their own `{id, label, icon, render}`
> structure and are owned by Rail v2's renderer; `sidebar-panels` stays
> the additive flat-list region for panels appearing *below* the rail.
> Additive change — `version` stays at `'1.1'`.

The core layout defines named slots. Plugins/providers declare what they
mount into those slots via their `contributes` manifest.

### Slot definitions in HTML templates

```html
<!-- sidebar.html -->
<div data-slot="sidebar-panels">
  <!-- Provider panels render here dynamically -->
</div>

<!-- settings-tabs.html -->
<div data-slot="settings-connections">
  <!-- Connection cards render here -->
</div>
```

### SlotManager (new module)

```javascript
// js/slot-manager.js

const SlotManager = {
  _contributions: new Map(),  // slotId -> [{ pluginId, render, priority }]

  /**
   * Register a UI contribution (called during plugin/provider init).
   * Declarative: the manifest says where, the SlotManager places it.
   */
  contribute(slotId, contribution) {
    if (!this._contributions.has(slotId)) {
      this._contributions.set(slotId, []);
    }
    this._contributions.get(slotId).push(contribution);
    this._contributions.get(slotId).sort((a, b) =>
      (a.priority || 50) - (b.priority || 50)
    );
    this.renderSlot(slotId);
  },

  /**
   * Render all contributions into a slot's DOM element.
   */
  renderSlot(slotId) {
    const container = document.querySelector(`[data-slot="${slotId}"]`);
    if (!container) return;
    container.innerHTML = '';
    for (const c of this._contributions.get(slotId) || []) {
      const el = typeof c.render === 'function'
        ? c.render()           // Returns HTMLElement or HTML string
        : c.render;            // Static HTML string
      if (typeof el === 'string') {
        container.insertAdjacentHTML('beforeend', el);
      } else if (el instanceof HTMLElement) {
        container.appendChild(el);
      }
    }
  },

  /**
   * Re-render all slots (e.g., after connection change).
   */
  renderAll() {
    for (const slotId of this._contributions.keys()) {
      this.renderSlot(slotId);
    }
  },

  /**
   * Remove all contributions from a specific plugin/provider.
   */
  removeByPlugin(pluginId) {
    for (const [slotId, contribs] of this._contributions) {
      this._contributions.set(slotId,
        contribs.filter(c => c.pluginId !== pluginId)
      );
      this.renderSlot(slotId);
    }
  }
};
```

### Slot catalog (closed registry for 1.4.x)

The editor declares a fixed set of slots. Adding a slot requires a PR
that updates this table; plugins cannot invent private slot names that
the editor doesn't render.

| Slot ID | Host element | Purpose | Contribution kind |
|---|---|---|---|
| `rail-views` | sidebar.html — owned by Rail v2 renderer (`js/ui/left-pane-rail.js`) | **Structured** rail views — full panes addressable from the rail's icon column with their own button + view body. Contributions ship view metadata + a body renderer; Rail v2 builds both the rail button and the view container from each entry. Existing built-in views (Files, Issues, Pull Requests, Branches) migrate here per Decision 1. | structured (`view`) |
| `sidebar-panels` | sidebar.html — `<div data-slot="sidebar-panels">` peer of `.lp__rail-body`, immediately before `</aside>` | **Flat** additive panels that appear *below* the rail-content area, independent of the active rail view (e.g. provider-supplied status banners, secondary always-visible widgets). Not a destination for full panels duplicating a rail view — see Decision 1. | flat (`render`) |
| `settings-connections` | settings-tabs.html | Per-connection settings cards (URL, token, scopes). One card per connection; the slot is the container, each card a contribution. | flat (`render`) — structured `connection` shape reserved for the settings migration |
| `editor-toolbar` | editor pane (top of CodeMirror container) | View-mode toggles, format buttons, plugin actions | flat (`render`) |
| `chat-input-row` | chat panel (above the input) | Above-input affordances — e.g. the 1.4.0 active-tools chip row | flat (`render`) |
| `status-bar` | top bar `.tb__right` (see "Slot remap note") | Status pills — e.g. 1.2.0 compression ratio, 1.4.0 tool count | flat (`render`) |

**Contribution kind** governs the contract a contribution to that slot
must satisfy. *Flat* slots take the v1 zero-arg `render()` contract
unchanged. *Structured* slots take a slot-specific shape in addition to
`render`; the shape is part of the contract for that slot ID. See
"Structured contribution shapes" below.

Slots are rendered on demand: a contribution's `render()` is invoked
once per `renderSlot()` call. There are no mount/unmount lifecycle hooks
in 1.4.x — cleanup is the plugin's responsibility, typically via event
delegation rather than per-render listener bindings.

### Structured contribution shapes

Most slots are *flat*: a contribution's `render()` returns content that
the SlotManager mounts into the slot container, end of story. A subset
of slots have **regional semantics** — the region is more than a flat
list — and contributions to those slots carry extra structured fields
so the slot's owning renderer can interpret them.

The principle, applied uniformly across the catalog: **a slot defines a
region with consistent semantics; contributions follow that region's
contract.** Flat regions (status pills, additive sidebar panels,
editor-toolbar buttons) take just `render`. Structured regions (the
rail, eventually connection-card lists) take an extra shape field
named for the region.

#### `rail-views` slot — `view: {id, label, icon, badge?, priority?}`

```javascript
{
  pluginId: 'gitea',
  slot: 'rail-views',
  version: '1.1',
  view: {
    id: 'issues',                // Stable identifier; persisted in
                                 // localStorage as the active view.
                                 // Must be unique across all
                                 // `rail-views` contributions; the
                                 // renderer warns + skips on collision.
    label: 'Issues',             // Tooltip + aria-label on the rail
                                 // button.
    icon: '<svg ...>',           // Inline SVG string (Lucide-shape,
                                 // 24×24 viewBox, round caps/joins —
                                 // matches the rest of the codebase).
                                 // SlotManager does not sanitize SVG
                                 // strings; same XSS contract as the
                                 // string-`render` mount path.
    badge: () => 5,              // Optional zero-arg function returning
                                 // a non-negative integer. Re-evaluated
                                 // on `refreshEvent` (below); 0 hides
                                 // the badge.
    priority: 20,                // Optional. Controls left-rail button
                                 // order (lower = closer to top).
                                 // Default 50; ties broken by insertion
                                 // order. Built-in views ship with
                                 // explicit priorities (Files=10,
                                 // Issues=20, PRs=30, Branches=40)
                                 // so providers can interleave.
  },
  render: (container) => { ... }, // Mounted into the rail-view body
                                  // container. Receives the body
                                  // element so the renderer can mutate
                                  // `innerHTML` or `appendChild` in
                                  // place — distinct from the flat
                                  // zero-arg `render()` contract.
                                  // The Rail v2 renderer creates the
                                  // body container; `render` populates
                                  // it.
  refreshEvent: 'issues:refresh', // Optional. Same semantics as flat
                                  // slots — Rail v2 re-runs `render`
                                  // (and re-evaluates `badge`) when
                                  // EventBus fires.
}
```

The Rail v2 renderer (`js/ui/left-pane-rail.js`) is the consumer for
this slot kind. It builds the rail-button column from the contributed
`view` metadata (sorted by `priority ?? 50`) and creates per-view body
containers inside `.lp__rail-content`, invoking each `render` on the
matching body element. The current `RAIL_ITEMS` constant and the
hardcoded `.lp__rail-view` containers in `html/sidebar.html` become
**built-in plugin** contributions to `rail-views`; the migration walk
is laid out in Decision 1's "Migration walk" sub-section.

Unlike flat slots, `rail-views` contributions are **identity-bearing**:
two contributions with the same `view.id` collide rather than stacking.
The SlotManager logs `[SlotManager] rail-views id collision` and skips
the second entry. This is how built-in Files/Issues/PRs/Branches stay
overrideable by a provider that wants to replace one — the provider
contributes first (e.g. during `applyProviderContributions()` which
fires before the built-in plugin registration in the boot order
established for the migration), and the built-in plugin's
same-`id` contribution is the one that gets skipped. Built-in views can
also opt out by checking `SlotManager.hasViewId('issues')` before
contributing, but the collision-skip behavior is the load-bearing
guarantee.

#### Future structured slots (reserved)

- **`settings-connections`** is flat in v1 but the settings-tab
  migration may want a structured `connection: {id, label, fields}`
  shape so the settings tab owns the card chrome and the contribution
  only owns the body. Decision deferred to the settings migration PR.
- **`status-bar`** stays flat — a pill is a flat thing.

### Error semantics, security, and ordering

Four contract clarifications a 1.4.x implementation must honor:

1. **Render error containment.** If `contribution.render()` throws,
   SlotManager catches the error, logs it to `console.error` with
   `{ pluginId, slotId, error }`, and skips that contribution. Other
   contributions in the same slot still render. Plugins must not rely
   on exceptions to abort sibling contributions.

2. **HTML injection / XSS boundary.** Contributions that return an
   `HTMLElement` are mounted via `appendChild` (safe; the DOM API does
   not parse markup). Contributions that return a `string` are mounted
   via `insertAdjacentHTML('beforeend', ...)` and are **not** sanitized
   by SlotManager. Plugin authors are responsible for sanitizing any
   dynamic content they include in a string return value. Recommended
   patterns: build the tree with `document.createElement` +
   `textContent`, or pre-sanitize untrusted content with DOMPurify
   before returning the string. The project-wide rule against
   `return raw;` near a DOMPurify call (enforced by the CI security
   lint in `.gitea/workflows/ci.yaml`) applies inside plugin render
   functions just as it does in core code.

3. **Priority and tie-breaking.** Sort key is `(priority ?? 50)`
   ascending — lower number renders first. Default priority is **50**
   when omitted; bias up by setting a smaller number, down by setting
   a larger one. Ties break by registration order (insertion-stable —
   `Array.prototype.sort` is stable in all currently-supported
   browsers).

4. **CSS isolation.** No shadow DOM in 1.4.x. Plugins must namespace
   their CSS class names with their `pluginId` (e.g.
   `.gitea-issues__panel`, `.foo-plugin__row`). Style collisions are
   the plugin author's problem, not SlotManager's. `Plugins.injectCSS()`
   is the canonical injection point and already exists today.

### Schema additions

Add a `version: '1.1'` field to each panel/setting/menuItem entry in
`contributes`. The 1.4.x renderer rejects entries whose `version` it
does not recognize, providing a forward-compat lever: future schema
revisions ship as `'1.2'` etc. without breaking older renderers in
the wild. Entries without a `version` field are treated as `'1.1'` for
backwards compatibility with the providers that ship today.

### Provider manifest with UI extensions

The example below uses the post-Rail-v2 contract: Issues and Pull
Requests contribute to the **structured `rail-views` slot** so they
appear as full rail views with their own icon-column button; a
Workflows panel contributes to the **flat `sidebar-panels` slot** so
it appears as an additive panel below the rail-content area (i.e. it
isn't a full rail view, just a banner-style widget always visible
below the active rail view). Pick the slot whose region semantics
match the panel's UX role — see "Structured contribution shapes"
above for the rule.

```javascript
// js/git-providers/gitea.js
export default {
  id: 'gitea',
  name: 'Gitea',
  icon: '🍵',

  // ... API methods ...

  contributes: {
    panels: [
      // === Rail view: Issues ===
      // Renders as a rail-button + rail-view body pair. Replaces the
      // hardcoded `<div data-rail-view-container="issues">` block in
      // `html/sidebar.html` once the migration lands; the slot
      // contract above (Decision 1) wires it in declaratively.
      {
        version: '1.1',                            // schema version (see "Schema additions")
        slot: 'rail-views',                        // structured slot — see catalog
        view: {
          id: 'issues',                            // stable; persists as active rail view
          label: 'Issues',
          icon: SVG_ISSUES,                        // inline SVG, Lucide-shape 24×24
          badge: () => State.issues?.length || 0,  // re-evaluated on refreshEvent
          priority: 20,                            // Files=10, Issues=20, PRs=30, Branches=40
        },
        render: (container) => {                   // mounted into the rail-view body
          container.innerHTML = renderIssueRowsHtml({
            issues: State.issues,
            // ... existing renderIssueRowsHtml args from project-manager.js ...
          });
        },
        refreshEvent: 'issues:refresh',            // re-runs render + re-evaluates badge
      },

      // === Rail view: Pull Requests ===
      {
        version: '1.1',
        slot: 'rail-views',
        view: {
          id: 'prs',
          label: 'Pull Requests',
          icon: SVG_PRS,
          badge: () => State.pullRequests?.length || 0,
          priority: 30,
        },
        render: (container) => {
          container.innerHTML = renderPullRequestsHtml(State.pullRequests);
        },
        refreshEvent: 'prs:refresh',
      },

      // === Additive sidebar panel: Workflows banner ===
      // Renders below the rail-content area — visible regardless of
      // active rail view. Use this for status-banner panels that
      // shouldn't take an entire rail-view's worth of space.
      {
        version: '1.1',
        slot: 'sidebar-panels',
        id: 'gitea-workflows-banner',              // identifies the contribution; not a view id
        render: () => renderWorkflowsBanner(State.workflowRuns),
        refreshEvent: 'workflows:refresh',
      },
    ],

    tools: [
      {
        name: 'create_gitea_issue',
        description: 'Create a new issue in the Gitea repository',
        roles: ['full', 'pm'],
        parameters: { ... },
        handler: async (args, connection) => { ... }
      }
    ],

    settings: [
      {
        id: 'gitea-url',
        type: 'text',
        label: 'Gitea URL',
        placeholder: 'https://git.example.com',
        field: 'url'
      },
      {
        id: 'gitea-token',
        type: 'password',
        label: 'API Token',
        placeholder: 'Your Gitea API token',
        field: 'token'
      }
    ]
  }
};
```

### Worked example — migrating sidebar Issues from imperative to declarative

This is the concrete migration that motivated Decision 1. Today
[`js/project-manager.js:446`](../js/project-manager.js) drives the
Issues sidebar imperatively: `renderIssues()` queries `#issuesPanel`
inside the hardcoded `<div data-rail-view-container="issues">` HTML
block in `html/sidebar.html`, sets `innerHTML`, and is invoked by
`refreshIssues()`. Under Decision 1, that imperative path collapses
into one `rail-views` contribution.

**Before (imperative — what ships today):**

1. `html/sidebar.html` hardcodes the Issues rail-view container with
   its `<div class="lp2__pane-h">` header (title + refresh button) and
   inner `#issuesPanel` mount point.
2. `js/ui/left-pane-rail.js` `RAIL_ITEMS` const hardcodes the Issues
   rail button (icon, label, `badgeKey: 'issues'`); `computeBadges`
   reads `State.issues.length`.
3. `js/project-manager.js#renderIssues()` writes `innerHTML` into
   `#issuesPanel`; `refreshIssues()` calls it after the fetch.

**After (declarative — what Decision 1 commits to):**

1. The hardcoded Issues block in `html/sidebar.html` deletes.
2. `RAIL_ITEMS` in `left-pane-rail.js` loses the Issues entry; the
   rail renderer reads `rail-views` contributions instead.
3. `js/git-providers/gitea.js#contributes.panels` gains the
   `rail-views` Issues contribution shown in the manifest example
   above. `render` and `badge` close over the existing
   `renderIssueRowsHtml` helper and `State.issues` — no behavior
   change.
4. `refreshIssues()` in `project-manager.js` keeps its fetch logic
   and emits `issues:refresh` on `EventBus` — same event channel as
   today; the rail-view contribution's `refreshEvent` triggers the
   re-render.

User-visible behavior is unchanged: the rail still shows an Issues
button with a badge, the same view body, the same refresh flow. The
contract has moved: the **declaration** of "there is an Issues view"
now lives in the Gitea provider manifest, not in HTML + a hardcoded
constants table. A future GitHub provider can contribute its own
`rail-views` entry with `view.id: 'github-actions'` and the rail
will grow a new button.

Pull Requests migrates identically. Files and Branches migrate next
(both become built-in plugin contributions to `rail-views` — they
aren't git-provider-owned but the slot kind is the same).

---

## 5. Project Selector Changes

The project selector becomes connection-aware. Two approaches:

### Option A: Grouped dropdown

```
┌────────────────────────────┐
│ 🍵 Home Gitea              │  ← optgroup
│   xcaliber/ai-editor       │
│   xcaliber/tools           │
│ 🐙 GitHub                  │  ← optgroup
│   jeff/dotfiles             │
│   jeff/homelab              │
└────────────────────────────┘
```

### Option B: Connection tabs + project list

```
[🍵 Home] [🍵 Work] [🐙 GitHub]    ← tabs
┌────────────────────────────┐
│ xcaliber/ai-editor         │
│ xcaliber/tools             │
└────────────────────────────┘
```

**Recommendation: Option A** — simpler, works well with the existing `<select>`
element, and scales to 3-5 connections without taking extra space.

---

## 6. Migration Path

### Phase 1: Abstraction (no new providers)
1. Create `js/git-providers/registry.js` + `js/git-providers/gitea.js`
2. Extract current `GiteaAPI` methods into the Gitea provider
3. Create `js/slot-manager.js`
4. Add `connections[]` to `State.settings`
5. Migrate `project-manager.js` to use `GitProviderRegistry`
6. Migrate existing sidebar panels (issues, workflows) to use slots
7. **Everything still works with a single Gitea connection**

### Phase 2: Multi-connection
1. Settings UI for managing connections (add/remove/edit)
2. Grouped project selector
3. Per-connection repo fetching
4. SSE retry logic (independent, can ship in Phase 1)

### Phase 3: GitHub provider
1. Create `js/git-providers/github.js`
2. Map GitHub REST API to normalized interface
3. Add GitHub-specific `contributes` (Actions panel, PR reviews)
4. Register GitHub-specific LLM tools

### Phase 4: GitLab provider
1. Same pattern as GitHub

---

## 7. SSE Retry Logic (Quick Win)

Independent of git providers. Add to `llm.js`:

```javascript
// Retryable error conditions
const RETRYABLE_ERRORS = [
  (err) => err.message?.includes('zero-length'),
  (err) => err.message?.includes('empty document'),
  (err) => [502, 503, 504].includes(err.status),
  (err) => err.name === 'TypeError' && err.message?.includes('fetch'),
];

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

async function withRetry(fn, { maxRetries = MAX_RETRIES, onRetry } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isRetryable = RETRYABLE_ERRORS.some(check => check(err));
      if (!isRetryable || attempt === maxRetries) throw err;

      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      if (onRetry) onRetry(attempt + 1, delay, err);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}
```

---

## 8. File Layout

```
js/
├── git-providers/
│   ├── registry.js          # GitProviderRegistry
│   ├── base.js              # BASE_GIT_PROVIDER defaults
│   ├── gitea.js             # Gitea provider (extracted from gitea.js)
│   ├── github.js            # GitHub provider (Phase 3)
│   └── index.js             # Auto-registration
├── slot-manager.js          # UI extension slot system
├── gitea.js                 # → Becomes thin adapter importing from git-providers/gitea.js
│                            #   (backward compat for existing imports)
└── ...
```

---

## Decisions

Architectural decisions on this design. Load-bearing — implementations
honor them.

### Decision 1 — Rail v2 reconciliation (2026-05-11)

The 2.22.0 SlotManager rails shipped before the migration of the
sidebar Issues/PRs imperative renderers, leaving a conflict: the
`sidebar-panels` slot mount lives outside Rail v2's rail-content area,
so a provider contributing a full Issues panel to `sidebar-panels`
would show issues twice (once in the rail Issues view, once below).

**Resolution.** Add a new structured slot kind `rail-views`, owned by
Rail v2's renderer (`js/ui/left-pane-rail.js`). Provider/plugin
contributions carry `{view: {id, label, icon, badge?, priority?},
render(container), refreshEvent?}` and become first-class rail views —
the rail's button column and view-body containers are derived from
these contributions instead of from a hardcoded `RAIL_ITEMS` constant.
`sidebar-panels` is repurposed (and tightened in the catalog) as the
additive flat-list region for panels appearing *below* the rail-content
area, never as a destination for full panels that duplicate a rail
view. Conflict-resolution principle that generalizes to the future
`settings-connections` and any later structured region: **a slot
defines a region with consistent semantics; contributions follow that
region's contract.** Flat regions take just `render`; structured
regions carry a named shape field (`view`, `connection`, ...).

**Migration walk.**

1. Implementer ships the `rail-views` slot kind in `SlotManager`
   (collision-skip on duplicate `view.id`; structured render arity
   `render(container)`; sort by `view.priority ?? 50`).
2. Rail v2 renderer (`js/ui/left-pane-rail.js`) consumes `rail-views`
   contributions — builds the button column from `view` metadata
   (replacing `RAIL_ITEMS`), creates the body containers in
   `.lp__rail-content`, invokes `render(body)` per entry, wires
   `refreshEvent` to re-render + re-evaluate `badge`.
3. Built-in Files + Branches register as plugin contributions to
   `rail-views` (they aren't git-provider-owned). Issues + Pull
   Requests migrate into `js/git-providers/gitea.js#contributes.panels`
   per the worked example above. Imperative `renderIssues()` /
   `renderPullRequests()` in `project-manager.js` become helpers
   referenced by the contribution `render`s.
4. Hardcoded `.lp__rail-view` containers in `html/sidebar.html` delete
   once all four built-in views move to contributions; the rail body
   becomes empty-by-default and populated entirely from `rail-views`.

**Forward-compat.** Additive change: new slot row, new optional shape
field on contributions to that slot. `version` stays at `'1.1'`. No
existing flat-slot consumer changes shape. Providers that ship today's
metadata-only `panels[]` (no `render`, no `view`) continue to no-op
silently — the structured slot path requires both `view` and `render`,
and the renderer skips entries that don't match the slot's contract.

**Why Option 5 over alternatives.** The original options canvassed five
shapes (per-rail-view slots; sub-slot routing via a `railView` field;
slot relocation; full Rail v2 SlotManager rebuild; the chosen "new
structured slot kind"). Option 1 (one slot per existing rail view) is
explicit but doesn't make Rail v2 extensible — adding a "Workflows"
view would still require a catalog PR plus a new slot ID. Option 2
(field-based dispatch within `sidebar-panels`) hides the structural
distinction the slot's region semantics deserve, and the dispatcher
becomes the hard-to-reason-about part. Option 3 (relocate
`sidebar-panels` inside the rail) regresses Rail v2. Option 4 (full
Rail v2 SlotManager rebuild) overlaps substantially with Option 5 — in
practice Option 5 is Option 4 expressed as a slot kind. Option 5 is
the smallest contract change that both unblocks the deferred migration
and makes the rail extensible by future providers (which is the test
the contract needs to pass — a GitHub provider should be able to
contribute an Actions rail view without editing core).

**Settings-connections fall-through.** The same principle applies to
the deferred settings-connection-cards migration: each connection card
is a structured contribution to `settings-connections` (shape reserved
for that migration PR). Top-bar pills stay flat — a pill is just
`render`.

---

## 9. LLM Cognitive Load Considerations

Everything is declarative so an LLM can:

1. **Read a manifest** and understand what a provider contributes
2. **Generate a new provider** by filling in the same shape
3. **Modify UI extensions** by editing the `contributes` object
4. **Register tools** without knowing about the DOM or event wiring

The `contributes` pattern is the key insight: it's a static data structure
that declares capabilities rather than imperative code that wires them up.
An LLM doesn't need to trace execution flow through `addEventListener` calls
and DOM manipulation — it just needs to produce the right shape.
