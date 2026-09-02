import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const rootUrl = new URL('../', import.meta.url);

async function read(relativePath) {
    return readFile(new URL(relativePath, rootUrl), 'utf8');
}

test('untrusted validation is read-only and never uses pull_request_target', async () => {
    const workflow = await read('.github/workflows/validation.yml');
    assert.match(workflow, /permissions:\n  contents: read/u);
    assert.doesNotMatch(workflow, /pull_request_target/u);
    assert.doesNotMatch(workflow, /packages: write|kubectl|DOCKERHUB|REGISTRY/u);
});

test('validation exposes stable required check names', async () => {
    const workflow = await read('.github/workflows/validation.yml');
    assert.match(workflow, /name: Node and policy/u);
    assert.match(workflow, /name: Browser/u);
    assert.match(workflow, /name: Container/u);
    assert.match(workflow, /node --test tests\/test-\*\.mjs/u);
    assert.match(workflow, /run-browser-tests\.mjs --output browser-test-results\.json/u);
    assert.match(workflow, /mcr\.microsoft\.com\/playwright:v1\.62\.1-noble@sha256:[0-9a-f]{64}/u);
    assert.match(workflow, /npm audit --audit-level=moderate/u);
});

test('browser validation is machine-readable and fails closed on network or runtime drift', async () => {
    const runner = await read('scripts/ci/run-browser-tests.mjs');
    const harness = await read('tests/index.html');
    const dependencies = await read('tests/test-dependencies.js');

    assert.match(runner, /context\.route\('\*\*\/\*'/u);
    assert.match(runner, /parsed\.origin !== origin/u);
    assert.match(runner, /route\.abort\('blockedbyclient'\)/u);
    assert.match(runner, /context\.routeWebSocket/u);
    assert.match(runner, /response\.status\(\) >= 400/u);
    assert.match(runner, /writeFile\(outputPath/u);
    assert.match(harness, /window\.__AI_EDITOR_TEST_RESULTS__ = \{\s*status: 'complete'/u);
    assert.match(harness, /unhandledrejection/u);
    assert.doesNotMatch(dependencies, /https?:\/\//u);
});

test('release publication is tag-only and gated on exact-SHA validation', async () => {
    const workflow = await read('.github/workflows/publish-image.yml');
    assert.match(workflow, /tags: \['v\*\.\*\.\*'\]/u);
    assert.doesNotMatch(workflow, /pull_request:|branches:/u);
    assert.match(workflow, /commits\/\$\{GITHUB_SHA\}\/check-runs/u);
    assert.match(workflow, /'Node and policy' 'Browser' 'Container'/u);
    assert.match(workflow, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/u);
});

test('release publication writes only GHCR packages and attestations', async () => {
    const workflow = await read('.github/workflows/publish-image.yml');
    assert.match(workflow, /packages: write/u);
    assert.match(workflow, /attestations: write/u);
    assert.match(workflow, /ghcr\.io\/\$\{\{ github\.repository \}\}/u);
    assert.match(workflow, /sbom: true/u);
    assert.doesNotMatch(workflow, /kubectl|DOCKERHUB|registry\.gobha\.me/u);
});

test('container uses digest-pinned bases and the locked dependency graph', async () => {
    const dockerfile = await read('Dockerfile');
    assert.match(dockerfile, /FROM node:22-slim@sha256:[0-9a-f]{64}/u);
    assert.match(dockerfile, /FROM nginx:1-alpine@sha256:[0-9a-f]{64}/u);
    assert.match(dockerfile, /COPY vendor\/package\.json vendor\/package-lock\.json/u);
    assert.match(dockerfile, /npm ci --ignore-scripts/u);
});

test('production rate limiting does not import the excluded eval tree', async () => {
    const pacer = await read('js/llm/pacer.js');
    const compatibilityModule = await read('evals/pacing.js');
    assert.match(pacer, /from '\.\/rate-limiter\.js'/u);
    assert.doesNotMatch(pacer, /from ['"][^'"]*evals/u);
    assert.match(compatibilityModule, /from '\.\.\/js\/llm\/rate-limiter\.js'/u);
});

test('security-sensitive vendor versions are exact', async () => {
    const packageJson = JSON.parse(await read('vendor/package.json'));
    assert.equal(packageJson.dependencies.dompurify, '3.4.14');
    assert.equal(packageJson.devDependencies.esbuild, '0.28.2');
    assert.equal(packageJson.devDependencies.playwright, '1.62.1');
});

test('legacy Kubernetes manifest is explicitly non-authoritative', async () => {
    const manifest = await read('k8s/deployment.yaml');
    assert.match(manifest, /LEGACY, NON-AUTHORITATIVE REFERENCE/u);
    assert.match(manifest, /GitHub Actions never applies this file/u);
});
