/* Merge conflict resolver — yes, possible in pure browser.
   Three-pane: Theirs (incoming) | Resolved (editable, monospace) | Ours (current).
   Per-hunk: accept theirs / accept ours / both / AI suggest.
   Conflict navigator on the side; mini-map of conflicts in the gutter.
*/

const mcFiles = [
  { path: 'js/indexer.js',    conflicts: 3, resolved: 1, status: 'active' },
  { path: 'css/sidebar.css',  conflicts: 1, resolved: 1, status: 'done' },
  { path: 'package.json',     conflicts: 1, resolved: 0, status: 'pending' },
];

const mcHunks = [
  {
    id: 1,
    line: 42,
    state: 'unresolved',
    theirs: [
      'export function indexer(opts = {}) {',
      '  const batch = opts.batchSize ?? 32;',
      '  const par   = opts.parallel  ?? 4;',
      '  return new Indexer({ batch, par });',
      '}',
    ],
    ours: [
      'export function indexer(opts = {}) {',
      '  const cfg = readSettings("indexer");',
      '  const batch = opts.batchSize ?? cfg.batch ?? 64;',
      '  return new Indexer({ batch, parallel: cfg.parallel });',
      '}',
    ],
  },
  {
    id: 2,
    line: 88,
    state: 'resolved-ours',
    theirs: [
      'await this.flush();',
      'this.queue = [];',
    ],
    ours: [
      'await this.flush({ persist: true });',
      'this.queue.length = 0;',
    ],
    resolved: [
      'await this.flush({ persist: true });',
      'this.queue.length = 0;',
    ],
  },
  {
    id: 3,
    line: 134,
    state: 'unresolved',
    theirs: [
      '  if (this.aborted) return;',
      '  this.emit("done", { count: this.n });',
    ],
    ours: [
      '  if (this.aborted) { this.emit("aborted"); return; }',
      '  this.emit("done", { count: this.n, t: Date.now() - this.t0 });',
    ],
  },
];

function McTopBar() {
  return (
    <div className="mc__topbar">
      <span className="mc__title-block">
        <span className="mc__warn-glyph">⚠</span>
        <span className="mc__title">Resolve conflicts</span>
        <span className="mc__sub">merging <code>main</code> into <code>fix/indexer-batch</code></span>
      </span>
      <div className="mc__topbar-meta">
        <span className="mc__progress">
          <span className="mc__progress-bar"><span style={{ width: '40%' }}></span></span>
          <span>2 of 5 resolved</span>
        </span>
        <button className="pr__btn">Abort merge</button>
        <button className="pr__btn pr__btn--primary" disabled>Mark all resolved → commit merge</button>
      </div>
    </div>
  );
}

function McFilePane() {
  return (
    <div className="mc__filepane">
      <div className="mc__filepane-head">Conflicting files</div>
      {mcFiles.map(f => (
        <div key={f.path} className={`mc__file-row mc__file-row--${f.status}`}>
          <span className={`mc__file-pip mc__file-pip--${f.status}`}></span>
          <span className="mc__file-path">{f.path}</span>
          <span className="mc__file-stat">
            {f.resolved}/{f.conflicts}
          </span>
        </div>
      ))}
      <div className="mc__filepane-section">Already merged</div>
      <div className="mc__file-row mc__file-row--clean">
        <span className="mc__file-pip mc__file-pip--clean"></span>
        <span className="mc__file-path">21 files (no conflict)</span>
      </div>
    </div>
  );
}

function McHunkLabel({ side, count, line }) {
  const L = side === 'theirs'
    ? <><span className="mc__side-mark mc__side-mark--theirs">◀</span><strong>Incoming</strong> · main</>
    : side === 'ours'
    ? <><span className="mc__side-mark mc__side-mark--ours">▶</span><strong>Current</strong> · fix/indexer-batch</>
    : <><span className="mc__side-mark mc__side-mark--res">●</span><strong>Resolved</strong></>;
  return (
    <div className={`mc__pane-head mc__pane-head--${side}`}>
      <span className="mc__pane-head-l">{L}</span>
      <span className="mc__pane-head-r">{count} lines{line ? ` · L${line}` : ''}</span>
    </div>
  );
}

