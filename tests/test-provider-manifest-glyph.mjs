// @ts-check
/**
 * Tests for the 2.26.0 `provider.glyph` manifest field.
 *
 * Pre-2.26.0, `js/settings/connections-tab.js#glyphFor` carried a hardcoded
 * `{github, gitea, gitlab, bitbucket, local} → 2-letter code` map and a
 * stale `bitbucket: 'BB'` entry for a provider that was never registered
 * (audit entry `[REG] [S] [needs-investigation]`). 2.26.0 moves the per-
 * provider 2-letter code into the provider's own manifest as `glyph`, and
 * the consumer becomes a thin `GitProviderRegistry.get(id)?.glyph` lookup
 * with a first-2-chars fallback for forward-compat.
 *
 * Audit entries closed: `[HC] [S] [likely] glyphFor in connections-tab.js
 * hardcodes provider→glyph map` + `[REG] [S] [needs-investigation]
 * bitbucket listed in glyphFor but no bitbucketProvider registered`.
 *
 * @since 2.26.0
 */

import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import giteaProvider from '../js/git-providers/gitea.js';
import githubProvider from '../js/git-providers/github.js';
import gitlabProvider from '../js/git-providers/gitlab.js';
import { LOCAL_PROVIDER } from '../js/git-providers/local.js';
import { GitProviderRegistry } from '../js/git-providers/registry.js';

// ============================================
// Manifest shape — each registered provider declares a 2-char glyph
// ============================================

test('every registered provider manifest exposes a 2-character glyph string', () => {
    for (const p of [giteaProvider, githubProvider, gitlabProvider, LOCAL_PROVIDER]) {
        assert.equal(typeof p.glyph, 'string', `${p.id} provider must declare a string glyph`);
        assert.equal(p.glyph.length, 2, `${p.id}.glyph must be exactly 2 chars (got "${p.glyph}")`);
        assert.equal(p.glyph, p.glyph.toUpperCase(), `${p.id}.glyph must be uppercase`);
    }
});

test('the four built-in glyphs match the pre-2.26.0 connections-tab map', () => {
    // Pre-2.26.0 hardcoded values, now sourced from each manifest. The
    // bitbucket: 'BB' entry from the old map is dropped — no provider
    // registered, so no glyph needed.
    assert.equal(giteaProvider.glyph, 'GT');
    assert.equal(githubProvider.glyph, 'GH');
    assert.equal(gitlabProvider.glyph, 'GL');
    assert.equal(LOCAL_PROVIDER.glyph, 'ZP');
});

// ============================================
// Registry lookup — `glyphFor` consumes through `GitProviderRegistry.get()`
// ============================================

test('GitProviderRegistry.get(id).glyph round-trips for every built-in', async () => {
    // Side-effect: importing index.js registers the four built-in providers.
    await import('../js/git-providers/index.js');
    assert.equal(GitProviderRegistry.get('gitea')?.glyph, 'GT');
    assert.equal(GitProviderRegistry.get('github')?.glyph, 'GH');
    assert.equal(GitProviderRegistry.get('gitlab')?.glyph, 'GL');
    assert.equal(GitProviderRegistry.get('local')?.glyph, 'ZP');
});

test('GitProviderRegistry.get returns a falsy lookup for an unregistered id', async () => {
    // The stale `bitbucket: 'BB'` row from the pre-2.26.0 hardcoded map
    // had no registered provider; the post-2.26.0 `glyphFor` falls back
    // to first-2-chars-uppercased via `?.glyph || ...`, so an absent
    // provider must produce a falsy `provider?.glyph` chain. `null` from
    // `Map.get()`-shaped registries and `undefined` from object-keyed
    // registries are both acceptable — we only require it to be falsy.
    await import('../js/git-providers/index.js');
    assert.ok(!GitProviderRegistry.get('bitbucket'), 'bitbucket must not resolve');
    assert.ok(!GitProviderRegistry.get('does-not-exist'), 'unknown id must not resolve');
});
