# Automatic PR merging

Prow github actions supports automatic PR merging through
[Github actions cron jobs](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule).

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
      - uses: cncf/prow-github-actions@v2
        with:
          jobs: lgtm
          github-token: '${{ secrets.GITHUB_TOKEN }}'

          # optional; tide.merge_method in prow.yaml wins over this input
          merge-method: squash
```

This Github workflow checks every hour for open PRs that pass the merge gate below and
attempts to merge them. Locked and closed PRs are skipped. Every eligible PR is attempted,
so one un-mergeable PR does not stop the others. Each failed merge is logged as an error
annotation (`could not merge pr #<n>: <reason>`); once all pages are processed the run
fails if any merge failed, listing the PRs:
`2 pull request(s) could not be merged: #1 (Pull Request is not mergeable), #7 (...)`.

The companion `lgtm` PR job removes the `lgtm` label from a PR that gets updated.
This prevents any un-reviewed code from being automatically merged by the lgtm-merger mechanism.
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
`labels` | `[lgtm]` | every pattern must match at least one label on the PR
`missing_labels` | `[do-not-merge/*, needs-rebase, hold]` | no pattern may match any label on the PR
`merge_method` | see below | `merge`, `squash` or `rebase`

A configured list **replaces** the default list, it does not extend it: `missing_labels: [needs-rebase]`
lets a PR with `do-not-merge/hold` merge. Label names compare case-insensitively; `*` matches any run of
characters, `/` included, so `do-not-merge/*` covers the whole family while a bare `do-not-merge` matches
only that exact label. `approved` is not in the default `labels` yet; it joins once
[`/approve`](./commands.md) aggregates approvals per OWNERS file in a later release.

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
This job pages through the repository's open PRs, following pages until one comes back empty. This _may_ trigger a state
where github rate limits Prow github actions.
This may only happen with very large projects.
Please open an issue if you see this consistently happen.
