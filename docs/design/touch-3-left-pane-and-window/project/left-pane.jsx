/* Left pane explorations.
   The current pane stacks three always-visible sections (Files, Issues, PRs).
   It's crowded. We try three responses:
     A. LeftPaneTabs     — tabs replace stacking. Honest, conventional, fastest to ship.
     B. LeftPaneRail     — VSCode-style activity rail. Room to grow (Search, Branches, History).
     C. LeftPaneWorkbench — branch-organized stream where issues/PRs annotate the file tree.
*/

const lpFiles = [
  { kind: 'dir',  depth: 0, name: '.aieditor', open: false },
  { kind: 'dir',  depth: 0, name: '.gitea',    open: false },
  { kind: 'dir',  depth: 0, name: 'assets',    open: false },
  { kind: 'dir',  depth: 0, name: 'css',       open: true  },
  { kind: 'file', depth: 1, name: 'base.css',  meta: 'M' },
  { kind: 'file', depth: 1, name: 'chat.css',  meta: '' },
  { kind: 'file', depth: 1, name: 'editor.css', meta: '' },
  { kind: 'file', depth: 1, name: 'memory.css', meta: '' },
  { kind: 'file', depth: 1, name: 'sidebar.css', meta: 'M' },
  { kind: 'dir',  depth: 0, name: 'js',        open: true  },
  { kind: 'file', depth: 1, name: 'app.js',    meta: '' },
  { kind: 'file', depth: 1, name: 'editor.js', meta: 'M', issues: 2 },
  { kind: 'file', depth: 1, name: 'memory.js', meta: '' },
  { kind: 'file', depth: 1, name: 'version.js', meta: '' },
  { kind: 'dir',  depth: 0, name: 'plugins',   open: false },
  { kind: 'file', depth: 0, name: 'index.html', meta: '' },
  { kind: 'file', depth: 0, name: 'README.md',  meta: '' },
];

const lpIssues = [
  { id: 142, title: 'Diff view scrolls horizontally on long lines',     repo: 'ai-editor', tag: 'bug',     age: '2h', files: ['js/editor.js'] },
  { id: 138, title: 'Add keyboard shortcut for "open recent"',          repo: 'ai-editor', tag: 'feat',    age: '1d', files: [] },
  { id: 131, title: 'Memory viewer flickers when chat scrolls',         repo: 'ai-editor', tag: 'bug',     age: '3d', files: ['js/memory.js','css/memory.css'] },
  { id: 127, title: 'Settings: timezone selector defaults to UTC',      repo: 'ai-editor', tag: 'nit',     age: '4d', files: [] },
  { id: 119, title: 'Plugin loader silently swallows manifest errors',  repo: 'ai-editor', tag: 'bug',     age: '1w', files: [] },
];

const lpPRs = [
  { num: 84, title: 'Refactor diff renderer to virtual-scroll',           branch: 'feat/virtual-diff',  status: 'review',  reviewers: 1, comments: 6, addn: 412, del: 188, behind: 0,  ahead: 7,  ago: '12m' },
  { num: 81, title: 'Connections: per-provider list + aggregated picker', branch: 'feat/connections',   status: 'mergeable', reviewers: 2, comments: 14, addn: 760, del: 92, behind: 0,  ahead: 11, ago: '4h' },
  { num: 79, title: 'Theme tokens contract',                              branch: 'feat/tokens',        status: 'draft',   reviewers: 0, comments: 0, addn: 88,  del: 4,   behind: 3,  ahead: 5,  ago: '1d' },
  { num: 76, title: 'Indexer batch size from settings',                   branch: 'fix/indexer-batch',  status: 'conflict',reviewers: 1, comments: 2, addn: 22,  del: 17,  behind: 4,  ahead: 2,  ago: '2d' },
];

const lpStatusTone = {
  review: 'pip',
  mergeable: 'ok',
  draft: 'mute',
  conflict: 'warn',
};
const lpStatusLabel = {
  review: 'Review',
  mergeable: 'Mergeable',
  draft: 'Draft',
  conflict: 'Conflict',
};

/* ─── shared bits ─────────────────────────────────────────────────── */

function LpBranchBar({ extra }) {
  return (
    <div className="lp__branch">
      <span className="lp__branch-icn"><Icon.GitBranch /></span>
      <span className="lp__branch-name">main</span>
      <span className="lp__branch-meta">↑0 ↓2</span>
      {extra}
    </div>
  );
}

