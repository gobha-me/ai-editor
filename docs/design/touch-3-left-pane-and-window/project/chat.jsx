/* Chat panel — three ambition levels, React JSX. */

window.ChatPolish = function ChatPolish({ theme }) {
  return (
    <div className={"theme-" + theme} style={{ height: "100%" }}>
      <div className="chat">
        <div className="chat__head">
          <button className="chat__model">
            <Icon.Sparkles />
            <span>Sonnet 4.5</span>
            <span className="meta">·  200k</span>
          </button>
          <span className="chat__access">● full access</span>
          <div className="chat__head-actions">
            <button className="chat__head-btn" title="New thread"><Icon.Plus /></button>
            <button className="chat__head-btn" title="More"><Icon.More /></button>
          </div>
        </div>
        <div className="chat__body">
          <div className="chat__welcome">
            <div className="chat__welcome-mark"><Icon.Sparkles /></div>
            <h3>Ask me anything</h3>
            <p>I can read your repo, explain code, and write changes back through Git.</p>
            <div className="chat__starters">
              <div className="chat__starter"><Icon.FileEdit /> Edit or refactor a file</div>
              <div className="chat__starter"><Icon.Eye /> Explain what this code does</div>
              <div className="chat__starter"><Icon.Bug /> Fix bugs from the issue tracker</div>
            </div>
          </div>
        </div>
        <div className="chat__compose">
          <textarea className="chat__textarea" placeholder="Ask, edit, or @mention a file…" />
          <div className="chat__compose-row">
            <button className="chat__compose-btn"><Icon.AtSign /> file</button>
            <button className="chat__compose-btn"><Icon.Paperclip /></button>
            <button className="chat__send">Send <kbd>⌘↵</kbd></button>
          </div>
        </div>
      </div>
    </div>
  );
};

window.ChatRestructure = function ChatRestructure({ theme }) {
  const codeStyle = { fontFamily: "var(--tk-font-mono)", fontSize: 11.5, background: "var(--tk-bg-2)", padding: "1px 5px", borderRadius: 3 };
  return (
    <div className={"theme-" + theme} style={{ height: "100%" }}>
      <div className="chat chat--restructure">
        <div className="chat__threads">
          <div className="chat__thread-item chat__thread-item--active" title="Current"><Icon.Sparkles /></div>
          <div className="chat__thread-item" title="auth refactor"><Icon.Code /></div>
          <div className="chat__thread-item" title="bug 472"><Icon.Bug /></div>
          <div className="chat__thread-item" title="commit msg"><Icon.GitCommit /></div>
          <div className="chat__thread-item" style={{ marginTop: "auto" }} title="New"><Icon.Plus /></div>
        </div>
        <div className="chat__main">
          <div className="chat__head">
            <input style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "var(--tk-text)", fontSize: "var(--tk-fs-md)", fontFamily: "inherit", fontWeight: 500 }} defaultValue="auth refactor" />
            <button className="chat__model"><Icon.Sparkles /> Sonnet 4.5</button>
            <button className="chat__head-btn"><Icon.More /></button>
          </div>
          <div className="chat__body">
            <div className="chat__msg chat__msg--user">
              <div className="chat__msg-role">you</div>
              <div className="chat__msg-body">Refactor parseAuth to handle expired tokens.</div>
            </div>
            <div className="chat__msg">
              <div className="chat__msg-role">claude</div>
              <div className="chat__msg-body">I'll wrap the parse with a try/catch and surface a typed <code style={codeStyle}>ExpiredTokenError</code>. Editing <code style={codeStyle}>auth.go</code>…</div>
            </div>
          </div>
          <div className="chat__compose">
            <textarea className="chat__textarea" placeholder="Reply…" />
            <div className="chat__compose-row">
              <button className="chat__compose-btn"><Icon.AtSign /></button>
              <button className="chat__compose-btn"><Icon.Paperclip /></button>
              <button className="chat__send">Send <kbd>⌘↵</kbd></button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

window.ChatReskin = function ChatReskin({ theme }) {
  const codeStyle = { fontFamily: "var(--tk-font-mono)", fontSize: 11.5, background: "var(--tk-bg-2)", padding: "1px 5px", borderRadius: 3 };
  return (
    <div className={"theme-" + theme} style={{ height: "100%" }}>
      <div className="chat chat--reskin">
        <div className="chat__body" style={{ padding: "22px 18px" }}>
          <div className="chat__welcome" style={{ padding: "36px 12px" }}>
            <h3 style={{ fontSize: 18, marginBottom: 8 }}>What are we working on?</h3>
            <p>I have read access to <code style={codeStyle}>main</code> · 218 files indexed.</p>
            <div className="chat__starters" style={{ maxWidth: 320 }}>
              <div className="chat__starter"><Icon.FileEdit /><span>Refactor a function</span></div>
              <div className="chat__starter"><Icon.Eye /><span>Explain something</span></div>
              <div className="chat__starter"><Icon.Bug /><span>Fix a bug</span></div>
              <div className="chat__starter"><Icon.GitCommit /><span>Write a commit message</span></div>
            </div>
          </div>
        </div>
        <div className="chat__compose" style={{ background: "transparent", border: "none", padding: "0 14px 16px" }}>
          <div style={{ background: "var(--tk-bg-2)", border: "1px solid var(--tk-border-2)", borderRadius: "var(--tk-radius-lg)", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
            <textarea className="chat__textarea" placeholder="Ask, edit, or @mention…" style={{ background: "transparent", border: "none", minHeight: 38, padding: 4 }} />
            <div className="chat__compose-row" style={{ marginTop: 0 }}>
              <button className="chat__model" style={{ background: "transparent", border: "none", padding: "4px 6px", fontSize: 11 }}><Icon.Sparkles /> Sonnet 4.5</button>
              <button className="chat__compose-btn"><Icon.AtSign /></button>
              <button className="chat__compose-btn"><Icon.Paperclip /></button>
              <button className="chat__send" style={{ borderRadius: "var(--tk-radius)" }}><Icon.Send /></button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
