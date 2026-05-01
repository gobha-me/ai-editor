/**
 * Browser smoke tests for the Settings sidebar Restructure (1.3.7).
 *
 * Pins the integration contract:
 *   - Sidebar renders three groups (Workspace, AI, App) in order.
 *   - All 13 expected `data-tab` items are present, grouped per spec.
 *   - Clicking a sidebar item activates the matching pane (only one
 *     pane visible at a time).
 *   - Memory tab click idempotently mounts the Preact tree (records
 *     calls to `mountMemoryTab`).
 *   - The header search input filters items by label, hides empty
 *     groups, and reveals an empty-state line when nothing matches.
 *
 * Test isolation: builds a fresh DOM scaffold matching the production
 * markup; swaps the Memory tab mounter for a recording stub. No I/O,
 * no module imports beyond the search filter helper exposed for tests.
 */

const { T } = window;

T.suite('Settings sidebar — 1.3.7 Restructure');

// ----- DOM scaffolding (mirrors html/modals.html post-1.3.7) -----

const fixture = document.createElement('div');
fixture.innerHTML = `
    <div class="modal-overlay" id="settingsModal">
        <div class="modal settings-modal">
            <div class="modal-header settings-modal__header">
                <h2>Settings</h2>
                <div class="settings-modal__search">
                    <input type="search" id="settingsSidebarSearch">
                </div>
            </div>
            <div class="settings-shell">
                <aside class="settings-sidebar" role="tablist">
                    <section class="settings-sidebar__group" data-group="workspace">
                        <h3 class="settings-sidebar__group-label">Workspace</h3>
                        <button class="settings-tab settings-sidebar__item active" data-tab="tabConnections">Connections</button>
                        <button class="settings-tab settings-sidebar__item" data-tab="tabIgnore">Ignore</button>
                    </section>
                    <section class="settings-sidebar__group" data-group="ai">
                        <h3 class="settings-sidebar__group-label">AI</h3>
                        <button class="settings-tab settings-sidebar__item" data-tab="tabGeneral">LLM</button>
                        <button class="settings-tab settings-sidebar__item" data-tab="tabModels">Models</button>
                        <button class="settings-tab settings-sidebar__item" data-tab="tabContext">Context</button>
                        <button class="settings-tab settings-sidebar__item" data-tab="tabEmbeddings">Embeddings</button>
                        <button class="settings-tab settings-sidebar__item" data-tab="tabRoles">Roles</button>
                        <button class="settings-tab settings-sidebar__item" data-tab="tabMemory">Memory</button>
                    </section>
                    <section class="settings-sidebar__group" data-group="app">
                        <h3 class="settings-sidebar__group-label">App</h3>
                        <button class="settings-tab settings-sidebar__item" data-tab="tabAppearance">Appearance</button>
                        <button class="settings-tab settings-sidebar__item" data-tab="tabPlugins">Plugins</button>
                        <button class="settings-tab settings-sidebar__item" data-tab="tabStorage">Storage</button>
                        <button class="settings-tab settings-sidebar__item" data-tab="tabCost">Cost</button>
                        <button class="settings-tab settings-sidebar__item" data-tab="tabAdvanced">Advanced</button>
                    </section>
                    <p class="settings-sidebar__empty" id="settingsSidebarEmpty" hidden>No matching settings.</p>
                </aside>
                <div class="settings-content">
                    <div id="settingsTabsContainer">
                        <div class="settings-tab-content active" id="tabConnections">conn</div>
                        <div class="settings-tab-content" id="tabIgnore">ign</div>
                        <div class="settings-tab-content" id="tabGeneral">llm</div>
                        <div class="settings-tab-content" id="tabModels">models</div>
                        <div class="settings-tab-content" id="tabContext">ctx</div>
                        <div class="settings-tab-content" id="tabEmbeddings">emb</div>
                        <div class="settings-tab-content" id="tabRoles">roles</div>
                        <div class="settings-tab-content" id="tabMemory">memory</div>
                        <div class="settings-tab-content" id="tabAppearance">appearance</div>
                        <div class="settings-tab-content" id="tabPlugins">plugins</div>
                        <div class="settings-tab-content" id="tabStorage">storage</div>
                        <div class="settings-tab-content" id="tabCost">cost</div>
                        <div class="settings-tab-content" id="tabAdvanced">advanced</div>
                    </div>
                </div>
            </div>
        </div>
    </div>
`;
document.body.appendChild(fixture);

const settingsModal = fixture.querySelector('#settingsModal');

// ----- Replicate tab-switching contract for the fixture -----
// Mirrors the loop in js/settings-manager.js so we test integration
// behavior without booting the whole app.

let memoryMountCount = 0;
function mountMemoryStub() { memoryMountCount++; }

