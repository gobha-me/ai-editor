/* PR Review surface — full takeover of the editor area when you open a PR.
   The pain point: today, "really reviewing" a PR means leaving for the repo BE.
   So we put it all here. Tabs: Conversation · Files · Commits · Checks.
   Files tab is the meat: file tree of changes, side-by-side diff, inline threads.
*/

const prMeta = {
  num: 84,
  title: 'Refactor diff renderer to virtual-scroll',
  branch: 'feat/virtual-diff',
  base: 'main',
  author: 'jules',
  status: 'review',
  addn: 412,
  del: 188,
  files: 9,
  commits: 6,
  comments: 14,
  ago: '12 minutes ago',
};

const prChangedFiles = [
  { path: 'js/editor.js',          add: 84,  del: 42, status: 'M', threads: 3, viewed: true  },
  { path: 'js/diff.js',            add: 212, del: 0,  status: 'A', threads: 4, viewed: false },
  { path: 'js/diff-virtual.js',    add: 96,  del: 0,  status: 'A', threads: 1, viewed: false, active: true },
  { path: 'js/diff-legacy.js',     add: 0,   del: 124, status: 'D', threads: 0, viewed: true  },
  { path: 'css/editor.css',        add: 12,  del: 18, status: 'M', threads: 2, viewed: false },
  { path: 'css/diff.css',          add: 4,   del: 4,  status: 'M', threads: 0, viewed: false },
  { path: 'tests/diff.spec.js',    add: 0,   del: 0,  status: 'R', threads: 0, viewed: false, renamed: 'tests/diff-renderer.spec.js' },
  { path: 'docs/diff.md',          add: 4,   del: 0,  status: 'M', threads: 0, viewed: false },
];

/* A short, focused side-by-side diff for one file. */
const prDiffHunks = [
  {
    header: '@@ -0,0 +1,18 @@   js/diff-virtual.js',
    rows: [
      { l: '',  r: '1',  lcode: '',                                         rcode: 'import { measure } from "./editor.js";',         lk: 'add' },
      { l: '',  r: '2',  lcode: '',                                         rcode: '',                                                lk: 'add' },
      { l: '',  r: '3',  lcode: '',                                         rcode: 'export class VirtualDiff {',                       lk: 'add' },
      { l: '',  r: '4',  lcode: '',                                         rcode: '  constructor(host, opts = {}) {',                 lk: 'add' },
      { l: '',  r: '5',  lcode: '',                                         rcode: '    this.host = host;',                            lk: 'add' },
      { l: '',  r: '6',  lcode: '',                                         rcode: '    this.rowH = opts.rowH ?? measure().lineH;',    lk: 'add' },
      { l: '',  r: '7',  lcode: '',                                         rcode: '    this.buf  = opts.buf  ?? 24;',                 lk: 'add' },
      { l: '',  r: '8',  lcode: '',                                         rcode: '  }',                                              lk: 'add' },
      { thread: { author: 'priya', body: 'Should rowH react to font-size changes? today it\'s captured once on construct.' } },
      { l: '',  r: '9',  lcode: '',                                         rcode: '  mount(rows) {',                                  lk: 'add' },
      { l: '',  r: '10', lcode: '',                                         rcode: '    this.rows = rows;',                            lk: 'add' },
      { l: '',  r: '11', lcode: '',                                         rcode: '    this.host.style.height = (rows.length * this.rowH) + "px";', lk: 'add' },
      { l: '',  r: '12', lcode: '',                                         rcode: '    this.host.addEventListener("scroll", this.onScroll);',       lk: 'add' },
      { l: '',  r: '13', lcode: '',                                         rcode: '    this.render();',                               lk: 'add' },
      { l: '',  r: '14', lcode: '',                                         rcode: '  }',                                              lk: 'add' },
    ]
  },
];

const prComments = [
  {
    author: 'priya', role: 'reviewer', when: '8m', file: 'js/diff-virtual.js', line: 8,
    body: 'Should rowH react to font-size changes? today it\'s captured once on construct. If a user bumps font, the row math goes stale.',
    replies: [
      { author: 'jules', when: '5m', body: 'Good catch — wiring it to a ResizeObserver on host. Push in a sec.' }
    ],
    resolved: false,
  },
  {
    author: 'priya', role: 'reviewer', when: '7m', file: 'js/diff.js', line: 142,
    body: 'Worth pulling the chunker into its own module so we can test it without mounting?',
    replies: [],
    resolved: false,
  },
  {
    author: 'wei', role: 'reviewer', when: '11m', file: 'js/editor.js', line: 304,
    body: 'Why drop the legacy path immediately? Could we keep it behind a flag for a release?',
    replies: [
      { author: 'jules', when: '10m', body: 'Fair. Adding `editor.useLegacyDiff` setting; defaults to off.' }
    ],
    resolved: true,
  },
];

function PrAvatar({ who, size = 24 }) {
  const initials = who.slice(0, 2).toUpperCase();
  return <span className="pr__avatar" style={{ width: size, height: size, fontSize: size * 0.42 }}>{initials}</span>;
}

