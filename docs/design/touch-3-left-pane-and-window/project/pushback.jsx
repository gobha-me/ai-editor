/* Pushback memo — React JSX */

window.Pushback = function Pushback() {
  const items = [
    {
      tag: "FRAME", tone: "frame",
      title: "The real problem isn't the chrome — it's that the app has no shape.",
      body: (<>
        <p>You said it: ugly from day 1, only gotten more cluttered. The cause is that 1.0 was a single-pane MVP and every release since has stapled features onto whatever surface had room. Memory landed in Settings because Settings had a tab strip. Issues and PRs landed in the left rail because the rail had vertical space. The chat panel grew a model picker, an access pill, a send button, and an attach button next to each other because the compose bar had pixels left.</p>
        <p>A facelift that only re-skins this loses. Within two releases we'd be back here. <strong className="callout">The work is to give every surface a job, then design to that job</strong> — top bar = identity + global state, settings = configuration, chat = conversation, and (newly) <strong className="callout">debug = diagnostics, help = docs</strong>. Anything that doesn't fit one of those gets a new home or gets cut.</p>
      </>),
    },
    {
      tag: "GAP", tone: "gap",
      title: "Three surfaces missing from the original brief. We have to design them now.",
      body: (<>
        <p>The brief said top bar / settings / chat. While auditing the app I found three things that aren't on that list but are wired into the same chrome and will undo the facelift if we ignore them:</p>
        <p>(1) <strong className="callout">Connections is N-of-each, not 1-per-provider.</strong> The original Settings mockup had a single "Git host" dropdown. Real users have two GitHub accounts (personal + work) plus self-hosted Gitea or GitLab. The repo dropdown in the top bar pulls from <em>all</em> of them, so the data model and the picker UI both have to handle aggregation with provider provenance. I've redesigned Connections as a per-provider list with "Add another" on each, plus an aggregated repo picker that shows where each repo came from.</p>
        <p>(2) <strong className="callout">There is no debug surface.</strong> When the indexer falls behind, when a connection's token expires mid-session, when a plugin throws — there's nowhere for the user to see it. They open devtools or file a ticket. I've added a Debug panel: live log stream with level filter, connection health + last error, indexer queue, AI request log with tokens/latency, plugin warnings, "Copy diagnostic bundle" button.</p>
        <p>(3) <strong className="callout">Help is a single icon that opens a marketing page.</strong> The app has hotkeys, a plugin SDK, tools, roles, and an architecture worth documenting — none of it is reachable from inside the app. I've added a Help panel: left-rail nav across docs, search-all with snippets, and a data-driven hotkeys page that renders ⌘ on mac and Ctrl on win/linux automatically.</p>
        <p>Both new panels are slide-outs from the right edge — same pattern as Settings — so they don't fight chat for the main column.</p>
      </>),
    },
    {
      tag: "PUSH", tone: "push",
      title: "Don't redesign the top bar. Replace its purpose.",
      body: (<>
        <p>The current top bar is five unlabeled icons doing five unrelated jobs (revert, settings, plugins, models, help). Adding labels won't fix it because the underlying problem is that the top bar is being used as a junk drawer for actions that have no other home.</p>
        <p><strong className="callout">LOCKED — ship Restructure.</strong> The top bar holds <em>identity</em> (brand + repo + branch + connection state) and <em>command surface</em> (⌘K). Everything else moves: revert → editor toolbar where the diff lives, plugins → settings, model picker → chat compose. The icon row pares from 5 to 3: <em>Settings, Help, Debug</em>. Both theme variants (Refined + Editorial) ship as the same component.</p>
      </>),
    },
    {
      tag: "DECIDED", tone: "decided",
      title: "One top bar, both themes. Reskin is dead.",
      body: (<>
        <p>I'd previously argued Restructure-vs-Reskin should be a per-user audience default. After review: that's two layouts to maintain to serve a population (newcomers using a developer tool) that's smaller than the engineering cost. <strong className="callout">Killed.</strong> One top bar, two theme skins.</p>
        <p>Discoverability for newcomers is solved by ⌘K and the new Help panel — the menu bar (File / Edit / View / Git / AI / Help) was solving the wrong problem.</p>
      </>),
    },
    {
      tag: "PUSH", tone: "push",
      title: "Tabs in Settings are dead. Stop treating them like they have a future.",
      body: (<>
        <p>You're at 11. Memory makes 12. Connections-as-list (now that it's N-of-each) effectively makes 13 because it needs its own page. Horizontal tab strips break at ~7 tabs on a 14" laptop, and you've been hiding the breakage by letting tabs scroll horizontally — which is a UX failure mode, not a feature.</p>
        <p><strong className="callout">LOCKED — ship Restructure.</strong> Vertical sidebar grouped Workspace / AI / App. Scales to 30+ items without redesign. ⌘K-search-settings comes free. Both theme variants ship as the same component. Polish (tabs) and Reskin (breadcrumbs) are off the table.</p>
      </>),
    },
    {
      tag: "PUSH", tone: "push",
      title: "The chat panel's welcome state is the lowest-leverage surface. Stop polishing it.",
      body: (<>
        <p>Users see the welcome state once. The compose bar and message stream — they see those a thousand times. Today the welcome state has a wave emoji, four bullet points, and visual weight equal to a 200-message thread. The compose bar has unlabeled icons and no model context.</p>
        <p><strong className="callout">Counter:</strong> the redesign should make the welcome state quieter (Reskin artboard) and the <em>compose bar</em> louder. Model picker belongs in the compose area, not the header. Thread switching belongs in a sidebar (Restructure artboard) — chat is now thread-shaped, single-thread is a bug.</p>
      </>),
    },
    {
      tag: "PROBE", tone: "probe",
      title: "Themes-as-plugin is the right call. The contract has to be designed up front.",
      body: (<>
        <p>You said themes are part of the plugin system, with an in-house opinion and easy add for others. Good — that's the only sane way. But two things have to be true on day one or third-party themes will be broken forever:</p>
        <p>(1) <strong className="callout">A frozen token vocabulary.</strong> Every color, font, radius, and spacing the app reads must come from <code>--tk-*</code>. No hardcoded hex anywhere in app CSS. The "Theme tokens" artboards show the contract; once published, removing a token is a breaking change.</p>
        <p>(2) <strong className="callout">A theme has to be one CSS file.</strong> Not a JS bundle, not a manifest. Drop a <code>.css</code> in <code>plugins/themes/</code>, the app picks it up. If theming requires JS, you'll get five themes total and they'll all be by you.</p>
      </>),
    },
    {
      tag: "PROBE", tone: "probe",
      title: "Two visual directions, one question: how loud do you want to be?",
      body: (<>
        <p>I cut the third direction (a Linear/Raycast/Zed clone) before bringing this to you. It read as "we copied Linear" no matter how I pushed it, and the only thing it added over Refined IDE was higher contrast — which you can get with a contrast slider. Two directions, not three:</p>
        <p><strong className="callout">Refined IDE</strong> is safe. Same family as Cursor/VSCode, executed properly. Won't surprise anyone. Lowest risk, lowest narrative.</p>
        <p><strong className="callout">Editorial Calm</strong> is the contrarian bet. Serif headings, generous space, warm neutrals. Says "AI editors don't have to feel like terminals." Highest upside if it lands, biggest miss if it reads as precious. <em>Don't ship as default — ship as a theme</em> and let it earn its way to default.</p>
        <p>My read: <strong className="callout">ship Refined IDE as the new default. Ship Editorial Calm as a bundled theme.</strong> Themes-as-plugin makes this nearly free, and one bundled alternative is enough to prove the contract works.</p>
      </>),
    },
    {
      tag: "PROBE", tone: "probe",
      title: "Iconography: pick one family and burn the emoji.",
      body: (<>
        <p>Today: ⚡ in the brand mark, 👋 in chat welcome, 🚀 in zip upload, plus emoji on file-tree action buttons. They render differently on every OS, they don't scale, they undermine every other type and color choice you make. They're also why the app reads as "scrappy weekend project" even when the engineering is solid.</p>
        <p><strong className="callout">Counter:</strong> Lucide. 1.6 stroke weight, line style, ~1500 icons, MIT, exact same family as Vercel/Linear/Replicate. I've used it across all artboards — every icon you see is one family. Emoji stays for user content; UI uses Lucide only.</p>
      </>),
    },
    {
      tag: "PROBE", tone: "probe",
      title: "Typography: stop using the system stack for everything.",
      body: (<>
        <p>System stack means UI on macOS uses SF, on Windows uses Segoe, on Linux whatever's installed. The app looks subtly different to every user, hierarchy varies because metrics differ, you have no opinion. That's a default, not a choice.</p>
        <p><strong className="callout">Counter:</strong> Inter for UI (Refined IDE), IBM Plex Sans + Source Serif 4 for Editorial Calm. JetBrains Mono / IBM Plex Mono for code surfaces. Self-hosted woff2.</p>
      </>),
    },
    {
      tag: "NIT", tone: "nit",
      title: "Status bar is empty real estate. Don't waste it.",
      body: (<>
        <p>The bottom strip currently shows <code>main</code> and a dot. It could carry: branch + ahead/behind, dirty-files count, current model + remaining tokens, indexer status, plugin warnings. <strong className="callout">Out of scope for this round</strong> — flagging for next.</p>
      </>),
    },
    {
      tag: "NIT", tone: "nit",
      title: "The left rail is fine for now.",
      body: (<>
        <p>You flagged top bar / settings / chat as the weak surfaces. Agreed. The left rail (Projects + Files + Issues + PRs stacked) is also undifferentiated, but it works because users scroll past it once and live in Files. Touch in a future release; not this one.</p>
      </>),
    },
  ];

  return (
    <div className="memo">
      <h1>Whole-app facelift — strategy memo</h1>
      <p className="lede">Two visual directions. Top bar + Settings <strong className="callout">locked to Restructure</strong>. Plus three surfaces the original brief missed.</p>
      <div className="legend">
        <span><strong className="memo__tag memo__tag--frame">FRAME</strong> the bigger problem</span>
        <span><strong className="memo__tag memo__tag--gap">GAP</strong> missing from brief</span>
        <span><strong className="memo__tag memo__tag--push">PUSH</strong> change before shipping</span>
        <span><strong className="memo__tag memo__tag--decided">DECIDED</strong> locked, no longer up for debate</span>
        <span><strong className="memo__tag memo__tag--probe">PROBE</strong> answer before code</span>
        <span><strong className="memo__tag memo__tag--nit">NIT</strong> small</span>
      </div>
      {items.map((it, i) => (
        <div key={i} className="memo__item">
          <div className="memo__item-head">
            <span className={"memo__tag memo__tag--" + it.tone}>{it.tag}</span>
            <h3 className="memo__title">{it.title}</h3>
          </div>
          <div className="memo__body">{it.body}</div>
        </div>
      ))}
      <div style={{ borderTop: "1px solid #232833", marginTop: 22, paddingTop: 14, color: "#6c7280", fontSize: 12 }}>
        <strong style={{ color: "#a8b3bf" }}>For the coder:</strong> Top bar = Restructure (one component, theme via <code>--tk-*</code>). Settings = Restructure sidebar. Connections, Debug, Help are net-new surfaces — see their sections. Chat panel is still in exploration; don't build yet. Theme tokens are the public contract.
      </div>
    </div>
  );
};