function LpFileRow({ row }) {
  return (
    <div className={`lp__row lp__row--${row.kind}`} style={{ paddingLeft: 8 + row.depth * 14 }}>
      {row.kind === 'dir' ? (
        <span className="lp__caret">{row.open ? <Icon.ChevronDown /> : <Icon.ChevronRight />}</span>
      ) : (
        <span className="lp__caret lp__caret--ph"></span>
      )}
      <span className={`lp__row-icn lp__row-icn--${row.kind}`}>
        {row.kind === 'dir' ? <Icon.Folder /> : <Icon.FileEdit />}
      </span>
      <span className="lp__row-name">{row.name}</span>
      <span className="lp__row-tail">
        {row.issues ? <span className="lp__pip lp__pip--issue" title={`${row.issues} open issues reference this file`}>{row.issues}</span> : null}
        {row.meta ? <span className="lp__row-meta">{row.meta}</span> : null}
      </span>
    </div>
  );
}

function LpIssueRow({ it, compact }) {
  return (
    <div className={`lp__issue ${compact ? 'lp__issue--compact' : ''}`}>
      <span className={`lp__issue-tag lp__issue-tag--${it.tag}`}>{it.tag}</span>
      <span className="lp__issue-num">#{it.id}</span>
      <span className="lp__issue-title">{it.title}</span>
      <span className="lp__issue-age">{it.age}</span>
    </div>
  );
}

function LpPrRow({ pr, compact }) {
  return (
    <div className={`lp__pr ${compact ? 'lp__pr--compact' : ''}`}>
      <div className="lp__pr-head">
        <span className={`lp__pr-status lp__pr-status--${lpStatusTone[pr.status]}`}>
          <span className="lp__pr-dot"></span>
          {lpStatusLabel[pr.status]}
        </span>
        <span className="lp__pr-num">#{pr.num}</span>
        <span className="lp__pr-age">{pr.ago}</span>
      </div>
      <div className="lp__pr-title">{pr.title}</div>
      <div className="lp__pr-meta">
        <span className="lp__pr-branch"><Icon.GitBranch /> {pr.branch}</span>
        <span className="lp__pr-diff">
          <span className="lp__pr-add">+{pr.addn}</span>
          <span className="lp__pr-del">−{pr.del}</span>
        </span>
        <span className="lp__pr-comments"><Icon.Hash />{pr.comments}</span>
      </div>
    </div>
  );
}

/* ─── A. Tabs ─────────────────────────────────────────────────────── */

function LeftPaneTabs({ theme = 'refined', tab = 'files' }) {
  return (
    <div className={`theme-${theme} surface lp lp--tabs`}>
      <div className="lp__head">
        <span className="lp__head-title">xcaliber/ai-editor</span>
        <button className="lp__head-icon"><Icon.Refresh /></button>
        <button className="lp__head-icon"><Icon.Close /></button>
      </div>
      <LpBranchBar />

      <div className="lp__tabs">
        <button className={`lp__tab ${tab === 'files' ? 'lp__tab--active' : ''}`}>
          <Icon.Folder /> Files
        </button>
        <button className={`lp__tab ${tab === 'issues' ? 'lp__tab--active' : ''}`}>
          <Icon.Bug /> Issues <span className="lp__tab-count">5</span>
        </button>
        <button className={`lp__tab ${tab === 'prs' ? 'lp__tab--active' : ''}`}>
          <Icon.GitCommit /> PRs <span className="lp__tab-count">4</span>
        </button>
      </div>

      {tab === 'files' && (
        <div className="lp__pane lp__pane--files">
          <div className="lp__filter">
            <Icon.Search />
            <input placeholder="Filter files…" />
          </div>
          {lpFiles.map((r, i) => <LpFileRow key={i} row={r} />)}
        </div>
      )}
      {tab === 'issues' && (
        <div className="lp__pane">
          <div className="lp__filter">
            <Icon.Search /><input placeholder="Filter issues…" />
            <button className="lp__filter-btn"><Icon.Filter /></button>
          </div>
          {lpIssues.map(it => <LpIssueRow key={it.id} it={it} />)}
        </div>
      )}
      {tab === 'prs' && (
        <div className="lp__pane">
          <div className="lp__filter">
            <Icon.Search /><input placeholder="Filter PRs…" />
          </div>
          {lpPRs.map(pr => <LpPrRow key={pr.num} pr={pr} />)}
        </div>
      )}
    </div>
  );
}

