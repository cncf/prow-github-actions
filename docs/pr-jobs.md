# Pull Request Jobs

Jobs | Description
--- | ---
`lgtm` | Removes the `lgtm` label (if present) when the PR is updated, so updated code must be reviewed again before [automatic merging](./automatic-merging.md).

`lgtm` is the only PR job.

```yaml
name: Run Jobs on PR
on: pull_request

permissions:
  pull-requests: write

jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - uses: cncf/prow-github-actions@v2
        with:
          jobs: lgtm
          github-token: '${{ secrets.GITHUB_TOKEN }}'
```

The default `pull_request` activity types (`opened`, `synchronize`, `reopened`) are the ones you want; `labeled` is not needed and would not self-trigger removal.
