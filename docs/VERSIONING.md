# AI Editor Versioning

AI Editor uses released `X.Y.Z` versions and optional in-flight `X.Y.Z.N`
stamps. Version choice follows product impact and release readiness; there is no
time- or minor-count-based release objective.

## Source coherence

- A released `X.Y.Z` in `js/version.js` must equal the first released heading in
  `CHANGELOG.md`.
- An in-flight `X.Y.Z.N` must target a version different from the latest release
  and keep its changes under `Unreleased`.
- Only an exact `vX.Y.Z` tag matching the source version can publish an image.
- Published tags and historical changelog headings are never renamed.

Run the same check used by GitHub Actions:

```bash
node scripts/ci/validate.mjs
```

## Release gate

Release authority is ordered and fail-closed:

1. Merge through a pull request with `Node and policy` and `Container` green.
2. Wait for those checks to finish successfully on the exact `main` merge SHA.
3. Promote `Unreleased`, set the final `X.Y.Z`, and rerun local validation.
4. Create the annotated `vX.Y.Z` tag.
5. The tag workflow verifies main ancestry and the exact-SHA checks, then
   publishes GHCR `vX.Y.Z` and `latest` plus SBOM/provenance.
6. Verify the digest and package visibility before creating the GitHub Release.

No tag or image publication deploys the application. Cluster promotion requires
separate authority, provenance consumption, protected environments, secret
management, health checks, and rollback.
