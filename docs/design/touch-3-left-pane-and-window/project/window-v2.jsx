/* Window v2 — chat-dominant, sessions, multi-branch.
   The middle is no longer "the file." It's whatever the active session is doing:
   talking to the agent, reviewing a PR, resolving a conflict, editing a file.
   Chat is the spine, not the side. The editor docks beside chat, not the other way around.
*/

const w2Sessions = [
  { id: 's1', label: 'main',         scope: 'workspace', dirty: 1 },
  { id: 's2', label: '#131 memory flicker', scope: 'agent', branch: 'agent/issue-131', state: 'running', active: true },
  { id: 's3', label: '#145 mark viewed',    scope: 'agent', branch: 'agent/issue-145', state: 'review' },
  { id: 's4', label: 'PR #84',              scope: 'review', branch: 'feat/virtual-diff' },
];

const w2Chat = [
  { who: 'me',    body: 'Take issue #131 — memory viewer flickers when chat scrolls.' },
  { who: 'agent', body: 'On it. Reading js/memory.js and js/chat.js to find the scroll handler.', meta: 'read 2 files · 4.1k tok' },
  { who: 'agent', kind: 'tool', body: 'Edited js/memory.js — debounced the resize observer (16ms).', meta: '+12 −4' },
  { who: 'agent', body: 'The flicker came from the observer firing on every chat append. Debouncing fixes it without dropping intent. Want me to add a regression test?' },
  { who: 'me',    body: 'Yes, then open the PR.' },
  { who: 'agent', kind: 'running', body: 'Adding test in tests/memory.spec.js…', meta: 'step 3 of 4' },
];

function W2TopBar({ theme }) {
  return (
    <div className="w2__top">
      <div className="w2__top-l">
        <span className="w2__brand"><Icon.Sparkles /> AI Editor <span className="w2__ver">v2.0.0-rc.1</span></span>
        <span className="w2__divider"></span>
        <button className="w2__proj"><Icon.Box /> xcaliber/ai-editor <Icon.ChevronDown /></button>
      </div>

      {/* Sessions tabs — multi-branch / multi-task in one window */}
      <div className="w2__sessions">
        {w2Sessions.map(s => (
          <button key={s.id} className={`w2__sess ${s.active ? 'w2__sess--active' : ''} w2__sess--${s.scope}`}>
            {s.scope === 'agent'  && <span className={`w2__sess-pip ${s.state === 'running' ? 'w2__sess-pip--run' : ''}`}>{s.state === 'running' ? <span className="lp2__pulse"></span> : '✓'}</span>}
            {s.scope === 'review' && <Icon.GitCommit />}
            {s.scope === 'workspace' && <Icon.GitBranch />}
            <span className="w2__sess-label">{s.label}</span>
            {s.dirty ? <span className="w2__sess-dirty">●</span> : null}
            <span className="w2__sess-x">×</span>
          </button>
        ))}
        <button className="w2__sess-new" title="New session"><Icon.Plus /></button>
      </div>

      <div className="w2__top-r">
        <span className="w2__top-stat">3,605 tok</span>
        <span className="w2__top-stat w2__top-stat--mute">$0.0011</span>
        <span className="w2__divider"></span>
        <button className="w2__top-icon" title="Search"><Icon.Search /></button>
        <button className="w2__top-icon" title="Settings"><Icon.Settings /></button>
        <button className="w2__top-icon" title="Help"><Icon.Help /></button>
      </div>
    </div>
  );
}

/* ── Chat as the spine ─────────────────────────────────────────── */

