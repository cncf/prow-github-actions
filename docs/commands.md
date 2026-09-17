# Prow github actions commands

These docs describe `main`. Features added since the latest release (`v2.0.0`) ship in the next release, `v3.0.0`, which also creates the floating `v3` tag; until then pin `@v2.0.0` for the released behaviour ([releasing](./releasing.md)).

## Command syntax

- A command must start a line of the comment; leading whitespace is allowed. A command mentioned mid-sentence is ignored.
- Commands and their keywords (`cancel`, `clear`, `not-planned`) are case-insensitive: `/LGTM cancel` works.
- **Label values** are matched case-insensitively against the prow configuration ([configuration](./configuration.md), [labeling](./labeling.md)) and applied with the casing written in the file: `/kind Bug` adds `kind/bug`.
- Commands inside Markdown code (fenced ``` / ~~~ blocks, indented code, inline `code`) and blockquotes are ignored.
- When a command appears on several lines of one comment every line is applied (`/kind bug` and `/kind cleanup` add both labels), except `/milestone` and `/retitle` where the last line wins.
- A `cancel` on any line wins over a plain `/lgtm`, `/hold` or `/approve`.
- Milestone titles are matched exactly.
- Prow-style aliases (`/remove-lgtm`, `/unhold`, ...) are enabled together with their base command. Listing an alias in `prow-commands` enables the whole command family: configuring only `/remove-kind` also enables `/kind`, and only `/unhold` also enables `/hold`.
- Any other lower-case `/<key>` listed in `prow-commands` is a [label command](./labeling.md#any-key-is-a-command) backed by the `<key>` label section of the prow configuration ([configuration](./configuration.md)).

Commands | Policy | Description
--- | --- | ---
`/approve` | [OWNERS](#owners) approver for **at least one** changed file if the repo has OWNERS files, otherwise Org members and Collaborators | on a repo with OWNERS files: records the commenter's approval for the files they own and re-evaluates the [approve plugin](#approve), which adds `approved` once every changed file is covered and posts/edits the `[APPROVALNOTIFIER]` comment; no GitHub review is submitted. Otherwise: the bot submits an approving review. The [merge gate](./automatic-merging.md#event-driven-merging) is evaluated right after
`/approve no-issue` | same as `/approve` | same as `/approve`; accepted for Prow compatibility
`/approve cancel` | same as `/approve` | on a repo with OWNERS files: withdraws the commenter's approval and re-evaluates (`approved` is removed if the files they covered are no longer covered). Otherwise: dismisses the bot's latest approval
`/remove-approve` | same as `/approve` | same as `/approve cancel`
`/assign [@userA @userB @etc]` | anyone | Assign other users (or yourself if no one is specified). Target user must be Org Member, Collaborator, or have previously commented
`/unassign [@userA @userB @etc]` | anyone | Unassigns specified people (or yourself if no one is specified). With targets, the commenter must be Org Member, Collaborator, or have previously commented. Target must have been already assigned.
`/cc [@userA @userB @etc]` | anyone | Request review from specified people (or yourself if no one is specified). Self-cc requires Collaborator; targets must be an Org Member, Collaborator, or have previously commented.
`/uncc [@userA @userB @etc]` | anyone | Dismiss review request for specified people (or yourself if no one is specified). Self-uncc requires Collaborator; with targets, the commenter must be Org Member, Collaborator, or have previously commented. Target must already have had a review requested.
`/close` | Collaborators **or the issue/PR author** | closes the issue / PR
`/close not-planned` | Collaborators **or the issue/PR author** | closes the issue / PR with the `not planned` state reason
`/reopen` | Collaborators **or the issue/PR author** | reopens a closed issue / PR
`/lock [resolved / off-topic / too-heated / spam]` | Collaborators | locks the issue / PR with the specified reason (case-insensitive; an unknown reason fails the run without locking)
`/milestone milestone-name` | Collaborators | Adds issue / PR to an existing milestone. With no title the run fails. An unknown title fails the run with the list of available milestones
`/milestone clear` | Collaborators | Removes the issue / PR from its milestone
`/retitle some new title` | Collaborators | Renames the issue / PR. With no title, nothing happens
`/meow` | anyone | replies with a random cat image from [the cat API](https://thecatapi.com)
`/check-required-labels` | anyone | re-evaluates every [`require_matching_label`](./configuration.md#require_matching_label) rule on the open issue / PR at once: adds the missing `needs-*` labels, removes the satisfied ones. No `/remove-` form
`/retest` | same as `/lgtm`, PRs only | re-runs the failed jobs of every GitHub Actions workflow run on the head commit that ended in `failure`, `cancelled` or `timed_out`; runs in progress are left alone. Reacts 🚀 on the comment; comments only when nothing failed. Needs `actions: write`. [trigger](#trigger)
`/test all` | same as `/lgtm`, PRs only | re-runs every completed GitHub Actions workflow run on the head commit, whatever its conclusion. [trigger](#trigger)
`/test <workflow>` | same as `/lgtm`, PRs only | re-runs the completed run(s) whose workflow name or file matches (`ci`, `CI`, `ci.yml`; case-insensitive); several `/test` lines are unioned. No match: comments the list of runs
`/test ?`, `/test` | same as `/lgtm`, PRs only | comments a `workflow` / `status` / `conclusion` table of the runs on the head commit
`/ok-to-test` | same as `/lgtm`, **not the PR author**, PRs only | approves the GitHub Actions workflow runs waiting for approval on the head commit (a first-time contributor's fork) and adds the `ok-to-test` label; while the label stays, pending runs are approved again on every push and by the [sweep](./cron-jobs.md#sweep). Needs `actions: write`. [trigger](#trigger)
`/auto-cc` | anyone, PRs only | runs [blunderbuss](./configuration.md#blunderbuss): requests review from `request_count` [OWNERS](#owners) reviewers of the changed files, ignoring `ignore_drafts` and `ignore_authors`. No arguments, no `/remove-` form

Label Commands | Policy | Description
--- | --- | ---
`/area [label1 label2 ...]` | anyone | adds an area/<> label(s) if it's defined in the prow configuration ([configuration](./configuration.md))
`/remove-area [label1 label2 ...]` | anyone | removes an area/<> label(s) if it's defined in the prow configuration ([configuration](./configuration.md))
`/kind [label1 label2 ...]` | anyone | adds a kind/<> label(s) if it's defined in the prow configuration ([configuration](./configuration.md))
`/remove-kind [label1 label2 ...]` | anyone | removes a kind/<> label(s) if it's defined in the prow configuration ([configuration](./configuration.md))
`/lgtm` | [OWNERS](#owners) reviewer or approver for **at least one** changed file if the repo has OWNERS files, otherwise Org members and Collaborators; **not the PR author** | on a PR, records the head commit as a `prow/lgtm` commit status, then adds the `lgtm` label and evaluates the [merge gate](./automatic-merging.md#event-driven-merging) right after: a `clean` PR merges in the same run. The label only merges while it is [bound to the head](./automatic-merging.md#lgtm-is-bound-to-a-commit); needs `statuses: write`. Like Prow, you cannot LGTM your own PR; the guard also applies to issues since the label has no meaning there either
`/lgtm cancel` | same as `/lgtm`, **or the PR author** | removes the `lgtm` label and sets the head's `prow/lgtm` status to `pending`
`/remove-lgtm` | same as `/lgtm`, **or the PR author** | same as `/lgtm cancel`
`/hold` | anyone | adds the `do-not-merge/hold` label (or [`hold.label`](./configuration.md#hold)) which prevents [automatic PR merging](./automatic-merging.md). Also see [lgtm removal on pr update](./pr-jobs.md)
`/hold cancel` | anyone | removes the `do-not-merge/hold` (or `hold.label`) label and the legacy `hold` label, whichever are present, and evaluates the [merge gate](./automatic-merging.md#event-driven-merging) right after
`/unhold`, `/remove-hold` | anyone | same as `/hold cancel`
`/priority [label1 label2 ...]` | anyone | adds a priority/<> label(s) if it's defined in the prow configuration ([configuration](./configuration.md)). Exclusive by default: replaces any existing `priority/*` labels
`/remove-priority [label1 label2 ...]` | anyone | removes a priority/<> label(s) if it's defined in the prow configuration ([configuration](./configuration.md))
`/label [label1 label2 ...]` | anyone | adds the label(s) verbatim if listed under `labels:` in the prow configuration ([configuration](./configuration.md)). Label names containing spaces are not supported. Refuses `lgtm`, `hold`, `approved`, `do-not-merge/*` and `hold.label`
`/remove-label [label1 label2 ...]` | anyone | removes the label(s) if listed under `labels:` in the prow configuration ([configuration](./configuration.md)). Refuses `lgtm`, `hold`, `approved`, `do-not-merge/*` and `hold.label`
`/lifecycle [frozen / stale / rotten]` | anyone | adds the `lifecycle/<>` label and removes any other `lifecycle/*`. Values come from Prow and can be [overridden in the prow configuration](./labeling.md#lifecycle-stage-and-status-labels)
`/remove-lifecycle [frozen / stale / rotten]` | anyone | removes the `lifecycle/<>` label
`/stage [alpha / beta / stable]` | anyone | adds the `stage/<>` label and removes any other `stage/*`. Values come from Prow and can be [overridden in the prow configuration](./labeling.md#lifecycle-stage-and-status-labels)
`/remove-stage [alpha / beta / stable]` | anyone | removes the `stage/<>` label
`/status [approved-for-milestone / in-progress / in-review]` | anyone | adds the `status/<>` label and removes any other `status/*`. Values come from Prow and can be [overridden in the prow configuration](./labeling.md#lifecycle-stage-and-status-labels)
`/remove-status [approved-for-milestone / in-progress / in-review]` | anyone | removes the `status/<>` label
`/help` | anyone | adds the `help wanted` label
`/remove-help` | anyone | removes the `help wanted` and `good first issue` labels
`/good-first-issue` | anyone | adds the `good first issue` and `help wanted` labels
`/remove-good-first-issue` | anyone | removes the `good first issue` label
`/<key> [value1 value2 ...]` | anyone | adds `<key>/<value>` label(s) for any other label section `<key>` of the prow configuration ([configuration](./configuration.md)) once `/<key>` is listed in `prow-commands`. Exclusive when the section sets `exclusive: true`
`/remove-<key> [value1 value2 ...]` | anyone | removes `<key>/<value>` label(s) listed under `<key>` in the prow configuration ([configuration](./configuration.md))
`/remove [label1 label2 ...]` | Collaborators | removes a specified label(s) on an issue / PR

Every label-writing command that ran (`/lgtm`, `/approve`, `/hold`, `/remove`, `/ok-to-test` and the label commands below) is followed by a re-check of the [`require_matching_label`](./configuration.md#require_matching_label) rules (`/kind cleanup` clears `needs-kind` in the same run) and, on an open PR, by the merge gate; see [events](./events.md#the-bots-writes-fire-no-events) for why.

Every label command applies only labels the repository already defines ([labeling](./labeling.md#labels-must-exist-in-the-repository)); a missing label fails the run with `the label(s) <names> cannot be applied because the repository doesn't have them`. The `/remove-<key>` commands are enabled together with their base command and only remove values listed in the prow configuration ([configuration](./configuration.md)), so anyone may use them. `lgtm`, `hold`, `approved`, `do-not-merge/*` and a configured `hold.label` are always refused by `/label` and `/remove-label`, even when listed under `labels:`; the run fails with `<label> is managed by its own command`. Use `/lgtm`, `/hold` and `/approve` for those, and `/remove` for arbitrary labels.

## What happens when you are not authorized

Failure behaviour differs per command:

- `/close`, `/reopen` and `/retitle` silently do nothing.
- `/lock`, `/remove` and `/milestone` fail the run.
- `/lgtm`, `/approve`, `/retest`, `/test` and `/ok-to-test` reply with a comment and fail the run.

## `/lgtm` and the reviewed commit

On a pull request `/lgtm` reads the head commit, writes the `prow/lgtm` commit status on it
(`success`, "lgtm by \<login\> at \<sha7\>", linked to the comment) and only then applies the
label; a status the token cannot write (403) fails the command with
`cannot bind lgtm to the commit: grant statuses: write to the workflow (or set lgtm.bind_to_commit: false)`
and applies no label. Every merge path then requires the head to still carry that status; a
head pushed after the `/lgtm` has none, so the label is stripped with one explanatory comment
instead of merging. `/lgtm cancel` sets the status to `pending`. On an issue `/lgtm` only
labels. Details, the configuration flag and the upgrade note:
[automatic merging](./automatic-merging.md#lgtm-is-bound-to-a-commit).

## trigger

Modelled on Prow's [`trigger`](https://github.com/kubernetes-sigs/prow/tree/main/pkg/plugins/trigger)
plugin, for the repository's own **GitHub Actions workflow runs**. Checks from other CI systems
are neither listed nor re-run.

Command | Does | Runs it acts on
--- | --- | ---
`/retest` | `POST .../runs/{id}/rerun-failed-jobs` | completed runs with conclusion `failure`, `cancelled` or `timed_out`
`/test all` | `POST .../runs/{id}/rerun` | every completed run
`/test <workflow>` | `POST .../runs/{id}/rerun` | completed runs whose `name` or workflow file basename matches, case-insensitively
`/test ?`, `/test` | a comment | none; lists `workflow`, `status`, `conclusion`
`/ok-to-test` | `POST .../runs/{id}/approve`, then the `ok-to-test` label | runs with `status` or `conclusion` `action_required` (awaiting approval)

- **Who may**: whoever may `/lgtm` (an OWNERS reviewer or approver of a changed file, otherwise an org
  member or collaborator). For `/retest` and `/test` the pull request author is not excluded: an
  org-member author may retest their own PR. `/ok-to-test` refuses the author (`you cannot approve the
  workflow runs of your own pull request`): it is the trust decision. Refusals reply with a comment and
  fail the run, like `/lgtm`.
- **What counts as a run**: every workflow run on the pull request's **head commit**
  (`GET /repos/{owner}/{repo}/actions/runs?head_sha=<head>`), **except the workflow this very command
  runs in** (the run whose name is `GITHUB_WORKFLOW`, the caller's workflow): re-running it would re-run
  the command.
- **Feedback**: on success a single 🚀 reaction on the triggering comment, no comment. A comment is
  posted only when nothing happened: `No failed GitHub Actions workflow runs on <sha7>: N in progress,
  M successful. Checks from other CI systems cannot be re-run here.`, or `... are already being re-run.`
  when every candidate answered 409 (not completed, or already re-running; those are skipped).
- **`ok-to-test` is the trust marker.** GitHub holds the workflow runs of a first-time contributor's public
  fork until a maintainer approves them. `/ok-to-test` approves the ones waiting on the head, then applies
  the `ok-to-test` label ([built-in](./labeling.md#built-in-labels), created by `label-sync`; it must
  exist). While the pull request carries the label, the runs waiting on every later head are approved
  too: by the `pull_request` `synchronize`/`reopened` handler when the token can write (`pull_request_target`,
  or a same-repository PR) and by the [`sweep`](./cron-jobs.md#sweep) otherwise ([events](./events.md#which-events-each-feature-needs)).
  Removing the label by hand stops the auto-approval; nothing re-adds it. Nothing pending on the head
  still earns the rocket when the label was just added; with the label already present it comments
  `No workflow runs waiting for approval on <sha7>.` instead. The post-command
  [`needs-*` re-check and merge gate](./events.md#the-bots-writes-fire-no-events) follow, as after
  any label write.
- **Permissions**: the run endpoints need **`actions: write`** (the templates and the reusable workflow
  grant it). A 403 fails the run with `cannot re-run workflows: grant actions: write to the workflow` (`cannot approve
  workflow runs: ...` for `/ok-to-test`).
  The reaction needs `issues: write` / `pull-requests: write`; a failed reaction is only a warning.
- On an issue every trigger command replies `/retest only applies to pull requests.` and does nothing.
- `/override`, `/skip` and `/retest-required` are not supported.

## Enabling `/meow`

`/meow` is opt in and calls a third party image provider ([the cat API](https://thecatapi.com)). Anyone who can comment on the repository can invoke it and consume the configured API quota, so enable it only on repositories where that is acceptable. The command must be on its own line. It is best effort: if the provider is unavailable it leaves a short note instead of failing the workflow. Only images served from the provider's own CDN are rendered.

```yaml
permissions:
  issues: write
  pull-requests: write

jobs:
  prow:
    runs-on: ubuntu-latest
    steps:
      - uses: cncf/prow-github-actions@v3
        with:
          prow-commands: /meow
          github-token: '${{ secrets.GITHUB_TOKEN }}'
          cat-api-key: '${{ secrets.CAT_API_KEY }}'
```

The workflow token needs `issues: write` or `pull-requests: write` to post the response, because a new repository's `GITHUB_TOKEN` often defaults to read only. Grant both when the same workflow handles comments on issues and pull requests.

The API key is optional; unauthenticated access is best effort and may be rate limited by the provider. When set, it is provided from a repository secret and registered for runner masking before use, and is never intentionally included in the request URL or a GitHub comment.

## OWNERS

A simplified version of [Prow's OWNERS](https://go.k8s.io/owners) files is supported. When the repository contains any `OWNERS` file, the `/lgtm` and `/approve` commands are authorized against them and [`/approve` aggregates approvals per OWNERS file](#approve); when it contains none, org members and collaborators may use both commands. The same files drive the `pull_request` plugins: [`owners-label`](./labeling.md#labels-from-owners-files) applies their `labels:`, [`blunderbuss`](./configuration.md#blunderbuss) requests reviews from their `reviewers`, and [`approve`](#approve) manages the `approved` label. See an [example][owners-example] using OWNERS files.

### Where OWNERS files live

An `OWNERS` file may be placed in any directory. It applies to the files in that directory and all directories below it. Which files apply to a given path is resolved the way Prow does it: walk from the file's directory up to the repository root and take the union of every `OWNERS` file on the way (a directory's `OWNERS` plus its parents'). A root-only `OWNERS` therefore covers the whole repository.

Setting `options.no_parent_owners: true` in an `OWNERS` file stops the walk there, so only that file (and any below it) applies and the parents' approvers and reviewers are not inherited.

### Which files decide the outcome

On a pull request the changed files are listed (for renames both the old and the new path count) and their OWNERS are read from the PR's **base** branch. The head branch is never consulted, so a pull request cannot grant itself approvers by editing an `OWNERS` file.

- `/approve`: the commenter must be an `approver` for **at least one** changed file; their approval then counts for the files they own and the [approve plugin](#approve) decides whether the whole pull request is approved. The refusal is `<user> is not an approver for any changed file`.
- `/lgtm`: the commenter must be a `reviewer` or `approver` for **at least one** changed file (Prow's lgtm rule).
- On an issue there are no changed files, so the root `OWNERS` of the default branch is used.

The `approvers` role does not grant `/lgtm` on its own for issues; on pull requests an approver of a changed file may also `/lgtm`.

### approve

Modelled on Prow's [`approve`](https://github.com/kubernetes-sigs/prow/tree/main/pkg/plugins/approve)
plugin. It only acts on pull requests whose base branch has OWNERS files; repositories without
any OWNERS file keep the legacy `/approve` (a bot review, see [below](#repositories-without-owners-files)).

**Coverage, not counting.** A pull request is approved when the current approvers *collectively*
cover every changed file (both paths of a rename count). A user covers a file when an OWNERS file
in the file's directory or above lists them under `approvers` (`options.no_parent_owners` stops
the walk, like everywhere else). One approver may cover everything; a PR spanning `sdk/` and
`olm/` with disjoint approvers needs one of each.

**Who is a current approver** is recomputed from scratch on every evaluation from the PR's
comments and reviews; nothing is remembered between runs but the `approved` label itself:

Source | Effect
--- | ---
the PR author | approves implicitly every file their OWNERS entries cover ([`approve.require_self_approval: false`](./configuration.md#approve), Prow's default). They still cannot `/lgtm` their own PR
`/approve`, `/approve no-issue` | adds the commenter, if they are an approver of at least one changed file
`/approve cancel`, `/remove-approve` | removes the commenter
a review in state `APPROVED` | adds the reviewer (unless [`ignore_review_state`](./configuration.md#approve))
a review in state `CHANGES_REQUESTED` | removes the reviewer, even after a `/approve` (unless `ignore_review_state`)
`/lgtm`, `/lgtm cancel` | count as `/approve`, `/approve cancel` only with [`lgtm_acts_as_approve`](./configuration.md#approve)
comments or reviews by bots | never count

Comments and reviews are ordered by time; each user's latest action wins, so `/approve` after a
`CHANGES_REQUESTED` review re-adds them and a cancel after an approval removes them. A comment
carrying both `/approve` and `/approve cancel` is a cancel.

**What it writes:**

- the `approved` label, added when the PR becomes covered and removed when it stops being covered.
  Only written when the state changes; a human adding or removing it triggers a re-evaluation that
  puts it back the way the coverage says. The label must [exist in the repository](./labeling.md#labels-must-exist-in-the-repository)
  (`label-sync` creates it);
- one `[APPROVALNOTIFIER] This PR is **APPROVED**` / `**NOT APPROVED**` comment, posted on the first
  evaluation and edited in place afterwards (found by the hidden marker `<!-- prow-github-actions/approve -->`).
  It lists the approvers so far, who to `/assign` to complete the approval (chosen greedily: whoever
  covers the most still-uncovered files, ties alphabetically) and every OWNERS file the PR touches,
  struck through with its approvers once covered, bold otherwise.

**Sticky.** A push (`synchronize`) never removes `approved`; the PR is re-evaluated because the
changed files may differ, and the comments and reviews still stand. This is the opposite of `lgtm`,
which the [`lgtm` PR job](./pr-jobs.md) removes on every push.

**Edge cases:** a pull request with **no changed files** is not approved (there is nothing anyone
vouches for); a changed file no OWNERS file covers can never be approved and is listed as such in
the notifier. `/approve cancel` by someone who never approved is a no-op re-evaluation.

**No bot review.** On repositories with OWNERS files the bot submits no GitHub review any more:
a review by `github-actions[bot]` would satisfy branch protection's "required approving reviews"
on its own, which is the wrong signal once `approved` is what the [merge gate](./automatic-merging.md#the-merge-gate)
requires. `/approve cancel` therefore dismisses nothing; it just recomputes.

Events that evaluate: `pull_request` `opened`, `reopened`, `synchronize`, `labeled`/`unlabeled` of
`approved`; `pull_request_review` `submitted`, `dismissed`; and the `/approve` family of comments.
See [events](./events.md).

### Repositories without OWNERS files

Zero behaviour change. `/approve` by an org member or collaborator makes the bot submit an
`APPROVE` review; `/approve cancel` and `/remove-approve` dismiss its latest one; no `approved`
label, no notifier. The same legacy path applies to `/approve` on an **issue** even when the
repository has OWNERS files (the root OWNERS file authorizes it), since an issue has no changed
files to cover.

The pull request plugins resolve the same set of OWNERS files per changed file. `owners-label` applies the union of their `labels`; `blunderbuss` draws reviewers from the union of their `reviewers` (and `approvers`), weighting each by how many changed files they cover. Prow's owners-label takes only the deepest OWNERS file's labels; here labels inherit from parent directories like approvers do, and `options.no_parent_owners` stops that inheritance too.

### Failure modes

Authorization fails closed:

- a changed file with no covering `OWNERS` file fails the command with an error naming the file;
- an `OWNERS` file that cannot be fetched or parsed (for example `approvers` is not a list) fails the command;
- the org-member/collaborator fallback applies only when the repository has **no** `OWNERS` file at all.

### File format

The OWNERS file must be in YAML format. All entries are expected to be GitHub usernames (compared case-insensitively); teams are not supported.

Key | Meaning
--- | ---
`approvers` | list of usernames whose `/approve` (or approving review, or authorship) covers the files under this directory; may also `/lgtm` on a pull request; reviewer candidates for `blunderbuss` unless `exclude_approvers`
`reviewers` | list of usernames who may use `/lgtm`; reviewer candidates for `blunderbuss`
`labels` | list of labels `owners-label` adds to a pull request touching this directory; applied verbatim, must [exist in the repository](./labeling.md#labels-from-owners-files)
`options.no_parent_owners` | `true` stops inheritance from parent directories

`emeritus_approvers`, `emeritus_reviewers` and `filters` are accepted but ignored (`filters` is noted in the debug log). `OWNERS_ALIASES` files and aliases are not supported. Unknown keys are tolerated. `labels` must be a list of strings; anything else fails like a malformed role.

```yaml
# List of usernames who may use /lgtm and get review requests
reviewers:
  - user1
  - user2
  - user3

# List of usernames who may use /approve
approvers:
  - user1
  - user2
  - admin1

# Labels added to every pull request that touches this directory
labels:
  - area/sdk

# Optional: do not inherit approvers, reviewers and labels from parent directories
options:
  no_parent_owners: false
```

[owners-example]: ./examples.md#review-and-approve-pull-requests
