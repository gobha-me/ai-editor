/* Zip Up / Zip Down in v2 chrome.
   Three scopes, three homes:
     1. Project zip   → in the Project switcher menu (next to brand)
     2. Branch zip    → in the Branches view in the rail (sibling to Cut release)
     3. Session zip   → on session tabs (right-click) — a session snapshot
   Plus: a refined Upload Zip modal that keeps today's killer features
     (selectable file list, diff scan, target dir, commit message) in v2's visual language.
*/

/* ── 1. Project switcher menu ──────────────────────────────────── */

function ZipProjectMenu({ theme = 'refined' }) {
  return (
    <div className={`theme-${theme} surface zip-demo`}>
      <div className="zip-demo__hint">Click the project switcher in the top bar</div>
      <div className="zip-demo__anchor">
        <button className="w2__proj zip-demo__open"><Icon.Box /> xcaliber/ai-editor <Icon.ChevronDown /></button>
        <div className="zip-menu">
          <div className="zip-menu__sec">Projects</div>
          <button className="zip-menu__row zip-menu__row--active"><Icon.Box /> xcaliber/ai-editor <span className="zip-menu__meta">main</span></button>
          <button className="zip-menu__row"><Icon.Box /> xcaliber/gobha <span className="zip-menu__meta">main</span></button>
          <button className="zip-menu__row"><Icon.Box /> xcaliber/diem <span className="zip-menu__meta">feat/billing</span></button>
          <div className="zip-menu__div"></div>
          <div className="zip-menu__sec">Bring in</div>
          <button className="zip-menu__row"><Icon.Plus /> Clone from URL… <span className="zip-menu__meta">git</span></button>
          <button className="zip-menu__row zip-menu__row--accent"><Icon.Box /> Import from .zip… <span className="zip-menu__meta">batch commit</span></button>
          <div className="zip-menu__div"></div>
          <div className="zip-menu__sec">Take out</div>
          <button className="zip-menu__row"><Icon.Box /> Export project as .zip <span className="zip-menu__meta">all branches</span></button>
          <button className="zip-menu__row"><Icon.Box /> Export branch as .zip <span className="zip-menu__meta">main · current</span></button>
        </div>
      </div>
      <div className="zip-demo__caption">Whole-repo zip lives here. Project-level affordance, project-level menu.</div>
    </div>
  );
}

/* ── 2. Branches view with zip actions ─────────────────────────── */

