# AI Editor Container

The repository builds a static nginx image with all browser dependencies bundled.
It requires no network access at runtime.

## Local build

```bash
docker build -t ai-editor .
docker run --rm -p 8080:8000 ai-editor
```

Use `BASE_PATH` to serve from a sub-path:

```bash
docker run --rm -p 8080:8000 -e BASE_PATH=/editor ai-editor
```

## Reproducibility and security

- Node and nginx base images are pinned by digest.
- `vendor/package-lock.json` is authoritative and the build uses `npm ci`.
- CodeMirror, Preact, marked, DOMPurify, JSZip, and htmx come from the locked npm
  graph; build-time dependency audit fails at moderate severity or higher.
- The runtime image contains application assets only, not tests, CI, evaluation,
  Gitea workflow, or Kubernetes files.

## Published images

Future approved `vX.Y.Z` tags publish these `linux/amd64` GHCR tags:

- `ghcr.io/gobha-me/ai-editor:vX.Y.Z` — immutable release coordinate.
- `ghcr.io/gobha-me/ai-editor:latest` — most recent approved release.

There is no `dev`, `test`, preview, or `edge` publication. The delivery-reset
change itself publishes no image. On the first approved GHCR release, verify the
package is linked to this repository and publicly readable before announcing it.

## Deployment boundary

This repository builds and publishes the product artifact; it does not deploy it.
The existing `k8s/deployment.yaml` is a legacy reference and is not applied by
GitHub Actions. A cluster-owned deployment must define digest-pinned provenance,
credential authority, protected environments, health verification, and rollback
before consuming GHCR.