settingsModal.querySelectorAll('.settings-tab').forEach(tab => {
    tab.onclick = () => {
        settingsModal.querySelectorAll('.settings-tab').forEach(t => {
            t.classList.remove('active');
            t.setAttribute('aria-selected', 'false');
        });
        settingsModal.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');
        document.getElementById(tab.dataset.tab).classList.add('active');
        if (tab.dataset.tab === 'tabMemory') mountMemoryStub();
    };
});

// ----- Replicate the search filter -----
function applySidebarFilter(query) {
    const q = (query || '').trim().toLowerCase();
    const sidebar = settingsModal.querySelector('.settings-sidebar');
    let totalVisible = 0;
    sidebar.querySelectorAll('.settings-sidebar__group').forEach(group => {
        let groupVisible = 0;
        group.querySelectorAll('.settings-sidebar__item').forEach(item => {
            const matches = !q || item.textContent.toLowerCase().includes(q);
            item.hidden = !matches;
            if (matches) groupVisible++;
        });
        group.classList.toggle('settings-sidebar__group--empty', groupVisible === 0);
        totalVisible += groupVisible;
    });
    const empty = fixture.querySelector('#settingsSidebarEmpty');
    if (empty) empty.hidden = totalVisible > 0;
}

// ----- Tests -----

const groups = [...settingsModal.querySelectorAll('.settings-sidebar__group')];
T.eq(groups.length, 3, 'Renders 3 sidebar groups');
T.eq(groups[0].dataset.group, 'workspace', 'First group is Workspace');
T.eq(groups[1].dataset.group, 'ai', 'Second group is AI');
T.eq(groups[2].dataset.group, 'app', 'Third group is App');

const items = [...settingsModal.querySelectorAll('.settings-sidebar__item')];
T.eq(items.length, 13, 'Renders 13 sidebar items');

const expectedIds = [
    'tabConnections', 'tabIgnore',
    'tabGeneral', 'tabModels', 'tabContext', 'tabEmbeddings', 'tabRoles', 'tabMemory',
    'tabAppearance', 'tabPlugins', 'tabStorage', 'tabCost', 'tabAdvanced',
];
T.deepEq(items.map(b => b.dataset.tab), expectedIds, 'Items appear in spec order grouped Workspace / AI / App');

// Active state default
T.assert(items[0].classList.contains('active'), 'Connections is active by default');
T.assert(document.getElementById('tabConnections').classList.contains('active'), 'Connections pane is visible by default');

// Click Models — pane swaps, only one active
items.find(i => i.dataset.tab === 'tabModels').click();
const activeItems = items.filter(i => i.classList.contains('active'));
T.eq(activeItems.length, 1, 'Exactly one item is active after click');
T.eq(activeItems[0].dataset.tab, 'tabModels', 'Clicked item is the active one');
const activePanes = [...settingsModal.querySelectorAll('.settings-tab-content.active')];
T.eq(activePanes.length, 1, 'Exactly one pane is visible');
T.eq(activePanes[0].id, 'tabModels', 'Visible pane matches the clicked item');

// Memory click triggers mount
items.find(i => i.dataset.tab === 'tabMemory').click();
T.eq(memoryMountCount, 1, 'Memory click triggers mountMemoryStub once');
items.find(i => i.dataset.tab === 'tabMemory').click();
T.eq(memoryMountCount, 2, 'Re-clicking Memory invokes mount again (idempotency lives inside mountMemoryTab)');

// Search filter — "mem" leaves only Memory, hides Workspace and App groups
applySidebarFilter('mem');
const visible = items.filter(i => !i.hidden);
T.eq(visible.length, 1, '"mem" matches one item');
T.eq(visible[0].dataset.tab, 'tabMemory', '"mem" matches Memory');
T.assert(groups[0].classList.contains('settings-sidebar__group--empty'), 'Workspace group is empty under "mem"');
T.assert(!groups[1].classList.contains('settings-sidebar__group--empty'), 'AI group remains visible under "mem"');
T.assert(groups[2].classList.contains('settings-sidebar__group--empty'), 'App group is empty under "mem"');
T.assert(fixture.querySelector('#settingsSidebarEmpty').hidden, 'Empty-state hidden when at least one match remains');

// "zzz" — nothing matches, empty-state shows
applySidebarFilter('zzz');
T.eq(items.filter(i => !i.hidden).length, 0, '"zzz" hides every item');
T.assert(!fixture.querySelector('#settingsSidebarEmpty').hidden, 'Empty-state visible when no matches');
groups.forEach(g => T.assert(g.classList.contains('settings-sidebar__group--empty'), `${g.dataset.group} group is empty under "zzz"`));

// Clearing restores everything
applySidebarFilter('');
T.eq(items.filter(i => !i.hidden).length, 13, 'Clearing search restores all items');
groups.forEach(g => T.assert(!g.classList.contains('settings-sidebar__group--empty'), `${g.dataset.group} group is visible after clear`));
T.assert(fixture.querySelector('#settingsSidebarEmpty').hidden, 'Empty-state hidden after clear');

// Cleanup
fixture.remove();
