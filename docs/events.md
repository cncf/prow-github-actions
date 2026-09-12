# Events

The action reads `GITHUB_EVENT_NAME` and routes the event to one handler. An event
that is not in the table logs `<event> not yet supported` as an error annotation and
exits 0 without calling the API.

## Handled today

Event | Input | Does
--- | --- | ---
`issue_comment` | `prow-commands` | Runs the [`/commands`](./commands.md) found in the comment.
`pull_request` | `jobs` | Runs the [PR jobs](./pr-jobs.md); `lgtm` acts on `synchronize` only.
`pull_request_target` | `jobs` | Same as `pull_request` with a write token on fork PRs. Read the [safety rule](./pr-jobs.md#pull_request_target) first.
`schedule`, `workflow_dispatch`, `push` | `jobs` | Runs the [jobs](./cron-jobs.md) (`lgtm` merger, `label-sync`).

## Routed, no handlers yet

Event | Why it is routed
--- | ---
`issues` | label and lifecycle policy on issues
`pull_request_review` | review-driven labels
`check_suite`, `status` | merging when checks finish (`status` is the legacy commit status API; PRs are looked up by head sha)

These exit 0 and make no API calls. Handlers arrive with require-matching-label,
owners-label and event-driven merging in later releases.

Subscribing early is harmless and lets the workflow file stay put when the handlers land:

```yaml
name: Prow github actions
on:
  issue_comment:
    types: [created]
  issues:
    types: [opened, labeled, unlabeled]
  pull_request_target:
    types: [opened, synchronize, reopened, labeled, unlabeled]
  pull_request_review:
    types: [submitted]

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
          prow-commands: /lgtm /approve /hold /kind /area /priority
          jobs: lgtm
          github-token: '${{ secrets.GITHUB_TOKEN }}'
```
