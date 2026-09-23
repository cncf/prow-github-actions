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
   SHA256-verified download; dev/build/test scopes excluded, `dist/` excluded
   via `--exclude-path dist`).
3. **Sign the SBOM** with [cosign](https://github.com/sigstore/cosign)
   (keyless, via GitHub OIDC) and create a SLSA build provenance
   attestation covering both `dist/index.js` and the SBOM.
4. **Create a GitHub Release** with auto-generated release notes and the
   following attached artifacts:
   - `prow-github-actions-<version>.spdx.json` — the SBOM
   - `prow-github-actions-<version>.spdx.json.bundle` — cosign signature bundle
   - `prow-github-actions-<version>.intoto.jsonl` — SLSA provenance

   `release.yml` then prepends [`docs/releases/vX.Y.Z.md`](./releases/), when
   the file exists, to the generated notes.

For stable releases, `release.yml` additionally moves the floating major tag
(`v2`, `v3`, …) to the new release so that `uses: cncf/prow-github-actions@v3`
and `uses: cncf/prow-github-actions/.github/workflows/prow.yml@v3` track the
latest `v3.x.y`. Pre-releases never move the floating tag.

The templates, the README and the docs pin the **exact** release (`@v3.0.1`) on
purpose: organizations that hash-pin can replace it with the release's commit
sha, and Dependabot bumps it to the next release. The floating `v3` tag keeps
moving for callers who prefer it ([upgrading](./installing.md#upgrading)).

The [reusable workflow](../.github/workflows/prow.yml) is versioned with the
action: it checks out `cncf/prow-github-actions` at `job.workflow_sha`, the
commit of the workflow file itself, so a tag or sha names both the workflow and
the action bundle that runs. Nothing in it needs updating at release time.

## Cutting a stable release

Everything but the tag lands through one pull request; the tag is pushed once
that PR is on `main`.

1. Update the pinned version, `X.Y.Z` being the release:

   ```bash
   npm version X.Y.Z --no-git-tag-version   # package.json and package-lock.json
   ```

2. Replace `@vOLD` with `@vX.Y.Z` in `README.md`, `docs/`, `templates/` and
   `.github/workflows/prow*.yml`, for the action and the reusable workflow
   alike. `__tests__/version.test.ts` fails until every reference agrees with
   `package.json`; the floating `@v3` and the `@vX.Y.Z` placeholder are the
   only other refs it accepts. `docs/releases/` is exempt: past notes keep the
   version they announced.

3. Write `docs/releases/vX.Y.Z.md`: what changed, breaking changes, upgrade
   steps ([`v3.0.0`](./releases/v3.0.0.md) is the model). `release.yml`
   prepends it to GitHub's generated notes; the same test checks the file
   exists.

4. Build, lint, pack and test, then commit everything including `dist/`:

   ```bash
   npm run all          # build + lint + pack + test
   git add -A
   git commit -s -m "chore: release vX.Y.Z"
   ```

5. Open the pull request and merge it.

6. Tag the merge commit on `main` and push the tag:

   ```bash
   git checkout main && git pull
   git tag vX.Y.Z
   git push origin vX.Y.Z
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
(`v1.0.0`, `v2.0.0-rc.1`, `v2.0.0`, `v3.0.0`, …). The floating major tag
(`v3`) always points at the latest stable `v3.x.y` release:

```yaml
# track the latest v3.x.y
- uses: cncf/prow-github-actions@v3

# or pin to an exact release, what the templates ship
- uses: cncf/prow-github-actions@v3.0.1
```

The same refs work for the reusable workflow,
`cncf/prow-github-actions/.github/workflows/prow.yml@v3`.
