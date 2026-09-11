# Automatic PR merging

Prow github actions supports automatic PR merging through
[Github actions cron jobs](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule).

```yaml
name: Merge on lgtm label
on:
  schedule:
    - cron: '0 * * * *'

permissions:
  contents: write
  pull-requests: write

jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - uses: cncf/prow-github-actions@v2
        with:
          jobs: lgtm
          github-token: '${{ secrets.GITHUB_TOKEN }}'

          # this configuration is optional and will default to 'merge'
          # possible options are 'merge', 'rebase', or 'squash'
          merge-method: squash
```
This Github workflow will check every hour
for PRs with the `lgtm` label and will attempt to automatically merge them.
If the `hold` label is present, it will block automatic merging.
Locked and closed PRs are skipped. An unknown `merge-method` falls back to `merge`.
Every eligible PR is attempted, so one un-mergeable PR does not stop the others.
Each failed merge is logged as an error annotation (`could not merge pr #<n>: <reason>`);
once all pages are processed the run fails if any merge failed, listing the PRs:
`2 pull request(s) could not be merged: #1 (Pull Request is not mergeable), #7 (...)`.

The companion `lgtm` PR job removes the `lgtm` label from a PR that gets updated.
This prevents any un-reviewed code from being automatically merged by the lgtm-merger mechanism.
See [PR jobs](./pr-jobs.md) for the full workflow.

Refer to the [lgtm command](./commands.md) and the [PR jobs](./pr-jobs.md) for further reference.

## Known limitations
This job pages through the repository's open PRs, following pages until one comes back empty. This _may_ trigger a state
where github rate limits Prow github actions.
This may only happen with very large projects.
Please open an issue if you see this consistently happen.
