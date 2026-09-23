# Jobs

Jobs run from the `jobs` input on `schedule`, `workflow_dispatch` and `push` events
(`pull_request` and `pull_request_target` run the [PR jobs](./pr-jobs.md)). The input is space or newline
delimited and case-insensitive (`jobs: sweep lgtm label-sync`). Every listed job runs, in
parallel; an unknown name fails the run with `could not execute <job>`. A pull request both `sweep`
and `lgtm` reach is evaluated once per run, by whichever gets to it first (`skipping pr #N: already
evaluated in this run`); event handlers never dedupe.

Jobs | Description | Permissions
--- | --- | ---
`lgtm` | Backstop for [event-driven merging](./automatic-merging.md#event-driven-merging): catches events GitHub dropped or runs that were skipped; comment commands (`/lgtm`, `/approve`, `/unhold`) evaluate the PR themselves and do not need it. Pages through the repository's open pull requests, following pages until one comes back empty, and sends every one that passes the [merge gate](./automatic-merging.md#the-merge-gate) on its listed labels (`tide.labels` present, no `tide.missing_labels`; by default `lgtm` and none of `do-not-merge/*`, `needs-rebase`, `hold`) through the shared merge path: the [`lgtm` binding](./automatic-merging.md#lgtm-is-bound-to-a-commit) (a stale `lgtm` is stripped, not merged), then `mergeable_state` (`clean` and `has_hooks` merge). A PR that fails the gate on its listed labels costs no further call. On a branch that requires a merge queue the PR is enqueued instead (`enqueued pr #<n>`), which counts as done ([merge queues](./automatic-merging.md#merge-queues)). Skips locked and closed PRs and logs why each other PR was skipped; a refused merge fails the run listing those PRs. With the events subscribed an hourly or daily schedule is enough, or drop the job. | `contents: write`, `pull-requests: write`, `statuses: write`
`sweep` | For the [`pull_request` install mode](./installing.md#without-pull_request_target): evaluates every open pull request updated within [`sweep.lookback`](#sweep) the way the `pull_request` and `pull_request_review` handlers would have, which those events cannot do for fork pull requests (read-only token). `needs-*` rules, OWNERS labels, reviewers, approval, the pending runs of PRs labeled `ok-to-test`, the merge path. | `contents: write`, `issues: write`, `pull-requests: write`, `statuses: write`, `actions: write`
`label-sync` | Creates the labels the prow configuration describes and updates the color or description of those that drifted. Never deletes or renames a label. | `contents: read`, `issues: write`

## `sweep`

Under `pull_request` (not `pull_request_target`) the runs for a fork pull request get a
read-only token and [return at once](./events.md#fork-pull-requests-under-pull_request). The
`sweep` job does their work on a schedule instead: it lists the open pull requests newest-updated
first (`GET /pulls?state=open&sort=updated&direction=desc&per_page=100`), pages until a page
reaches back past `now − lookback`, and evaluates every pull request updated inside the window,
three at a time, each sequentially:

Step | Reuses | Does | Skipped when
--- | --- | --- | ---
1 | [`require_matching_label`](./configuration.md#require_matching_label) | every PR rule, no grace period | no rule is configured
2 | [`owners-label`](./labeling.md#labels-from-owners-files) | adds the missing OWNERS `labels:` | the repository has no OWNERS files
3 | [`blunderbuss`](./configuration.md#blunderbuss) | requests reviewers like `opened` would; honours `ignore_authors` and `ignore_drafts` | no OWNERS files; the PR was created before the window; it has requested reviewers, reviews, or is a draft
4 | [`approve`](./commands.md#approve) | recomputes `approved` and the notifier | no OWNERS files
5 | [`ok-to-test`](./commands.md#trigger) | approves the workflow runs waiting for approval on the head | the PR does not carry `ok-to-test`
6 | [`tide`](./automatic-merging.md) | the label gate, the [`lgtm` binding](./automatic-merging.md#lgtm-is-bound-to-a-commit) (a stale `lgtm` is stripped), `mergeable_state`, the merge | never; `tide.merge_on_events` does not apply, the sweep is a scheduled job like `lgtm`

Same-repository pull requests are evaluated too; every step is idempotent, so the sweep
changes nothing the events already did. The log has one `sweep: N candidates updated since
<time>` line and one `sweep: #<n> merged|enqueued|evaluated[ with N error(s)]` line per pull request. A
failure on one pull request is collected and the rest still run; the run fails at the end with
`sweep: N pull request(s) failed: #<n> (<step>: <reason>), ...`.

```yaml
sweep:
  lookback: 1h # default; capped at 24h
```

Cost: one list page per 100 candidates, then per candidate one pull request read, one status
read when it carries `lgtm`, one labels read with `needs-*` rules, and on OWNERS repositories
the changed files, the base tree and its OWNERS blobs (shared by steps 2–4), the comments and
the reviews, and one workflow-runs read plus one approval per held run when it carries `ok-to-test`: about 4–6 calls on a plain repository, 8–10 with OWNERS files. Run it every five
minutes: `*/5 * * * *` is the shortest interval GitHub schedules ("The shortest interval you can
run scheduled workflows is once every 5 minutes"), and slots are delayed or dropped under load,
so a fork pull request waits minutes for its labels, reviewers and merge. The `lookback` must be
longer than the schedule interval plus the expected delay; the default hour is generous.

```yaml
name: Prow sweep
on:
  schedule:
    - cron: '*/5 * * * *'

permissions:
  contents: write
  issues: write
  pull-requests: write
  statuses: write
  actions: write

jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - uses: cncf/prow-github-actions@v3.0.1
        with:
          jobs: sweep lgtm
          github-token: '${{ secrets.GITHUB_TOKEN }}'
```

## `label-sync`

The job reconciles the repository's labels with the catalogue derived from the
[configuration](./configuration.md#the-label-catalogue): every label section, the
built-in `/lifecycle`, `/stage` and `/status` values, the labels the action's own
commands apply (`lgtm`, `approved`, `do-not-merge/hold`, the legacy `hold`, `help wanted`, `good first issue`, `ok-to-test`) and every
`require_matching_label` missing label. Label commands only apply labels that exist
([labeling](./labeling.md#labels-must-exist-in-the-repository)), so run this job once
after adopting the action and whenever the configuration changes.

Repository label | Action
--- | ---
absent | created with the catalogue's name, color and description
present, color or description differs | updated in place; only the differing fields are sent
present, only the name's case differs | left alone; the repository's casing wins
present with a description the catalogue lacks | left alone; nothing is ever cleared
not in the catalogue | left alone; nothing is ever deleted

Every label is attempted; a refused write is logged as an error annotation and the run
fails at the end with `N label(s) could not be synced: <name> (<reason>), ...`. One
`core.info` line summarises what was created, updated and unchanged.

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
      - uses: cncf/prow-github-actions@v3.0.1
        with:
          jobs: label-sync
          github-token: '${{ secrets.GITHUB_TOKEN }}'
```

Input | Default | Meaning
--- | --- | ---
`dry-run` | `false` | `true` logs `would create [...]`, `would update [...]` and writes nothing

When the configuration lives in the organization's `.project` or `.github` repository, a
`schedule` trigger (for example daily) picks up changes made there. With the
[reusable workflow](./installing.md) this is the caller's `label-sync` job.

Removed: `pr-labeler` — the deprecated cron job that labeled PRs by file globs from
`.github/labels.yaml` has been removed. Use
[`actions/labeler`](https://github.com/actions/labeler) with the `pull_request_target`
trigger instead; it labels PRs on each event, securely, even from forks. `jobs:
pr-labeler` now fails with an unknown-job error.
