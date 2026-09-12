# Pull Request Jobs

The `jobs` input is space or newline delimited and case-insensitive.

Jobs | Runs on | Description
--- | --- | ---
`lgtm` | `synchronize` only | Removes the `lgtm` label (if present) when new commits are pushed, so updated code must be reviewed again before [automatic merging](./automatic-merging.md).

`lgtm` is the only PR job. Every other activity type (`opened`, `reopened`, `labeled`,
`unlabeled`, `ready_for_review`, `edited`, `closed`, ...) is logged at debug level and
skipped, so a workflow may subscribe to `labeled`/`unlabeled` without the job stripping
the label the moment `/lgtm` adds it.

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

The default `pull_request` activity types (`opened`, `synchronize`, `reopened`) include
`synchronize`, so no `types:` filter is needed.
