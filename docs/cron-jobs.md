# Cron jobs

The following jobs are supported through [cron Github workflows](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule).
The `jobs` input is space or newline delimited and case-insensitive (`jobs: lgtm`).
Both jobs page through the repository's pull requests, following pages until one comes back empty, and skip locked and closed PRs.

Jobs | Description
--- | ---
`lgtm` | Will attempt to automatically merge a PR with the `lgtm` label. Blocked by the `hold` label. See [automatic PR merging](./automatic-merging.md). Removed by the [lgtm PR job on pr update](./pr-jobs.md)
`pr-labeler` | **(DEPRECATED)** Labels PRs with labels based on file globs found in `.github/labels.yaml` (or `.yml`)

## `pr-labeler` (deprecated)

The `pr-labeler` cron job predates GitHub's `pull_request_target` trigger, which lets
[`actions/labeler`](https://github.com/actions/labeler) label PRs from forks securely on
each event instead of sweeping every open PR on a schedule. Use `actions/labeler` for new
setups; this job remains for repositories that need to batch label all their PRs.

The job reads `.github/labels.yaml` (or `.github/labels.yml`) from the repository, maps
labels to file globs, and labels every open, unlocked PR whose changed files match.

This job may be run with the following workflow configuration:

```yaml
name: Label PRs from globs
on:
  schedule:
    - cron: '0 * * * *'

permissions:
  contents: read
  pull-requests: write

jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - uses: cncf/prow-github-actions@v2
        with:
          jobs: pr-labeler
          github-token: '${{ secrets.GITHUB_TOKEN }}'
```

Querying every open PR on a schedule may hit GitHub rate limits on very large projects.
For the historical discussion see
[actions/labeler#12](https://github.com/actions/labeler/issues/12#issuecomment-670967607).
