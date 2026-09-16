# Prow Github Actions ⛵️

This project is inspired by [Prow](https://github.com/kubernetes/test-infra/tree/master/prow) and brings its chat-ops functionality and project management to a simple, Github actions workflow.

> Prow is a Kubernetes based CI/CD system ... and provides GitHub automation in the form of policy enforcement, chat-ops via /foo style commands, and automatic PR merging.

## Quickstart

Setting up an organization? Start with [Prow for your organization](./docs/prow-for-your-org.md).

Check out the _"EXAMPLE"_ issues and pull requests (open and closed) in this repo to see how this works!

One caller workflow installs the whole bot. Copy [`templates/workflow-templates/prow.yml`](./templates/workflow-templates/prow.yml)
to `.github/workflows/prow.yml`, or install **Prow** from *Actions → New workflow* once your
organization ships it as a [workflow template](./docs/installing.md#an-organization):

```yaml
name: Prow
on:
  issues:
    types: [opened, reopened, labeled, unlabeled]
  issue_comment:
    types: [created]
  pull_request_target:
    types: [opened, reopened, synchronize, ready_for_review, labeled, unlabeled]
  pull_request_review:
    types: [submitted, dismissed]
  check_suite:
    types: [completed]
  schedule:
    - cron: '0 * * * *'
  workflow_dispatch:
  push:
    branches: [main]
    paths: [.github/prow.yaml]

permissions:
  contents: write
  issues: write
  pull-requests: write
  statuses: write

concurrency:
  group: prow-${{ github.event_name }}-${{ github.event.action }}-${{ github.event.comment.id || github.event.pull_request.number || github.event.issue.number || github.run_id }}
  cancel-in-progress: false

jobs:
  prow:
    if: github.event_name != 'workflow_dispatch' && github.event_name != 'push'
    uses: cncf/prow-github-actions/.github/workflows/prow.yml@v3

  label-sync:
    if: github.event_name == 'workflow_dispatch' || github.event_name == 'push'
    uses: cncf/prow-github-actions/.github/workflows/prow.yml@v3
    with:
      jobs: label-sync
```

With no configuration at all this gives you every built-in `/command`, reviewers from OWNERS
files, fork-safe automatic merging on `lgtm` (plus `approved` when the repository has
[OWNERS files](./docs/commands.md#owners)) where `lgtm` is
[bound to the reviewed commit](./docs/automatic-merging.md#lgtm-is-bound-to-a-commit) and never
merges commits pushed after it, and the `label-sync` job (run it once from
*Actions → Prow → Run workflow* so the labels exist). Add a `prow.yaml` to the repository or to
your organization's `.github` repository for label families and `needs-*` rules
([starter](./templates/prow.yaml), [configuration](./docs/configuration.md)). The
[Installing](./docs/installing.md) guide covers organizations, upgrading, inputs and secrets.

These docs describe `main`. The next release is `v3.0.0`; it creates the floating `v3` tag
the caller above references, and until then `@main` is the only ref of the reusable workflow
that resolves ([releasing](./docs/releasing.md)). The action requires the `node24` runtime
(GitHub requires actions/runner 2.327.1 or newer for node24 on self-hosted runners).

### Using the action directly

The action can also be a step of your own workflow, which is the form for GitHub Enterprise
Server (the reusable workflow needs github.com) and for mixing it with other steps:

```yaml
name: Prow github actions
on:
  issue_comment:
    types: [created]

permissions:
  issues: write
  pull-requests: write
  statuses: write
  contents: read

jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - uses: cncf/prow-github-actions@v3
        with:
          prow-commands: /assign /unassign /cc /uncc /approve /lgtm /hold /close /reopen /lock /retitle /milestone /remove /area /kind /priority /label /lifecycle /stage /status /help /good-first-issue /meow
          github-token: '${{ secrets.GITHUB_TOKEN }}'
```

This is the full list of available commands. Prow-style aliases (`/unhold`, `/remove-kind`, ...) come with their base command, and listing an alias enables the whole command family. [Events](./docs/events.md#recommended-triggers) has the direct form subscribed to everything; [jobs](./docs/cron-jobs.md), [automatic merging](./docs/automatic-merging.md) and [PR jobs](./docs/pr-jobs.md) have the per-feature workflows.

## Documentation
- [Prow for your organization](./docs/prow-for-your-org.md)
- [Installing](./docs/installing.md)
- [Overview](./docs/overview.md)
- [Events](./docs/events.md)
- [Commands](./docs/commands.md)
- [Configuration](./docs/configuration.md)
- [Labeling](./docs/labeling.md)
- [Jobs (lgtm merger, label-sync)](./docs/cron-jobs.md)
- [Automatic PR merging](./docs/automatic-merging.md) ([event-driven](./docs/automatic-merging.md#event-driven-merging), [upgrading from the `hold` label](./docs/automatic-merging.md#upgrading-from-the-hold-label))
- [PR jobs](./docs/pr-jobs.md)
- [Examples](./docs/examples.md)
- [Releasing](./docs/releasing.md)
- [Contributing](./docs/contributing.md)

---

_open water breeze_\
_the ocean seas are endless_\
_forward to the prow_