/* ─── B. Activity rail ────────────────────────────────────────────── */

function LeftPaneRail({ theme = 'refined', view = 'files' }) {
  const items = [
    { id: 'files',    icon: <Icon.Folder />,     label: 'Files' },
    { id: 'search',   icon: <Icon.Search />,     label: 'Search' },
    { id: 'branches', icon: <Icon.GitBranch />,  label: 'Branches' },
    { id: 'issues',   icon: <Icon.Bug />,        label: 'Issues',     badge: 5 },
    { id: 'prs',      icon: <Icon.GitCommit />,  label: 'Pull Requests', badge: 4 },
    { id: 'history',  icon: <Icon.Activity />,   label: 'History' },
  ];

  const VIEWS = {
    files: (
      <>
        <div className="lp__pane-title">Files <span className="lp__pane-actions">
          <Icon.Refresh /> <Icon.Plus />
        </span></div>
        <div className="lp__filter">
          <Icon.Search /><input placeholder="Filter files…" />
        </div>
        {lpFiles.map((r, i) => <LpFileRow key={i} row={r} />)}
      </>
    ),
    issues: (
      <>
        <div className="lp__pane-title">Issues
          <span className="lp__pane-tagrow">
            <span className="lp__pill lp__pill--on">Open · 5</span>
            <span className="lp__pill">Mine · 1</span>
            <span className="lp__pill">All</span>
          </span>
        </div>
        {lpIssues.map(it => <LpIssueRow key={it.id} it={it} />)}
      </>
    ),
    prs: (
      <>
        <div className="lp__pane-title">Pull Requests
          <span className="lp__pane-tagrow">
            <span className="lp__pill lp__pill--on">Open · 4</span>
            <span className="lp__pill">Mine · 2</span>
            <span className="lp__pill">Reviewing · 1</span>
          </span>
        </div>
        {lpPRs.map(pr => <LpPrRow key={pr.num} pr={pr} />)}
      </>
    ),
    branches: (
      <>
        <div className="lp__pane-title">Branches
          <span className="lp__pane-actions"><Icon.Plus /></span>
        </div>
        <div className="lp__br-current">
          <span className="lp__br-pip"></span>
          <span className="lp__br-name">main</span>
          <span className="lp__br-meta">last commit · 2h</span>
        </div>
        <div className="lp__pane-sub">Active</div>
        {[
          { name: 'feat/virtual-diff',   meta: '↑7 ↓0', age: '12m' },
          { name: 'feat/connections',    meta: '↑11 ↓0', age: '4h'  },
          { name: 'fix/indexer-batch',   meta: '↑2 ↓4',  age: '2d'  },
        ].map(b => (
          <div key={b.name} className="lp__br-row">
            <Icon.GitBranch />
            <span className="lp__br-name">{b.name}</span>
            <span className="lp__br-meta">{b.meta}</span>
            <span className="lp__br-age">{b.age}</span>
          </div>
        ))}
      </>
    ),
  };

  return (
    <div className={`theme-${theme} surface lp lp--rail`}>
      <div className="lp__rail">
        {items.map(it => (
          <button key={it.id} className={`lp__rail-btn ${view === it.id ? 'lp__rail-btn--active' : ''}`} title={it.label}>
            {it.icon}
            {it.badge ? <span className="lp__rail-badge">{it.badge}</span> : null}
          </button>
        ))}
        <div className="lp__rail-spacer"></div>
        <button className="lp__rail-btn" title="Settings"><Icon.Settings /></button>
      </div>
      <div className="lp__rail-content">
        <div className="lp__head">
          <span className="lp__head-title">xcaliber/ai-editor</span>
          <button className="lp__head-icon"><Icon.Close /></button>
        </div>
        <LpBranchBar />
        <div className="lp__pane lp__pane--rail">{VIEWS[view] || VIEWS.files}</div>
      </div>
    </div>
  );
}