function ZipBranchesView({ theme = 'refined' }) {
  return (
    <div className={`theme-${theme} surface zip-demo zip-demo--rail`}>
      <div className="lp lp--rail lp2" style={{ height: '100%' }}>
        <div className="lp__rail">
          <button className="lp__rail-btn"><Icon.Folder /></button>
          <button className="lp__rail-btn"><Icon.Bug /></button>
          <button className="lp__rail-btn lp__rail-btn--active"><Icon.GitBranch /></button>
        </div>
        <div className="lp__rail-content">
          <div className="lp__pane lp__pane--rail lp2__pane">
            <div className="lp2__pane-h">
              <span className="lp2__pane-title">Branches</span>
              <span className="lp2__pane-h-actions">
                <button title="New branch"><Icon.Plus /></button>
                <button title="Import .zip into new branch"><Icon.Box /></button>
              </span>
            </div>
            <div className="lp__filter"><Icon.Search /><input placeholder="Filter branches…" /></div>

            <div className="lp2__br lp2__br--current">
              <div className="lp2__br-row1">
                <Icon.GitBranch />
                <span className="lp2__br-name">main</span>
                <span className="lp2__br-tag">main</span>
                <span className="lp2__br-age">2h</span>
              </div>
              <div className="lp2__br-row2">
                <span className="lp2__br-meta">↑0 ↓2</span>
                <span className="lp2__br-actions">
                  <button className="lp2__sec" title="Export branch as .zip"><Icon.Box /></button>
                  <button className="lp2__start"><Icon.Box /> Cut release</button>
                </span>
              </div>
            </div>

            <div className="lp2__br">
              <div className="lp2__br-row1">
                <Icon.GitBranch />
                <span className="lp2__br-name">feat/virtual-diff</span>
                <span className="lp2__br-tag lp2__br-tag--pr">#84</span>
                <span className="lp2__br-age">12m</span>
              </div>
              <div className="lp2__br-row2">
                <span className="lp2__br-meta">↑7 ↓0</span>
                <span className="lp2__br-actions">
                  <button className="lp2__sec" title="Export as .zip"><Icon.Box /></button>
                  <button className="lp2__sec">Switch</button>
                </span>
              </div>
            </div>

            {/* Drop zone shows up when a .zip is being dragged anywhere over the window */}
            <div className="zip-drop">
              <div className="zip-drop__icon"><Icon.Box /></div>
              <div className="zip-drop__title">Drop .zip to import as new branch</div>
              <div className="zip-drop__sub">batch commit · auto-named from file</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── 3. Session tab context menu ──────────────────────────────── */

function ZipSessionMenu({ theme = 'refined' }) {
  return (
    <div className={`theme-${theme} surface zip-demo`}>
      <div className="zip-demo__hint">Right-click a session tab in the top bar</div>
      <div className="zip-demo__anchor">
        <div className="zip-demo__sess-row">
          <button className="w2__sess w2__sess--agent w2__sess--active">
            <span className="w2__sess-pip w2__sess-pip--run"><span className="lp2__pulse"></span></span>
            <span className="w2__sess-label">#131 memory flicker</span>
          </button>
        </div>
        <div className="zip-menu zip-menu--small">
          <div className="zip-menu__sec">Session · #131</div>
          <button className="zip-menu__row"><Icon.FileEdit /> Rename</button>
          <button className="zip-menu__row"><Icon.GitCommit /> Open PR</button>
          <div className="zip-menu__div"></div>
          <div className="zip-menu__sec">Snapshot</div>
          <button className="zip-menu__row zip-menu__row--accent"><Icon.Box /> Export session as .zip <span className="zip-menu__meta">branch + chat + notes</span></button>
          <button className="zip-menu__row"><Icon.Box /> Export branch only <span className="zip-menu__meta">no chat</span></button>
          <div className="zip-menu__div"></div>
          <button className="zip-menu__row zip-menu__row--danger"><Icon.X /> Close session</button>
        </div>
      </div>
      <div className="zip-demo__caption">A session snapshot = branch <em>plus</em> the chat history that produced it. Hand it to a teammate, they reopen the agent thread mid-flow.</div>
    </div>
  );
}

/* ── 4. Refined Upload Zip modal in the v2 visual language ───── */

function ZipUploadModal({ theme = 'refined', mode = 'diff' }) {
  const files = [
    { n: '.dockerignore',          s: '236 B',   sel: true,  d: 'modified' },
    { n: '.gitea/workflows/ci.yaml', s: '13.6 KB', sel: true, d: 'modified' },
    { n: '20-configure-base-path.sh', s: '2.1 KB',  sel: false, d: 'unchanged' },
    { n: 'assets/favicon.svg',     s: '554 B',   sel: false, d: 'unchanged' },
    { n: 'CHANGELOG.md',           s: '215.4 KB', sel: true, d: 'modified' },
    { n: 'css/base.css',           s: '8.3 KB',  sel: true,  d: 'modified' },
    { n: 'css/chat.css',           s: '25.1 KB', sel: true,  d: 'modified' },
    { n: 'css/components.css',     s: '15.6 KB', sel: true,  d: 'new' },
  ];
  return (
    <div className={`theme-${theme} surface zip-demo zip-demo--modal`}>
      <div className="zip-modal">
        <div className="zip-modal__h">
          <span className="zip-modal__title"><Icon.Box /> Upload Zip</span>
          <button className="w2__top-icon" title="Close"><Icon.X /></button>
        </div>

        <div className="zip-modal__file">
          <Icon.Box />
          <span className="zip-modal__file-name">ai-editor-main.zip</span>
          <span className="zip-modal__file-meta">286 text · 4.9 MB</span>
        </div>

        {/* The new bit: a clear "where does this go" decision up top */}
        <div className="zip-modal__target">
          <div className="zip-modal__target-row">
            <span className="zip-modal__target-label">Commit to</span>
            <div className="zip-modal__seg">
              <button className="zip-modal__seg-btn">main</button>
              <button className="zip-modal__seg-btn zip-modal__seg-btn--on">new branch</button>
              <button className="zip-modal__seg-btn">new session</button>
            </div>
          </div>
          <div className="zip-modal__target-row">
            <span className="zip-modal__target-label">Branch name</span>
            <input className="zip-modal__input" defaultValue="import/ai-editor-main-2026-05-07" />
          </div>
        </div>

        <div className="zip-modal__toolbar">
          <button className="lp2__sec">Select all</button>
          <button className="lp2__sec">Select none</button>
          <button className="lp2__sec lp2__sec--accent"><Icon.Search /> Scan for diffs</button>
          <span className="zip-modal__count">95 / 286 selected</span>
        </div>

        <div className="zip-modal__list">
          {files.map((f, i) => (
            <div key={i} className={`zip-modal__row ${f.sel ? 'zip-modal__row--on' : ''}`}>
              <input type="checkbox" defaultChecked={f.sel} />
              <Icon.FileEdit />
              <span className="zip-modal__row-name">{f.n}</span>
              <span className={`zip-modal__row-diff zip-modal__row-diff--${f.d}`}>{f.d}</span>
              <span className="zip-modal__row-size">{f.s}</span>
            </div>
          ))}
        </div>

        <div className="zip-modal__field">
          <label>Target directory <span className="zip-modal__hint">leave empty for repo root</span></label>
          <input className="zip-modal__input" placeholder="e.g. src/components" />
        </div>

        <div className="zip-modal__field">
          <label>Commit message</label>
          <input className="zip-modal__input" defaultValue="Import 95 files from ai-editor-main.zip" />
        </div>

        <div className="zip-modal__atomic">
          <Icon.GitCommit /> One atomic commit · revert with one click
        </div>

        <div className="zip-modal__foot">
          <button className="lp2__sec">Cancel</button>
          <button className="lp2__start"><Icon.Box /> Upload 95 files</button>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ZipProjectMenu, ZipBranchesView, ZipSessionMenu, ZipUploadModal });