function PrFileRow({ f, active }) {
  const cls = `pr__file-row ${active ? 'pr__file-row--active' : ''} ${f.viewed ? 'pr__file-row--viewed' : ''}`;
  return (
    <div className={cls}>
      <span className={`pr__file-mark pr__file-mark--${f.status.toLowerCase()}`}>{f.status}</span>
      <span className="pr__file-path">{f.path}</span>
      <span className="pr__file-tail">
        {f.threads ? <span className="pr__file-threads"><Icon.Hash />{f.threads}</span> : null}
        {f.add ? <span className="pr__file-add">+{f.add}</span> : null}
        {f.del ? <span className="pr__file-del">−{f.del}</span> : null}
      </span>
    </div>
  );
}

function PrTopBar({ tab, onTab }) {
  return (
    <div className="pr__topbar">
      <button className="pr__back"><Icon.ChevronRight style={{ transform: 'rotate(180deg)' }} /> PRs</button>
      <span className={`pr__status pr__status--review`}>
        <span className="pr__status-dot"></span> In review
      </span>
      <span className="pr__num">#{prMeta.num}</span>
      <h1 className="pr__title-inline">{prMeta.title}</h1>

      <div className="pr__topbar-actions">
        <button className="pr__btn">Checkout</button>
        <button className="pr__btn pr__btn--primary"><Icon.ListChecks /> Review</button>
      </div>
    </div>
  );
}

function PrTabs({ tab, onTab }) {
  const tabs = [
    { id: 'conversation', label: 'Conversation', count: prMeta.comments, icon: <Icon.Hash /> },
    { id: 'files',        label: 'Files',        count: prMeta.files,    icon: <Icon.FileEdit /> },
    { id: 'commits',      label: 'Commits',      count: prMeta.commits,  icon: <Icon.GitCommit /> },
    { id: 'checks',       label: 'Checks',       count: 4, ok: true,     icon: <Icon.Activity /> },
  ];
  return (
    <div className="pr__tabs">
      {tabs.map(t => (
        <button key={t.id} className={`pr__tab ${tab === t.id ? 'pr__tab--active' : ''}`}>
          {t.icon}
          <span>{t.label}</span>
          <span className={`pr__tab-count ${t.ok ? 'pr__tab-count--ok' : ''}`}>{t.count}</span>
        </button>
      ))}
      <span className="pr__branch-trail">
        <code>{prMeta.branch}</code> <span>→</span> <code>{prMeta.base}</code>
      </span>
    </div>
  );
}

