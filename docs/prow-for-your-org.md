# Prow for your GitHub organization

You have a GitHub organization (or one repository) and you want the way
kubernetes/kubernetes *interacts with people*: `/lgtm` and `/approve` chat-ops, OWNERS-driven
review flow, label families and `needs-*` rules, and pull requests that merge themselves once
they pass review. This guide is the one path to that. It covers Prow's **repository
interactions** only; Prow's CI side (`/test`, `/retest`, ProwJobs) is out of scope — CI stays
in your own workflows. Every step links to the reference pages; [installing](./installing.md)
is the reference for the mechanics (inputs, secrets, upgrading, the direct action form).

## What you get, and what you don't

Parity with [prow.k8s.io](https://prow.k8s.io), row by row. Every ✓ and ✗ below is what the
code on `main` does today.

| prow.k8s.io | Here | Notes |
| --- | --- | --- |
| `approve` plugin: `/approve`, `/approve cancel`, `/approve no-issue` | ✓ | With OWNERS files: aggregated coverage approval, `approved` label, `[APPROVALNOTIFIER]` comment, no bot review. Without: membership check plus a bot `Approve` review. [commands](./commands.md#approve) |
| `lgtm` plugin: `/lgtm`, `/lgtm cancel`, `/remove-lgtm` | ✓ | Refused for the PR author; bound to the reviewed commit with a `prow/lgtm` status and removed on push; never set by a GitHub review. [commands](./commands.md) |
| `tide`: merge when the gate passes | ✓ | Event-driven plus a cron backstop; one merge path checks the gate, the `lgtm` binding (a stale `lgtm` never merges) and `mergeable_state`; `merge`, `squash` or `rebase`. [automatic merging](./automatic-merging.md) |
| `blunderbuss`: reviewers requested on open | ✓ | `/auto-cc` reruns it on demand; drafts wait for `ready_for_review` by default. [configuration](./configuration.md#blunderbuss) |
| `owners-label`: labels from OWNERS files | ✓ | Applies the **union** of `labels:` along the OWNERS walk (Prow: deepest file only). [labeling](./labeling.md#labels-from-owners-files) |
| `require-matching-label`: `needs-*` labels | ✓ | `/check-required-labels` re-evaluates every rule; a human removing `needs-*` gets it re-added. [configuration](./configuration.md#require_matching_label) |
| `hold` plugin: `/hold`, `/hold cancel`, `/unhold` | ✓ | Applies `do-not-merge/hold`; the legacy `hold` label still blocks and is removed by cancel. [commands](./commands.md) |
| `label` plugin: `/kind`, `/area`, `/priority`, `/label`, `/remove-*` | ✓ | Plus a dynamic `/<key>` command per label section. Prow's `additional_labels` is our `labels.labels` allowlist. [labeling](./labeling.md) |
| `lifecycle`: `/lifecycle`, `/stage`, `/status`, `/remove-*` | ✓ | Prow's built-in values; overridable per section. [labeling](./labeling.md#lifecycle-stage-and-status-labels) |
| `assign` plugin: `/assign`, `/unassign`, `/cc`, `/uncc` | ✓ | [commands](./commands.md) |
| `milestone` plugin: `/milestone`, `/milestone clear` | ✓ | [commands](./commands.md) |
| `retitle` | ✓ | [commands](./commands.md) |
| `lock` | ✓ | `/lock [resolved / off-topic / too-heated / spam]` |
| `close` / `reopen` | ✓ | `/close not-planned` sets the state reason |
| `help` plugin: `/help`, `/good-first-issue`, `/remove-help` | ✓ | GitHub's default label names. [labeling](./labeling.md#help-wanted-and-good-first-issue) |
| `dog` / `cat` plugins | partial | `/meow` only, opt-in, calls a third-party image API. [commands](./commands.md#enabling-meow) |
| `welcome` plugin | ✗ | |
| `size` plugin | ✗ | Use [`actions/labeler`](https://github.com/actions/labeler) or similar |
| `wip` plugin | ✗ | No `WIP` title check; a **draft** PR never merges (`mergeable_state` `draft` is skipped) and blunderbuss waits for `ready_for_review` |
| `/test`, `/retest`, `/override`, `/skip` | ✗ | CI is your workflow's job, not the bot's |
| `cherrypicker` (`/cherry-pick`) | ✗ | |
| `OWNERS_ALIASES` | ✗ | Not read |
| OWNERS `filters` | ✗ | Accepted but ignored (debug-logged) |
| OWNERS `emeritus_approvers` | ✗ | Accepted but ignored |
| `/lgtm` via a GitHub "Approve" review | ✗ | Reviews feed `approved` only, never `lgtm` |
| `/approve` via a GitHub "Approve" review | ✓ | On OWNERS repositories an `APPROVED` review adds the reviewer as approver; `CHANGES_REQUESTED` removes them. [commands](./commands.md#approve) |

## Before you start

| You need | Why |
| --- | --- |
| Org admin (or repo admin for a single repo) | Creating `<org>/.github` and installing workflows |
| A **public** `<org>/.github` repository | The org tier every consumer's `GITHUB_TOKEN` can read |
| A decision on OWNERS-gated merging | An OWNERS file changes the merge gate to `lgtm` + `approved` (step 4) |
| A decision on a private `<org>/.project` | It wins over `.github` but needs a token that can read it; skip it unless you must hide the config ([installing](./installing.md#the-project-tier)) |
| A look at your rulesets | Required reviews or checks the bot's `GITHUB_TOKEN` cannot satisfy block its merges (see [day-one surprises](#rulesets-tokens-and-other-day-one-surprises)) |

## Step 1 — the organization config

Copy [`templates/prow.yaml`](../templates/prow.yaml) to `prow.yaml` at the root of
`<org>/.github`. Every repository of the organization inherits it; a repository's own
`.github/prow.yaml` layers on top ([tiers](./configuration.md#where-configuration-lives)).

| Section | What it does |
| --- | --- |
| `labels.kind` | `/kind bug`, `/kind cleanup`, … with the Kubernetes colors and descriptions |
| `labels.priority` | `/priority critical-urgent`, …; exclusive, one priority at a time |
| `labels.triage` | `/triage accepted`, …; exclusive |
| `labels.lifecycle` | the built-in `/lifecycle` values, spelled out so the labels are created |
| `labels.do-not-merge` | the merge gate's deny-list family; `/hold` applies `do-not-merge/hold` |
| `require_matching_label` | `needs-kind` on issues and PRs without a `kind/*`; `needs-triage` on issues only |
| `tide` | the merge gate, spelled out at its defaults |
| `hold` | the label `/hold` applies, at its default |
| `blunderbuss` | two reviewers requested from OWNERS when a PR opens, drafts wait, Dependabot ignored |

Trim what you don't want; the schema and every default are in
[configuration](./configuration.md).

## Step 2 — the workflow

Copy the trio `prow.yml`, `prow.properties.json`, `prow.svg` from
[`templates/workflow-templates/`](../templates/workflow-templates/prow.yml) into
`workflow-templates/` of `<org>/.github` (add `prow-pull-request.yml` and its `.properties.json`
if some repositories may not use `pull_request_target`,
[installing](./installing.md#without-pull_request_target)). Every repository then sees **Prow** under
*Actions → New workflow → Workflows created by \<org\>*; one click installs the caller with the
default branch filled in ([an organization](./installing.md#an-organization)). You can also
copy the caller into `.github/workflows/prow.yml` by hand. It is:

```yaml
name: Prow
on:
  issues:
    types: [opened, reopened, labeled, unlabeled]
  issue_comment:
    types: [created]
  # pull_request_target, not pull_request: fork pull requests get a write token, so they can be
  # labeled and merged too. This is safe because nothing here checks out or runs pull request
  # code; the reusable workflow only checks out cncf/prow-github-actions itself.
  pull_request_target:
    types: [opened, reopened, synchronize, ready_for_review, labeled, unlabeled]
  pull_request_review:
    types: [submitted, dismissed]
  check_suite:
    types: [completed]
  # backstop for merges missed by the events above
  schedule:
    - cron: '0 * * * *'
  # label-sync: run once after installing, then whenever .github/prow.yaml changes
  workflow_dispatch:
  push:
    branches: [$default-branch]
    paths: [.github/prow.yaml]

# the reusable workflow can use at most what is granted here
permissions:
  contents: write
  issues: write
  pull-requests: write
  statuses: write

# One run per comment (commands are never collapsed); per event+action for everything else,
# so a pending `synchronize` run can only be superseded by a newer `synchronize` run.
# Never cancel a run that may be merging.
concurrency:
  group: prow-${{ github.event_name }}-${{ github.event.action }}-${{ github.event.comment.id || github.event.pull_request.number || github.event.issue.number || github.run_id }}
  cancel-in-progress: false

jobs:
  prow:
    if: github.event_name != 'workflow_dispatch' && github.event_name != 'push'
    uses: cncf/prow-github-actions/.github/workflows/prow.yml@v3
    # optional; the defaults enable every built-in command and the lgtm job
    # with:
    #   prow-commands: /lgtm /approve /hold /kind /area /priority
    #   merge-method: squash
    # optional; only for a token that can read a private <org>/.project or a /meow key
    # secrets:
    #   token: ${{ secrets.PROW_TOKEN }}
    #   cat-api-key: ${{ secrets.CAT_API_KEY }}

  label-sync:
    if: github.event_name == 'workflow_dispatch' || github.event_name == 'push'
    uses: cncf/prow-github-actions/.github/workflows/prow.yml@v3
    with:
      jobs: label-sync
```

The templates reference `@v3`. That floating tag appears with the first `v3.x.y` release;
until it exists, `@main` is the only ref that resolves. The `permissions` block is the
ceiling: the reusable workflow can only downgrade what the caller grants
([installing](./installing.md#one-repository)). Inputs, secrets and upgrading are covered
there too — nothing here needs to change for them.

## Step 3 — labels

In each repository, run the workflow once by hand: *Actions → Prow → Run workflow*. That is
the `label-sync` job, which creates every label the configuration describes. Labels are
created and updated, never deleted or renamed. Label commands only apply labels that already
exist; a missing label fails the run. A push that changes `.github/prow.yaml` re-syncs on its
own. Reference: [cron-jobs](./cron-jobs.md#label-sync).

## Step 4 — OWNERS (this is where it becomes Prow)

Add an `OWNERS` file to the root of the default branch, and directory-scoped ones where the
reviewers differ:

```yaml
# OWNERS
approvers:
  - alice
  - bob
reviewers:
  - carol
```

```yaml
# sdk/OWNERS: sdk-maintainer owns everything under sdk/ and does not inherit the root lists
approvers:
  - sdk-maintainer
reviewers:
  - sdk-reviewer
labels:
  - area/sdk
options:
  no_parent_owners: true
```

Those are all the keys supported: `approvers`, `reviewers`, `labels`,
`options.no_parent_owners`. `OWNERS_ALIASES`, `filters` and `emeritus_approvers` are not
supported. [commands](./commands.md#owners) has the full format and the failure modes.

What changes the moment the default branch carries any OWNERS file:

| Before | After |
| --- | --- |
| merge gate: `lgtm` | merge gate: `lgtm` **and** `approved` |
| `/approve` posts a bot "Approve" review | `/approve` records coverage; no bot review is submitted |
| — | one `[APPROVALNOTIFIER]` comment tracks who still needs to approve, edited in place |
| — | the author implicitly approves the files they own (`approve.require_self_approval: false`, Prow's default) |
| any org member or collaborator can `/lgtm` | `/lgtm` needs a reviewer or approver of at least one changed file, and never the author |
| — | reviewers are auto-requested from OWNERS when a PR opens (blunderbuss) |
| — | OWNERS `labels:` are applied to PRs touching that tree (owners-label) |

`approved` is sticky across pushes; `lgtm` is bound to the commit it reviewed, is removed on
every push and must be re-earned.
[commands](./commands.md#approve) and [automatic merging](./automatic-merging.md#the-merge-gate)
have the details.

## Step 5 — verify

Open a throwaway PR from a **non-author** account and walk this table. Each run is visible
under *Actions → Prow* in the `prow` job log; skipped merges show up as `skipping pr #N: …`
lines.

| You type | Expected |
| --- | --- |
| `/kind cleanup` | `kind/cleanup` applied, `needs-kind` removed **in the same run** |
| `/lgtm` as the PR author | refused with the comment "you cannot LGTM your own PR."; the run is marked failed |
| `/approve` and `/lgtm` on **two lines** of one comment from a second account that is an OWNERS reviewer/approver | a green `prow/lgtm` check on the head, `lgtm` applied, `approved` once coverage is complete, merged seconds later (we observed 3 s) |
| push a commit to the PR, then re-run *Actions → Prow* on `schedule` or wait for the next check suite | `lgtm` removed with the comment "`lgtm` is not bound to the current head commit"; nothing merges until a new `/lgtm` |
| `/approve /lgtm` on **one line** | nothing beyond `/approve` with the argument `/lgtm`, which is ignored: a command must start a line ([commands](./commands.md#command-syntax)) |

## Rulesets, tokens and other day-one surprises

| Surprise | What happens | What to do |
| --- | --- | --- |
| Branch protection or rulesets require reviews/checks the `GITHUB_TOKEN` cannot satisfy | `mergeable_state` is `blocked`; the event path skips the merge and logs the state | Lower the requirement, or let a human's review satisfy it ([automatic merging](./automatic-merging.md#event-driven-merging)) |
| A merge made with `GITHUB_TOKEN` fires no `push` workflows | post-merge automation does not run | pass a PAT or GitHub App token via the `token` secret ([installing](./installing.md#inputs-and-secrets)) |
| `<org>/.project` is private | a consumer's `GITHUB_TOKEN` cannot read it; the org tier silently falls through to `<org>/.github` | keep the org config in `.github`, or pass a `token` that can read `.project` ([installing](./installing.md#the-project-tier)) |
| Fork PRs | the template uses `pull_request_target`, so forks get labels and merges; safe because nothing checks out PR code ([events](./events.md#pull_request_target-and-the-reusable-workflow)) | nothing |
| zizmor (`dangerous-triggers`) or a hash-pin org policy rejects `pull_request_target` | `pull_request` gives fork PRs a read-only token | use the [`pull_request` template](./installing.md#without-pull_request_target): fork PRs are handled by the scheduled `sweep` within minutes, comments stay instant |
| Cron slots are delayed or dropped under GitHub load (observed: two slots dropped, one 16 min late) | merges land on events within seconds; the cron is only the backstop for missed events | keep the events subscribed; shorten the cron only if you accept the gap |
| You want cron-only merging | — | set `tide.merge_on_events: false` ([automatic merging](./automatic-merging.md#merge_on_events)) |

## How this differs from Prow

The deliberate divergences, each documented where it lives:

- a human removing a `needs-*` label gets it re-added (Prow only reacts to labels matching the rule's regexp) — [configuration](./configuration.md#require_matching_label)
- owners-label applies the **union** of `labels:` along the OWNERS walk, not just the deepest file's — [labeling](./labeling.md#labels-from-owners-files)
- `/hold` applies `do-not-merge/hold`; the legacy `hold` label still blocks and is removed by cancel — [automatic merging](./automatic-merging.md#upgrading-from-the-hold-label)
- every merge path, the cron included, merges only on `mergeable_state` `clean`/`has_hooks` — [automatic merging](./automatic-merging.md)
- `lgtm` is bound to the head commit with a `prow/lgtm` commit status and a stale `lgtm` is stripped by whichever path evaluates the PR next; Prow relies on the `synchronize` event alone — [automatic merging](./automatic-merging.md#lgtm-is-bound-to-a-commit)
- on OWNERS repositories `/approve` submits no bot review — [commands](./commands.md#approve)
- comment commands that write a label evaluate `needs-*` and the merge gate in the same run, because the bot's own label writes fire no events; Prow's tide re-syncs on a loop instead — [events](./events.md#the-bots-writes-fire-no-events)

Not divergences, but often assumed to be: the author implicitly approving files they own
(`approve.require_self_approval: false`) and GitHub reviews never setting `lgtm` are both
Prow's defaults too ([configuration](./configuration.md#approve)).
