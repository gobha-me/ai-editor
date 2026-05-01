/**
 * Browser smoke tests for the Connections panel rebuild (1.3.8).
 *
 * Pins the integration contract:
 *   - Renders one .conn__group per non-hidden registered provider.
 *   - Per-group count badge matches the number of connections of that
 *     provider; empty groups show the empty-state line.
 *   - "Add ${provider} account" buttons carry the provider id in
 *     `data-conn-add` for event delegation.
 *   - Connection rows render the URL, token-presence label, and
 *     enabled-state label in the meta line.
 *   - Status pill resolution: ok / warn (no token, _unreachable) /
 *     disabled. Warn rows render the .conn__warn-pip.
 *   - showConnectionEditor(null, providerId) preselects the provider
 *     in the dropdown and hides the URL input when provider has a
 *     fixedUrl.
 *
 * Test isolation: the GitProviderRegistry is a module singleton, so
 * the test seeds it with provider + connection fixtures, snapshots the
 * pre-test state, and restores it on teardown.
 */

import { GitProviderRegistry } from '../js/git-providers/index.js';
import {
    __test_renderConnectionsGroups,
    __test_showConnectionEditor,
} from '../js/settings/connections-tab.js';

const { T } = window;

T.suite('Connections panel — 1.3.8 Touch 2 layout');

// ----- DOM scaffold (mirrors html/settings-tabs.html post-1.3.8) -----

const fixture = document.createElement('div');
fixture.innerHTML = `
    <div class="settings-tab-content active" id="tabConnections">
        <div class="conn">
            <div id="connectionsGroups"></div>
        </div>
        <div id="connectionEditor" style="display: none;">
            <h4 id="connectionEditorTitle">New Connection</h4>
            <select id="connEditProvider"></select>
            <div id="connEditUrlGroup">
                <input id="connEditUrl">
            </div>
            <input id="connEditLabel">
            <input id="connEditToken">
            <input type="checkbox" id="connEditEnabled">
            <div id="connectionTestResult"></div>
        </div>
    </div>
`;
document.body.appendChild(fixture);

// ----- Snapshot existing registry state, seed test fixtures -----

const priorConnections = GitProviderRegistry.listConnections();
GitProviderRegistry.loadConnections([]);

const fakeGithub = {
    id: 'github', name: 'GitHub', icon: '🐙', fixedUrl: 'https://api.github.com',
    listRepos: async () => [], testConnection: async () => ({ ok: true })
};
const fakeGitea = {
    id: 'gitea', name: 'Gitea', icon: '🍵',
    listRepos: async () => [], testConnection: async () => ({ ok: true })
};
const fakeGitlab = {
    id: 'gitlab', name: 'GitLab', icon: '🦊', fixedUrl: 'https://gitlab.com/api/v4',
    listRepos: async () => [], testConnection: async () => ({ ok: true })
};

// register() merges with BASE_GIT_PROVIDER and is idempotent for our purposes —
// re-registering with the same id replaces the prior entry.
GitProviderRegistry.register(fakeGithub);
GitProviderRegistry.register(fakeGitea);
GitProviderRegistry.register(fakeGitlab);

GitProviderRegistry.addConnection({ id: 'gh-personal', provider: 'github', label: 'personal', url: 'https://api.github.com', token: 'tok-1', enabled: true });
GitProviderRegistry.addConnection({ id: 'gh-work',     provider: 'github', label: 'work',     url: 'https://api.github.com', token: 'tok-2', enabled: false });
GitProviderRegistry.addConnection({ id: 'gitea-home',  provider: 'gitea',  label: 'home lab', url: 'https://git.example.dev', token: '',       enabled: true });

const giteaConn = GitProviderRegistry.listConnections().find(c => c.id === 'gitea-home');
giteaConn._unreachable = true; // simulate circuit-breaker tripped

// ----- Render -----

__test_renderConnectionsGroups();

const groupsEl = fixture.querySelector('#connectionsGroups');
const groups = [...groupsEl.querySelectorAll('.conn__group')];

// ----- Group structure -----

T.eq(groups.length, 3, 'Renders one .conn__group per non-hidden provider');

// Real registration order in js/git-providers/index.js is gitea → github →
// gitlab → local (local is hidden). The renderer iterates the registry, so
// the rendered order matches that — assert the test's expectation against
// reality, not the design mockup's alphabetical impulse.
T.deepEq(
    groups.map(g => g.dataset.provider),
    ['gitea', 'github', 'gitlab'],
    'Groups appear in registry order (gitea, github, gitlab)'
);

