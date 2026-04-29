/* Pushback panel — directional notes on docs/DESIGN-memory.md
 * Six weeks before code: argue about model and defaults now.
 */

window.Pushback = function Pushback() {
  const items = [
    {
      tag: "PUSH",
      title: "Three scopes (user / workspace / persona) is one too many for v1.",
      body: (
        <>
          <p>The doc treats <em>user</em> and <em>persona</em> as orthogonal, but in practice <strong>persona</strong> is just a named user preset. The mental model "is this fact about <em>me</em>, or about <em>this codebase</em>" is two-bucket. Adding persona forces every consent prompt to ask a 3-way question users will mostly get wrong.</p>
          <p><strong>Counter:</strong> ship 1.3.0 with <code>user</code> + <code>workspace</code>. Promote <code>persona</code> to a 1.4 once you have real usage data showing user-scope memories cluster into named groups. The chat consent prompt becomes drastically simpler — no scope picker, just a default with a "change scope" affordance for the 5% case.</p>
        </>
      ),
    },
    {
      tag: "PUSH",
      title: "Confidence scores in the data model leak ML-think into a markdown file.",
      body: (
        <>
          <p>A <code>confidence: 0.78</code> field on a memory is doing two jobs badly: (1) telling the agent how much to weight it at retrieval, (2) telling the user "this might be wrong." The first is the agent's job to compute fresh from source; persisting it in the file means it goes stale the moment the source context shifts. The second should be a UI affordance, not a number.</p>
          <p><strong>Counter:</strong> store <code>source: user_explicit | agent_proposed | inferred</code> and let that drive UI treatment. Drop the float. If you later want retrieval-time confidence, compute it; don't commit it.</p>
        </>
      ),
    },
    {
      tag: "PUSH",
      title: "Auto-staging memory on commit is the wrong default — even opt-in.",
      body: (
        <>
          <p>Memory writes that piggyback on user commits create two failure modes the doc waves at: (1) the user is committing <em>code</em>, not curating memory, so they'll rubber-stamp the diff and accumulate junk; (2) when memory is wrong, the fix is buried in a code commit's history, not a memory commit's. <code>git log .aieditor/memory/</code> becomes useless.</p>
          <p><strong>Counter:</strong> memory commits go on a separate cadence. Either (a) a dedicated "Save memory" action in the Memory tab that creates its own commit, or (b) a periodic auto-commit on a <code>memory/</code> branch that opens a PR weekly. Co-mingling muddies both signals.</p>
        </>
      ),
    },
    {
      tag: "PROBE",
      title: "The protected-branch warning needs a real escape hatch, not just a refusal.",
      body: (
        <>
          <p>Doc says memory diff "surfaces as an unstageable warning" on protected branches. That's the start of a flow, not the end of one. If a user is working on <code>main</code> (which many small repos do), they'll hit this every commit and learn to ignore it.</p>
          <p><strong>Probe:</strong> what's the intended path? My Flow 3B sketch shows a "Branch off &amp; commit memory" button that auto-creates <code>memory/auto-YYYYMMDD</code>. Is that the model? Or do you expect users to manage memory branches by hand? The answer changes whether this is a 30-second feature or a 2-day one.</p>
        </>
      ),
    },
    {
      tag: "PROBE",
      title: "Markdown-as-DB has a merge story you haven't written down.",
      body: (
        <>
          <p>Two engineers on the same workspace, both branches accept different memory proposals, both merge. <code>preferences.md</code> conflicts. Now what? Markdown merges line-by-line; semantic dedupe (same key, different values) is your problem. The doc skips this.</p>
          <p><strong>Probe:</strong> ship 1.3.0 with a deterministic key-sorted format and an explicit "last write wins on key collision" rule applied at load-time, not merge-time. That way merge conflicts are <em>visible</em> as duplicate keys and the loader picks the latest <code>updated_at</code>. Don't try to write a smart 3-way memory merge.</p>
        </>
      ),
    },
    {
      tag: "PROBE",
      title: "Editing existing surfaces stays vanilla — but consent prompts live in chat.",
      body: (
        <>
          <p>Constraint says chat panel is out-of-scope vanilla. Flow 1 punches a Preact island into <code>js/chat/messages.js</code>'s render path. That's fine, but it's the first time chat hosts a framework component, and you'll want a clean handoff: the consent card subscribes to memory state via the store hook, not via direct DOM manipulation from chat handlers.</p>
          <p><strong>Probe:</strong> define this contract before code starts — a <code>&lt;memory-proposal&gt;</code> custom-element wrapper that chat appends as a placeholder, then Preact mounts inside. That keeps the chat-panel migration question deferred without leaking memory's framework choice into chat.</p>
        </>
      ),
    },
    {
      tag: "NIT",
      title: "11→12 tabs: don't fix it now.",
      body: (
        <>
          <p>You said the Settings consolidation is deferred. I agree — Memory belongs in the existing tab strip for 1.3.0 (Flow 2A). The sidebar option (2B) is shown as a forcing function only: if Memory is the tab that breaks the strip, that's a 2.0 trigger, not a 1.3 problem. <strong>Don't ship the sidebar refactor as part of memory work.</strong></p>
        </>
      ),
    },
  ];

  const tagBg = (t) => t === "PUSH" ? "rgba(232,123,85,0.15)" : t === "PROBE" ? "rgba(97,175,239,0.15)" : "rgba(133,153,160,0.15)";
  const tagFg = (t) => t === "PUSH" ? "var(--memory)" : t === "PROBE" ? "var(--accent)" : "var(--text-muted)";

  return (
    <div style={{ padding: "1.5rem 2rem", maxWidth: 820, fontFamily: "var(--font-sans)", color: "var(--text-primary)" }}>
      <h1 style={{ fontFamily: "var(--font-serif, var(--font-sans))", fontWeight: 400, fontSize: "1.6rem", margin: "0 0 0.4rem" }}>Pushback on docs/DESIGN-memory.md</h1>
      <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-md)", margin: "0 0 1.5rem", lineHeight: 1.55 }}>
        Six weeks before code; the cheap time to argue about model and defaults.{" "}
        <span style={{ color: "var(--memory)" }}>PUSH</span> = I'd change this before shipping.{" "}
        <span style={{ color: "var(--accent)" }}>PROBE</span> = I want an answer before code starts.{" "}
        <span style={{ color: "var(--text-muted)" }}>NIT</span> = small.
      </p>
      {items.map((item, i) => (
        <div key={i} style={{ borderTop: "1px solid var(--border)", padding: "1.1rem 0" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem", marginBottom: "0.4rem" }}>
            <span style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--font-xs)",
              padding: "1px 6px",
              borderRadius: 2,
              background: tagBg(item.tag),
              color: tagFg(item.tag),
            }}>{item.tag}</span>
            <h3 style={{ margin: 0, fontSize: "var(--font-lg)", fontWeight: 500, color: "var(--text-primary)" }}>{item.title}</h3>
          </div>
          <div className="pushback-body" style={{ fontSize: "var(--font-md)", lineHeight: 1.6, color: "var(--text-secondary)" }}>
            {item.body}
          </div>
        </div>
      ))}
      <div style={{ borderTop: "1px solid var(--border)", marginTop: "1.5rem", paddingTop: "1rem", color: "var(--text-muted)", fontSize: "var(--font-sm)" }}>
        Items are ordered by what would block 1.3.0 if unanswered. Top three are model questions; bottom four are implementation-shaped.
      </div>
    </div>
  );
};
