# Jobs

Jobs run from the `jobs` input on `schedule`, `workflow_dispatch` and `push` events
(`pull_request` and `pull_request_target` run the [PR jobs](./pr-jobs.md)). The input is space or newline
delimited and case-insensitive (`jobs: lgtm label-sync`). Every listed job runs; an
unknown name fails the run with `could not execute <job>`.

Jobs | Description | Permissions
--- | --- | ---
`lgtm` | Pages through the repository's open pull requests, following pages until one comes back empty, and merges every one that carries `lgtm` and not `hold`. Skips locked and closed PRs. See [automatic PR merging](./automatic-merging.md). Removed by the [lgtm PR job on pr update](./pr-jobs.md) | `contents: write`, `pull-requests: write`
`label-sync` | Creates the labels the prow configuration describes and updates the color or description of those that drifted. Never deletes or renames a label. | `contents: read`, `issues: write`

## `label-sync`

The job reconciles the repository's labels with the catalogue derived from the
[configuration](./configuration.md#the-label-catalogue): every label section, the
built-in `/lifecycle`, `/stage` and `/status` values, the labels the action's own
commands apply (`lgtm`, `approved`, `hold`, `help wanted`, `good first issue`) and every
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
      - uses: cncf/prow-github-actions@v2
        with:
          jobs: label-sync
          github-token: '${{ secrets.GITHUB_TOKEN }}'
```

Input | Default | Meaning
--- | --- | ---
`dry-run` | `false` | `true` logs `would create [...]`, `would update [...]` and writes nothing

When the configuration lives in the organization's `.project` or `.github` repository, a
`schedule` trigger (for example daily) picks up changes made there.

Removed: `pr-labeler` — the deprecated cron job that labeled PRs by file globs from
`.github/labels.yaml` has been removed. Use
[`actions/labeler`](https://github.com/actions/labeler) with the `pull_request_target`
trigger instead; it labels PRs on each event, securely, even from forks. `jobs:
pr-labeler` now fails with an unknown-job error.
