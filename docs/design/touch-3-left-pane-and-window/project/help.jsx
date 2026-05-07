/* Help panel — slide-out from right edge.
   Left rail nav + content. Variants:
   - "hotkeys" : data-driven hotkeys page (platform-aware)
   - "sdk"     : editorial-friendly markdown page (Plugin SDK)
   - "search"  : flat search results across all docs
*/

const { useState: useStateH } = React;

window.HelpPanel = function HelpPanel({ theme, variant, platform }) {
  // platform: "mac" | "win" — controls hotkey rendering
  const plat = platform || "mac";
  const navItems = [
    { id: "getting-started", label: "Getting started", icon: "Sparkles", group: "" },
    { id: "hotkeys",         label: "Hotkeys",         icon: "Hash",     group: "" },
    { id: "command-palette", label: "Command palette", icon: "Search",   group: "" },
    { id: "plugin-sdk",      label: "Plugin SDK",      icon: "Box",      group: "Building" },
    { id: "tools",           label: "Tools API",       icon: "Code",     group: "Building" },
    { id: "themes",          label: "Themes",          icon: "Palette",  group: "Building" },
    { id: "roles",           label: "Roles",           icon: "AtSign",   group: "Concepts" },
    { id: "memory",          label: "Memory",          icon: "Brain",    group: "Concepts" },
    { id: "architecture",    label: "Architecture",    icon: "Server",   group: "Concepts" },
    { id: "changelog",       label: "Changelog",       icon: "GitCommit", group: "Reference" },
  ];

  const activeId =
    variant === "hotkeys" ? "hotkeys" :
    variant === "sdk"     ? "plugin-sdk" :
    variant === "search"  ? "hotkeys" :
    "getting-started";

  // Group nav
  const navByGroup = [];
  let currentGroup = null;
  for (const item of navItems) {
    if (item.group !== currentGroup) {
      currentGroup = item.group;
      navByGroup.push({ group: currentGroup, items: [] });
    }
    navByGroup[navByGroup.length - 1].items.push(item);
  }

  return (
    <div className={"theme-" + theme} style={{ height: "100%" }}>
      <div className="help">
        <div className="help__head">
          <div className="help__title">
            <Icon.Book />
            <span>Help &amp; docs</span>
          </div>
          <div style={{ flex: 1 }}></div>
          <button className="help__head-btn" title="Close"><Icon.X /></button>
        </div>

        <div className="help__body">
          <aside className="help__nav">
            <div className="help__search-wrap">
              <Icon.Search />
              <input
                className="help__search-input"
                placeholder="Search all docs…"
                defaultValue={variant === "search" ? "commit" : ""}
              />
              <kbd>⌘/</kbd>
            </div>
            {navByGroup.map((g, gi) => (
              <div key={gi} className="help__nav-group">
                {g.group && <div className="help__nav-group-title">{g.group}</div>}
                {g.items.map((it) => {
                  const I = Icon[it.icon];
                  const isActive = it.id === activeId && variant !== "search";
                  return (
                    <div
                      key={it.id}
                      className={"help__nav-item " + (isActive ? "help__nav-item--active" : "")}
                    >
                      <I />
                      <span>{it.label}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </aside>

          <div className="help__content">
            {variant === "hotkeys" && <HelpHotkeys plat={plat} />}
            {variant === "sdk"     && <HelpSDK />}
            {variant === "search"  && <HelpSearchResults plat={plat} />}
          </div>
        </div>

        <div className="help__foot">
          <a className="help__foot-link"><Icon.Github /> Source &amp; issues</a>
          <span className="help__foot-sep">·</span>
          <a className="help__foot-link"><Icon.Coffee /> Buy me a coffee</a>
          <div style={{ flex: 1 }}></div>
          <span className="help__foot-meta">v1.3.1 · docs synced 2h ago</span>
        </div>
      </div>
    </div>
  );
};

/* ── Hotkey rendering helpers ─────────────────────────────────────── */
function Kbd({ keys, plat }) {
  // keys: array of tokens: "mod", "shift", "alt", "enter", "k", etc.
  // We render mac glyphs on mac, words on win/linux.
  const map = plat === "mac"
    ? { mod: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃", enter: "↵", esc: "Esc", tab: "Tab", space: "Space", up: "↑", down: "↓", left: "←", right: "→", backspace: "⌫", slash: "/", comma: ",", period: ".", semicolon: ";" }
    : { mod: "Ctrl", shift: "Shift", alt: "Alt", ctrl: "Ctrl", enter: "Enter", esc: "Esc", tab: "Tab", space: "Space", up: "↑", down: "↓", left: "←", right: "→", backspace: "Backspace", slash: "/", comma: ",", period: ".", semicolon: ";" };
  return (
    <span className="kbd-combo">
      {keys.map((k, i) => {
        const label = map[k] || (k.length === 1 ? k.toUpperCase() : k);
        return (
          <React.Fragment key={i}>
            {i > 0 && <span className="kbd-plus">{plat === "mac" ? "" : "+"}</span>}
            <kbd className="help-kbd">{label}</kbd>
          </React.Fragment>
        );
      })}
    </span>
  );
}

function HelpHotkeys({ plat }) {
  const groups = [
    { title: "Global", keys: [
      { combo: ["mod", "k"], desc: "Open command palette" },
      { combo: ["mod", "p"], desc: "Quick-open file" },
      { combo: ["mod", "shift", "p"], desc: "Run command" },
      { combo: ["mod", "comma"], desc: "Open settings" },
      { combo: ["mod", "shift", "d"], desc: "Toggle debug panel" },
      { combo: ["mod", "slash"], desc: "Toggle help" },
    ]},
    { title: "Editor", keys: [
      { combo: ["mod", "s"], desc: "Save" },
      { combo: ["mod", "z"], desc: "Undo" },
      { combo: ["mod", "shift", "z"], desc: "Redo" },
      { combo: ["mod", "d"], desc: "Add next match to selection" },
      { combo: ["alt", "up"], desc: "Move line up" },
      { combo: ["alt", "down"], desc: "Move line down" },
    ]},
    { title: "Chat", keys: [
      { combo: ["mod", "l"], desc: "Focus chat" },
      { combo: ["mod", "enter"], desc: "Send message" },
      { combo: ["mod", "shift", "n"], desc: "New thread" },
      { combo: ["mod", "shift", "l"], desc: "Switch model" },
      { combo: ["alt", "enter"], desc: "Send to a different role" },
    ]},
    { title: "Git", keys: [
      { combo: ["mod", "shift", "g"], desc: "Open git panel" },
      { combo: ["mod", "shift", "k"], desc: "Commit staged changes" },
      { combo: ["mod", "shift", "b"], desc: "Switch branch" },
    ]},
  ];

  return (
    <article className="help__article">
      <div className="help__crumbs">Reference <span className="help__crumb-sep">›</span> Hotkeys</div>
      <h1 className="help__h1">Hotkeys</h1>
      <p className="help__lede">Showing {plat === "mac" ? "macOS" : "Windows / Linux"} keys.
        <button className="help__plat-toggle">switch to {plat === "mac" ? "Windows / Linux" : "macOS"}</button>
      </p>

      <aside className="help__toc">
        <div className="help__toc-title">On this page</div>
        {groups.map((g, i) => (
          <a key={i} className="help__toc-link">{g.title}</a>
        ))}
      </aside>

      {groups.map((g, gi) => (
        <section key={gi} className="help__hk-group">
          <h2 className="help__h2">{g.title}</h2>
          <div className="help__hk-list">
            {g.keys.map((k, ki) => (
              <div key={ki} className="help__hk-row">
                <Kbd keys={k.combo} plat={plat} />
                <span className="help__hk-desc">{k.desc}</span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </article>
  );
}

function HelpSDK() {
  const codeBlock = (s) => (
    <pre className="help__pre"><code>{s}</code></pre>
  );

  return (
    <article className="help__article">
      <div className="help__crumbs">Building <span className="help__crumb-sep">›</span> Plugin SDK</div>
      <h1 className="help__h1">Plugin SDK</h1>
      <p className="help__lede">A plugin is a folder under <code className="help__code">plugins/</code> with a <code className="help__code">manifest.json</code> and an entry script. The runtime loads it on app start, sandboxed in an iframe with a typed message bridge to the host.</p>

      <aside className="help__toc">
        <div className="help__toc-title">On this page</div>
        <a className="help__toc-link">Anatomy</a>
        <a className="help__toc-link">Manifest</a>
        <a className="help__toc-link">Activation</a>
        <a className="help__toc-link">API surface</a>
        <a className="help__toc-link">Themes are plugins too</a>
      </aside>

      <h2 className="help__h2">Anatomy</h2>
      <p>Every plugin ships three things, no more:</p>
      <ul className="help__ul">
        <li><code className="help__code">manifest.json</code> — id, version, capabilities, contributes</li>
        <li><code className="help__code">main.js</code> — entry, runs once on activation</li>
        <li>Any number of static assets (icons, css, html templates) referenced by relative path</li>
      </ul>

      <h2 className="help__h2">Manifest</h2>
      {codeBlock(`{
  "id": "editorconfig-extras",
  "version": "0.4.1",
  "name": "EditorConfig Extras",
  "main": "main.js",
  "capabilities": ["editor.observe", "settings.contribute"],
  "contributes": {
    "settings": [
      { "id": "ece.trimTrailingNewlines", "type": "boolean", "default": true }
    ],
    "commands": [
      { "id": "ece.normalize", "title": "Normalize whitespace" }
    ]
  }
}`)}

      <h2 className="help__h2">Activation</h2>
      <p>Plugins register handlers; they don't run code at module top level. The host calls <code className="help__code">activate(ctx)</code> when the plugin is needed. <code className="help__code">ctx</code> is your only handle to the editor — guard everything through it so a stale plugin can't escape its sandbox.</p>
      {codeBlock(`export function activate(ctx) {
  ctx.commands.register("ece.normalize", () => {
    const editor = ctx.editor.active();
    if (!editor) return;
    editor.transform(normalizeWhitespace);
  });
}`)}

      <h2 className="help__h2">Themes are plugins too</h2>
      <p>A theme is a plugin with no JS entry. Just a manifest pointing at a single CSS file. The runtime drops it into <code className="help__code">document.head</code> when activated. Every variable the app reads — colors, fonts, radii, spacing — is documented in the <a className="help__a">theme tokens reference</a>; using anything else is undefined behavior.</p>
    </article>
  );
}

function HelpSearchResults({ plat }) {
  // Flat, ranked, with doc tag — the (a) pattern.
  const results = [
    { doc: "Hotkeys",        section: "Git",           title: "Commit staged changes",       snippet: "<mark>⌘⇧K</mark> · commits everything in the staging area with the current message draft. Pairs with the diff…" },
    { doc: "Hotkeys",        section: "Chat",          title: "Send to a different role",   snippet: "Use Alt+Enter while drafting to send the same message to a non-default role — useful for asking the <mark>commit</mark>-message role to draft…" },
    { doc: "Command palette", section: "Built-ins",     title: "git: commit",                 snippet: "Runs the same flow as <mark>⌘⇧K</mark>. The palette shows a preview of files that will be included before…" },
    { doc: "Plugin SDK",     section: "Manifest",      title: "contributes.commands",        snippet: "Plugins can contribute <mark>commit</mark>-related commands — e.g. ‘amend last <mark>commit</mark>’ — by registering against the git capability…" },
    { doc: "Roles",          section: "Built-in roles", title: "commit-message",              snippet: "The <mark>commit</mark>-message role is auto-invoked when the commit modal opens with no draft. It reads the diff and proposes…" },
    { doc: "Memory",         section: "Promotion",     title: "Promoting a fact",            snippet: "Memory promotion happens at <mark>commit</mark> time — the modal lets you opt in to including newly-learned facts in the commit…" },
    { doc: "Architecture",   section: "Git layer",     title: "Direct-from-browser commits", snippet: "All <mark>commit</mark>s go from the browser to the git host's API directly — we never proxy. See Connections for…" },
  ];

  return (
    <article className="help__article help__article--search">
      <div className="help__crumbs">Search results <span className="help__crumb-sep">›</span> <span className="help__mono">commit</span></div>
      <h1 className="help__h1">7 results for <span className="help__mono help__h1-mono">“commit”</span></h1>
      <p className="help__lede help__lede--search">across 9 docs · ranked by relevance · <button className="help__plat-toggle">group by doc</button></p>

      <div className="help__results">
        {results.map((r, i) => (
          <div key={i} className="help__result">
            <div className="help__result-head">
              <span className="help__result-tag">{r.doc}</span>
              <span className="help__result-sep">›</span>
              <span className="help__result-section">{r.section}</span>
            </div>
            <div className="help__result-title">{r.title}</div>
            <div
              className="help__result-snippet"
              dangerouslySetInnerHTML={{ __html: r.snippet }}
            />
          </div>
        ))}
      </div>
    </article>
  );
}