// ----- Per-group counts (look up by provider id, not index) -----

const githubGroup = groupsEl.querySelector('.conn__group[data-provider="github"]');
const giteaGroup  = groupsEl.querySelector('.conn__group[data-provider="gitea"]');
const gitlabGroup = groupsEl.querySelector('.conn__group[data-provider="gitlab"]');
T.assert(githubGroup && giteaGroup && gitlabGroup, 'All three provider groups are queryable by data-provider');

T.eq(githubGroup.querySelector('.conn__provider-count').textContent, '2', 'GitHub group count is 2');
T.eq(giteaGroup.querySelector('.conn__provider-count').textContent,  '1', 'Gitea group count is 1');
T.eq(gitlabGroup.querySelector('.conn__provider-count').textContent, '0', 'GitLab group count is 0');

T.eq(githubGroup.querySelectorAll('.conn__row').length, 2, 'GitHub group renders 2 rows');
T.eq(giteaGroup.querySelectorAll('.conn__row').length,  1, 'Gitea group renders 1 row');
T.eq(gitlabGroup.querySelectorAll('.conn__row').length, 0, 'GitLab group renders 0 rows');

T.assert(gitlabGroup.querySelector('.conn__empty'), 'Empty GitLab group renders the empty-state line');

// ----- Add buttons carry provider id for event delegation -----

const addBtns = [...groupsEl.querySelectorAll('[data-conn-add]')];
T.deepEq(
    addBtns.map(b => b.dataset.connAdd).sort(),
    ['gitea', 'github', 'gitlab'],
    'Each group has an Add button keyed to its provider id'
);

// ----- Provider glyph -----

T.eq(githubGroup.querySelector('.conn__provider-glyph').textContent, 'GH', 'GitHub glyph is GH');
T.eq(giteaGroup.querySelector('.conn__provider-glyph').textContent,  'GT', 'Gitea glyph is GT');
T.eq(gitlabGroup.querySelector('.conn__provider-glyph').textContent, 'GL', 'GitLab glyph is GL');

// ----- Row content & status pill resolution -----

const personalRow = githubGroup.querySelector('[data-conn-id="gh-personal"]');
T.assert(personalRow, 'gh-personal row exists');
T.assert(personalRow.querySelector('.conn__status--ok'), 'gh-personal renders status--ok (token present, enabled, not unreachable)');
T.assert(!personalRow.querySelector('.conn__warn-pip'),  'gh-personal has no warn pip');
T.assert(personalRow.querySelector('.conn__row-meta').textContent.includes('token saved'), 'gh-personal meta line shows "token saved"');
T.assert(personalRow.querySelector('.conn__row-meta').textContent.includes('enabled'),     'gh-personal meta line shows "enabled"');

const workRow = githubGroup.querySelector('[data-conn-id="gh-work"]');
T.assert(workRow.classList.contains('conn__row--disabled'), 'gh-work row carries the disabled modifier');
T.assert(workRow.querySelector('.conn__status--disabled'), 'gh-work renders status--disabled (enabled:false)');
T.assert(workRow.querySelector('.conn__row-meta').textContent.includes('disabled'), 'gh-work meta line shows "disabled"');

const homeRow = giteaGroup.querySelector('[data-conn-id="gitea-home"]');
T.assert(homeRow.querySelector('.conn__status--warn'), 'gitea-home renders status--warn (_unreachable)');
T.assert(homeRow.querySelector('.conn__warn-pip'),     'gitea-home renders the warn pip');

// ----- showConnectionEditor preselects provider + hides URL when fixed -----

__test_showConnectionEditor(null, 'github');
T.eq(document.getElementById('connEditProvider').value, 'github', 'Editor preselects GitHub when opened from the GitHub group');
T.eq(document.getElementById('connEditUrlGroup').style.display, 'none', 'URL field hidden for fixedUrl provider (GitHub)');
T.eq(
    document.getElementById('connectionEditorTitle').textContent,
    'New GitHub Connection',
    'Editor title surfaces the preselected provider name'
);

__test_showConnectionEditor(null, 'gitea');
T.eq(document.getElementById('connEditProvider').value, 'gitea', 'Editor preselects Gitea when opened from the Gitea group');
T.assert(document.getElementById('connEditUrlGroup').style.display !== 'none', 'URL field visible for non-fixedUrl provider (Gitea)');

// ----- Cleanup: restore prior connections; seeded providers stay (registry has no unregister) -----

GitProviderRegistry.loadConnections(priorConnections);
fixture.remove();
