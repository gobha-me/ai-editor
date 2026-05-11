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
> below. Five `<div data-slot="...">` mount points wired across the app
> shell; `applyProviderContributions()` fires at boot. Existing
> imperative renderers (`Plugins.registerButton()`, `Plugins.registerModal()`,
> hardcoded sidebar issues/PRs panels, top-bar status pills, settings
> connection cards) are unchanged — SlotManager is additive. Provider
> manifests today declare panel metadata without `render` functions, so
> the consumer skips them silently (forward-compat); migration of those
> imperative renderers into declarative `render` functions is per-surface
> follow-up work. See [CHANGELOG §2.22.0](../CHANGELOG.md).
>
> **Slot remap note (2.22.0).** The `status-bar` slot's "bottom of app
> shell" wording in the catalog table below predates the 1.3.6 Touch 2
> Restructure that consolidated status pills into the top-bar `.tb__right`.
> The 2.22.0 mount point lives in `html/header.html` inside `nav.tb__right`,
> matching the catalog's intent (compression / tool-count pills) even if
> not the literal "bottom" position.

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

| Slot ID | Host element | Purpose |
|---|---|---|
| `sidebar-panels` | sidebar.html | Provider panels (issues, workflows, releases, etc.) |
| `settings-connections` | settings-tabs.html | Per-connection settings cards (URL, token, scopes) |
| `editor-toolbar` | editor pane (top of CodeMirror container) | View-mode toggles, format buttons, plugin actions |
| `chat-input-row` | chat panel (above the input) | Above-input affordances — e.g. the 1.4.0 active-tools chip row |
| `status-bar` | bottom of app shell | Status pills — e.g. 1.2.0 compression ratio, 1.4.0 tool count |

Slots are rendered on demand: a contribution's `render()` is invoked
once per `renderSlot()` call. There are no mount/unmount lifecycle hooks
in 1.4.x — cleanup is the plugin's responsibility, typically via event
delegation rather than per-render listener bindings.

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

```javascript
// js/git-providers/gitea.js
export default {
  id: 'gitea',
  name: 'Gitea',
  icon: '🍵',

  // ... API methods ...

  contributes: {
    panels: [
      {
        version: '1.1',                                  // schema version (see "Schema additions")
        id: 'gitea-issues',
        slot: 'sidebar-panels',
        title: 'Issues',
        icon: '📋',
        priority: 50,                                    // default; lower → renders first (see "Priority and tie-breaking")
        render: (connection, state) => renderIssuesPanel(state.issues),
        refreshEvent: 'issues:refresh'                   // optional; re-renders panel when this fires on EventBus
      },
      {
        version: '1.1',
        id: 'gitea-workflows',
        slot: 'sidebar-panels',
        title: 'Workflows',
        icon: '⚙️',
        render: (connection, state) => renderWorkflowsPanel(state.workflowRuns),
        refreshEvent: 'workflows:refresh'
      }
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
