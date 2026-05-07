/* Left pane v2 — rail as the chassis (B was the right answer), but built
   around the actual ai-editor workflow:
     click ticket → ▶ Start → agent works → PR opens.
   New verbs on the rail: Tasks (in-flight agents), Releases (AI notes).
   Files get hover-actions (new file/dir, rename, delete).
   Branch dropdown is real now: switch, new, with inline release CTA.
*/

const lp2Files = [
  { kind: 'dir',  depth: 0, name: 'css', open: true },
  { kind: 'file', depth: 1, name: 'base.css' },
  { kind: 'file', depth: 1, name: 'sidebar.css', meta: 'M' },
  { kind: 'dir',  depth: 0, name: 'js', open: true },
  { kind: 'file', depth: 1, name: 'app.js' },
  { kind: 'file', depth: 1, name: 'editor.js', meta: 'M' },
  { kind: 'file', depth: 1, name: 'memory.js' },
  { kind: 'file', depth: 0, name: 'index.html' },
  { kind: 'file', depth: 0, name: 'README.md' },
];

const lp2Issues = [
  { id: 142, title: 'Diff view scrolls horizontally on long lines', tag: 'bug',  age: '2h', state: 'open' },
  { id: 138, title: 'Add keyboard shortcut for "open recent"',      tag: 'feat', age: '1d', state: 'open' },
  { id: 131, title: 'Memory viewer flickers when chat scrolls',     tag: 'bug',  age: '3d', state: 'running', agent: 'Coder' },
  { id: 127, title: 'Settings: timezone selector defaults to UTC',  tag: 'nit',  age: '4d', state: 'open' },
  { id: 119, title: 'Plugin loader silently swallows manifest errors', tag: 'bug', age: '1w', state: 'pr', pr: 84 },
];

const lp2Tasks = [
  { id: 't1', issue: 131, title: 'Memory viewer flickers when chat scrolls', agent: 'Coder · Qwen 3', step: 'Editing js/memory.js', pct: 62, started: '4m', tokens: '12.4k' },
  { id: 't2', issue: 145, title: 'Add "Mark all viewed" to PR file tree',    agent: 'Coder · Qwen 3', step: 'Awaiting test run', pct: 88, started: '11m', tokens: '28.1k' },
  { id: 't3', issue: 119, title: 'Plugin loader silently swallows…',         agent: 'Coder · Qwen 3', step: 'Opened PR #84', pct: 100, started: '2h', tokens: '54.0k', done: true },
];

const lp2Branches = [
  { name: 'main',                current: true,  ahead: 0, behind: 0, age: '2h', protected: true },
  { name: 'feat/virtual-diff',   ahead: 7, behind: 0,  age: '12m', pr: 84 },
  { name: 'feat/connections',    ahead: 11, behind: 0, age: '4h',  pr: 81 },
  { name: 'fix/indexer-batch',   ahead: 2, behind: 4,  age: '2d',  pr: 76, conflict: true },
  { name: 'agent/issue-131',     ahead: 3, behind: 0,  age: '4m',  agent: true },
];

const lp2Releases = [
  { tag: 'v1.9.0', date: '3 days ago', commits: 47, prs: 9, current: true },
  { tag: 'v1.8.2', date: '2 weeks ago', commits: 18, prs: 3 },
  { tag: 'v1.8.1', date: '3 weeks ago', commits: 6,  prs: 2 },
];

/* ─── Files view with action header + hover-actions ──────────────── */

