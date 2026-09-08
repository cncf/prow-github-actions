# Prow Github Actions ⛵️

This project is inspired by [Prow](https://github.com/kubernetes/test-infra/tree/master/prow) and brings its chat-ops functionality and project management to a simple, Github actions workflow.

> Prow is a Kubernetes based CI/CD system ... and provides GitHub automation in the form of policy enforcement, chat-ops via /foo style commands, and automatic PR merging.

## Quickstart

Check out the _"EXAMPLE"_ issues and pull requests (open and closed) in this repo to see how this works!

---
Run specified actions or jobs for issue and PR comments through a `workflow.yaml` file:

```yaml
name: Prow github actions
on:
  issue_comment:
    types: [created]

jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - uses: cncf/prow-github-actions@v2
        with:
          prow-commands: /assign /unassign /approve /retitle /area /kind /priority /remove /lgtm /close /reopen /lock /milestone /hold /cc /uncc
          github-token: '${{ secrets.GITHUB_TOKEN }}'
```

You can automatically merge PRs based on a cron schedule if it contains the `lgtm` label:

```yaml
name: Merge on lgtm label
on:
  schedule:
    - cron: '0 * * * *'

jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - uses: cncf/prow-github-actions@v2
        with:
          jobs: lgtm
          github-token: '${{ secrets.GITHUB_TOKEN }}'

          # this is optional and defaults to 'merge'
          merge-method: squash
```

Prow Github actions also supports removing the lgtm label when a PR is updated

```yaml
name: Run Jobs on PR
on: pull_request

jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - uses: cncf/prow-github-actions@v2
        with:
          jobs: lgtm
          github-token: '${{ secrets.GITHUB_TOKEN }}'
```

## Documentation
- [Overview](./docs/overview.md)
- [Commands](./docs/commands.md)
- [Labeling](./docs/labeling.md)
- [PR Labeling](./docs/pr-labeling.md)
- [Cron Jobs](./docs/cron-jobs.md)
- [Automatic PR merging](./docs/automatic-merging.md)
- [PR jobs](./docs/pr-jobs.md)
- [Examples](./docs/examples.md)
- [Releasing](./docs/releasing.md)
- [Contributing](./docs/contributing.md)

---

_open water breeze_\
_the ocean seas are endless_\
_forward to the prow_
