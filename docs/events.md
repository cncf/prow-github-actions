# Events

The action reads `GITHUB_EVENT_NAME` and routes the event to one handler. An event
that is not in the table logs `<event> not yet supported` as an error annotation and
exits 0 without calling the API.

## Handled today

Event | Input | Does
--- | --- | ---
`issue_comment` | `prow-commands` | Runs the [`/commands`](./commands.md) found in the comment; when one that writes labels ran, re-applies the [`require_matching_label`](./configuration.md#require_matching_label) rules and, on an open PR, runs [`tide`](./automatic-merging.md#event-driven-merging) ([why](#the-bots-writes-fire-no-events)).
`issues` | — | `opened`, `reopened`, `labeled`, `unlabeled`: applies the [`require_matching_label`](./configuration.md#require_matching_label) rules. Other activity types are logged and skipped.
`pull_request` | `jobs` | Same `require_matching_label` handling on the PR's labels; [`owners-label`](./labeling.md#labels-from-owners-files) on `opened`, `reopened`, `synchronize`; [`blunderbuss`](./configuration.md#blunderbuss) on `opened` and `ready_for_review`; [`lgtm`](./automatic-merging.md#lgtm-is-bound-to-a-commit) binds a `labeled` `lgtm` by a human to the head; [`approve`](./commands.md#approve) on `opened`, `reopened`, `synchronize` and on `labeled`/`unlabeled` of `approved`; [`tide`](./automatic-merging.md#event-driven-merging) on `labeled`, `unlabeled`, `reopened`, `ready_for_review`, `edited`; then the [PR jobs](./pr-jobs.md); `lgtm` acts on `synchronize` only. `jobs` may be empty.
`pull_request_target` | `jobs` | Same as `pull_request` with a write token on fork PRs. Read the [safety rule](./pr-jobs.md#pull_request_target) first.
`pull_request_review` | — | `submitted`, `dismissed`: [`approve`](./commands.md#approve) re-evaluates the approval (an `APPROVED` review adds an approver, `CHANGES_REQUESTED` removes one) on repositories with OWNERS files, then [`tide`](./automatic-merging.md#event-driven-merging) evaluates the reviewed PR (a review can also satisfy branch protection; it is not `lgtm`). On a fork PR the token is read-only ([below](#fork-pull-requests-under-pull_request)).
`check_suite`, `status` | — | `completed` / `success`: [`tide`](./automatic-merging.md#event-driven-merging) evaluates every open PR whose head is the commit. `status` is the legacy commit status API.
`schedule`, `workflow_dispatch`, `push` | `jobs` | Runs the [jobs](./cron-jobs.md) (`lgtm` merger, `label-sync`).

## Which events each feature needs

With the [reusable workflow](./installing.md) the trigger block lives in the caller; the
[template](../templates/workflow-templates/prow.yml) subscribes to all of these.

Feature | Events
--- | ---
[`/commands`](./commands.md) | `issue_comment` `[created]`
[`require_matching_label`](./configuration.md#require_matching_label) | `issues` and `pull_request` `[opened, reopened, labeled, unlabeled]`
[`owners-label`](./labeling.md#labels-from-owners-files), [`blunderbuss`](./configuration.md#blunderbuss) | `pull_request` `[opened, reopened, synchronize, ready_for_review]`
`lgtm` removed on new commits | `pull_request` `[synchronize]`
[event-driven merging](./automatic-merging.md#event-driven-merging) | `issue_comment` `[created]` (after a command), `pull_request` `[labeled, unlabeled, reopened, ready_for_review]`, `pull_request_review` `[submitted, dismissed]`, `check_suite` `[completed]`
[`lgtm` backstop](./cron-jobs.md) | `schedule`
[`label-sync`](./cron-jobs.md#label-sync) | `workflow_dispatch`, `push` (filtered to the configuration file)

## Recommended triggers

One workflow can subscribe to everything; every handler skips what does not concern it. The
merge needs `contents: write`. This is the direct form of the
[reusable-workflow caller](./installing.md#one-repository).

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
  statuses: write

jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - uses: cncf/prow-github-actions@v3
        with:
          prow-commands: /lgtm /approve /hold /kind /area /priority /check-required-labels /auto-cc
          jobs: lgtm
          github-token: '${{ secrets.GITHUB_TOKEN }}'
```

Use `pull_request_target` instead of `pull_request` when fork PRs must be labeled or merged on
the event; `pull_request` gets a read-only token on forks ([below](#fork-pull-requests-under-pull_request),
[safety rule](./pr-jobs.md#pull_request_target)). Repositories that only want the cron to merge
leave `pull_request_review` and `check_suite` out or set
[`tide.merge_on_events: false`](./automatic-merging.md#merge_on_events).

## Fork pull requests under `pull_request`

GitHub's rule: "The `GITHUB_TOKEN` has read-only permissions in pull requests from forked
repositories" ([events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)).
That covers the `pull_request` **and** `pull_request_review` runs of a fork PR, whatever the
`permissions` block says; `pull_request_target` runs, same-repository PRs and every
`issue_comment` run keep the write token.

Rather than fail on the first label write, the action recognises the situation and stops:

Event | `head.repo` | Token | Does
--- | --- | --- | ---
`pull_request`, `pull_request_review` | another repository (a fork) | read-only | `core.notice`: `fork pull request under <event>: the token is read-only; the sweep job handles it`; no handler runs, no API call is made
`pull_request`, `pull_request_review` | the repository itself | write | every handler, as usual
`pull_request_target` | anything | write | every handler, as usual

What those handlers would have done for the fork PR (`needs-*` labels, OWNERS labels and
reviewers, approval, the merge, a stale `lgtm`) is done by the [`sweep` job](./cron-jobs.md#sweep)
on its schedule; see [installing](./installing.md#without-pull_request_target) for that layout.
Comments (`/lgtm`, `/approve`, ...) on the fork PR still act instantly: `issue_comment` has a
write token.

## The bot's writes fire no events

Labels, reviews and merges made with `GITHUB_TOKEN` do not trigger workflows (GitHub's recursion
guard). The `lgtm` label the bot adds for `/lgtm` therefore fires no `labeled` event, and neither
does the `needs-kind` that `/kind` should clear. A comment run that executed a command that writes
labels (`/lgtm`, `/approve`, `/hold`, `/remove`, every label command and its `/remove-` form) so
does itself what those events would have done, in this order:

Step | Does | Cost
--- | --- | ---
[`require_matching_label`](./configuration.md#require_matching_label) | every rule that applies, no grace period; removes a stale `needs-*`, adds one the command broke (`/remove-kind`) | nothing without rules; one labels read with rules
[`tide`](./automatic-merging.md#event-driven-merging) | the merge gate on an open PR: `/lgtm`, `/approve`, `/unhold`, `/remove-*` merge in the same run | one PR read, plus one status read when the PR carries `lgtm` ([binding](./automatic-merging.md#lgtm-is-bound-to-a-commit)); nothing on an issue or a closed PR; off with [`merge_on_events: false`](./automatic-merging.md#merge_on_events)

Commands that cannot write a label (`/assign`, `/cc`, `/close`, `/milestone`, `/check-required-labels`
on its own, ...) and comments without a configured command make no extra call at all. A
failure in either step fails the run alongside the command's own error. Labels added by a human
still fire `labeled`; the [cron](./cron-jobs.md) stays the backstop for events GitHub drops.

## Concurrency

The [caller](./installing.md) sets the concurrency group; the reusable workflow sets none. With
`cancel-in-progress: false` GitHub keeps **one in-progress and one pending** run per group; a
newer pending run replaces the older pending one, which is cancelled.

```yaml
concurrency:
  group: prow-${{ github.event_name }}-${{ github.event.action }}-${{ github.event.comment.id || github.event.pull_request.number || github.event.issue.number || github.run_id }}
  cancel-in-progress: false
```

Payload | Group | Why
--- | --- | ---
`issue_comment` | one per comment | two commands seconds apart while a run is in progress would otherwise leave the middle one pending, and the third would cancel it: a command must never be dropped. `comment.id` comes before `issue.number` because a comment payload carries both
`pull_request` | one per activity type and PR | a pending `synchronize` run (removes `lgtm`) can only be replaced by a newer `synchronize`, never by a `labeled` run that would then merge unreviewed commits
`issues`, `pull_request_review` | one per activity type and number | same rule
`check_suite`, `schedule`, ... | one per run (`run_id`) | nothing to collapse

A burst of the same activity type on one object (Dependabot's `opened` plus two `labeled` within
a second) collapses to the newest pending run of each group. That is safe: every handler re-reads
the labels and the pull request from the API rather than trusting the payload, so the run that
survives sees the final state.

## `pull_request_target` and the reusable workflow

The [reusable workflow](../.github/workflows/prow.yml) has one `actions/checkout` step, and it
checks out `cncf/prow-github-actions` at `job.workflow_sha`, the commit of the workflow file
itself, never the caller's repository and never a pull request head. Under
`pull_request_target` that step therefore fetches only this action's own code; the
[safety rule](./pr-jobs.md#pull_request_target) holds and the
[template](../templates/workflow-templates/prow.yml) uses `pull_request_target` by default.

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
`labeled`, `unlabeled` | `require_matching_label`, `lgtm` (`labeled` `lgtm` by a human: bound to the head), `approve` (only for the `approved` label: a human's change is re-evaluated), `tide`
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