function W2Chat({ compact = false }) {
  return (
    <div className={`w2__chat ${compact ? 'w2__chat--compact' : ''}`}>
      <div className="w2__chat-h">
        <div className="w2__chat-h-l">
          <span className="w2__chat-title">
            {compact ? 'Chat' : <><Icon.Sparkles /> #131 · Memory viewer flickers</>}
          </span>
          {!compact && <span className="w2__chat-sub">agent/issue-131 · running · 12.4k tok</span>}
        </div>
        <div className="w2__chat-h-r">
          <button className="w2__chip">Coder</button>
          <button className="w2__chip">Qwen 3 ▾</button>
          <button className="w2__top-icon" title="Notes"><Icon.FileEdit /></button>
        </div>
      </div>

      <div className="w2__chat-stream">
        {w2Chat.map((m, i) => (
          <div key={i} className={`w2__msg w2__msg--${m.who} ${m.kind ? 'w2__msg--' + m.kind : ''}`}>
            {m.kind === 'tool' && <div className="w2__msg-tool"><Icon.FileEdit /> {m.body}<span className="w2__msg-meta">{m.meta}</span></div>}
            {m.kind === 'running' && <div className="w2__msg-running"><span className="lp2__pulse"></span> {m.body}<span className="w2__msg-meta">{m.meta}</span></div>}
            {!m.kind && (
              <>
                <div className="w2__msg-body">{m.body}</div>
                {m.meta && <div className="w2__msg-meta">{m.meta}</div>}
              </>
            )}
          </div>
        ))}
      </div>

      <div className="w2__chat-composer">
        <div className="w2__chat-inputs">
          <textarea placeholder="Ask, edit, or steer the agent…" rows={compact ? 2 : 3}></textarea>
        </div>
        <div className="w2__chat-foot">
          <span className="w2__chat-foot-l">
            <button className="w2__chip"><Icon.Plus /> Attach</button>
            <button className="w2__chip">Plan</button>
            <button className="w2__chip">Edit</button>
          </span>
          <span className="w2__chat-foot-r">
            <span className="w2__chat-tok">12.4k / 1M</span>
            <button className="w2__send"><Icon.Play /></button>
          </span>
        </div>
      </div>
    </div>
  );
}

/* ── The "stage" — what's beside the chat ─────────────────────── */

function W2WelcomeStage() {
  return (
    <div className="w2__stage w2__stage--welcome">
      <div className="w2__welcome">
        <div className="w2__welcome-eyebrow">v2.0 · Sessions</div>
        <h1 className="w2__welcome-h">What are we shipping?</h1>
        <p className="w2__welcome-sub">Pick an issue to send an agent at it, open a PR to review, or jump into a file.</p>
        <div className="w2__welcome-grid">
          <button className="w2__qa"><span><Icon.Bug /> Issues</span><span className="w2__qa-meta">5 open</span></button>
          <button className="w2__qa"><span><Icon.GitCommit /> Pull Requests</span><span className="w2__qa-meta">4 open · 1 from agents</span></button>
          <button className="w2__qa"><span><Icon.Sparkles /> Tasks</span><span className="w2__qa-meta">2 running</span></button>
          <button className="w2__qa"><span><Icon.Box /> Releases</span><span className="w2__qa-meta">draft v1.9.1</span></button>
        </div>
      </div>
    </div>
  );
}

function W2DiffStage() {
  return (
    <div className="w2__stage">
      <div className="w2__stage-h">
        <div className="w2__stage-tabs">
          <button className="w2__stage-tab w2__stage-tab--active"><Icon.FileEdit /> js/memory.js <span className="w2__sess-dirty">●</span></button>
          <button className="w2__stage-tab">tests/memory.spec.js</button>
        </div>
        <div className="w2__stage-h-r">
          <button className="w2__chip">Diff</button>
          <button className="w2__chip">Edit</button>
          <button className="w2__chip">Blame</button>
        </div>
      </div>
      <div className="w2__diff">
        <div className="w2__diff-line w2__diff-line--ctx"><span>42</span><span>const observer = new ResizeObserver((entries) => {`{`}</span></div>
        <div className="w2__diff-line w2__diff-line--del"><span>43</span><span>−   for (const e of entries) updatePane(e);</span></div>
        <div className="w2__diff-line w2__diff-line--add"><span>43</span><span>+   schedule(() => {`{`} for (const e of entries) updatePane(e); {`}`});</span></div>
        <div className="w2__diff-line w2__diff-line--ctx"><span>44</span><span>{`}`});</span></div>
        <div className="w2__diff-line w2__diff-line--ctx"><span>45</span><span></span></div>
        <div className="w2__diff-line w2__diff-line--add"><span>46</span><span>+ const schedule = (fn) =&gt; {`{`} </span></div>
        <div className="w2__diff-line w2__diff-line--add"><span>47</span><span>+   if (raf) cancelAnimationFrame(raf);</span></div>
        <div className="w2__diff-line w2__diff-line--add"><span>48</span><span>+   raf = requestAnimationFrame(fn);</span></div>
        <div className="w2__diff-line w2__diff-line--add"><span>49</span><span>+ {`}`};</span></div>
      </div>
    </div>
  );
}

/* ── Window shells ─────────────────────────────────────────────── */

function WindowV2Welcome({ theme = 'refined' }) {
  return (
    <div className={`theme-${theme} surface w2`}>
      <W2TopBar theme={theme} />
      <div className="w2__body">
        <div className="w2__left"><LeftPaneRailV2 theme={theme} view="tasks" /></div>
        <div className="w2__main w2__main--chatdom">
          <W2WelcomeStage />
          <W2Chat />
        </div>
      </div>
      <div className="w2__statusbar">
        <span>main · clean</span>
        <span>2 agents running</span>
        <span>0.84 DIEM · 2h10m</span>
      </div>
    </div>
  );
}

function WindowV2TaskRunning({ theme = 'refined' }) {
  return (
    <div className={`theme-${theme} surface w2`}>
      <W2TopBar theme={theme} />
      <div className="w2__body">
        <div className="w2__left"><LeftPaneRailV2 theme={theme} view="tasks" /></div>
        <div className="w2__main w2__main--split">
          <W2DiffStage />
          <W2Chat compact />
        </div>
      </div>
      <div className="w2__statusbar">
        <span>agent/issue-131 · 3 ahead</span>
        <span>● task running · step 3/4</span>
        <span>12.4k / 1M · $0.018</span>
      </div>
    </div>
  );
}

function WindowV2ChatFocus({ theme = 'refined' }) {
  return (
    <div className={`theme-${theme} surface w2`}>
      <W2TopBar theme={theme} />
      <div className="w2__body">
        <div className="w2__left w2__left--collapsed">
          <LeftPaneRailV2 theme={theme} view="tasks" />
        </div>
        <div className="w2__main w2__main--chatonly">
          <div className="w2__chat-wide"><W2Chat /></div>
        </div>
      </div>
      <div className="w2__statusbar">
        <span>focus mode · ⌘\ to expand</span>
        <span>● task running</span>
        <span>12.4k / 1M</span>
      </div>
    </div>
  );
}

Object.assign(window, { WindowV2Welcome, WindowV2TaskRunning, WindowV2ChatFocus });
