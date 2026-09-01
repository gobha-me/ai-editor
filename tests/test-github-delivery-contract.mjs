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
    assert.match(workflow, /name: Container/u);
    assert.match(workflow, /node --test tests\/test-\*\.mjs/u);
    assert.match(workflow, /npm audit --audit-level=moderate/u);
});

test('release publication is tag-only and gated on exact-SHA validation', async () => {
    const workflow = await read('.github/workflows/publish-image.yml');
    assert.match(workflow, /tags: \['v\*\.\*\.\*'\]/u);
    assert.doesNotMatch(workflow, /pull_request:|branches:/u);
    assert.match(workflow, /commits\/\$\{GITHUB_SHA\}\/check-runs/u);
    assert.match(workflow, /'Node and policy' 'Container'/u);
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

test('security-sensitive vendor versions are exact', async () => {
    const packageJson = JSON.parse(await read('vendor/package.json'));
    assert.equal(packageJson.dependencies.dompurify, '3.4.14');
    assert.equal(packageJson.devDependencies.esbuild, '0.28.2');
});

test('legacy Kubernetes manifest is explicitly non-authoritative', async () => {
    const manifest = await read('k8s/deployment.yaml');
    assert.match(manifest, /LEGACY, NON-AUTHORITATIVE REFERENCE/u);
    assert.match(manifest, /GitHub Actions never applies this file/u);
});
