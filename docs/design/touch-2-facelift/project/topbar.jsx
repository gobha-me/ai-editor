/* Top bar — three ambition levels, React JSX. */

window.TopBarPolish = function TopBarPolish({ theme }) {
  return (
    <div className={"surface theme-" + theme}>
      <div className="tb tb--polish">
        <div className="tb__brand">
          <div className="tb__brand-mark"><Icon.Bolt /></div>
          AI Editor <span className="tb__version">1.3.1</span>
        </div>
        <div className="tb__divider"></div>
        <div className="tb__group">
          <button className="tb__btn" title="Branch"><Icon.GitBranch /> main</button>
          <button className="tb__btn tb__btn--icon" title="Revert changes"><Icon.Undo /></button>
        </div>
        <div className="tb__usage">
          <span className="num">12.4k</span> tok · <span className="num">38</span> req
        </div>
        <div className="tb__right">
          <span className="tb__status-dot" title="Connected"></span>
          <button className="tb__btn tb__btn--icon" title="Plugins"><Icon.Plug /></button>
          <button className="tb__btn tb__btn--icon" title="Help"><Icon.Help /></button>
          <button className="tb__btn tb__btn--icon" title="Settings"><Icon.Settings /></button>
        </div>
      </div>
    </div>
  );
};

window.TopBarRestructure = function TopBarRestructure({ theme }) {
  return (
    <div className={"surface theme-" + theme}>
      <div className="tb tb--restructure">
        <div className="tb__brand">
          <div className="tb__brand-mark"><Icon.Bolt /></div>
          AI Editor
        </div>
        <div className="tb__divider"></div>
        <button className="tb__btn"><Icon.GitBranch /> main <span className="tb__version">·  3 ahead</span></button>
        <div className="tb__cmd">
          <Icon.Search />
          <span>Search files, run commands, ask AI…</span>
          <kbd>⌘K</kbd>
        </div>
        <div className="tb__right">
          <div className="tb__usage"><span className="num">12.4k</span> tok</div>
          <div className="tb__divider"></div>
          <button className="tb__btn tb__btn--icon" title="Plugins"><Icon.Plug /></button>
          <button className="tb__btn tb__btn--icon" title="Settings"><Icon.Settings /></button>
          <div className="tb__avatar">P</div>
        </div>
      </div>
    </div>
  );
};

window.TopBarReskin = function TopBarReskin({ theme }) {
  return (
    <div className={"surface theme-" + theme}>
      <div className="tb tb--reskin" style={{ padding: "0 0 0 12px" }}>
        <div className="tb__brand" style={{ paddingRight: 14 }}>
          <div className="tb__brand-mark"><Icon.Bolt /></div>
        </div>
        <div className="tb__menu">
          <button className="tb__btn">File</button>
          <button className="tb__btn">Edit</button>
          <button className="tb__btn">View</button>
          <button className="tb__btn">Git</button>
          <button className="tb__btn">AI</button>
          <button className="tb__btn">Help</button>
        </div>
        <div className="tb__right" style={{ paddingRight: 12 }}>
          <div className="tb__cmd" style={{ maxWidth: 240 }}>
            <Icon.Search />
            <span>Command palette</span>
            <kbd>⌘K</kbd>
          </div>
          <div className="tb__avatar">P</div>
        </div>
      </div>
    </div>
  );
};
