/* Flow 2 — Memory tab placement */

const { useState: useState2 } = React;

const FAKE_MEMORIES = [
  { id: 1, scope: "user", key: "preferred_indent", value: "4 spaces, never tabs",
    src: "user_explicit", updated: "2 days ago", confidence: 1.0 },
  { id: 2, scope: "workspace", key: "test_style", value: "table-driven with subtests; one t.Run per case",
    src: "agent_proposed", updated: "12 minutes ago", confidence: 0.85 },
  { id: 3, scope: "workspace", key: "auth_approach", value: "JWT in httpOnly cookies; never localStorage",
    src: "user_explicit", updated: "yesterday", confidence: 1.0 },
  { id: 4, scope: "user", key: "commit_style", value: "Conventional Commits — feat/fix/chore prefix",
    src: "user_explicit", updated: "5 days ago", confidence: 1.0 },
  { id: 5, scope: "persona", key: "tone", value: "terse; skip pleasantries; show diffs not paragraphs",
    src: "user_explicit", updated: "3 days ago", confidence: 1.0 },
  { id: 6, scope: "workspace", key: "error_handling", value: "wrap errors with %w; never panic in handlers",
    src: "agent_proposed", updated: "yesterday", confidence: 0.78 },
];

function MemoryTabContent() {
  const [scope, setScope] = useState2("all");
  const [selected, setSelected] = useState2(2);
  const [repoMode, setRepoMode] = useState2(true);
  const [search, setSearch] = useState2("");

  const filtered = FAKE_MEMORIES.filter((m) => {
    if (scope !== "all" && m.scope !== scope) return false;
    if (search && !(m.key + " " + m.value).toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const sel = FAKE_MEMORIES.find((m) => m.id === selected);

  const monoSm = { fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-secondary)" };

  return (
    <div className="mem-tab">
      <div className="mem-tab__top">
        <div className="mem-tab__title">
          ◆ Memory <span className="count">{FAKE_MEMORIES.length} entries</span>
        </div>
        <div className={"mem-toggle " + (repoMode ? "mem-toggle--on" : "")} onClick={() => setRepoMode(!repoMode)}>
          <span className="mem-toggle__switch"></span>
          <span>Commit to <code style={monoSm}>.aieditor/memory/</code></span>
        </div>
        <button className="mem-tab__btn">Audit log</button>
        <button className="mem-tab__btn">Export</button>
      </div>
      {repoMode && (
        <div className="mem-tab__banner">
          <span style={{ color: "var(--memory)" }}>●</span>
          Memory is committed with this repo. Files: <code>preferences.md</code> · <code>decisions.md</code> · <code>project-context.md</code>
        </div>
      )}
      <div className="mem-tab__filters">
        <input className="mem-tab__search" placeholder="Search memories…"
          value={search} onInput={(e) => setSearch(e.currentTarget.value)} />
        <div className="mem-tab__scope-group">
          {["all","user","workspace","persona"].map((s) => (
            <button key={s} className={"mem-tab__scope " + (scope === s ? "mem-tab__scope--active" : "")}
              onClick={() => setScope(s)}>{s}</button>
          ))}
        </div>
      </div>
      <div className="mem-tab__split">
        <div className="mem-tab__list">
          {filtered.length === 0 && (
            <div style={{ padding: "2rem 1rem", textAlign: "center", color: "var(--text-muted)", fontSize: "var(--font-md)" }}>
              No memories match.
            </div>
          )}
          {filtered.map((m) => (
            <div key={m.id} className={"mem-row " + (m.id === selected ? "mem-row--active" : "")}
              onClick={() => setSelected(m.id)}>
              <div className={"mem-row__scope mem-row__scope--" + m.scope}>{m.scope}</div>
              <div className="mem-row__main">
                <div className="mem-row__kv">
                  <span className="key">{m.key}</span><span className="colon">: </span>{m.value}
                </div>
                <div className="mem-row__meta">
                  <span className={"src " + m.src.replace("_","-")}>{m.src}</span>
                  <span>·</span>
                  <span>updated {m.updated}</span>
                  {m.confidence < 1 && (<><span>·</span><span>conf {m.confidence.toFixed(2)}</span></>)}
                </div>
              </div>
              <div className="mem-row__actions">
                <button className="mem-row__action" title="Edit">✎</button>
                <button className="mem-row__action" title="Delete">×</button>
              </div>
            </div>
          ))}
        </div>
        {sel && (
          <div className="mem-detail">
            <h5>Edit memory</h5>
            <div className="field">
              <label style={{ fontSize: "var(--font-xs)", color: "var(--text-muted)", display: "block", marginBottom: 3 }}>key</label>
              <input defaultValue={sel.key} key={"k-"+sel.id} />
            </div>
            <div className="field">
              <label style={{ fontSize: "var(--font-xs)", color: "var(--text-muted)", display: "block", marginBottom: 3 }}>value</label>
              <textarea rows={3} defaultValue={sel.value} key={"v-"+sel.id}></textarea>
            </div>
            <div className="field" style={{ display: "flex", gap: "0.4rem" }}>
              <span className="tag tag--memory">{sel.scope}</span>
              <span className="tag">{sel.src}</span>
              {sel.confidence < 1 && <span className="tag">conf {sel.confidence.toFixed(2)}</span>}
            </div>
            <h5 style={{ marginTop: "1rem" }}>Audit (3 most recent)</h5>
            <div className="audit-entry">
              <span className="when">12m ago</span> · <span className="who">agent_proposed</span><br/>
              created from chat turn #847 ("table-driven tests")
            </div>
            <div className="audit-entry">
              <span className="when">3d ago</span> · <span className="who">user</span><br/>
              superseded earlier value "subtests required"
            </div>
            <div className="audit-entry">
              <span className="when">5d ago</span> · <span className="who">user</span><br/>
              created via Settings UI
            </div>
            <div style={{ marginTop: "1rem", display: "flex", gap: "0.4rem" }}>
              <button className="mem-tab__btn" style={{ flex: 1 }}>Save</button>
              <button className="mem-tab__btn" style={{ color: "var(--error)", borderColor: "rgba(241,76,76,0.3)" }}>Delete</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SettingsTabsMock({ activeTab }) {
  const tabs = ["Connections","LLM","Models","Appearance","Context","Embeddings","Ignore","Roles","Memory","Plugins","Storage","Advanced"];
  return (
    <div className="mock-settings">
      <div className="mock-settings__head">
        <h2>⚙️ Settings</h2>
        <span className="close">×</span>
      </div>
      <div className="mock-settings__tabs">
        {tabs.map((t) => (
          <button key={t}
            className={"mock-settings__tab " + (t === activeTab ? "mock-settings__tab--active " : "") + (t === "Memory" ? "mock-settings__tab--memory" : "")}>
            {t}
            {t === "Memory" && <span className="tab-badge">2</span>}
          </button>
        ))}
      </div>
      <div className="mock-settings__body">
        <MemoryTabContent />
      </div>
    </div>
  );
}

function SettingsSidebarMock() {
  return (
    <div className="mock-settings mock-settings--sidebar">
      <div className="mock-settings__head">
        <h2>⚙️ Settings</h2>
        <span className="close">×</span>
      </div>
      <div className="mock-settings__body">
        <div className="settings-sidebar">
          <div className="settings-sidebar__group">Workspace</div>
          <div className="settings-sidebar__item">Connections</div>
          <div className="settings-sidebar__item">Ignore</div>
          <div className="settings-sidebar__group">AI</div>
          <div className="settings-sidebar__item">LLM</div>
          <div className="settings-sidebar__item">Models</div>
          <div className="settings-sidebar__item">Context</div>
          <div className="settings-sidebar__item">Embeddings</div>
          <div className="settings-sidebar__item">Roles</div>
          <div className="settings-sidebar__item settings-sidebar__item--active">◆ Memory</div>
          <div className="settings-sidebar__group">App</div>
          <div className="settings-sidebar__item">Appearance</div>
          <div className="settings-sidebar__item">Plugins</div>
          <div className="settings-sidebar__item">Storage</div>
          <div className="settings-sidebar__item">Advanced</div>
        </div>
        <MemoryTabContent />
      </div>
    </div>
  );
}

window.Flow2A = function Flow2A() {
  return <SettingsTabsMock activeTab="Memory" />;
};

window.Flow2B = function Flow2B() {
  return <SettingsSidebarMock />;
};
