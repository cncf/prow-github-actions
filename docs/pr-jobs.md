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

## `pull_request_target`

`pull_request_target` carries the same payload as `pull_request` and is routed to the
same PR jobs. It runs in the context of the base branch with a **write** token, also for
pull requests from forks, which is what lets the `lgtm` job remove labels on fork PRs
where `pull_request` only gets a read token.

This is safe only because the action never checks out or executes pull request code.
Never add `actions/checkout` of the PR head (`ref: ${{ github.event.pull_request.head.sha }}`)
or run scripts from the PR in a `pull_request_target` job.

```yaml
name: Run Jobs on PR
on: pull_request_target

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
