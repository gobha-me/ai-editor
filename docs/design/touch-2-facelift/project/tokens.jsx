/* Theme tokens artboard — React JSX. */

window.ThemeTokens = function ThemeTokens({ theme, name, blurb }) {
  const colors = [
    ["--tk-bg",      "background"],
    ["--tk-bg-1",    "panel"],
    ["--tk-bg-2",    "input"],
    ["--tk-bg-3",    "hover"],
    ["--tk-text",    "text"],
    ["--tk-text-2",  "text muted"],
    ["--tk-text-3",  "text dim"],
    ["--tk-border",  "border"],
    ["--tk-accent",  "accent"],
    ["--tk-success", "success"],
    ["--tk-warn",    "warn"],
    ["--tk-error",   "error"],
  ];
  return (
    <div className={"theme-" + theme}>
      <div className="tokens">
        <div style={{ fontFamily: "var(--tk-font-display)", fontSize: "var(--tk-fs-xl)", fontWeight: 500, letterSpacing: "-0.01em", color: "var(--tk-text)", marginBottom: 2 }}>{name}</div>
        <div style={{ fontSize: "var(--tk-fs-xs)", color: "var(--tk-text-3)", marginBottom: 12, lineHeight: 1.5 }}>{blurb}</div>

        <h4>Type</h4>
        <div className="tokens__type-row"><span className="label">display</span><span className="sample tokens__sample-display">Settings</span></div>
        <div className="tokens__type-row"><span className="label">ui</span><span className="sample tokens__sample-ui">Connect to your Git host</span></div>
        <div className="tokens__type-row"><span className="label">mono</span><span className="sample tokens__sample-mono">parseAuth(token)</span></div>

        <h4>Color</h4>
        {colors.map(([varName, label]) => (
          <div key={varName} className="tokens__row">
            <div className="tokens__swatch" style={{ background: "var(" + varName + ")" }}></div>
            <span className="tokens__name">{label}</span>
            <span className="tokens__value">{varName}</span>
          </div>
        ))}

        <h4>Plugin contract</h4>
        <div className="tokens__plug">{`/* my-theme.css */
.theme-mytheme {
  --tk-bg: #...;
  --tk-accent: #...;
  --tk-font-ui: 'Inter';
  /* override what you need */
}`}</div>
      </div>
    </div>
  );
};
