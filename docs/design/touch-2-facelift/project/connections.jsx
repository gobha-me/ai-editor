/* Settings → Connections — N-of-each git providers
   Each provider type can have 0..N instances (multiple GitHub accounts,
   multiple self-hosted Gitea/GitLab, etc). Each instance has its own
   auth, base URL, display name, last sync.
*/

window.ConnectionsList = function ConnectionsList({ theme, variant }) {
  const connections = [
    { id: "gh-personal", provider: "github", name: "personal", url: "github.com", account: "@padraicobaoill", repos: 47, status: "ok", lastSync: "2m ago" },
    { id: "gh-work", provider: "github", name: "Acme Corp (work)", url: "github.com", account: "@padraic-acme", repos: 18, status: "ok", lastSync: "12m ago" },
    { id: "gitea-home", provider: "gitea", name: "home lab", url: "git.padraic.dev", account: "padraic", repos: 9, status: "ok", lastSync: "1h ago" },
    { id: "gitlab-acme", provider: "gitlab", name: "Acme self-hosted", url: "gitlab.acme.internal", account: "padraic.obaoill", repos: 23, status: "warn", lastSync: "stale · token expires Fri" },
  ];

  const providerMeta = {
    github:  { label: "GitHub",  glyph: "GH" },
    gitea:   { label: "Gitea",   glyph: "GT" },
    gitlab:  { label: "GitLab",  glyph: "GL" },
    bitbucket: { label: "Bitbucket", glyph: "BB" },
  };

  // Group connections by provider so the implementor sees the N-of-each model.
  const grouped = {};
  for (const c of connections) {
    grouped[c.provider] = grouped[c.provider] || [];
    grouped[c.provider].push(c);
  }
  const providerOrder = ["github", "gitea", "gitlab", "bitbucket"];

  return (
    <div className={"theme-" + theme}>
      <div className="settings settings--connections">
        <div className="settings__head">
          <h2 className="settings__head-title">Settings</h2>
          <span className="settings__head-trail">›</span>
          <span className="settings__head-crumb">Connections</span>
          <div style={{ flex: 1 }}></div>
          <div className="settings__search"><Icon.Search /><span>Search settings…</span><kbd>⌘K</kbd></div>
        </div>

        <div className="conn">
          <div className="conn__head">
            <div>
              <h3 className="conn__title">Git connections</h3>
              <p className="conn__sub">Connect any number of accounts per provider — multiple GitHub accounts, self-hosted Gitea/GitLab, or others. Repos from every connected account appear in the global repo picker.</p>
            </div>
          </div>

          {providerOrder.map((p) => {
            const list = grouped[p] || [];
            const meta = providerMeta[p];
            return (
              <div key={p} className="conn__group">
                <div className="conn__group-head">
                  <div className="conn__provider">
                    <span className={"conn__provider-glyph conn__provider-glyph--" + p}>{meta.glyph}</span>
                    <span className="conn__provider-label">{meta.label}</span>
                    <span className="conn__provider-count">{list.length}</span>
                  </div>
                  <button className="conn__add"><Icon.Plus /> Add {meta.label} account</button>
                </div>

                {list.length === 0 && (
                  <div className="conn__empty">
                    No {meta.label} accounts connected.
                  </div>
                )}

                {list.map((c) => (
                  <div key={c.id} className="conn__row">
                    <div className="conn__row-main">
                      <div className="conn__row-name">
                        {c.name}
                        {c.status === "warn" && <span className="conn__warn-pip" title="Needs attention" />}
                      </div>
                      <div className="conn__row-meta">
                        <span className="conn__url"><Icon.Link /> {c.url}</span>
                        <span className="conn__sep">·</span>
                        <span>{c.account}</span>
                        <span className="conn__sep">·</span>
                        <span>{c.repos} repos</span>
                      </div>
                    </div>
                    <div className="conn__row-right">
                      <span className={"conn__status conn__status--" + c.status}>
                        <span className="conn__status-dot" /> {c.lastSync}
                      </span>
                      <button className="conn__row-action" title="Re-authorize"><Icon.Refresh /></button>
                      <button className="conn__row-action" title="Disconnect"><Icon.X /></button>
                    </div>
                  </div>
                ))}
              </div>
            );
          })}

          {variant === "with-picker" && (
            <div className="conn__picker">
              <div className="conn__picker-head">
                <Icon.Folder />
                <span className="conn__picker-title">Aggregated repo picker</span>
                <span className="conn__picker-sub">how the global repo dropdown reads from every connected account</span>
              </div>
              <div className="conn__picker-search">
                <Icon.Search />
                <input placeholder="Filter 97 repos across 4 accounts…" defaultValue="auth" />
              </div>
              <div className="conn__picker-list">
                {[
                  { provider: "github", account: "personal", repo: "padraicobaoill/auth-server", desc: "OAuth2 + WebAuthn relying party" },
                  { provider: "github", account: "Acme Corp", repo: "acme-corp/auth-gateway", desc: "Internal SSO bridge" },
                  { provider: "gitea",  account: "home lab",  repo: "padraic/authd",       desc: "Personal auth daemon, Go" },
                  { provider: "gitlab", account: "Acme self-hosted", repo: "platform/auth-policies", desc: "OPA policy bundle" },
                ].map((r, i) => (
                  <div key={i} className="conn__picker-row">
                    <span className={"conn__provider-glyph conn__provider-glyph--sm conn__provider-glyph--" + r.provider}>{providerMeta[r.provider].glyph}</span>
                    <div className="conn__picker-text">
                      <div className="conn__picker-repo">{r.repo}</div>
                      <div className="conn__picker-desc">{r.desc}</div>
                    </div>
                    <span className="conn__picker-account">{r.account}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