function McHunk({ hunk, idx, active }) {
  const cls = `mc__hunk ${active ? 'mc__hunk--active' : ''} mc__hunk--${hunk.state}`;
  return (
    <div className={cls}>
      <div className="mc__hunk-head">
        <span className="mc__hunk-num">Conflict {idx + 1}</span>
        <span className="mc__hunk-line">L{hunk.line}</span>
        {hunk.state === 'unresolved'
          ? <span className="mc__hunk-state mc__hunk-state--unresolved">Unresolved</span>
          : <span className="mc__hunk-state mc__hunk-state--resolved">Resolved (took ours)</span>}
        <div className="mc__hunk-actions">
          <button className="mc__act mc__act--theirs">← Take theirs</button>
          <button className="mc__act mc__act--both">Take both</button>
          <button className="mc__act mc__act--ours">Take ours →</button>
          <span className="mc__act-sep"></span>
          <button className="mc__act mc__act--ai"><Icon.Sparkles /> AI resolve</button>
          <button className="mc__act mc__act--edit"><Icon.FileEdit /> Edit</button>
        </div>
      </div>

      <div className="mc__three">
        <div className="mc__pane mc__pane--theirs">
          <McHunkLabel side="theirs" count={hunk.theirs.length} />
          <pre className="mc__code">
            {hunk.theirs.map((l, i) => (
              <div key={i} className="mc__code-row mc__code-row--theirs">
                <span className="mc__code-num">{hunk.line + i}</span>
                <span className="mc__code-line">{l}</span>
              </div>
            ))}
          </pre>
        </div>

        <div className="mc__pane mc__pane--resolved">
          <McHunkLabel side="resolved" count={(hunk.resolved || []).length} line={hunk.line} />
          {hunk.state === 'unresolved' ? (
            <div className="mc__resolved-empty">
              <span>Pick a side, take both, or edit directly.</span>
              <button className="mc__act mc__act--ai mc__act--lg"><Icon.Sparkles /> Let AI try</button>
            </div>
          ) : (
            <pre className="mc__code mc__code--resolved">
              {hunk.resolved.map((l, i) => (
                <div key={i} className="mc__code-row mc__code-row--resolved">
                  <span className="mc__code-num">{hunk.line + i}</span>
                  <span className="mc__code-line">{l}</span>
                </div>
              ))}
            </pre>
          )}
        </div>

        <div className="mc__pane mc__pane--ours">
          <McHunkLabel side="ours" count={hunk.ours.length} />
          <pre className="mc__code">
            {hunk.ours.map((l, i) => (
              <div key={i} className="mc__code-row mc__code-row--ours">
                <span className="mc__code-num">{hunk.line + i}</span>
                <span className="mc__code-line">{l}</span>
              </div>
            ))}
          </pre>
        </div>
      </div>
    </div>
  );
}

/* The conflict mini-map on the right: a line-of-the-file scrubber
   with conflict bands and resolution state. */
function McMinimap() {
  return (
    <div className="mc__minimap">
      <div className="mc__minimap-head">js/indexer.js</div>
      <div className="mc__minimap-track">
        {/* file body, fake */}
        {Array.from({ length: 60 }).map((_, i) => (
          <div key={i} className="mc__minimap-row"></div>
        ))}
        {/* conflict bands */}
        <div className="mc__minimap-band mc__minimap-band--unresolved" style={{ top: '24%', height: '6%' }}>1</div>
        <div className="mc__minimap-band mc__minimap-band--resolved"   style={{ top: '50%', height: '4%' }}>2</div>
        <div className="mc__minimap-band mc__minimap-band--unresolved" style={{ top: '74%', height: '5%' }}>3</div>
      </div>
      <div className="mc__minimap-foot">
        <span><span className="mc__lpip mc__lpip--unresolved"></span> 2 unresolved</span>
        <span><span className="mc__lpip mc__lpip--resolved"></span> 1 resolved</span>
      </div>
    </div>
  );
}

function MergeConflict({ theme = 'refined' }) {
  return (
    <div className={`theme-${theme} surface mc`}>
      <McTopBar />
      <div className="mc__body">
        <McFilePane />
        <div className="mc__main">
          {mcHunks.map((h, i) => <McHunk key={h.id} hunk={h} idx={i} active={i === 0} />)}
        </div>
        <McMinimap />
      </div>
    </div>
  );
}

Object.assign(window, { MergeConflict });