function Lp2Files() {
  return (
    <>
      <div className="lp2__pane-h">
        <span className="lp2__pane-title">Files</span>
        <span className="lp2__pane-h-actions">
          <button title="New file"><Icon.Plus /></button>
          <button title="New folder"><Icon.Folder /></button>
          <button title="Refresh"><Icon.Refresh /></button>
          <button title="Collapse all"><Icon.ChevronDown /></button>
        </span>
      </div>
      <div className="lp__filter">
        <Icon.Search /><input placeholder="Filter files…" />
      </div>

      {/* "Now" strip — the workbench idea, kept tiny so it doesn't get in the way */}
      <div className="lp2__now">
        <div className="lp2__now-row">
          <span className="lp2__now-label">Changes</span>
          <span className="lp2__now-val">4 files</span>
          <button className="lp2__now-link">Stage…</button>
        </div>
        <div className="lp2__now-row">
          <span className="lp2__now-label">Agent</span>
          <span className="lp2__now-val lp2__now-val--run">●</span>
          <span className="lp2__now-val">2 running</span>
          <button className="lp2__now-link">View tasks</button>
        </div>
      </div>

      <div className="lp2__pane-sub">Tree</div>
      {lp2Files.map((r, i) => (
        <div key={i} className={`lp__row lp__row--${r.kind} lp2__row`} style={{ paddingLeft: 8 + r.depth * 14 }}>
          {r.kind === 'dir'
            ? <span className="lp__caret">{r.open ? <Icon.ChevronDown /> : <Icon.ChevronRight />}</span>
            : <span className="lp__caret lp__caret--ph"></span>}
          <span className={`lp__row-icn lp__row-icn--${r.kind}`}>
            {r.kind === 'dir' ? <Icon.Folder /> : <Icon.FileEdit />}
          </span>
          <span className="lp__row-name">{r.name}</span>
          <span className="lp2__row-hover">
            <button title="New in folder"><Icon.Plus /></button>
            <button title="Rename"><Icon.FileEdit /></button>
            <button title="Delete"><Icon.X /></button>
          </span>
          {r.meta ? <span className="lp__row-meta">{r.meta}</span> : null}
        </div>
      ))}
    </>
  );
}

/* ─── Issues view with prominent ▶ Start ─────────────────────────── */

