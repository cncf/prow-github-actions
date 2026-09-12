# Prow Github Actions ⛵️

This project is inspired by [Prow](https://github.com/kubernetes/test-infra/tree/master/prow) and brings its chat-ops functionality and project management to a simple, Github actions workflow.

> Prow is a Kubernetes based CI/CD system ... and provides GitHub automation in the form of policy enforcement, chat-ops via /foo style commands, and automatic PR merging.

## Quickstart

Check out the _"EXAMPLE"_ issues and pull requests (open and closed) in this repo to see how this works!

These docs describe `main`. Features added since the latest release (`v2.0.0`) ship in the next release, which also creates the floating `v2` tag; until then pin `@v2.0.0` for the released behaviour. The action requires the `node24` runtime (GitHub requires actions/runner 2.327.1 or newer for node24 on self-hosted runners) and works on GitHub Enterprise Server via `GITHUB_API_URL`.

---
Run specified actions or jobs for issue and PR comments through a `workflow.yaml` file:

```yaml
name: Prow github actions
on:
  issue_comment:
    types: [created]

permissions:
  issues: write
  pull-requests: write
  contents: read

jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - uses: cncf/prow-github-actions@v2
        with:
          prow-commands: /assign /unassign /cc /uncc /approve /lgtm /hold /close /reopen /lock /retitle /milestone /remove /area /kind /priority /label /lifecycle /stage /status /help /good-first-issue /meow
          github-token: '${{ secrets.GITHUB_TOKEN }}'
```

This is the full list of available commands. Prow-style aliases (`/unhold`, `/remove-kind`, ...) come with their base command, and listing an alias enables the whole command family.

Configuration can live in the repo or in your org's `.project`/`.github` repo — see [configuration](./docs/configuration.md).

Label commands only apply labels the repository already has. Create them from the configuration with the `label-sync` job, on demand or whenever `prow.yaml` changes:

```yaml
name: Sync labels from prow.yaml
on:
  workflow_dispatch:
  push:
    branches: [main]
    paths: [.github/prow.yaml]

permissions:
  contents: read
  issues: write

jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - uses: cncf/prow-github-actions@v2
        with:
          jobs: label-sync
          github-token: '${{ secrets.GITHUB_TOKEN }}'
```

You can automatically merge PRs based on a cron schedule if it contains the `lgtm` label:

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

          # this is optional and defaults to 'merge'
          merge-method: squash
```

Prow Github actions also supports removing the lgtm label when new commits are pushed to a PR (the `synchronize` activity type; other types are skipped)

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

## Documentation
- [Overview](./docs/overview.md)
- [Commands](./docs/commands.md)
- [Configuration](./docs/configuration.md)
- [Labeling](./docs/labeling.md)
- [Jobs (lgtm merger, label-sync)](./docs/cron-jobs.md)
- [Automatic PR merging](./docs/automatic-merging.md)
- [PR jobs](./docs/pr-jobs.md)
- [Examples](./docs/examples.md)
- [Releasing](./docs/releasing.md)
- [Contributing](./docs/contributing.md)

---

_open water breeze_\
_the ocean seas are endless_\
_forward to the prow_
