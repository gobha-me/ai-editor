/* Flow 1 — Memory consent prompt in chat
 * Two variants exposed via probe-controls:
 *   default — full inline card (recommended)
 *   quiet   — single-line dashed indicator (for proposal frequency = minimal)
 */

const { useState: useState1 } = React;

function MockChat({ children, headline = "PROJ · refactor-auth" }) {
  return (
    <div className="mock-chat">
      <div className="mock-chat__header">
        <span style={{ color: "var(--accent)" }}>●</span>
        <span>{headline}</span>
        <span style={{ marginLeft: "auto", fontSize: "var(--chat-xs)", color: "var(--text-muted)" }}>claude-sonnet-4.5</span>
      </div>
      <div className="mock-chat__messages">{children}</div>
      <div className="mock-chat__input">
        <textarea placeholder="Ask about your code…" rows={2}></textarea>
      </div>
    </div>
  );
}

function ConsentCard({ variant, state, setState, draft, setDraft, candidate }) {
  const editing = state === "editing";
  const dismissed = state === "dismissed";
  const saved = state === "saved";

  const onAccept = () => setState("saved");
  const onEdit = () => setState(editing ? "saved" : "editing");
  const onDismiss = () => setState("dismissed");
  const onUndo = () => setState("open");
  const onSaveEdit = () => setState("saved");

  if (variant === "quiet" && !editing && !saved) {
    return (
      <div className={"mem-consent mem-consent--quiet " + (dismissed ? "is-dismissed" : "")}>
        <div className="mem-consent__line" onClick={() => setState("editing")}>
          <span className="icon">◆</span>
          <span className="label">Remember as workspace memory?</span>
          <span className="preview">{candidate.key}: {candidate.value}</span>
          <button className="mem-btn mem-btn--ghost" onClick={(e) => { e.stopPropagation(); onAccept(); }}>Save</button>
          <button className="mem-btn mem-btn--ghost" onClick={(e) => { e.stopPropagation(); onDismiss(); }}>×</button>
        </div>
      </div>
    );
  }

  if (saved) {
    return (
      <div className="mem-consent is-saved">
        <div className="mem-consent__head">
          <span>✓ Saved to memory</span>
          <span className="scope">.aieditor/memory/preferences.md</span>
        </div>
        <div className="mem-consent__body">
          <div className="mem-consent__kv">
            <span className="key">{candidate.key}</span><span className="colon">: </span>
            <span>{draft || candidate.value}</span>
          </div>
          <div className="mem-consent__why">
            Will be staged with your next commit on{" "}
            <code style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>refactor-auth</code>.
            {" "}<a className="src-link" onClick={onUndo}>Undo</a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={"mem-consent " + (dismissed ? "is-dismissed" : "")}>
      <div className="mem-consent__head">
        <span>◆ Remember</span>
        <span className="scope">scope: {candidate.scope}</span>
      </div>
      <div className="mem-consent__body">
        <div className="mem-consent__kv">
          <span className="key">{candidate.key}</span><span className="colon">: </span>
          {editing ? (
            <input className="value-input" value={draft || candidate.value}
              onInput={(e) => setDraft(e.currentTarget.value)} autoFocus />
          ) : (
            <span>{draft || candidate.value}</span>
          )}
        </div>
        <div className="mem-consent__why">
          Inferred from your last 3 turns about <a className="src-link">tests/test-llm-pure.js</a>.
          {" "}Stored as <code style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>user_explicit</code> if you accept.
        </div>
      </div>
      <div className="mem-consent__actions">
        <span className="spacer"></span>
        {editing ? (
          <>
            <button className="mem-btn" onClick={() => setState("open")}>Cancel</button>
            <button className="mem-btn mem-btn--primary" onClick={onSaveEdit}>Save edit <span className="kbd">↵</span></button>
          </>
        ) : (
          <>
            <button className="mem-btn mem-btn--ghost" onClick={onDismiss}>Dismiss</button>
            <button className="mem-btn" onClick={onEdit}>Edit</button>
            <button className="mem-btn mem-btn--primary" onClick={onAccept}>Remember <span className="kbd">↵</span></button>
          </>
        )}
      </div>
    </div>
  );
}

window.Flow1 = function Flow1() {
  const [variant, setVariant] = useState1("default");
  const [state, setState] = useState1("open");
  const [draft, setDraft] = useState1("");
  const candidate = {
    key: "test_style",
    value: "table-driven tests with subtests; one t.Run per case",
    scope: "workspace",
  };

  const codeStyle = { fontFamily: "var(--font-mono)", fontSize: "0.9em", background: "rgba(0,0,0,0.25)", padding: "1px 4px", borderRadius: 2 };

  return (
    <div className="artboard-frame artboard-frame--chat">
      <div className="artboard-titlebar">
        <span className="dot"></span><span className="dot"></span><span className="dot"></span>
        <span style={{ marginLeft: "0.5rem" }}>Chat panel — proposal in stream</span>
        <span className="path">js/chat/messages.js</span>
      </div>
      <div className="probe-controls">
        <span className="label">variant:</span>
        <div className="seg">
          <button className={variant === "default" ? "active" : ""} onClick={() => { setVariant("default"); setState("open"); }}>Inline card</button>
          <button className={variant === "quiet" ? "active" : ""} onClick={() => { setVariant("quiet"); setState("open"); }}>Quiet line</button>
        </div>
        <span className="label" style={{ marginLeft: "auto" }}>state: <code style={{ color: "var(--text-secondary)" }}>{state}</code></span>
        <button className="mem-tab__btn" onClick={() => setState("open")}>Reset</button>
      </div>
      <MockChat>
        <div className="mock-msg">
          <div className="mock-msg__role">you · 2:14pm</div>
          <div className="mock-msg__content">
            Add a table-driven test for the new <code style={codeStyle}>parseAuth()</code> helper. Same shape as the others — one t.Run per case.
          </div>
        </div>
        <div className="mock-msg">
          <div className="mock-msg__role">claude · 2:14pm</div>
          <div className="mock-msg__content">
            Done. Added <code style={codeStyle}>TestParseAuth</code> with 6 cases following your subtest pattern.
            <div className="mock-tool"><span className="name">edit_file</span><span className="arg">tests/auth_test.go +47 −0</span></div>
          </div>
        </div>
        <ConsentCard
          variant={variant}
          state={state}
          setState={setState}
          draft={draft}
          setDraft={setDraft}
          candidate={candidate}
        />
        <div className="mock-msg">
          <div className="mock-msg__role">claude · 2:14pm</div>
          <div className="mock-msg__content" style={{ opacity: 0.6 }}>Want me to add a benchmark too, or move on to the integration test?</div>
        </div>
      </MockChat>
    </div>
  );
};
