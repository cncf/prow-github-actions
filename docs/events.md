# Events

The action reads `GITHUB_EVENT_NAME` and routes the event to one handler. An event
that is not in the table logs `<event> not yet supported` as an error annotation and
exits 0 without calling the API.

## Handled today

Event | Input | Does
--- | --- | ---
`issue_comment` | `prow-commands` | Runs the [`/commands`](./commands.md) found in the comment.
`issues` | — | `opened`, `reopened`, `labeled`, `unlabeled`: applies the [`require_matching_label`](./configuration.md#require_matching_label) rules. Other activity types are logged and skipped.
`pull_request` | `jobs` | Same `require_matching_label` handling on the PR's labels; [`owners-label`](./labeling.md#labels-from-owners-files) on `opened`, `reopened`, `synchronize`; [`blunderbuss`](./configuration.md#blunderbuss) on `opened` and `ready_for_review`; [`approve`](./commands.md#approve) on `opened`, `reopened`, `synchronize` and on `labeled`/`unlabeled` of `approved`; [`tide`](./automatic-merging.md#event-driven-merging) on `labeled`, `unlabeled`, `reopened`, `ready_for_review`, `edited`; then the [PR jobs](./pr-jobs.md); `lgtm` acts on `synchronize` only. `jobs` may be empty.
`pull_request_target` | `jobs` | Same as `pull_request` with a write token on fork PRs. Read the [safety rule](./pr-jobs.md#pull_request_target) first.
`pull_request_review` | — | `submitted`, `dismissed`: [`approve`](./commands.md#approve) re-evaluates the approval (an `APPROVED` review adds an approver, `CHANGES_REQUESTED` removes one) on repositories with OWNERS files, then [`tide`](./automatic-merging.md#event-driven-merging) evaluates the reviewed PR (a review can also satisfy branch protection; it is not `lgtm`).
`check_suite`, `status` | — | `completed` / `success`: [`tide`](./automatic-merging.md#event-driven-merging) evaluates every open PR whose head is the commit. `status` is the legacy commit status API.
`schedule`, `workflow_dispatch`, `push` | `jobs` | Runs the [jobs](./cron-jobs.md) (`lgtm` merger, `label-sync`).

## Recommended triggers

One workflow can subscribe to everything; every handler skips what does not concern it. The
merge needs `contents: write`.

```yaml
name: Prow github actions
on:
  issue_comment:
    types: [created]
  issues:
    types: [opened, reopened, labeled, unlabeled]
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review, labeled, unlabeled]
  pull_request_review:
    types: [submitted, dismissed]
  check_suite:
    types: [completed]

permissions:
  contents: write
  issues: write
  pull-requests: write

jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - uses: cncf/prow-github-actions@v2
        with:
          prow-commands: /lgtm /approve /hold /kind /area /priority /check-required-labels /auto-cc
          jobs: lgtm
          github-token: '${{ secrets.GITHUB_TOKEN }}'
```

Use `pull_request_target` instead of `pull_request` when fork PRs must be labeled or merged;
`pull_request` gets a read-only token on forks ([safety rule](./pr-jobs.md#pull_request_target)).
Repositories that only want the cron to merge leave `pull_request_review` and `check_suite` out
or set [`tide.merge_on_events: false`](./automatic-merging.md#merge_on_events).

## `issues` and `pull_request`

With no `require_matching_label` rule in any configuration tier the `issues` event only reads
the configuration and exits 0. On `pull_request` the OWNERS plugins also read the pull request's
changed files and the OWNERS files of the base branch; `approve` and `tide` share one recursive
listing of the default branch tree to learn whether the repository has OWNERS files at all, and a
repository without them makes no further OWNERS calls. `tide` reads the pull request once and
stops when the merge gate fails.

Activity type | Handlers
--- | ---
`opened` | `require_matching_label`, `owners-label`, `blunderbuss`, `approve`
`reopened` | `require_matching_label`, `owners-label`, `approve`, `tide`
`synchronize` | `owners-label`, `approve` (the changed files may differ; approvals stay), the `lgtm` job (`tide` waits for the next check suite: a push must not merge)
`ready_for_review` | `blunderbuss` (drafts wait for it by default), `tide`
`labeled`, `unlabeled` | `require_matching_label`, `approve` (only for the `approved` label: a human's change is re-evaluated), `tide`
`edited` | `tide` (a base branch change alters mergeability)

The handlers of one event run one after the other in the order listed, `tide` last, and `tide`
re-reads the labels from the API rather than trusting the payload, so a label an earlier
handler applied in the same run is seen.

`owners-label` and `blunderbuss` read the OWNERS files of the PR's **base** branch, so they
are safe on `pull_request_target`: nothing from the head branch is executed or trusted.

## `check_suite` and `status`

Both only trigger a workflow whose file is on the **default branch**. GitHub does not send
`check_suite` for suites created by GitHub Actions itself (its recursion guard), so a repository
whose checks are all Actions workflows sees the event only for other apps' suites; `/lgtm` after
green checks (the `labeled` event) or the cron merges those PRs. A suite that ended in `failure`,
`cancelled`, `timed_out` or `action_required` (a `pending`, `failure` or `error` status) makes
no API call: it cannot have made a PR mergeable.

A merge performed with `GITHUB_TOKEN` does not trigger `push` workflows; use a PAT or GitHub App
token when other automation must run after the merge.
