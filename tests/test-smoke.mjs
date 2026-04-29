/**
 * Runner-health smoke test for `node --test`.
 *
 * Catches a broken CI runner config (wrong Node version, broken module
 * resolution, missing globbed files) before it manifests as a confusing
 * failure in a real test suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('node:test runner is operational', () => {
    assert.equal(1 + 1, 2);
});

test('ESM resolution works from tests/ to ../js/', async () => {
    const mod = await import('../js/version.js');
    assert.match(mod.VERSION, /^\d+\.\d+\.\d+$/);
    assert.equal(typeof mod.APP_NAME, 'string');
});

test('node version is recent enough for native test runner', () => {
    const [major] = process.versions.node.split('.').map(Number);
    assert.ok(major >= 20, `Node ${process.versions.node} is too old; need >= 20`);
});