/* AI summary banner — distinguishing feature for an *AI* editor */
function PrAiSummary() {
  return (
    <div className="pr__ai">
      <div className="pr__ai-head">
        <span className="pr__ai-mark"><Icon.Sparkles /></span>
        <span className="pr__ai-title">AI review summary</span>
        <span className="pr__ai-meta">Coder · 4.2k tokens · regenerate</span>
      </div>
      <div className="pr__ai-body">
        <p>Replaces the current line-by-line diff renderer with a virtualized one. Hot path is <code>js/diff-virtual.js</code>; <code>js/diff.js</code> is now a thin wrapper. Legacy renderer is kept behind a settings flag (good — see #76 thread).</p>
        <ul className="pr__ai-points">
          <li><span className="pr__ai-pip pr__ai-pip--ok"></span> Reduces diff render time on 5k-line files from ~480ms → ~38ms (per included bench).</li>
          <li><span className="pr__ai-pip pr__ai-pip--warn"></span> <code>rowH</code> is captured once on construct — won't follow font-size changes. Reviewer flagged this.</li>
          <li><span className="pr__ai-pip pr__ai-pip--info"></span> No tests for the chunker. Worth extracting before merge.</li>
        </ul>
      </div>
    </div>
  );
}

/* Files-tab body: tree + diff + comment thread on one row */
function PrFilesView() {
  return (
    <div className="pr__files">
      <div className="pr__filetree">
        <div className="pr__filetree-head">
          <span>Changed files</span>
          <span className="pr__filetree-count">{prMeta.files}</span>
        </div>
        <div className="pr__filetree-filter">
          <Icon.Search /><input placeholder="Filter" />
        </div>
        <div className="pr__filetree-list">
          {prChangedFiles.map((f, i) => <PrFileRow key={i} f={f} active={f.active} />)}
        </div>
        <div className="pr__filetree-foot">
          <label className="pr__viewed">
            <input type="checkbox" /> Mark all viewed
          </label>
          <span className="pr__viewed-count">2 / {prMeta.files} viewed</span>
        </div>
      </div>

      <div className="pr__diff">
        <div className="pr__diff-head">
          <span className="pr__file-mark pr__file-mark--a">A</span>
          <span className="pr__diff-path">js/diff-virtual.js</span>
          <span className="pr__diff-stat">
            <span className="pr__file-add">+96</span><span className="pr__file-del">−0</span>
          </span>
          <div className="pr__diff-actions">
            <div className="pr__diff-modeswitch">
              <button className="pr__diff-mode pr__diff-mode--active">Split</button>
              <button className="pr__diff-mode">Unified</button>
            </div>
            <button className="pr__diff-iconbtn" title="View whole file"><Icon.Eye /></button>
            <button className="pr__diff-iconbtn" title="Open in editor"><Icon.Code /></button>
            <label className="pr__viewed pr__viewed--inline">
              <input type="checkbox" /> Viewed
            </label>
          </div>
        </div>

        {prDiffHunks.map((h, i) => (
          <div key={i} className="pr__hunk">
            <div className="pr__hunk-header">{h.header}</div>
            <div className="pr__hunk-body pr__hunk-body--split">
              {h.rows.map((row, j) => {
                if (row.thread) {
                  return (
                    <div key={j} className="pr__hunk-thread">
                      <PrAvatar who="priya" size={20} />
                      <div className="pr__hunk-thread-body">
                        <span className="pr__hunk-thread-meta">priya · 8m</span>
                        <p>{row.thread.body}</p>
                        <div className="pr__hunk-thread-actions">
                          <button className="pr__btn-ghost">Reply</button>
                          <button className="pr__btn-ghost">Resolve</button>
                          <button className="pr__btn-ghost"><Icon.Sparkles /> Suggest fix</button>
                        </div>
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={j} className={`pr__diff-row pr__diff-row--${row.lk}`}>
                    <span className="pr__diff-num">{row.l}</span>
                    <span className="pr__diff-code pr__diff-code--l">{row.lcode}</span>
                    <span className="pr__diff-num">{row.r}</span>
                    <span className="pr__diff-code pr__diff-code--r">
                      {row.rk === 'add' || row.lk === 'add' ? <span className="pr__diff-bg pr__diff-bg--add"></span> : null}
                      {row.rcode}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        <div className="pr__hunk-collapsed">
          <Icon.More /> 4 more hunks · 81 lines
        </div>
      </div>
    </div>
  );
}

/* Conversation-tab body */
function PrConversationView() {
  return (
    <div className="pr__convo">
      <PrAiSummary />

      <div className="pr__convo-event">
        <PrAvatar who="jules" />
        <div className="pr__convo-evbody">
          <div className="pr__convo-evhead">
            <strong>jules</strong> opened this pull request <span>{prMeta.ago}</span>
          </div>
          <div className="pr__convo-evcard">
            <p>Replaces the diff renderer with a virtualized window so 5k-line files don't lock the editor. Behind a setting; legacy path stays. Bench attached.</p>
            <p><strong>Closes</strong> #142, <strong>part of</strong> #119.</p>
          </div>
        </div>
      </div>

      {prComments.map((c, i) => (
        <div key={i} className={`pr__convo-event ${c.resolved ? 'pr__convo-event--resolved' : ''}`}>
          <PrAvatar who={c.author} />
          <div className="pr__convo-evbody">
            <div className="pr__convo-evhead">
              <strong>{c.author}</strong> commented on <code>{c.file}:{c.line}</code> <span>{c.when}</span>
              {c.resolved && <span className="pr__resolved-tag">resolved</span>}
            </div>
            <div className="pr__convo-evcard">
              <p>{c.body}</p>
              {c.replies.map((r, j) => (
                <div key={j} className="pr__convo-reply">
                  <PrAvatar who={r.author} size={20} />
                  <div>
                    <div className="pr__convo-evhead"><strong>{r.author}</strong> <span>{r.when}</span></div>
                    <p>{r.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}

      <div className="pr__convo-event pr__convo-event--system">
        <span className="pr__convo-syspip"><Icon.GitCommit /></span>
        <div>jules pushed 3 commits · added <code>useLegacyDiff</code> setting</div>
        <span className="pr__convo-sysago">3m</span>
      </div>
    </div>
  );
}

/* The review dock — sticky bottom on every tab */
function PrReviewDock() {
  return (
    <div className="pr__dock">
      <div className="pr__dock-left">
        <span className="pr__dock-pending">3 pending comments</span>
        <span className="pr__dock-sep">·</span>
        <span className="pr__dock-meta">12 of 14 threads addressed</span>
      </div>
      <div className="pr__dock-actions">
        <button className="pr__btn">Comment</button>
        <button className="pr__btn pr__btn--warn">Request changes</button>
        <button className="pr__btn pr__btn--ok">Approve</button>
        <button className="pr__btn pr__btn--primary">Submit review</button>
      </div>
    </div>
  );
}

/* Top-level surface */
function PrReview({ theme = 'refined', tab = 'files' }) {
  return (
    <div className={`theme-${theme} surface pr`}>
      <PrTopBar tab={tab} />
      <PrTabs tab={tab} />
      <div className="pr__tab-body">
        {tab === 'files'        && <PrFilesView />}
        {tab === 'conversation' && <PrConversationView />}
      </div>
      <PrReviewDock />
    </div>
  );
}

Object.assign(window, { PrReview });
