/* Debug panel — slide-out from right edge.
   Sections: live log stream, connection health, indexer queue,
   AI request log, plugin warnings, copy diagnostic bundle.
*/

const { useState: useStateD } = React;

window.DebugPanel = function DebugPanel({ theme }) {
  const [tab, setTab] = useStateD("logs");
  const [level, setLevel] = useStateD("all");

  const tabs = [
    { id: "logs", label: "Logs", icon: "Activity", count: null },
    { id: "conn", label: "Connections", icon: "Plug", count: 1, warn: true },
    { id: "indexer", label: "Indexer", icon: "Database", count: null },
    { id: "ai", label: "AI", icon: "Sparkles", count: null },
    { id: "plugins", label: "Plugins", icon: "Box", count: 2, warn: true },
  ];

  return (
    <div className={"theme-" + theme} style={{ height: "100%" }}>
      <div className="debug">
        <div className="debug__head">
          <div className="debug__title">
            <Icon.Bug />
            <span>Debug</span>
          </div>
          <div className="debug__head-meta">
            <span className="debug__head-pip debug__head-pip--ok" /> 1 active session · 14m
          </div>
          <div style={{ flex: 1 }}></div>
          <button className="debug__head-btn" title="Pause stream"><Icon.Pause /></button>
          <button className="debug__head-btn debug__head-btn--primary" title="Copy diagnostic bundle">
            <Icon.Copy /> Copy bundle
          </button>
          <button className="debug__head-btn" title="Close"><Icon.X /></button>
        </div>

        <div className="debug__tabs">
          {tabs.map((t) => {
            const I = Icon[t.icon];
            return (
              <button
                key={t.id}
                className={"debug__tab " + (t.id === tab ? "debug__tab--active" : "")}
                onClick={() => setTab(t.id)}
              >
                <I />
                <span>{t.label}</span>
                {t.count != null && (
                  <span className={"debug__tab-count " + (t.warn ? "debug__tab-count--warn" : "")}>{t.count}</span>
                )}
              </button>
            );
          })}
        </div>

        <div className="debug__body">
          {tab === "logs" && <DebugLogs level={level} setLevel={setLevel} />}
          {tab === "conn" && <DebugConn />}
          {tab === "indexer" && <DebugIndexer />}
          {tab === "ai" && <DebugAI />}
          {tab === "plugins" && <DebugPlugins />}
        </div>
      </div>
    </div>
  );
};

