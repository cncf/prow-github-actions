# Installing

New to this? [Prow for your organization](./prow-for-your-org.md) is the guided path; this page is the reference.

One caller workflow runs the whole bot through the reusable workflow
[`cncf/prow-github-actions/.github/workflows/prow.yml`](../.github/workflows/prow.yml).
The caller owns the triggers, the permissions and the concurrency group; the reusable
workflow runs the action at its own commit, so the two never drift.

* [One repository](#one-repository)
* [Without `pull_request_target`](#without-pull_request_target)
* [An organization](#an-organization)
* [Upgrading](#upgrading)
* [Inputs and secrets](#inputs-and-secrets)
* [What you get with zero config](#what-you-get-with-zero-config)
* [Using the action directly](#using-the-action-directly)

## One repository

Step | Do
--- | ---
1 | Copy [`templates/workflow-templates/prow.yml`](../templates/workflow-templates/prow.yml) to `.github/workflows/prow.yml`. Replace `$default-branch` with your default branch (the organization installer below does this for you).
2 | Optionally add a `.github/prow.yaml` ([starter](../templates/prow.yaml), [reference](./configuration.md)). Without one the [built-in labels](#what-you-get-with-zero-config) and the organization's file, if any, apply.
3 | *Actions → Prow → Run workflow* once: the `label-sync` job creates the labels the configuration describes. Label commands only apply labels that exist.

The caller, in full:

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
  actions: write

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

Trigger | Why
--- | ---
`pull_request_target` | Fork pull requests get a write token, so they are labeled and merged too. Safe because nothing checks out or runs pull request code: the reusable workflow only checks out `cncf/prow-github-actions` at its own commit ([events](./events.md#pull_request_target-and-the-reusable-workflow)). Forbidden by your policy? See [without `pull_request_target`](#without-pull_request_target).
`schedule` | Backstop for merges the events missed ([jobs](./cron-jobs.md)). Hourly is plenty; drop it if you like.
`workflow_dispatch`, `push` | The `label-sync` job, on demand and whenever `.github/prow.yaml` changes.
`concurrency` | One group per comment, and per event and activity type for everything else ([events](./events.md#concurrency)). `cancel-in-progress` stays `false`: a run that is merging must not be cancelled.

The `permissions` block is the ceiling: a reusable workflow's job can use at most what the
caller grants. The reusable job asks for exactly `contents: write` (merges, reading OWNERS
and configuration files), `issues: write` and `pull-requests: write` (labels, comments,
assignees, reviews) `statuses: write` (the `prow/lgtm` commit status that
[binds `lgtm` to the reviewed commit](./automatic-merging.md#lgtm-is-bound-to-a-commit)) and
`actions: write` ([`/retest`, `/test` and `/ok-to-test`](./commands.md#trigger) re-run or approve workflow runs).
Grant less and GitHub refuses to start the called job, since a called
workflow may only downgrade, never elevate, the caller's permissions.

## Without `pull_request_target`

Some organizations forbid `pull_request_target` outright (zizmor's `dangerous-triggers` audit
flags it; a hash-pinning policy often comes with it). The second template,
[`templates/workflow-templates/prow-pull-request.yml`](../templates/workflow-templates/prow-pull-request.yml)
(with `prow-pull-request.properties.json`, sharing `prow.svg`), installs the same bot on
`pull_request`. The diff against the default caller is two lines of triggers and one job:

```diff
-  pull_request_target:
+  pull_request:
     types: [opened, reopened, synchronize, ready_for_review, labeled, unlabeled]
   schedule:
-    - cron: '0 * * * *'
+    - cron: '*/5 * * * *'
 jobs:
   prow:
-    if: github.event_name != 'workflow_dispatch' && github.event_name != 'push'
+    if: github.event_name != 'workflow_dispatch' && github.event_name != 'push' && github.event_name != 'schedule'
+  sweep:
+    if: github.event_name == 'schedule'
+    uses: cncf/prow-github-actions/.github/workflows/prow.yml@v3
+    with:
+      jobs: sweep lgtm
```

Pull request | Handled by | Latency
--- | --- | ---
from the repository itself | the events, as with the default template | seconds
from a fork | the [`sweep` job](./cron-jobs.md#sweep): `needs-*` labels, OWNERS labels and reviewers, approval, the merge. The `pull_request`/`pull_request_review` runs [return at once](./events.md#fork-pull-requests-under-pull_request): GitHub gives them a read-only token | the cron interval; `*/5` is GitHub's shortest and slots are delayed under load, so minutes
any, on a comment (`/lgtm`, `/approve`, ...) | the `issue_comment` run, which has a write token on forks too | seconds

Caveat: an `lgtm` label applied **by hand** on a fork pull request cannot be
[bound to the commit](./automatic-merging.md#lgtm-is-bound-to-a-commit) by the read-only run,
so the sweep strips it with a comment; use `/lgtm`. Organizations that hash-pin replace `@v3`
in the template with the release's commit sha and a `# v3.x.y` comment; Dependabot keeps it
current.

## An organization

Put | At | Effect
--- | --- | ---
[`prow.yaml`](../templates/prow.yaml) | `<org>/.github` repository, `prow.yaml` | Every repository of the organization inherits it; a repository's own `.github/prow.yaml` layers on top ([tiers](./configuration.md#where-configuration-lives)).
[`prow.yml`](../templates/workflow-templates/prow.yml), [`prow.properties.json`](../templates/workflow-templates/prow.properties.json), [`prow.svg`](../templates/workflow-templates/prow.svg) | `<org>/.github` repository, `workflow-templates/` | Every repository sees **Prow** under *Actions → New workflow → Workflows created by <org>*; one click installs the caller with `$default-branch` filled in ([GitHub docs](https://docs.github.com/en/actions/sharing-automations/creating-workflow-templates-for-your-organization)).
[`prow-pull-request.yml`](../templates/workflow-templates/prow-pull-request.yml), [`prow-pull-request.properties.json`](../templates/workflow-templates/prow-pull-request.properties.json) | same place, optional | **Prow (pull_request, no pull_request_target)**, the [`pull_request` install mode](#without-pull_request_target) for organizations whose policy forbids `pull_request_target`.

### The `.project` tier

The loader looks for `<org>/.project` `prow.yaml` before `<org>/.github` `prow.yaml`. A
consuming repository's `GITHUB_TOKEN` cannot read another **private** repository, and the
loader treats an unreadable repository like a missing one: with a private `.project` the
organization tier silently falls through to `<org>/.github`. To use a private `.project`,
pass a token with read access to it:

```yaml
jobs:
  prow:
    uses: cncf/prow-github-actions/.github/workflows/prow.yml@v3
    secrets:
      token: ${{ secrets.PROW_TOKEN }}
```

Or name the source explicitly with the `config` input, which replaces the organization
lookup ([the `config` input](./configuration.md#the-config-input)).

## Upgrading

Ref | Behaviour
--- | ---
`@v3` | Floats: `release.yml` moves it to every stable `v3.x.y`. Nothing to do.
`@v3.1.0` | Exact release.
`@<sha>` | Exact commit, for repositories that pin everything.

Whatever the ref, the reusable workflow checks out the action at the **same commit as the
workflow file**, so a caller pinned to a sha runs exactly that action bundle and a floating
tag moves both together. [Dependabot](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/keeping-your-actions-up-to-date-with-dependabot)
updates the `uses:` of reusable workflows like any action.

The reusable workflow needs github.com: it reads the `job.workflow_sha` context, which is not
available on GitHub Enterprise Server. There, [use the action directly](#using-the-action-directly).

Since `lgtm` is [bound to the reviewed commit](./automatic-merging.md#lgtm-is-bound-to-a-commit)
the caller must grant `statuses: write` (the templates and the snippets on this page do), unless
`prow.yaml` sets `lgtm.bind_to_commit: false`. Without it `/lgtm` fails with
`cannot bind lgtm to the commit: grant statuses: write ...` and applies no label. Pull requests
already carrying `lgtm` when you upgrade are unbound: their next evaluation strips the label
once, with a comment saying why; re-apply with `/lgtm`.

## Inputs and secrets

Every input is optional. Each maps to the `action.yml` input of the same name.

Input | Default | Meaning
--- | --- | ---
`prow-commands` | every built-in command except `/meow` | The [`/commands`](./commands.md) to enable on `issue_comment`. Setting it replaces the list: add `/meow` or a dynamic `/<key>` command here.
`jobs` | `lgtm` | The [jobs](./cron-jobs.md) for `schedule`, `workflow_dispatch` and `push`, and the [PR jobs](./pr-jobs.md) for `pull_request`: `lgtm` merges on the schedule and strips `lgtm` from updated PRs; `sweep` evaluates recently updated PRs (fork PRs under `pull_request`).
`merge-method` | `merge` | `merge`, `squash` or `rebase`; `tide.merge_method` in `prow.yaml` wins. Ignored on a branch that requires a merge queue: the queue's method wins ([merge queues](./automatic-merging.md#merge-queues)).
`config` | — | An explicit configuration source, `owner/repo:path[@ref]` or an `https://` url ([configuration](./configuration.md#the-config-input)).
`dry-run` | `false` | `label-sync` logs what it would create or update and writes nothing.

Secret | Default | Meaning
--- | --- | ---
`token` | the caller's `github.token` | A token that can read a private `<org>/.project`, or a bot user's token so merges trigger `push` workflows ([events](./events.md#check_suite-and-status)).
`cat-api-key` | — | The [thecatapi.com](https://thecatapi.com) key for [`/meow`](./commands.md#enabling-meow).

```yaml
jobs:
  prow:
    uses: cncf/prow-github-actions/.github/workflows/prow.yml@v3
    with:
      prow-commands: /lgtm /approve /hold /kind /area /priority /meow
      merge-method: squash
    secrets:
      token: ${{ secrets.PROW_TOKEN }}
      cat-api-key: ${{ secrets.CAT_API_KEY }}
```

`secrets: inherit` also works; the reusable workflow reads only `token` and `cat-api-key`.

## What you get with zero config

With the caller alone and no `prow.yaml` in any tier:

Feature | Docs
--- | ---
Every built-in `/command` on issues and pull requests: assign, cc, approve, lgtm, hold, close, reopen, lock, retitle, milestone, help, good-first-issue, lifecycle, stage, status, check-required-labels, auto-cc, retest, test, ok-to-test, and the label commands once their labels exist | [commands](./commands.md)
Reviewers requested and labels applied from OWNERS files | [labeling](./labeling.md#labels-from-owners-files), [blunderbuss](./configuration.md#blunderbuss)
Automatic merging once a PR carries `lgtm` and no `do-not-merge/*`, `needs-rebase` or `hold`, on events and hourly; `lgtm` counts only for the commit it reviewed | [automatic merging](./automatic-merging.md)
`lgtm` removed when new commits are pushed | [PR jobs](./pr-jobs.md)
`label-sync` creating `lgtm`, `approved`, `do-not-merge/hold`, `hold`, `help wanted`, `good first issue`, `ok-to-test` and the `lifecycle/*`, `stage/*`, `status/*` labels | [jobs](./cron-jobs.md#label-sync)

Label sections (`/kind`, `/area`, `/priority`, ...) and `needs-*` rules need a `prow.yaml`
([starter](../templates/prow.yaml)).

## Using the action directly

The action itself is still `uses: cncf/prow-github-actions@v3` with the same inputs; it is the
way on GitHub Enterprise Server and for workflows that mix it with other steps. The
[events](./events.md#recommended-triggers) page has the direct form of the caller above.
