# Automatic PR merging

A pull request is merged as soon as it passes the [merge gate](#the-merge-gate) **and** GitHub
reports it mergeable. Two paths get there:

Path | Trigger | Reads `mergeable_state` | Role
--- | --- | --- | ---
event-driven | `pull_request`, `pull_request_review`, `check_suite`, `status` | yes: merges `clean` and `has_hooks` only | primary; merges within seconds of the last label, review or check
`lgtm` cron job | `schedule` with `jobs: lgtm` | no: merges blindly and lets GitHub refuse | backstop for missed events; optional

## Event-driven merging

Subscribe the workflow that runs the action to the events that can change a pull request's
mergeability. The handlers need no input beyond `github-token`; the merge needs `contents: write`.

```yaml
name: Prow github actions
on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review, labeled, unlabeled]
  pull_request_review:
    types: [submitted, dismissed]
  check_suite:
    types: [completed]
  issue_comment:
    types: [created]
  issues:
    types: [opened, reopened, labeled, unlabeled]

permissions:
  contents: write
  pull-requests: write
  issues: write

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

Event | Activity types evaluated | Pull request(s)
--- | --- | ---
`pull_request`, `pull_request_target` | `labeled`, `unlabeled`, `reopened`, `ready_for_review`, `edited` | `pull_request.number`
`pull_request_review` | `submitted`, `dismissed` | `pull_request.number`
`check_suite` | `completed`, unless the conclusion is `failure`, `cancelled`, `timed_out` or `action_required` | `check_suite.pull_requests`, else every open PR whose head is `head_sha`
`status` | `success` (`pending`, `failure`, `error` make no call) | every open PR whose head is `sha`

`opened` is skipped: nothing can be mergeable yet. `synchronize` is skipped on purpose: a push
must remove `lgtm` (the [`lgtm` PR job](./pr-jobs.md)) and must not merge, and the job runs
after the event handlers, so evaluating there would race the removal. The check suite that the
push starts, or the cron, evaluates the PR once it is reviewed again. A review here only counts
towards branch protection; turning reviews into `lgtm` is not what this does.

For each candidate the handler reads `GET /pulls/{n}` (labels are taken from that read, not
from the payload), applies the [merge gate](#the-merge-gate), then looks at GitHub's own verdict:

`mergeable_state` | Outcome | Why
--- | --- | ---
`clean` | merge | every required check and review passed
`has_hooks` | merge | clean, a non-required pre-receive hook is still running
`unstable` | skip | a non-required check is pending or failed; GitHub would merge, this action does not
`blocked` | skip | a required check or review is missing
`behind` | skip | branch protection requires the branch to be up to date
`dirty` | skip | merge conflicts
`draft` | skip | draft pull request
`unknown` | retry, then skip | see below

A skip is logged as `skipping pr #<n>: not mergeable (<state>)` and never fails the run. This is
stricter than the cron, which sends the merge and reports GitHub's refusal instead.

### `unknown`: GitHub computes mergeability lazily

Right after a push GitHub has not computed `mergeable_state`; the first read starts the
computation and answers `unknown`. When the gate passes and the state is `unknown` the handler
re-reads the pull request after 1 s, 2 s and 4 s (7 s in total). A state still `unknown` after
the last read is skipped like any other non-mergeable state; the next event or the cron gets it.
The waits only happen once the gate passes: a PR without `lgtm` costs one read.

### Concurrency

Two events for one pull request can run at the same time (a label and a check completing within
seconds). Both may send the merge; GitHub refuses the loser with `405`. The handler then re-reads
the pull request: `merged: true` is logged as `pr #<n> was merged concurrently` and is not a
failure. Any other refusal is logged as an error annotation and fails the run with
`could not merge pull request(s) #<n>`, so the operator sees it.

### `merge_on_events`

```yaml
tide:
  merge_on_events: false
```

`false` turns all three handlers off after they read the configuration: no pull request is read,
nothing is merged, the cron alone merges. Default `true`. Repositories that do not subscribe to
the events get the same effect without the flag.

A merge performed with `GITHUB_TOKEN` does not trigger `push` workflows for other automation;
use a PAT or GitHub App token if something must run after the merge.

## The `lgtm` cron job

The cron is the backstop for missed events (a workflow run that was skipped, a webhook that was
lost, a PR whose state was still `unknown` when the last event ran). It pages through every open
pull request, applies the merge gate to the listed labels and sends the merge without reading
`mergeable_state`; GitHub refuses what cannot merge.

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
      - uses: cncf/prow-github-actions@v3
        with:
          jobs: lgtm
          github-token: '${{ secrets.GITHUB_TOKEN }}'

          # optional; tide.merge_method in prow.yaml wins over this input
          merge-method: squash
```

Locked and closed PRs are skipped. Every eligible PR is attempted, so one un-mergeable PR does
not stop the others. Each failed merge is logged as an error annotation
(`could not merge pr #<n>: <reason>`); once all pages are processed the run fails if any merge
failed, listing the PRs: `2 pull request(s) could not be merged: #1 (Pull Request is not mergeable), #7 (...)`.
With event-driven merging in place an hourly or daily schedule is plenty; drop the cron entirely
if a missed event is acceptable.

The companion `lgtm` PR job removes the `lgtm` label from a PR that gets updated.
This prevents any un-reviewed code from being automatically merged by either path.
See [PR jobs](./pr-jobs.md) for the full workflow.

## The merge gate

The gate is Prow's [tide](https://docs.prow.k8s.io/docs/components/core/tide/) query,
read from the `tide` section of the [configuration](./configuration.md#tide):

```yaml
tide:
  labels: [lgtm] # every entry must be present
  missing_labels: [do-not-merge/*, needs-rebase, hold] # no entry may be present
  merge_method: squash
```

Key | Default | Rule
--- | --- | ---
`labels` | `[lgtm]`; `[lgtm, approved]` on a repository with [OWNERS files](./commands.md#owners) | every pattern must match at least one label on the PR
`missing_labels` | `[do-not-merge/*, needs-rebase, hold]` | no pattern may match any label on the PR
`merge_method` | see below | `merge`, `squash` or `rebase`
`merge_on_events` | `true` | `false` leaves merging to the cron; see [above](#merge_on_events)

A configured list **replaces** the default list, it does not extend it: `missing_labels: [needs-rebase]`
lets a PR with `do-not-merge/hold` merge. Label names compare case-insensitively; `*` matches any run of
characters, `/` included, so `do-not-merge/*` covers the whole family while a bare `do-not-merge` matches
only that exact label.

The `labels` default follows the repository: with no `OWNERS` file anywhere on the default
branch it is `[lgtm]`; with one it is `[lgtm, approved]`, the label the
[`/approve` plugin](./commands.md#approve) manages. The check is one recursive tree listing of
the default branch per run (the event payload's `repository.default_branch`, else
`GET /repos/{owner}/{repo}`), skipped entirely when `tide.labels` is configured.

`lgtm` and `approved` age differently: a push (`synchronize`) removes `lgtm` (the
[`lgtm` PR job](./pr-jobs.md)) but never `approved`, which is recomputed from the comments and
reviews on the PR and stays until an approver cancels or a review requests changes.

A PR that does not pass is skipped with the reason in the job log:

```
skipping pr #12: missing lgtm
skipping pr #13: blocked by do-not-merge/work-in-progress
```

### `merge_method`

Resolution order, first match wins:

1. `tide.merge_method` in the configuration
2. the `merge-method` action input
3. `merge`

The input keeps working for existing workflows; the configuration wins when both are set. An unknown input
value falls back to `merge`, an unknown `tide.merge_method` fails the run at configuration validation.

### The `do-not-merge/*` family

Prow's blocking labels; any of them blocks the gate by default. Only `do-not-merge/hold` is applied by this
action; the others exist so humans and other automation can block a merge with a label the gate already knows.

Label | Applied by | Meaning in Prow
--- | --- | ---
`do-not-merge/hold` | [`/hold`](./commands.md) | someone issued `/hold`
`do-not-merge/work-in-progress` | humans, other automation | the PR title starts with `WIP` or the PR is a draft
`do-not-merge/invalid-owners-file` | humans, other automation | an OWNERS file in the PR does not parse
`do-not-merge/release-note-label-needed` | humans, other automation | the PR has no release note label
`do-not-merge/contains-merge-commits` | humans, other automation | the PR carries merge commits
`do-not-merge/blocked-paths` | humans, other automation | the PR touches a blocked path
`do-not-merge/cherry-pick-not-approved` | humans, other automation | a release branch cherry-pick lacks approval
`do-not-merge/<anything>` | humans, other automation | matched by `do-not-merge/*`; Kubernetes uses `do-not-merge/needs-kind` and `do-not-merge/needs-sig`

`needs-rebase` and the legacy `hold` complete the default deny-list. `/label` and `/remove-label` refuse
every `do-not-merge/*` label ([commands](./commands.md)); apply the others through GitHub's UI or other
tooling, and remove them with `/remove`. Only `do-not-merge/hold` is in the
[label catalogue](./configuration.md#the-label-catalogue); create the others by hand or list them in a
`labels` section.

## Upgrading to aggregated approval

**BREAKING** for repositories with OWNERS files. `/approve` no longer makes the bot submit a
GitHub review; it feeds the [approve plugin](./commands.md#approve), which manages the `approved`
label, and the merge gate's default `labels` becomes `[lgtm, approved]` there.

What | Before | Now (repositories with OWNERS files)
--- | --- | ---
`/approve` requires | approver for **every** changed file | approver for **at least one** changed file
`/approve` does | the bot submits an `APPROVE` review | records the commenter's approval; `approved` is added once every changed file is covered; the `[APPROVALNOTIFIER]` comment is posted/edited
the PR author | nothing | implicitly approves the files they own (`approve.require_self_approval: false`)
GitHub reviews | ignored | `APPROVED` adds an approver, `CHANGES_REQUESTED` removes one
`/approve cancel` | dismisses the bot's review | withdraws the commenter's approval; recomputes
the merge gate requires | `lgtm` | `lgtm` **and** `approved`
a push (`synchronize`) | — | removes `lgtm` (unchanged), keeps `approved`

Repositories **without** OWNERS files are untouched: bot review, no label, gate `[lgtm]`.

Steps:

1. Run the [`label-sync` job](./cron-jobs.md#label-sync), or create `approved` by hand. Until it
   exists an evaluation that wants to add it fails with
   `the label(s) approved cannot be applied because the repository doesn't have them`.
2. Subscribe the workflow to `pull_request` (`opened`, `reopened`, `synchronize`, `labeled`,
   `unlabeled`) and `pull_request_review` (`submitted`, `dismissed`) so approvals from reviews and
   authorship are picked up ([events](./events.md)). `/approve` comments work with `issue_comment` alone.
3. Open PRs need an approver: an author who owns every changed file is approved on the next
   evaluation; anyone else needs `/approve` (or an approving review) from the OWNERS approvers.
4. If branch protection relied on the bot's approving review to satisfy "required approving
   reviews", that review is no longer submitted. Either let this action's merge gate be the
   approval signal (`approved` + `lgtm`, then it merges), or lower the required review count and
   let a human's review, which the plugin also counts, satisfy the protection.
5. To keep merging on `lgtm` alone, pin the gate: `tide: { labels: [lgtm] }`. The `approved`
   label and the notifier are still maintained for information.

This repository has no OWNERS files, so its own workflows are unaffected.

## Upgrading from the `hold` label

**BREAKING.** `/hold` used to apply `hold`; it now applies Prow's `do-not-merge/hold`.

What | Before | Now
--- | --- | ---
`/hold` applies | `hold` | `do-not-merge/hold` (`hold.label` in the configuration)
`/hold cancel`, `/unhold`, `/remove-hold` remove | `hold` | `hold.label` **and** the legacy `hold`, whichever are present
the merge gate blocks on | `hold` | `do-not-merge/*`, `needs-rebase`, `hold`
`label-sync` creates | `hold` | `do-not-merge/hold` and `hold`

Steps:

1. Run the [`label-sync` job](./cron-jobs.md#label-sync), or create `do-not-merge/hold` by hand. Until it
   exists `/hold` fails with `the label(s) do-not-merge/hold cannot be applied because the repository doesn't have them`.
2. Nothing to do for PRs already carrying `hold`: they keep blocking the merge and `/hold cancel` releases them.
3. To keep the old name instead, set it in `prow.yaml`; cancel still removes both names:

   ```yaml
   hold:
     label: hold
   ```

4. Workflows that set `merge-method` keep working; move it to `tide.merge_method` when convenient.

Refer to the [lgtm command](./commands.md) and the [PR jobs](./pr-jobs.md) for further reference.

## Known limitations
The cron job pages through the repository's open PRs, following pages until one comes back empty. This _may_ trigger a state
where github rate limits Prow github actions.
This may only happen with very large projects.
Please open an issue if you see this consistently happen.

`check_suite` and `status` only trigger a workflow whose file is on the default branch, and
GitHub does not send `check_suite` for suites created by GitHub Actions itself (recursion guard).
A repository whose only checks are GitHub Actions workflows therefore gets no `check_suite`
event when they finish; the `labeled` event (`/lgtm` after green checks) or the cron merges it.