function DebugLogs({ level, setLevel }) {
  const lines = [
    { t: "14:22:08.412", lvl: "info",  src: "indexer", msg: "queued 12 files for embedding" },
    { t: "14:22:08.418", lvl: "debug", src: "indexer", msg: "skip auth.go.bak (in .editorignore)" },
    { t: "14:22:09.001", lvl: "info",  src: "ai",      msg: "request claude-sonnet-4.5 · 1842 in / 412 out · 1.8s" },
    { t: "14:22:14.220", lvl: "warn",  src: "git/gitlab.acme.internal", msg: "token expires Fri · re-auth recommended" },
    { t: "14:22:14.340", lvl: "info",  src: "git/github.com",   msg: "fetched 3 PRs · acme-corp/auth-gateway" },
    { t: "14:22:18.070", lvl: "error", src: "plugin:editorconfig-extras", msg: "uncaught TypeError: cannot read 'rules' of undefined (init)" },
    { t: "14:22:18.071", lvl: "info",  src: "plugins", msg: "disabled editorconfig-extras for this session" },
    { t: "14:22:21.500", lvl: "debug", src: "indexer", msg: "embed batch 4/12 · 380ms" },
    { t: "14:22:24.100", lvl: "info",  src: "ai",      msg: "request claude-sonnet-4.5 · 12.4k in / 198 out · 2.3s" },
    { t: "14:22:31.880", lvl: "warn",  src: "memory",  msg: "promotion candidate: ‘prefers tabs over spaces’ (3rd mention)" },
    { t: "14:22:33.012", lvl: "debug", src: "indexer", msg: "embed batch 12/12 · queue empty" },
    { t: "14:22:40.700", lvl: "info",  src: "git/github.com",   msg: "push padraic-acme/auth-gateway · feat/refresh-tokens" },
  ];
  const filtered = level === "all" ? lines : lines.filter((l) => l.lvl === level);
  return (
    <div className="debug__panel">
      <div className="debug__bar">
        <div className="debug__filter-group">
          {["all", "debug", "info", "warn", "error"].map((l) => (
            <button
              key={l}
              className={"debug__chip " + (l === level ? "debug__chip--active" : "") + (l !== "all" ? " debug__chip--" + l : "")}
              onClick={() => setLevel(l)}
            >
              {l}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }}></div>
        <div className="debug__bar-search">
          <Icon.Search />
          <input placeholder="Filter…" />
        </div>
      </div>
      <div className="debug__log">
        {filtered.map((l, i) => (
          <div key={i} className="debug__log-row">
            <span className="debug__log-time">{l.t}</span>
            <span className={"debug__log-level debug__log-level--" + l.lvl}>{l.lvl}</span>
            <span className="debug__log-src">{l.src}</span>
            <span className="debug__log-msg">{l.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DebugConn() {
  const conns = [
    { name: "github · personal",       url: "github.com",            status: "ok",   meta: "last sync 2m ago · 47 repos · 240 RL/h",       err: null },
    { name: "github · Acme Corp",      url: "github.com",            status: "ok",   meta: "last sync 12m ago · 18 repos · 1980 RL/h",     err: null },
    { name: "gitea · home lab",        url: "git.padraic.dev",       status: "ok",   meta: "last sync 1h ago · 9 repos · self-hosted",     err: null },
    { name: "gitlab · Acme self-hosted", url: "gitlab.acme.internal", status: "warn", meta: "last sync 3h ago · 23 repos · self-hosted",  err: "token expires Fri 18 Apr · 401 on /projects (1×)" },
  ];
  return (
    <div className="debug__panel">
      <div className="debug__section-title">Git providers · 4 connected</div>
      {conns.map((c, i) => (
        <div key={i} className={"debug__conn " + (c.status !== "ok" ? "debug__conn--warn" : "")}>
          <div className="debug__conn-row">
            <span className={"conn__status conn__status--" + c.status}>
              <span className="conn__status-dot" />
            </span>
            <div className="debug__conn-name">{c.name}</div>
            <div className="debug__conn-url">{c.url}</div>
          </div>
          <div className="debug__conn-meta">{c.meta}</div>
          {c.err && (
            <div className="debug__conn-err">
              <Icon.Bug /> {c.err}
            </div>
          )}
        </div>
      ))}
      <div className="debug__section-title" style={{ marginTop: 14 }}>AI providers · 1 connected</div>
      <div className="debug__conn">
        <div className="debug__conn-row">
          <span className="conn__status conn__status--ok"><span className="conn__status-dot" /></span>
          <div className="debug__conn-name">anthropic</div>
          <div className="debug__conn-url">api.anthropic.com</div>
        </div>
        <div className="debug__conn-meta">last request 8s ago · p50 1.4s · p95 3.8s · 38 req · 12.4k tok</div>
      </div>
    </div>
  );
}

function DebugIndexer() {
  return (
    <div className="debug__panel">
      <div className="debug__stat-row">
        <div className="debug__stat">
          <div className="debug__stat-label">Status</div>
          <div className="debug__stat-value debug__stat-value--ok">idle</div>
        </div>
        <div className="debug__stat">
          <div className="debug__stat-label">Indexed</div>
          <div className="debug__stat-value">218 / 218</div>
        </div>
        <div className="debug__stat">
          <div className="debug__stat-label">Queued</div>
          <div className="debug__stat-value">0</div>
        </div>
        <div className="debug__stat">
          <div className="debug__stat-label">Storage</div>
          <div className="debug__stat-value">14.2 MB</div>
        </div>
      </div>
      <div className="debug__progress">
        <div className="debug__progress-fill" style={{ width: "100%" }} />
      </div>
      <div className="debug__section-title">Last batch · 14:22:33</div>
      <div className="debug__batch">
        <div className="debug__batch-row"><span>chunks embedded</span><span>312</span></div>
        <div className="debug__batch-row"><span>embedding model</span><span>voyage-code-3 (local)</span></div>
        <div className="debug__batch-row"><span>p50 / p95 latency</span><span>180ms / 420ms</span></div>
        <div className="debug__batch-row"><span>skipped (ignore)</span><span>14</span></div>
        <div className="debug__batch-row"><span>skipped (binary)</span><span>3</span></div>
      </div>
      <button className="debug__btn">Re-index from scratch</button>
    </div>
  );
}

function DebugAI() {
  const reqs = [
    { t: "14:22:40", model: "claude-sonnet-4.5", tok_in: 12420, tok_out: 198, ms: 2300, role: "edit", status: "ok" },
    { t: "14:22:09", model: "claude-sonnet-4.5", tok_in: 1842,  tok_out: 412, ms: 1820, role: "chat", status: "ok" },
    { t: "14:21:51", model: "claude-haiku-4.5",  tok_in: 920,   tok_out: 88,  ms: 410,  role: "commit-msg", status: "ok" },
    { t: "14:21:33", model: "claude-sonnet-4.5", tok_in: 8104,  tok_out: 0,   ms: 18000,role: "explain", status: "abort" },
    { t: "14:20:12", model: "claude-sonnet-4.5", tok_in: 4220,  tok_out: 612, ms: 2100, role: "edit", status: "ok" },
  ];
  return (
    <div className="debug__panel">
      <div className="debug__stat-row">
        <div className="debug__stat"><div className="debug__stat-label">Requests · session</div><div className="debug__stat-value">38</div></div>
        <div className="debug__stat"><div className="debug__stat-label">Tokens in</div><div className="debug__stat-value">102.4k</div></div>
        <div className="debug__stat"><div className="debug__stat-label">Tokens out</div><div className="debug__stat-value">8.2k</div></div>
        <div className="debug__stat"><div className="debug__stat-label">Spend · est</div><div className="debug__stat-value">$0.41</div></div>
      </div>
      <div className="debug__section-title">Recent requests</div>
      <div className="debug__table">
        <div className="debug__table-head">
          <span>time</span><span>model</span><span>role</span><span style={{ textAlign: "right" }}>in / out</span><span style={{ textAlign: "right" }}>ms</span><span>status</span>
        </div>
        {reqs.map((r, i) => (
          <div key={i} className="debug__table-row">
            <span className="debug__mono">{r.t}</span>
            <span className="debug__mono">{r.model}</span>
            <span>{r.role}</span>
            <span className="debug__mono" style={{ textAlign: "right" }}>{r.tok_in.toLocaleString()} / {r.tok_out.toLocaleString()}</span>
            <span className="debug__mono" style={{ textAlign: "right" }}>{r.ms.toLocaleString()}</span>
            <span className={"debug__pill debug__pill--" + (r.status === "ok" ? "ok" : "warn")}>{r.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DebugPlugins() {
  const plugins = [
    { name: "editorconfig-extras", version: "0.4.1", status: "error", msg: "uncaught TypeError on init · disabled this session" },
    { name: "vim-mode",            version: "1.2.0", status: "warn",  msg: "uses deprecated keymap.register API · removed in 2.0" },
    { name: "theme-editorial-calm", version: "1.0.0", status: "ok",    msg: "loaded · 1 css file · 8.2 KB" },
    { name: "lint-everything",     version: "0.9.3", status: "ok",    msg: "loaded · 4 hooks registered" },
    { name: "github-copilot-ish",  version: "0.2.7", status: "ok",    msg: "loaded · idle" },
  ];
  return (
    <div className="debug__panel">
      <div className="debug__section-title">5 plugins loaded · 1 error · 1 warning</div>
      {plugins.map((p, i) => (
        <div key={i} className={"debug__plugin debug__plugin--" + p.status}>
          <div className="debug__plugin-row">
            <Icon.Box />
            <div className="debug__plugin-name">{p.name}</div>
            <div className="debug__plugin-ver">v{p.version}</div>
            <span className={"debug__pill debug__pill--" + (p.status === "ok" ? "ok" : p.status === "warn" ? "warn" : "error")}>{p.status}</span>
          </div>
          <div className="debug__plugin-msg">{p.msg}</div>
        </div>
      ))}
    </div>
  );
}
