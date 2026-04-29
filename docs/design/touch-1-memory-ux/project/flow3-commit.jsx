/* Flow 3 — Commit modal with pending memory writes */

const { useState: useState3 } = React;

function CommitModalMock({ isProtected }) {
  const [msg, setMsg] = useState3(isProtected
    ? "fix(auth): handle expired refresh token"
    : "feat(tests): add table-driven cases for parseAuth");
  const [showMemDetails, setShowMemDetails] = useState3(false);

  const codeFiles = isProtected
    ? [
        { path: "js/llm/api.js", add: 12, del: 4 },
        { path: "js/chat/handlers.js", add: 8, del: 2 },
      ]
    : [
        { path: "tests/auth_test.go", add: 47, del: 0 },
        { path: "auth.go", add: 3, del: 1 },
      ];
  const memFiles = [
    { path: ".aieditor/memory/preferences.md", add: 2, del: 0,
      preview: "+ test_style: table-driven with subtests; one t.Run per case\n+ (auto-staged 2:14pm from chat)" },
  ];

  const monoSm = { fontFamily: "var(--font-mono)", fontSize: 11 };

  return (
    <div className="mock-modal">
      <div className="mock-modal__head">
        <h3>Commit changes</h3>
        <span className="close">×</span>
      </div>
      <div className="mock-modal__body">
        <div className="branch-row">
          <span className="branch-row__label">branch</span>
          <code className="branch-row__name">{isProtected ? "main" : "refactor-auth"}</code>
          {isProtected ? (
            <span className="branch-row__protected">⛨ protected</span>
          ) : (
            <span className="branch-row__protected" style={{ color: "var(--text-muted)", background: "transparent", borderColor: "transparent" }}>tracking origin/refactor-auth</span>
          )}
        </div>

        <div className="commit-section">
          <div className="commit-section__head">
            <span className="commit-section__title">Code changes</span>
            <span className="commit-section__count">
              {codeFiles.length} files · {codeFiles.reduce((s,f)=>s+f.add,0)} added · {codeFiles.reduce((s,f)=>s+f.del,0)} removed
            </span>
          </div>
          {codeFiles.map((f) => (
            <div key={f.path} className="commit-file">
              <input type="checkbox" defaultChecked />
              <code className="path">{f.path}</code>
              <span className="commit-file__stats">
                <span className="add">+{f.add}</span>
                <span className="del">−{f.del}</span>
              </span>
            </div>
          ))}
        </div>

        {isProtected ? (
          <div className="commit-section commit-section--warn">
            <div className="commit-section__head">
              <span className="commit-section__title commit-section__title--warn">⚠ Memory writes can't be staged here</span>
              <span className="commit-section__count">on protected branch</span>
            </div>
            <p className="commit-section__hint">
              You have <strong>1 pending memory update</strong>. It won't be committed to <code style={monoSm}>main</code> — these usually land on feature branches or in a dedicated <code style={monoSm}>memory/</code> branch.
            </p>
            {memFiles.map((f) => (
              <div key={f.path} className="commit-file commit-file--mem commit-file--disabled">
                <input type="checkbox" disabled />
                <code className="path">{f.path}</code>
                <span className="commit-file__stats">
                  <span className="add">+{f.add}</span>
                </span>
              </div>
            ))}
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.6rem" }}>
              <button className="mem-btn">Branch off & commit memory</button>
              <button className="mem-btn mem-btn--ghost">Keep pending</button>
              <button className="mem-btn mem-btn--ghost">Discard</button>
            </div>
          </div>
        ) : (
          <div className="commit-section commit-section--mem">
            <div className="commit-section__head">
              <span className="commit-section__title commit-section__title--mem">◆ Memory updates</span>
              <span className="commit-section__count">auto-staged · 1 file</span>
              <a className="src-link" style={{ marginLeft: "auto" }}
                onClick={() => setShowMemDetails(!showMemDetails)}>{showMemDetails ? "Hide" : "Show"} diff</a>
            </div>
            {memFiles.map((f) => (
              <React.Fragment key={f.path}>
                <div className="commit-file commit-file--mem">
                  <input type="checkbox" defaultChecked />
                  <code className="path">{f.path}</code>
                  <span className="commit-file__stats">
                    <span className="add">+{f.add}</span>
                  </span>
                </div>
                {showMemDetails && (
                  <pre style={{ fontFamily: "var(--font-mono)", fontSize: 11, background: "var(--bg-darker, #1a1a1a)", padding: "0.6rem 0.75rem", borderRadius: 3, marginTop: "0.5rem", color: "var(--text-secondary)", whiteSpace: "pre-wrap" }}>{f.preview}</pre>
                )}
              </React.Fragment>
            ))}
          </div>
        )}

        <div className="field" style={{ marginTop: "1rem" }}>
          <label style={{ display: "block", fontSize: "var(--font-xs)", color: "var(--text-muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>commit message</label>
          <textarea className="commit-msg" rows={3}
            value={msg} onInput={(e) => setMsg(e.currentTarget.value)}></textarea>
        </div>
      </div>
      <div className="mock-modal__foot">
        <button className="mem-btn mem-btn--ghost">Cancel</button>
        <button className="mem-btn">Stage only</button>
        <button className="mem-btn mem-btn--primary">Commit {isProtected ? "(code only)" : "& push"}</button>
      </div>
    </div>
  );
}

window.Flow3A = function Flow3A() {
  return <CommitModalMock isProtected={false} />;
};

window.Flow3B = function Flow3B() {
  return <CommitModalMock isProtected={true} />;
};