function Lp2Issues() {
  return (
    <>
      <div className="lp2__pane-h">
        <span className="lp2__pane-title">Issues</span>
        <span className="lp2__pane-h-actions">
          <button title="New issue"><Icon.Plus /></button>
          <button title="Refresh"><Icon.Refresh /></button>
        </span>
      </div>
      <div className="lp__filter">
        <Icon.Search /><input placeholder="Filter issues…" />
      </div>
      <div className="lp2__chips">
        <span className="lp__pill lp__pill--on">Open · 5</span>
        <span className="lp__pill">Mine · 1</span>
        <span className="lp__pill">In progress · 2</span>
      </div>

      {lp2Issues.map(it => (
        <div key={it.id} className={`lp2__issue lp2__issue--${it.state}`}>
          <div className="lp2__issue-head">
            <span className={`lp__issue-tag lp__issue-tag--${it.tag}`}>{it.tag}</span>
            <span className="lp__issue-num">#{it.id}</span>
            {it.state === 'running' && <span className="lp2__issue-state lp2__issue-state--run"><span className="lp2__pulse"></span>{it.agent}</span>}
            {it.state === 'pr'      && <span className="lp2__issue-state lp2__issue-state--pr">→ PR #{it.pr}</span>}
            <span className="lp__issue-age">{it.age}</span>
          </div>
          <div className="lp2__issue-title">{it.title}</div>
          {it.state === 'open' && (
            <div className="lp2__issue-actions">
              <button className="lp2__start"><Icon.Play /> Start</button>
              <button className="lp2__sec">Open</button>
            </div>
          )}
          {it.state === 'running' && (
            <div className="lp2__issue-actions">
              <button className="lp2__sec">View task</button>
              <button className="lp2__sec lp2__sec--danger">Cancel</button>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

/* ─── Tasks view: the agent loop made visible ────────────────────── */

function Lp2Tasks() {
  return (
    <>
      <div className="lp2__pane-h">
        <span className="lp2__pane-title">Tasks</span>
        <span className="lp2__pane-h-actions">
          <button title="New from issue"><Icon.Plus /></button>
        </span>
      </div>
      <div className="lp2__chips">
        <span className="lp__pill lp__pill--on">Running · 2</span>
        <span className="lp__pill">Done · 1</span>
        <span className="lp__pill">All</span>
      </div>

      {lp2Tasks.map(t => (
        <div key={t.id} className={`lp2__task ${t.done ? 'lp2__task--done' : ''}`}>
          <div className="lp2__task-head">
            <span className={`lp2__task-pip ${t.done ? 'lp2__task-pip--done' : 'lp2__task-pip--run'}`}>
              {t.done ? '✓' : <span className="lp2__pulse"></span>}
            </span>
            <span className="lp2__task-link">#{t.issue}</span>
            <span className="lp2__task-age">{t.started}</span>
          </div>
          <div className="lp2__task-title">{t.title}</div>
          <div className="lp2__task-step">{t.step}</div>
          <div className="lp2__task-bar">
            <span style={{ width: t.pct + '%' }}></span>
          </div>
          <div className="lp2__task-foot">
            <span className="lp2__task-agent">{t.agent}</span>
            <span className="lp2__task-tok">{t.tokens}</span>
          </div>
          {!t.done && (
            <div className="lp2__task-actions">
              <button className="lp2__sec">Watch</button>
              <button className="lp2__sec">Pause</button>
              <button className="lp2__sec lp2__sec--danger">Cancel</button>
            </div>
          )}
          {t.done && (
            <div className="lp2__task-actions">
              <button className="lp2__start"><Icon.GitCommit /> Open PR</button>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

/* ─── Branches view: actually interactive ────────────────────────── */

function Lp2Branches() {
  return (
    <>
      <div className="lp2__pane-h">
        <span className="lp2__pane-title">Branches</span>
        <span className="lp2__pane-h-actions">
          <button title="New branch"><Icon.Plus /></button>
          <button title="Refresh"><Icon.Refresh /></button>
        </span>
      </div>
      <div className="lp__filter">
        <Icon.Search /><input placeholder="Filter branches…" />
      </div>

      {lp2Branches.map(b => (
        <div key={b.name} className={`lp2__br ${b.current ? 'lp2__br--current' : ''}`}>
          <div className="lp2__br-row1">
            <Icon.GitBranch />
            <span className="lp2__br-name">{b.name}</span>
            {b.protected && <span className="lp2__br-tag">main</span>}
            {b.agent && <span className="lp2__br-tag lp2__br-tag--agent">agent</span>}
            {b.pr && <span className="lp2__br-tag lp2__br-tag--pr">#{b.pr}</span>}
            {b.conflict && <span className="lp2__br-tag lp2__br-tag--warn">conflict</span>}
            <span className="lp2__br-age">{b.age}</span>
          </div>
          <div className="lp2__br-row2">
            <span className="lp2__br-meta">↑{b.ahead} ↓{b.behind}</span>
            <span className="lp2__br-actions">
              {!b.current && <button className="lp2__sec">Switch</button>}
              {b.current && <button className="lp2__start"><Icon.Box /> Cut release</button>}
              {!b.current && !b.protected && <button className="lp2__sec lp2__sec--danger">Delete</button>}
            </span>
          </div>
        </div>
      ))}
    </>
  );
}

/* ─── Releases view with AI release notes draft ──────────────────── */

function Lp2Releases() {
  return (
    <>
      <div className="lp2__pane-h">
        <span className="lp2__pane-title">Releases</span>
        <span className="lp2__pane-h-actions">
          <button title="Draft release"><Icon.Plus /></button>
        </span>
      </div>

      <div className="lp2__rel-draft">
        <div className="lp2__rel-draft-h">
          <Icon.Sparkles />
          <span>Draft v1.9.1</span>
          <span className="lp2__rel-draft-meta">3 PRs since v1.9.0</span>
        </div>
        <div className="lp2__rel-draft-notes">
          AI-generated notes from <code>v1.9.0..main</code>
        </div>
        <div className="lp2__rel-draft-actions">
          <button className="lp2__start"><Icon.Sparkles /> Generate notes</button>
          <button className="lp2__sec">Review</button>
        </div>
      </div>

      <div className="lp2__pane-sub">Published</div>
      {lp2Releases.map(r => (
        <div key={r.tag} className="lp2__rel">
          <div className="lp2__rel-h">
            <Icon.Box />
            <span className="lp2__rel-tag">{r.tag}</span>
            {r.current && <span className="lp2__br-tag lp2__br-tag--ok">latest</span>}
            <span className="lp__issue-age">{r.date}</span>
          </div>
          <div className="lp2__rel-meta">{r.commits} commits · {r.prs} PRs</div>
        </div>
      ))}
    </>
  );
}

/* ─── PRs view (kept simple — full review lives in main editor) ──── */

function Lp2PRs() {
  return (
    <>
      <div className="lp2__pane-h">
        <span className="lp2__pane-title">Pull Requests</span>
        <span className="lp2__pane-h-actions">
          <button title="New PR"><Icon.Plus /></button>
          <button title="Refresh"><Icon.Refresh /></button>
        </span>
      </div>
      <div className="lp2__chips">
        <span className="lp__pill lp__pill--on">Open · 4</span>
        <span className="lp__pill">Mine · 2</span>
        <span className="lp__pill">Reviewing · 1</span>
        <span className="lp__pill lp__pill--accent">From agents · 1</span>
      </div>
      {lpPRs.map(pr => <LpPrRow key={pr.num} pr={pr} />)}
    </>
  );
}

/* ─── Top-level rail v2 ──────────────────────────────────────────── */

function LeftPaneRailV2({ theme = 'refined', view = 'tasks' }) {
  const items = [
    { id: 'files',    icon: <Icon.Folder />,    label: 'Files' },
    { id: 'search',   icon: <Icon.Search />,    label: 'Search' },
    { id: 'tasks',    icon: <Icon.Sparkles />,  label: 'Tasks',     badge: 2, hot: true },
    { id: 'issues',   icon: <Icon.Bug />,       label: 'Issues',    badge: 5 },
    { id: 'prs',      icon: <Icon.GitCommit />, label: 'Pull Requests', badge: 4 },
    { id: 'branches', icon: <Icon.GitBranch />, label: 'Branches' },
    { id: 'releases', icon: <Icon.Box />,       label: 'Releases' },
  ];

  const VIEWS = {
    files: <Lp2Files />,
    issues: <Lp2Issues />,
    tasks: <Lp2Tasks />,
    branches: <Lp2Branches />,
    releases: <Lp2Releases />,
    prs: <Lp2PRs />,
  };

  return (
    <div className={`theme-${theme} surface lp lp--rail lp2`}>
      <div className="lp__rail">
        {items.map(it => (
          <button key={it.id} className={`lp__rail-btn ${view === it.id ? 'lp__rail-btn--active' : ''}`} title={it.label}>
            {it.icon}
            {it.badge ? <span className={`lp__rail-badge ${it.hot ? 'lp__rail-badge--hot' : ''}`}>{it.badge}</span> : null}
          </button>
        ))}
        <div className="lp__rail-spacer"></div>
        <button className="lp__rail-btn" title="Settings"><Icon.Settings /></button>
      </div>

      <div className="lp__rail-content">
        {/* Real branch switcher up top — not static */}
        <div className="lp2__branchbar">
          <button className="lp2__branchbar-btn">
            <Icon.GitBranch />
            <span className="lp2__branchbar-name">main</span>
            <span className="lp2__branchbar-meta">↑0 ↓2</span>
            <Icon.ChevronDown />
          </button>
          <button className="lp2__branchbar-icon" title="Pull"><Icon.Refresh /></button>
        </div>

        <div className="lp__pane lp__pane--rail lp2__pane">
          {VIEWS[view] || VIEWS.files}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { LeftPaneRailV2 });
