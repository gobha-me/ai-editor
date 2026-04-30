/* Settings — three ambition levels, React JSX. */

const { useState } = React;

function ConnectionsContent() {
  return (
    <>
      <h2 className="settings__section-title">Connections</h2>
      <p className="settings__section-sub">Connect to your Git host and AI providers. None of your code or keys leave the browser.</p>
      <div className="settings__field">
        <div>
          <div className="settings__field-label">Git host</div>
          <div className="settings__field-help">Where your repos live. We use the host's API directly from the browser.</div>
        </div>
        <div className="settings__field-control">
          <select className="settings__select" style={{ width: 220 }}>
            <option>GitHub</option><option>Gitea</option><option>GitLab</option>
          </select>
        </div>
      </div>
      <div className="settings__field">
        <div>
          <div className="settings__field-label">Personal access token</div>
          <div className="settings__field-help">Used only by your browser. Stored encrypted in IndexedDB.</div>
        </div>
        <div className="settings__field-control">
          <input className="settings__input" type="password" defaultValue="ghp_••••••••••••••••" />
        </div>
      </div>
      <div className="settings__field">
        <div>
          <div className="settings__field-label">Anthropic API key</div>
          <div className="settings__field-help">Required for chat. Direct browser → Anthropic; nothing routes through us.</div>
        </div>
        <div className="settings__field-control" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input className="settings__input" type="password" defaultValue="sk-ant-•••••••" style={{ flex: 1 }} />
          <span className="chat__access" style={{ fontSize: 11 }}>● connected</span>
        </div>
      </div>
      <div className="settings__field">
        <div>
          <div className="settings__field-label">Telemetry</div>
          <div className="settings__field-help">Anonymous error and feature-use signal. Off by default.</div>
        </div>
        <div className="settings__field-control"><div className="settings__toggle"></div></div>
      </div>
    </>
  );
}

const TABS_8 = ["Connections","LLM","Models","Appearance","Context","Embeddings","Ignore","Roles"];

window.SettingsPolish = function SettingsPolish({ theme }) {
  const [active, setActive] = useState("Connections");
  return (
    <div className={"theme-" + theme} style={{ height: "100%" }}>
      <div className="settings">
        <div className="settings__head">
          <div className="settings__title">Settings</div>
          <div className="settings__search">
            <Icon.Search />
            <span>Search settings</span>
            <kbd>⌘K</kbd>
          </div>
          <button className="settings__close"><Icon.Close /></button>
        </div>
        <div className="settings__tabs">
          {TABS_8.map((t) => (
            <button key={t} className={"settings__tab " + (t === active ? "settings__tab--active" : "")}
              onClick={() => setActive(t)}>{t}</button>
          ))}
          <button className="settings__tab settings__tab-overflow"><Icon.More /></button>
        </div>
        <div className="settings__content">
          <ConnectionsContent />
        </div>
      </div>
    </div>
  );
};

window.SettingsRestructure = function SettingsRestructure({ theme }) {
  const groups = [
    ["Workspace", [["Connections","Plug"],["Ignore","ListChecks"]]],
    ["AI",        [["LLM","Brain"],["Models","Layers"],["Context","FileEdit"],["Embeddings","Server"],["Roles","AtSign"],["Memory","Brain"]]],
    ["App",       [["Appearance","Palette"],["Plugins","Box"],["Storage","Server"],["Advanced","Code"]]],
  ];
  const [active, setActive] = useState("Connections");
  return (
    <div className={"theme-" + theme} style={{ height: "100%" }}>
      <div className="settings">
        <div className="settings__head">
          <div className="settings__title">Settings</div>
          <div className="settings__search">
            <Icon.Search />
            <span>Search settings</span>
            <kbd>⌘K</kbd>
          </div>
          <button className="settings__close"><Icon.Close /></button>
        </div>
        <div className="settings__body">
          <div className="settings__sidebar">
            {groups.map(([g, items]) => (
              <React.Fragment key={g}>
                <div className="settings__sidebar-group">{g}</div>
                {items.map(([t, ic]) => {
                  const I = Icon[ic];
                  return (
                    <div key={t} className={"settings__sidebar-item " + (t === active ? "settings__sidebar-item--active" : "")}
                      onClick={() => setActive(t)}>
                      <I />
                      <span>{t}</span>
                      {t === "Memory" && <span className="badge">2</span>}
                    </div>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
          <div className="settings__content">
            <ConnectionsContent />
          </div>
        </div>
      </div>
    </div>
  );
};

window.SettingsReskin = function SettingsReskin({ theme }) {
  return (
    <div className={"theme-" + theme} style={{ height: "100%" }}>
      <div className="settings">
        <div className="settings__head" style={{ borderBottom: "none", paddingTop: 18, paddingBottom: 4, height: "auto", alignItems: "flex-start", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", width: "100%", gap: 12 }}>
            <div className="settings__title">Settings</div>
            <div className="settings__search" style={{ marginLeft: "auto" }}>
              <Icon.Search /><span>Jump to anything</span><kbd>⌘K</kbd>
            </div>
            <button className="settings__close"><Icon.Close /></button>
          </div>
          <div style={{ fontSize: 12, color: "var(--tk-text-3)", display: "flex", gap: 4, alignItems: "center" }}>
            <span>Workspace</span>
            <span style={{ opacity: 0.5 }}>›</span>
            <span style={{ color: "var(--tk-text-2)" }}>Connections</span>
          </div>
        </div>
        <div className="settings__body">
          <div className="settings__sidebar" style={{ width: 220, padding: "14px 8px" }}>
            <div className="settings__sidebar-group" style={{ paddingTop: 4 }}>Workspace</div>
            <div className="settings__sidebar-item settings__sidebar-item--active"><Icon.Plug /><span>Connections</span></div>
            <div className="settings__sidebar-item"><Icon.ListChecks /><span>Ignore patterns</span></div>
            <div className="settings__sidebar-group">AI behavior</div>
            <div className="settings__sidebar-item"><Icon.Brain /><span>Models &amp; routing</span></div>
            <div className="settings__sidebar-item"><Icon.FileEdit /><span>Context</span></div>
            <div className="settings__sidebar-item"><Icon.Brain /><span>Memory</span><span className="badge">2</span></div>
            <div className="settings__sidebar-item"><Icon.AtSign /><span>Roles</span></div>
            <div className="settings__sidebar-group">Application</div>
            <div className="settings__sidebar-item"><Icon.Palette /><span>Theme &amp; type</span></div>
            <div className="settings__sidebar-item"><Icon.Box /><span>Plugins</span></div>
            <div className="settings__sidebar-item"><Icon.Server /><span>Storage</span></div>
          </div>
          <div className="settings__content" style={{ padding: "28px 36px" }}>
            <ConnectionsContent />
          </div>
        </div>
      </div>
    </div>
  );
};
