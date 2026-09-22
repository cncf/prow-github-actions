# Automatic PR merging

A pull request is merged as soon as it passes the [merge gate](#the-merge-gate), its `lgtm`
is [bound to the head commit](#lgtm-is-bound-to-a-commit) **and** GitHub reports it mergeable.
Three paths reach the one merge routine:

Path | Trigger | Role
--- | --- | ---
event-driven | `issue_comment` (after a command), `pull_request`, `pull_request_review`, `check_suite`, `status` | primary; merges within seconds of the last command, label, review or check
`lgtm` cron job | `schedule` with `jobs: lgtm` | backstop for missed events; optional
[`sweep` job](./cron-jobs.md#sweep) | `schedule` with `jobs: sweep` | fork pull requests under `pull_request` ([installing](./installing.md#without-pull_request_target))

Every path evaluates a pull request the same way, in this order: label gate → `lgtm` binding →
`mergeable_state` (`clean` and `has_hooks` merge, everything else is skipped with the state as
the reason). Only the first step is free: a PR that fails the gate costs one read and nothing more.
On a branch that **requires a merge queue** the last step becomes "enqueue" and GitHub merges
([merge queues](#merge-queues)).

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
  statuses: write # the prow/lgtm commit status
  issues: write

jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - uses: cncf/prow-github-actions@v3.0.0
        with:
          prow-commands: /lgtm /approve /hold /kind /area /priority /check-required-labels /auto-cc
          jobs: lgtm
          github-token: '${{ secrets.GITHUB_TOKEN }}'
```

Event | Activity types evaluated | Pull request(s)
--- | --- | ---
`issue_comment` | `created`, after a label-writing [command](./commands.md) (`/lgtm`, `/approve`, `/hold`, `/remove`, `/kind`, ...) ran, on an open PR | `issue.number`
`pull_request`, `pull_request_target` | `labeled`, `unlabeled`, `reopened`, `ready_for_review`, `edited`; a `labeled` `lgtm` by a human is [bound to the head](#lgtm-is-bound-to-a-commit) first | `pull_request.number`
`pull_request_review` | `submitted`, `dismissed` | `pull_request.number`
`check_suite` | `completed`, unless the conclusion is `failure`, `cancelled`, `timed_out` or `action_required` | `check_suite.pull_requests`, else every open PR whose head is `head_sha`
`status` | `success` (`pending`, `failure`, `error` make no call) | every open PR whose head is `sha`

The bot's own label writes fire no `labeled` event
([events](./events.md#the-bots-writes-fire-no-events)), so `/lgtm`, `/approve`, `/unhold` and
every other command that changes a gate label evaluate the PR in the same run, right after the
command; a `/lgtm` on a `clean` PR merges it seconds later. A command that failed (an author's
`/lgtm`) still evaluates, which changes nothing since no label was written.

`opened` is skipped: nothing can be mergeable yet. `synchronize` is skipped on purpose: a push
must remove `lgtm` (the [`lgtm` PR job](./pr-jobs.md)) and must not merge, and the job runs
after the event handlers, so evaluating there would race the removal. The check suite that the
push starts, or the cron, evaluates the PR once it is reviewed again. A review here only counts
towards branch protection; turning reviews into `lgtm` is not what this does.

For each candidate the handler reads `GET /pulls/{n}` (labels are taken from that read, not
from the payload), applies the [merge gate](#the-merge-gate), checks the
[`lgtm` binding](#lgtm-is-bound-to-a-commit), then looks at GitHub's own verdict:

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

A skip is logged as `skipping pr #<n>: not mergeable (<state>)` and never fails the run. The cron
jobs apply the same rule since `lgtm` became bound to a commit; the cron no longer sends merges
GitHub would refuse.

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

`false` turns every event handler off after it reads the configuration, the evaluation after a
comment command included: no pull request is read, nothing is merged, the cron alone merges.
Default `true`. Repositories that do not subscribe to the events keep the after-command
evaluation and get the rest of the effect without the flag.

A merge performed with `GITHUB_TOKEN` does not trigger `push` workflows for other automation;
use a PAT or GitHub App token if something must run after the merge.

## `lgtm` is bound to a commit

The `lgtm` label counts toward a merge only while it is bound to the pull request's **current
head commit**. The binding is a commit status, context `prow/lgtm`, on the head SHA. A status
was chosen over a marker comment because only a write-token holder can set one (a PR author
cannot forge it) and because it is per commit by construction: a new head has no status, full
stop. So "new commits after review never merge" holds on **every** merge path (events, the
after-command evaluation, the `lgtm` cron, the `sweep`), whatever events the caller subscribed
to; the [`lgtm` PR job](./pr-jobs.md) removing the label on `synchronize` is defense in depth.

Step | When | Does
--- | --- | ---
bind | `/lgtm` succeeds | reads the PR's head, `POST /statuses/{head}` `prow/lgtm` `success` "lgtm by \<login\> at \<sha7\>" linking to the comment, **then** applies the label. A refused status (403) fails the command with `cannot bind lgtm to the commit: grant statuses: write to the workflow (or set lgtm.bind_to_commit: false)` and applies no label
bind | `pull_request` `labeled` `lgtm` by a **human** | the same status on `pull_request.head.sha`; a bot sender is ignored (the bot records its own bindings). `unlabeled` needs nothing: the label is the gate, the status the binding
verify | before any merge, once the label gate passes | `GET /commits/{head}/status`; `lgtm` on the PR ⇒ the head must carry `prow/lgtm` `success`. Without `lgtm` nothing is read
stale | the label is present, the head has no `success` | removes `lgtm`, sets `prow/lgtm` `pending` "lgtm removed: not bound to \<sha7\>", posts **one** comment per head (marker `<!-- prow-github-actions/lgtm-stale: <sha7> -->`), logs `skipping pr #<n>: lgtm not bound to <sha7>`; the run does not fail. The label being gone, the next evaluation makes no further call
cancel | `/lgtm cancel`, `/remove-lgtm` | removes the label as before and sets the head's `prow/lgtm` to `pending` "lgtm cancelled by \<login\>" so the checks UI stops showing a green lgtm; a refused status write here is a warning, not a failure

The stale comment reads: "`lgtm` is not bound to the current head commit (`<sha7>`): either
commits were pushed after it was applied, or it was applied by hand where the bot could not
record the commit. Removed. Re-apply with `/lgtm` once the current commits are reviewed."

```yaml
lgtm:
  bind_to_commit: true # the default
```

`false` restores label-only semantics: no status is written or read, and an `lgtm` applied
before a push merges the pushed commits unless the `synchronize` run removed it first. That is
weaker; use it only where `statuses: write` cannot be granted.

The merge itself is pinned to the verified commit: `PUT /pulls/{n}/merge` carries the head
`sha` the binding was checked on, so a push landing between the check and the merge is refused
by GitHub (409) and logged as `skipping pr #<n>: head moved`, never merged; the next event or
sweep re-evaluates the new head. Known window: a push that lands between a maintainer typing
`/lgtm` and the run recording the binding is bound, the same event-ordering window Prow has. Reading the status needs `statuses`
access too; with `statuses: write` missing the verification fails the run with
`could not read the prow/lgtm status of <sha7>: grant statuses: write ...`.

### Upgrading to the bound `lgtm`

**BREAKING.** The workflow needs `statuses: write` unless `lgtm.bind_to_commit: false`
([installing](./installing.md#upgrading)). Pull requests that already carry `lgtm` when you
upgrade are unbound: the next evaluation strips the label once, with the explanatory comment;
re-apply with `/lgtm`. The `lgtm` cron job now reads `mergeable_state` like the event path and
skips `blocked`, `unstable`, `behind`, `dirty` and `unknown` PRs instead of sending a merge
GitHub refuses; its failure list only contains merges GitHub actually refused.

## The `lgtm` cron job

The cron is the backstop for missed events (a workflow run that was skipped, a webhook that was
lost, a PR whose state was still `unknown` when the last event ran), not for comment commands:
those evaluate the PR themselves. It pages through every open pull request, applies the merge
gate to the listed labels and sends every PR that passes through the same evaluation as the
events: the [`lgtm` binding](#lgtm-is-bound-to-a-commit), then `mergeable_state`, then the merge.
A PR that fails the gate on its listed labels costs no further call.

```yaml
name: Merge on lgtm label
on:
  schedule:
    - cron: '0 * * * *'

permissions:
  contents: write
  pull-requests: write
  statuses: write

jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - uses: cncf/prow-github-actions@v3.0.0
        with:
          jobs: lgtm
          github-token: '${{ secrets.GITHUB_TOKEN }}'

          # optional; tide.merge_method in prow.yaml wins over this input
          merge-method: squash
```

Locked and closed PRs are skipped. Every eligible PR is attempted, so one un-mergeable PR does
not stop the others. A PR GitHub reports as not mergeable is skipped with the state logged; a
stale `lgtm` is stripped. Each refused merge is logged as an error annotation
(`could not merge pr #<n>: <reason>`); once all pages are processed the run fails if any merge
was refused, listing the PRs: `2 pull request(s) could not be merged: #1 (Pull Request is not mergeable), #7 (...)`.
With event-driven merging in place an hourly or daily schedule is plenty; drop the cron entirely
if a missed event is acceptable.

The companion `lgtm` PR job removes the `lgtm` label from a PR that gets updated on
`synchronize`; the [binding](#lgtm-is-bound-to-a-commit) makes the same guarantee without the
event. See [PR jobs](./pr-jobs.md) for the full workflow.

## Merge queues

A branch protection rule or ruleset with **Require merge queue** refuses every direct merge:
`PUT /pulls/{n}/merge` answers `405 Changes must be made through the merge queue.` Prow's tide
*is* a merge queue; with GitHub's in place its job collapses to **decide eligibility, then
enqueue**. The [merge gate](#the-merge-gate) plus the [`lgtm` binding](#lgtm-is-bound-to-a-commit)
is the ticket into the queue; GitHub batches, re-tests against the up-to-date base and merges.

```yaml
tide:
  merge_queue: auto # the default; off: never look, always PUT /merge
```

Step | Without a queue | With a required queue (`merge_queue: auto`)
--- | --- | ---
label gate, `lgtm` binding | unchanged | unchanged
detect | — | one GraphQL query per gate-passing PR: `isMergeQueueEnabled`, `isInMergeQueue`, `mergeQueueEntry { state position enqueuer }`
already queued | — | `skipping pr #<n>: in the merge queue (position P, STATE)`; no call
`mergeable_state` | `clean`, `has_hooks` merge; the rest skip | only `dirty` (conflicts) and `draft` skip; `blocked`, `behind`, `unstable`, `unknown` after the retries are **left to the queue** (debug-logged)
act | `PUT /pulls/{n}/merge` pinned to the head `sha` | `enqueuePullRequest(pullRequestId, expectedHeadOid: <the bound head>)`; logs `enqueued pr #<n> (position P)`
outcome | `merged` | `enqueued`, a success everywhere `merged` is: events, the cron and the sweep summaries
merge method | `tide.merge_method` | **the queue's** configured method; `tide.merge_method` and the `merge-method` input are ignored there (debug-logged once)

`expectedHeadOid` is the same guarantee the REST `sha` gave: the commit the binding was verified
on. A push between the check and the enqueue is refused by GitHub and logged as
`skipping pr #<n>: head moved`; GitHub also removes a queued PR whose head moves afterwards.

An enqueue GitHub refuses is classified by its message; the exact texts are not documented:

Message says | Result | Log
--- | --- | ---
the head OID does not match | skipped | `skipping pr #<n>: head moved`
already in the queue | skipped | `skipping pr #<n>: already in the merge queue`
not mergeable / required checks | skipped | `skipping pr #<n>: not ready for the merge queue: <GitHub's message>`
permission / resource not accessible | **failed** | `cannot add pr #<n> to the merge queue: the token may not enqueue (grant contents: write and pull-requests: write, or pass a token that can — see automatic-merging.md#merge-queues)`
anything else | **failed** | the raw message

### Leaving the queue when the gate breaks

An entry the **bot** put in the queue is removed when the PR stops passing the gate on an event:
`/lgtm cancel`, `/remove-lgtm`, `/hold`, `/approve cancel`, a `CHANGES_REQUESTED` review that
drops `approved`, a human removing a gate label, a stale `lgtm` being stripped. Each reaches the
same evaluation in the same run; the skip reads `skipping pr #<n>: missing lgtm (dequeued)` and
`dequeued pr #<n>: missing lgtm` is logged.

Rule | Why
--- | ---
only the bot's own entry (`enqueuer` is `github-actions` or ends with `[bot]`) | a human who clicked *Merge when ready* did so deliberately; never fight them
only on events, never on `schedule` | the cron and the sweep would otherwise cost one GraphQL query per open PR that fails the gate
a refused dequeue is a warning | the label, not the queue, is the gate

With a custom `token` the enqueuer is that user, so its entries look human to a run on another
token; keep one token for the bot.

### CI must subscribe to `merge_group`

The queue tests a temporary branch, not the PR. GitHub: "You **must** use the `merge_group`
event to trigger your GitHub Actions workflow when a pull request is added to a merge queue.
[...] Otherwise, status checks will not be triggered when you add a pull request to a merge
queue. The merge will fail as the required status check will not be reported."
([Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)).
Every workflow that reports a **required** check needs:

```yaml
on: [pull_request, merge_group]
```

Without it the queue stalls forever: tide enqueues, the entry waits for a check that never
runs, GitHub removes it, the next event enqueues again.

### Token

The bot enqueues with `GITHUB_TOKEN` granted `contents: write` and `pull-requests: write` (the
template already has both). If your queue refuses the bot with the permission message above,
pass a `token` that can ([installing](./installing.md#inputs-and-secrets)). Whether every
ruleset configuration lets `GITHUB_TOKEN` enqueue is being verified live; the message tells you.

### `merge_queue: off`

`off` restores the pre-queue behaviour byte for byte: no GraphQL call, `PUT /merge` always. On a
queue-required branch that means the 405 above on every evaluation, forever, and the run fails
each time; use it only where the GraphQL API is unreachable.

### What is not handled

The `pull_request` `enqueued` and `dequeued` activity types exist and are not handled: nothing
needs them yet. `check_suite` for the queue's temporary branches names no pull request in its
payload, so it evaluates nothing. Upgrading: nothing to do, the setting is additive.

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
`merge_queue` | `auto` | `off` never enqueues; see [merge queues](#merge-queues)

A configured list **replaces** the default list, it does not extend it: `missing_labels: [needs-rebase]`
lets a PR with `do-not-merge/hold` merge. Label names compare case-insensitively; `*` matches any run of
characters, `/` included, so `do-not-merge/*` covers the whole family while a bare `do-not-merge` matches
only that exact label.

The `labels` default follows the repository: with no `OWNERS` file anywhere on the default
branch it is `[lgtm]`; with one it is `[lgtm, approved]`, the label the
[`/approve` plugin](./commands.md#approve) manages. The check is one recursive tree listing of
the default branch per run (the event payload's `repository.default_branch`, else
`GET /repos/{owner}/{repo}`), skipped entirely when `tide.labels` is configured.

`lgtm` and `approved` age differently: `lgtm` is [bound to the head commit](#lgtm-is-bound-to-a-commit)
and a push (`synchronize`) removes it (the [`lgtm` PR job](./pr-jobs.md)); `approved` is never
removed by a push, it is recomputed from the comments and reviews on the PR and stays until an
approver cancels or a review requests changes.

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
The cron job pages through the repository's open PRs, following pages until one comes back empty,
and reads each PR that passes the label gate (plus its head's status). This _may_ trigger a state
where github rate limits Prow github actions.
This may only happen with very large projects.
Please open an issue if you see this consistently happen.

`check_suite` and `status` only trigger a workflow whose file is on the default branch, and
GitHub does not send `check_suite` for suites created by GitHub Actions itself (recursion guard).
A repository whose only checks are GitHub Actions workflows therefore gets no `check_suite`
event when they finish; the `labeled` event (`/lgtm` after green checks) or the cron merges it.