/* ─── C. Workbench (the bet) ──────────────────────────────────────── */
/* One stream organized by what's *active* on this branch. Issues badge
   the files they reference; PRs surface as cards with a "review" CTA. */

function LeftPaneWorkbench({ theme = 'refined' }) {
  return (
    <div className={`theme-${theme} surface lp lp--bench`}>
      <div className="lp__head">
        <span className="lp__head-title">xcaliber/ai-editor</span>
        <button className="lp__head-icon"><Icon.Refresh /></button>
        <button className="lp__head-icon"><Icon.Close /></button>
      </div>
      <LpBranchBar extra={<button className="lp__branch-switch">switch</button>} />

      <div className="lp__bench-scroll">

        {/* Active PR you're reviewing */}
        <div className="lp__bench-section">
          <div className="lp__bench-h">
            <span>Reviewing</span>
            <span className="lp__bench-h-count">1</span>
          </div>
          <div className="lp__bench-card lp__bench-card--pr">
            <div className="lp__pr-head">
              <span className="lp__pr-status lp__pr-status--pip"><span className="lp__pr-dot"></span>Awaiting your review</span>
              <span className="lp__pr-num">#84</span>
            </div>
            <div className="lp__pr-title">Refactor diff renderer to virtual-scroll</div>
            <div className="lp__bench-card-actions">
              <button className="lp__bench-btn lp__bench-btn--primary">Open review</button>
              <button className="lp__bench-btn">Diff</button>
            </div>
          </div>
        </div>

        {/* Your work in progress */}
        <div className="lp__bench-section">
          <div className="lp__bench-h">
            <span>Your work</span>
            <span className="lp__bench-h-meta">main · 4 changed</span>
          </div>
          <div className="lp__bench-changes">
            <div className="lp__change-row"><span className="lp__change-mark lp__change-mark--m">M</span><span>js/editor.js</span><span className="lp__change-stat">+24 −3</span></div>
            <div className="lp__change-row"><span className="lp__change-mark lp__change-mark--m">M</span><span>css/sidebar.css</span><span className="lp__change-stat">+8 −2</span></div>
            <div className="lp__change-row"><span className="lp__change-mark lp__change-mark--a">A</span><span>js/diff.js</span><span className="lp__change-stat">+212 −0</span></div>
            <div className="lp__change-row"><span className="lp__change-mark lp__change-mark--m">M</span><span>index.html</span><span className="lp__change-stat">+1 −1</span></div>
            <button className="lp__bench-stage">Stage all & commit…</button>
          </div>
        </div>

        {/* Open issues, but threaded into files */}
        <div className="lp__bench-section">
          <div className="lp__bench-h">
            <span>On this branch</span>
            <span className="lp__bench-h-meta">issues touching files you've edited</span>
          </div>
          <div className="lp__bench-card lp__bench-card--issue">
            <div className="lp__issue-row-1">
              <span className="lp__issue-tag lp__issue-tag--bug">bug</span>
              <span className="lp__issue-num">#142</span>
              <span className="lp__issue-age">2h</span>
            </div>
            <div className="lp__issue-title-bench">Diff view scrolls horizontally on long lines</div>
            <div className="lp__issue-files">
              <Icon.Link /> <code>js/editor.js</code>
            </div>
          </div>
          <div className="lp__bench-card lp__bench-card--issue">
            <div className="lp__issue-row-1">
              <span className="lp__issue-tag lp__issue-tag--bug">bug</span>
              <span className="lp__issue-num">#131</span>
              <span className="lp__issue-age">3d</span>
            </div>
            <div className="lp__issue-title-bench">Memory viewer flickers when chat scrolls</div>
            <div className="lp__issue-files">
              <Icon.Link /> <code>js/memory.js</code> · <code>css/memory.css</code>
            </div>
          </div>
        </div>

        {/* Files — collapsible at the bottom; you don't always need it */}
        <div className="lp__bench-section">
          <div className="lp__bench-h">
            <span>Files</span>
            <span className="lp__bench-h-meta">128 · search ⌘K</span>
          </div>
          {lpFiles.slice(0, 8).map((r, i) => <LpFileRow key={i} row={r} />)}
          <button className="lp__bench-more">Show all 128 files</button>
        </div>

      </div>
    </div>
  );
}

Object.assign(window, { LeftPaneTabs, LeftPaneRail, LeftPaneWorkbench });
