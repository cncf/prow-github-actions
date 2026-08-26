# Releasing

This document describes how prow-github-actions is released.

## Overview

Releases are automated through two GitHub Actions workflows:

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| [`release.yml`](../.github/workflows/release.yml) | Push of a `v*` tag | Stable (and tagged pre-) releases |
| [`pre-release.yml`](../.github/workflows/pre-release.yml) | Manual (`workflow_dispatch`) | Release candidates / pre-releases |

Both workflows:

1. **Verify** the code: `npm ci`, `npm run build`, `npm run lint`, `npm test`,
   and check that the committed `dist/` bundle matches a fresh `ncc` build
   (`npm run pack`). The release fails if `dist/` is out of date.
2. **Generate an SBOM** in SPDX 2.3 JSON format using
   [waybill](https://github.com/kusari-oss/waybill) (pinned version,
   SHA256-verified download).
3. **Sign the SBOM** with [cosign](https://github.com/sigstore/cosign)
   (keyless, via GitHub OIDC) and create a SLSA build provenance
   attestation.
4. **Create a GitHub Release** with auto-generated release notes and the
   following attached artifacts:
   - `prow-github-actions-<version>.spdx.json` — the SBOM
   - `prow-github-actions-<version>.spdx.json.bundle` — cosign signature bundle
   - `prow-github-actions-<version>.spdx.json.intoto.jsonl` — SLSA provenance

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

The `release.yml` workflow takes it from there. Tags containing `-rc`,
`-alpha`, or `-beta` are automatically marked as pre-releases.

## Cutting a pre-release (release candidate)

Use the **Pre-Release (manual)** workflow from the Actions tab:

1. Go to *Actions → Pre-Release (manual) → Run workflow*.
2. Enter the version **without** the leading `v`, e.g. `2.1.0-rc.1`.
3. Run the workflow on the branch you want to release from.

The workflow creates the tag `v2.1.0-rc.1`, runs the same verification and
SBOM pipeline, and publishes a GitHub Release marked as *pre-release*.

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

Verify the SLSA provenance attestation:

```bash
gh attestation verify prow-github-actions-${VERSION}.spdx.json \
  --repo cncf/prow-github-actions
```

## Versioning

Releases follow [SemVer](https://semver.org/) with `v`-prefixed tags
(`v1.0.0`, `v2.0.0-rc.1`, `v2.0.0`, …). Users are encouraged to pin to a
full version tag:

```yaml
- uses: cncf/prow-github-actions@v2.0.0
```
