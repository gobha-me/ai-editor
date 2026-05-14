// @ts-check
/**
 * Anti-regression test for the `BASE_GIT_PROVIDER.capabilities` six-flag
 * shape contract.
 *
 * Origin: `RE-EVAL following 2.49.0` ICD #4 code-aware finding #2 —
 * GitLab declared only `mergeConflictResolution: true`, leaving the
 * other five flags `undefined`. Every consumer site uses
 * `capabilities?.flag === true` so `undefined` reads as `false`, but a
 * future consumer that omits the `?.` chain would throw on GitLab.
 *
 * This test asserts each provider declares all six flags as explicit
 * booleans, so the `undefined → false` invariant can never silently
 * regress.
 *
 * @since 2.50.0
 */

import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BASE_GIT_PROVIDER } from '../js/git-providers/base.js';
import giteaProvider from '../js/git-providers/gitea.js';
import githubProvider from '../js/git-providers/github.js';
import gitlabProvider from '../js/git-providers/gitlab.js';
import { LOCAL_PROVIDER as localProvider } from '../js/git-providers/local.js';

const CAPABILITY_FLAGS = [
    'reviewSubmission',
    'threadResolve',
    'viewedFiles',
    'merge',
    'rerunCi',
    'mergeConflictResolution',
];

// Mirrors how `git-providers/registry.js#register` builds the live
// provider — shallow spread evaluates the `capabilities` getter at
// merge time, so the merged clone carries the runtime-resolved values
// for each provider.
function mergedClone(provider) {
    return { ...BASE_GIT_PROVIDER, ...provider };
}

const PROVIDERS = [
    { name: 'base', provider: BASE_GIT_PROVIDER },
    { name: 'github', provider: mergedClone(githubProvider) },
    { name: 'gitea', provider: mergedClone(giteaProvider) },
    { name: 'gitlab', provider: mergedClone(gitlabProvider) },
    { name: 'local', provider: mergedClone(localProvider) },
];

for (const { name, provider } of PROVIDERS) {
    test(`capabilities-shape: ${name} declares all six flags as explicit booleans`, () => {
        const caps = provider.capabilities;
        assert.ok(caps, `${name}.capabilities must be defined`);
        for (const flag of CAPABILITY_FLAGS) {
            assert.equal(
                typeof caps[flag],
                'boolean',
                `${name}.capabilities.${flag} must be an explicit boolean (got ${typeof caps[flag]} = ${caps[flag]})`
            );
        }
    });
}

test('capabilities-shape: no provider exposes flags beyond the six-flag contract', () => {
    for (const { name, provider } of PROVIDERS) {
        const extras = Object.keys(provider.capabilities).filter(
            (k) => !CAPABILITY_FLAGS.includes(k)
        );
        assert.deepEqual(
            extras,
            [],
            `${name}.capabilities exposes unexpected flags: ${extras.join(', ')} — extend CAPABILITY_FLAGS if these are intentional`
        );
    }
});
