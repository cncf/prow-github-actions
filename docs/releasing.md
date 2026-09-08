# Releasing

This document describes how prow-github-actions is released.

## Overview

Releases are automated through two GitHub Actions workflows:

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| [`release.yml`](../.github/workflows/release.yml) | Push of a `vX.Y.Z[-suffix]` tag | Stable (and tagged pre-) releases |
| [`pre-release.yml`](../.github/workflows/pre-release.yml) | Manual (`workflow_dispatch`) | Release candidates / pre-releases |

Both workflows:

1. **Verify** the code: `npm ci`, `npm run build`, `npm run lint`, `npm test`,
   and check that the committed `dist/` bundle matches a fresh `ncc` build
   (`npm run pack`). The release fails if `dist/` is out of date.
2. **Generate an SBOM** of the runtime dependencies in SPDX 2.3 JSON format
   using [waybill](https://github.com/kusari-oss/waybill) (pinned version,
   SHA256-verified download; dev/build/test scopes excluded).
3. **Sign the SBOM** with [cosign](https://github.com/sigstore/cosign)
   (keyless, via GitHub OIDC) and create a SLSA build provenance
   attestation covering both `dist/index.js` and the SBOM.
4. **Create a GitHub Release** with auto-generated release notes and the
   following attached artifacts:
   - `prow-github-actions-<version>.spdx.json` — the SBOM
   - `prow-github-actions-<version>.spdx.json.bundle` — cosign signature bundle
   - `prow-github-actions-<version>.intoto.jsonl` — SLSA provenance

For stable releases, `release.yml` additionally moves the floating major tag
(`v2`, `v3`, …) to the new release so that `uses: cncf/prow-github-actions@v2`
tracks the latest `v2.x.y`. Pre-releases never move the floating tag.

## Cutting a stable release

1. Make sure `main` is green and the bundled action is up to date:

   ```bash
   npm run all          # build + lint + pack + test
   git add dist/
   git commit -m "chore: Bump dist for release"
   git push
   ```

2. Update the `version` field in `package.json` if needed.

3. Tag and push:

   ```bash
   git tag v2.1.0
   git push origin v2.1.0
   ```

The `release.yml` workflow takes it from there. Tags with a pre-release
suffix (anything after a `-`, e.g. `v2.1.0-rc.1`) are marked as pre-releases
and do not move the floating major tag.

## Cutting a pre-release (release candidate)

Use the **Pre-Release (manual)** workflow from the Actions tab:

1. Go to *Actions → Pre-Release (manual) → Run workflow*.
2. Enter the version **without** the leading `v`, e.g. `2.1.0-rc.1`. The
   value must match `X.Y.Z-(rc|alpha|beta).N`; anything else is rejected.
3. Run the workflow on the branch you want to release from.

The workflow runs the same verification and SBOM pipeline, then creates the
tag `v2.1.0-rc.1` at the dispatched commit and publishes a GitHub Release
marked as *pre-release*.

> Note: the tag pushed by the workflow does **not** re-trigger
> `release.yml` — GitHub suppresses workflow runs triggered by pushes made
> with the default `GITHUB_TOKEN`.

## Verifying release artifacts

Verify the SBOM signature of a release:

```bash
VERSION=2.1.0
cosign verify-blob \
  --bundle prow-github-actions-${VERSION}.spdx.json.bundle \
  --certificate-identity-regexp="https://github.com/cncf/prow-github-actions" \
  --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
  prow-github-actions-${VERSION}.spdx.json
```

Verify the SLSA provenance of the bundled action (from a checkout of the
release tag) or of the SBOM:

```bash
gh attestation verify dist/index.js --repo cncf/prow-github-actions
gh attestation verify prow-github-actions-${VERSION}.spdx.json \
  --repo cncf/prow-github-actions
```

## Versioning

Releases follow [SemVer](https://semver.org/) with `v`-prefixed tags
(`v1.0.0`, `v2.0.0-rc.1`, `v2.0.0`, …). The floating major tag (`v2`) always
points at the latest stable `v2.x.y` release:

```yaml
# track the latest v2.x.y
- uses: cncf/prow-github-actions@v2

# or pin to an exact release
- uses: cncf/prow-github-actions@v2.1.0
```
