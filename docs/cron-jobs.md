# Cron jobs

The following jobs are supported through [cron Github workflows](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule).
The `jobs` input is space or newline delimited and case-insensitive (`jobs: lgtm`).
The job pages through the repository's pull requests, following pages until one comes back empty, and skips locked and closed PRs.

Jobs | Description
--- | ---
`lgtm` | Will attempt to automatically merge a PR with the `lgtm` label. Blocked by the `hold` label. See [automatic PR merging](./automatic-merging.md). Removed by the [lgtm PR job on pr update](./pr-jobs.md)

Removed: `pr-labeler` — the deprecated cron job that labeled PRs by file globs from
`.github/labels.yaml` has been removed. Use
[`actions/labeler`](https://github.com/actions/labeler) with the `pull_request_target`
trigger instead; it labels PRs on each event, securely, even from forks. `jobs:
pr-labeler` now fails with an unknown-job error.
